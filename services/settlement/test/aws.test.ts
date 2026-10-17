// AWS adapters (Kiro tasks 7-9) against mocked SDK clients, and the address boundary that the
// Vault Lambda runs. No network: aws-sdk-client-mock intercepts every command.
import { createHash, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { DecryptCommand, EncryptCommand, GenerateMacCommand, GetPublicKeyCommand, KMSClient, KMSInvalidMacException, SignCommand, VerifyMacCommand } from "@aws-sdk/client-kms";
import { InvokeCommand, LambdaClient, type InvokeCommandOutput } from "@aws-sdk/client-lambda";
import { SFNClient, StartExecutionCommand, StopExecutionCommand } from "@aws-sdk/client-sfn";
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { mockClient } from "aws-sdk-client-mock";
import { canonicalize, signReceipt, verifyReceipt, type HandoffReceipt } from "proof-of-handoff";
import { beforeEach, describe, expect, it } from "vitest";
import { DynamoSpentTokenStore, DynamoStore, kmsMacProvider, kmsReceiptSigner, kmsVault, lambdaBoundary, pollJobs, StepFunctionsScheduler } from "../src/aws/index.ts";
import { localVault, storeBoundary } from "../src/index.ts";
import { ADDRESS, makeStack, openWindowDeal } from "./helpers.ts";

const flush = () => new Promise((r) => setImmediate(r));
const payload = (body: string) => Buffer.from(body) as unknown as InvokeCommandOutput["Payload"];
const ccf = () => new ConditionalCheckFailedException({ message: "conditional", $metadata: {} });

describe("address boundary", () => {
  it("Settlement never decrypts itself: pass page and outbound guard both go through the boundary", async () => {
    const real = localVault("test-vault-key");
    const hostVault = { encrypt: real.encrypt, decrypt: async () => Promise.reject(new Error("the host must not decrypt")) };
    const st = await makeStack(({ store, clock }) => ({ vault: hostVault, boundary: storeBoundary({ store, vault: real, now: () => clock.now() }) }));
    const { pass, listing } = await openWindowDeal(st);
    expect((await st.s.passView(pass.id, "device-dana")).address).toBe(ADDRESS);
    const res = await st.s.checkOutgoing(listing.id, "Sure, come to 1427 Maple Ridge Dr anytime");
    expect(res).toEqual({ ok: false, violations: ["address_fragment"] });
  });

  it("re-checks R2 on its own: a caller that skips Settlement still can't get the address", async () => {
    const st = await makeStack();
    const { pass } = await openWindowDeal(st);
    const b = storeBoundary({ store: st.store, vault: localVault("test-vault-key"), now: () => st.clock.now() });
    expect(await b.revealForPass(pass.id, "device-evil")).toBeUndefined(); // not the bound device
    expect(await b.revealForPass(pass.id, "device-dana")).toBe(ADDRESS);
    st.clock.advance(2 * 60 * 60 * 1000); // past the window end
    expect(await b.revealForPass(pass.id, "device-dana")).toBeUndefined();
  });
});

describe("DynamoStore", () => {
  const ddb = mockClient(DynamoDBClient);
  const store = new DynamoStore(new DynamoDBClient({}), "stoop");
  beforeEach(() => ddb.reset());

  it("maps ifAbsent / ifVersion to conditions and reports a failed condition as false", async () => {
    ddb.on(PutItemCommand).resolvesOnce({}).rejectsOnce(ccf());
    expect(await store.put("deal#1", { id: "1", version: 3 }, { ifAbsent: true })).toBe(true);
    expect(await store.put("deal#1", { id: "1", version: 4 }, { ifVersion: 3 })).toBe(false);
    const [first, second] = ddb.commandCalls(PutItemCommand).map((c) => c.args[0].input);
    expect(first!.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(first!.Item!.ver).toEqual({ N: "3" });
    expect(second!.ConditionExpression).toBe("ver = :v");
    expect(second!.ExpressionAttributeValues).toEqual({ ":v": { N: "3" } });
  });

  it("transacts several writes all-or-nothing", async () => {
    ddb.on(TransactWriteItemsCommand).resolvesOnce({}).rejectsOnce(
      new TransactionCanceledException({ message: "cancelled", $metadata: {}, CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }] }),
    );
    const ops = [
      { key: "deal#1", value: { id: "1" }, ifAbsent: true },
      { key: "activedeal#L", value: { dealId: "1" }, ifAbsent: true },
    ];
    expect(await store.transact(ops)).toBe(true);
    expect(await store.transact(ops)).toBe(false);
    expect(ddb.commandCalls(TransactWriteItemsCommand)[0]!.args[0].input.TransactItems).toHaveLength(2);
  });

  it("gets documents and lists a prefix across pages in key order", async () => {
    ddb.on(GetItemCommand).resolvesOnce({ Item: { pk: { S: "deal#1" }, doc: { S: '{"id":"1"}' } } }).resolvesOnce({});
    expect(await store.get("deal#1")).toEqual({ id: "1" });
    expect(await store.get("deal#2")).toBeUndefined();
    ddb
      .on(ScanCommand)
      .resolvesOnce({ Items: [{ pk: { S: "decision#002" }, doc: { S: '{"n":2}' } }], LastEvaluatedKey: { pk: { S: "decision#002" } } })
      .resolvesOnce({ Items: [{ pk: { S: "decision#001" }, doc: { S: '{"n":1}' } }] });
    expect(await store.list("decision#")).toEqual([{ n: 1 }, { n: 2 }]);
    expect(ddb.commandCalls(ScanCommand)[1]!.args[0].input.ExclusiveStartKey).toEqual({ pk: { S: "decision#002" } });
  });

  it("spends a capability token once", async () => {
    ddb.on(PutItemCommand).resolvesOnce({}).rejectsOnce(ccf());
    const spent = new DynamoSpentTokenStore(new DynamoDBClient({}), "stoop");
    expect(await spent.markUsed("tid_1", Date.now() + 60_000)).toBe(true);
    expect(await spent.markUsed("tid_1", Date.now() + 60_000)).toBe(false);
  });
});

