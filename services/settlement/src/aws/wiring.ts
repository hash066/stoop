// Settlement's dependencies on AWS, built from the StoopStack outputs (`infra/outputs.json`, written
// by `pnpm --filter @stoop/infra deploy`). The host gets everything except the right to decrypt an
// address: reads go through the Vault Lambda (`lambdaBoundary`).
import { readFileSync } from "node:fs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SFNClient } from "@aws-sdk/client-sfn";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { ScheduledJob } from "../infra.ts";
import { DynamoSpentTokenStore, DynamoStore } from "./dynamo.ts";
import { kmsMacProvider, kmsReceiptSigner, kmsVault } from "./kms.ts";
import { pollJobs, StepFunctionsScheduler } from "./scheduler.ts";
import { lambdaBoundary } from "./vault-lambda.ts";

export interface AwsWiring {
  region: string;
  tableName: string;
  receiptKeyArn: string;
  tokenMacKeyArn: string;
  addressKeyArn: string;
  vaultFunctionName: string;
  stateMachineArn: string;
  jobQueueUrl: string;
}

const FIELDS: Record<Exclude<keyof AwsWiring, "region">, string> = {
  tableName: "TableName",
  receiptKeyArn: "ReceiptKeyArn",
  tokenMacKeyArn: "TokenMacKeyArn",
  addressKeyArn: "AddressKeyArn",
  vaultFunctionName: "VaultFunctionName",
  stateMachineArn: "StateMachineArn",
  jobQueueUrl: "JobQueueUrl",
};

/** Parse `cdk deploy --outputs-file` JSON ({ "StoopStack": { "TableName": ..., ... } }). */
export function parseAwsWiring(json: string, stackName = "StoopStack"): AwsWiring {
  const outputs = (JSON.parse(json) as Record<string, Record<string, string>>)[stackName];
  if (!outputs) throw new Error(`no ${stackName} outputs`);
  const w: Partial<AwsWiring> = {};
  for (const [k, out] of Object.entries(FIELDS)) {
    const v = outputs[out];
    if (!v) throw new Error(`${stackName} output ${out} is missing`);
    w[k as keyof typeof FIELDS] = v;
  }
  // Region from the state machine ARN: arn:aws:states:<region>:<account>:stateMachine:<name>
  w.region = w.stateMachineArn!.split(":")[3] ?? "us-east-1";
  return w as AwsWiring;
}

export const loadAwsWiring = (path: string, stackName?: string) => parseAwsWiring(readFileSync(path, "utf8"), stackName);

/** Every Settlement dependency that has an AWS twin, plus the job poller that replaces the local tick. */
export function awsSettlementDeps(w: AwsWiring) {
  const ddb = new DynamoDBClient({ region: w.region });
  const kms = new KMSClient({ region: w.region });
  const scheduler = new StepFunctionsScheduler(new SFNClient({ region: w.region }), w.stateMachineArn);
  return {
    store: new DynamoStore(ddb, w.tableName),
    spent: new DynamoSpentTokenStore(ddb, w.tableName),
    macp: kmsMacProvider(kms, w.tokenMacKeyArn),
    signer: kmsReceiptSigner(kms, w.receiptKeyArn),
    /** Encrypt only: the address key denies this host Decrypt. */
    vault: kmsVault(kms, w.addressKeyArn),
    boundary: lambdaBoundary(new LambdaClient({ region: w.region }), w.vaultFunctionName),
    scheduler,
    /** Start long-polling the saga's job queue; returns a stop function. */
    startJobs(handle: (job: ScheduledJob) => Promise<void>): () => void {
      const ac = new AbortController();
      void pollJobs({ sqs: new SQSClient({ region: w.region }), queueUrl: w.jobQueueUrl, scheduler, handle, signal: ac.signal });
      return () => ac.abort();
    },
  };
}
