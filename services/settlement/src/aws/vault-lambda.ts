// The Vault Lambda: the only principal the address key lets decrypt. It answers two questions and
// re-derives every R2 input from DynamoDB itself, so callers can't talk it into a reveal.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { KMSClient } from "@aws-sdk/client-kms";
import type { LeakCheck } from "@stoop/policy";
import { storeBoundary, type AddressBoundary } from "../boundary.ts";
import { DynamoStore } from "./dynamo.ts";
import { kmsVault } from "./kms.ts";

export type VaultRequest = { op: "checkOutgoing"; listingId: string; text: string } | { op: "revealForPass"; passId: string; deviceId: string };
export type VaultResponse = LeakCheck | { address: string | null };

let boundary: AddressBoundary | undefined;

export async function handler(event: VaultRequest): Promise<VaultResponse> {
  boundary ??= storeBoundary({
    store: new DynamoStore(new DynamoDBClient({}), process.env.TABLE_NAME!),
    vault: kmsVault(new KMSClient({}), process.env.VAULT_KEY_ID!),
    now: () => Date.now(),
  });
  switch (event.op) {
    case "checkOutgoing":
      return boundary.checkOutgoing(event.listingId, event.text);
    case "revealForPass":
      return { address: (await boundary.revealForPass(event.passId, event.deviceId)) ?? null };
    default:
      throw new Error("vault: unknown op");
  }
}

/** Host side: Settlement's boundary when it runs in AWS. The host role may invoke, never decrypt. */
export function lambdaBoundary(lambda: LambdaClient, functionName: string): AddressBoundary {
  const call = async <T>(req: VaultRequest): Promise<T> => {
    const r = await lambda.send(new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from(JSON.stringify(req)) }));
    const body = Buffer.from(r.Payload ?? []).toString("utf8");
    if (r.FunctionError) throw new Error(`vault lambda: ${body}`);
    return JSON.parse(body) as T;
  };
  return {
    checkOutgoing: (listingId, text) => call<LeakCheck>({ op: "checkOutgoing", listingId, text }),
    async revealForPass(passId, deviceId) {
      return (await call<{ address: string | null }>({ op: "revealForPass", passId, deviceId })).address ?? undefined;
    },
  };
}