describe("KMS adapters", () => {
  const kms = mockClient(KMSClient);
  beforeEach(() => kms.reset());

  it("vault binds every ciphertext to the address encryption context", async () => {
    kms.on(EncryptCommand).callsFake((i) => ({ CiphertextBlob: Buffer.concat([Buffer.from("enc:"), Buffer.from(i.Plaintext)]) }));
    kms.on(DecryptCommand).callsFake((i) => ({ Plaintext: Buffer.from(i.CiphertextBlob).subarray(4) }));
    const v = kmsVault(new KMSClient({}), "alias/stoop-vault");
    const c = await v.encrypt(ADDRESS);
    expect(c.startsWith("kms1.")).toBe(true);
    expect(await v.decrypt(c)).toBe(ADDRESS);
    expect(kms.commandCalls(EncryptCommand)[0]!.args[0].input.EncryptionContext).toEqual({ purpose: "stoop-address" });
    expect(kms.commandCalls(DecryptCommand)[0]!.args[0].input.EncryptionContext).toEqual({ purpose: "stoop-address" });
    await expect(v.decrypt("v1.local.cipher")).rejects.toThrow(/not a KMS ciphertext/);
  });

  it("MAC verifies with KMS and treats an invalid MAC as false", async () => {
    kms.on(GenerateMacCommand).resolves({ Mac: new Uint8Array([1, 2, 3]) });
    kms.on(VerifyMacCommand).resolvesOnce({ MacValid: true }).rejectsOnce(new KMSInvalidMacException({ message: "bad mac", $metadata: {} }));
    const m = kmsMacProvider(new KMSClient({}), "alias/stoop-mac");
    expect(await m.mac(new Uint8Array([9]))).toEqual(new Uint8Array([1, 2, 3]));
    expect(await m.verify(new Uint8Array([9]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(await m.verify(new Uint8Array([9]), new Uint8Array([0]))).toBe(false);
  });

  it("signs receipts as a DIGEST with KMS and the result verifies offline as ES256", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const receipt: HandoffReceipt = {
      v: 1, receiptId: "rcpt_1", dealId: "deal_1", listingId: "lst_1", itemHash: "a".repeat(64), verdict: "VERIFIED",
      signals: { P: true, D: true, B: true }, window: { start: 1, end: 2 },
      evidence: { checkInAt: 1, ringEvents: [{ kind: "button_press", at: 1, origin: "simulator" }] },
      decisionIds: ["dec_1"], issuer: "stoop-settlement", issuedAt: 1_760_000_000_000,
    };
    const signer = kmsReceiptSigner(new KMSClient({}), "arn:aws:kms:us-east-1:111122223333:key/0123456789abcdef");
    const b64u = (s: string) => Buffer.from(s).toString("base64url");
    const signingInput = `${b64u(JSON.stringify({ alg: "ES256", kid: signer.kid, typ: "poh+jws" }))}.${b64u(canonicalize(receipt))}`;
    kms.on(GetPublicKeyCommand).resolves({ PublicKey: publicKey.export({ format: "der", type: "spki" }) });
    kms.on(SignCommand).callsFake((i) => {
      expect(i.MessageType).toBe("DIGEST");
      expect(Buffer.from(i.Message)).toEqual(createHash("sha256").update(signingInput).digest());
      return { Signature: nodeSign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "der" }) };
    });
    const jws = await signReceipt(receipt, signer);
    const out = await verifyReceipt(jws, { keys: [await signer.publicJwk()] });
    expect(out.valid).toBe(true);
  });
});

