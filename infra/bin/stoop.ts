// CDK app: `pnpm --filter @stoop/infra deploy` (us-east-1, profile `stoop`).
import { App, Tags } from "aws-cdk-lib";
import { StoopStack } from "../lib/stoop-stack.ts";

const app = new App();
const stack = new StoopStack(app, "StoopStack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
  description: "Stoop: Settlement's AWS twins (KMS, DynamoDB, Vault Lambda, Step Functions saga)",
});
Tags.of(stack).add("project", "stoop");