describe("Step Functions scheduler + SQS poller", () => {
  const sfn = mockClient(SFNClient);
  const sqs = mockClient(SQSClient);
  beforeEach(() => {
    sfn.reset();
    sqs.reset();
  });

  it("starts one execution per job and stops it on cancel; a cancelled delivery is dropped", async () => {
    sfn.on(StartExecutionCommand).callsFake(async (i) => ({ executionArn: `arn:exec:${i.name}` }));
    sfn.on(StopExecutionCommand).resolves({});
    const s = new StepFunctionsScheduler(new SFNClient({}), "arn:sm");
    const id = s.schedule({ at: Date.now() + 60_000, kind: "close_window", dealId: "deal_1" });
    const keep = s.schedule({ at: Date.now() + 30_000, kind: "open_window", dealId: "deal_2" });
    await flush();
    const input = JSON.parse(sfn.commandCalls(StartExecutionCommand)[0]!.args[0].input.input!);
    expect(input.job).toMatchObject({ id, kind: "close_window", dealId: "deal_1" });
    expect(Date.parse(input.fireAt)).toBeGreaterThan(Date.now());
    expect(s.pending().map((j) => j.id)).toEqual([keep, id]);
    s.cancelFor("deal_1");
    await flush();
    expect(sfn.commandCalls(StopExecutionCommand)[0]!.args[0].input.executionArn).toBe(`arn:exec:${id}`);
    expect(s.accept({ id, at: 0, kind: "close_window", dealId: "deal_1" })).toBe(false);
    expect(s.accept({ id: keep, at: 0, kind: "open_window", dealId: "deal_2" })).toBe(true);
  });

  it("hands each delivered job to Settlement and deletes the message", async () => {
    const ac = new AbortController();
    const job = { id: "job_1", at: 1, kind: "open_window" as const, dealId: "deal_1" };
    sqs.on(ReceiveMessageCommand).resolvesOnce({ Messages: [{ Body: JSON.stringify(job), ReceiptHandle: "rh1" }] }).callsFake(async () => {
      ac.abort();
      return { Messages: [] };
    });
    sqs.on(DeleteMessageCommand).resolves({});
    const handled: string[] = [];
    await pollJobs({
      sqs: new SQSClient({}),
      queueUrl: "https://sqs/q",
      scheduler: new StepFunctionsScheduler(new SFNClient({}), "arn:sm"),
      handle: async (j) => void handled.push(j.id),
      signal: ac.signal,
    });
    expect(handled).toEqual(["job_1"]);
    expect(sqs.commandCalls(DeleteMessageCommand)[0]!.args[0].input.ReceiptHandle).toBe("rh1");
  });
});

describe("lambdaBoundary (host side)", () => {
  const lambda = mockClient(LambdaClient);
  beforeEach(() => lambda.reset());

  it("forwards both questions and surfaces a function error", async () => {
    lambda
      .on(InvokeCommand)
      .resolvesOnce({ Payload: payload(JSON.stringify({ ok: true, violations: [] })) })
      .resolvesOnce({ Payload: payload(JSON.stringify({ address: null })) })
      .resolvesOnce({ FunctionError: "Unhandled", Payload: payload('{"errorMessage":"boom"}') });
    const b = lambdaBoundary(new LambdaClient({}), "stoop-vault");
    expect(await b.checkOutgoing("lst_1", "hello")).toEqual({ ok: true, violations: [] });
    expect(await b.revealForPass("pass_1", "dev")).toBeUndefined();
    await expect(b.revealForPass("pass_1", "dev")).rejects.toThrow(/boom/);
    expect(JSON.parse(Buffer.from(lambda.commandCalls(InvokeCommand)[0]!.args[0].input.Payload as Uint8Array).toString())).toEqual({
      op: "checkOutgoing",
      listingId: "lst_1",
      text: "hello",
    });
  });
});

describe("AWS wiring from the StoopStack outputs", () => {
  const outputs = {
    StoopStack: {
      TableName: "stoop",
      ReceiptKeyArn: "arn:aws:kms:us-east-1:111122223333:key/r",
      TokenMacKeyArn: "arn:aws:kms:us-east-1:111122223333:key/m",
      AddressKeyArn: "arn:aws:kms:us-east-1:111122223333:key/a",
      VaultFunctionName: "stoop-vault",
      StateMachineArn: "arn:aws:states:us-east-1:111122223333:stateMachine:stoop-handoff-saga",
      JobQueueUrl: "https://sqs.us-east-1.amazonaws.com/111122223333/stoop-jobs",
      HostRoleArn: "arn:aws:iam::111122223333:role/StoopHostRole",
    },
  };

  it("parses cdk --outputs-file JSON, takes the region from the ARN, and names a missing output", async () => {
    const { parseAwsWiring } = await import("../src/aws/index.ts");
    const w = parseAwsWiring(JSON.stringify(outputs));
    expect(w).toMatchObject({ region: "us-east-1", tableName: "stoop", vaultFunctionName: "stoop-vault" });
    const { TableName: _, ...partial } = outputs.StoopStack;
    expect(() => parseAwsWiring(JSON.stringify({ StoopStack: partial }))).toThrow(/TableName is missing/);
  });

  it("builds the AWS twin for every Settlement dependency", async () => {
    const { awsSettlementDeps, parseAwsWiring } = await import("../src/aws/index.ts");
    const d = awsSettlementDeps(parseAwsWiring(JSON.stringify(outputs)));
    expect(d.store).toBeInstanceOf(DynamoStore);
    expect(d.spent).toBeInstanceOf(DynamoSpentTokenStore);
    expect(d.scheduler).toBeInstanceOf(StepFunctionsScheduler);
    expect(d.signer.kid).toMatch(/^kms-/);
    expect(typeof d.boundary.revealForPass).toBe("function");
  });
});
