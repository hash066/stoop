// CDK app: `pnpm --filter @stoop/infra deploy` (us-east-1, profile `stoop`).
import { App, Tags } from "aws-cdk-lib";
import { HostStack } from "../lib/host-stack.ts";
import { StoopStack } from "../lib/stoop-stack.ts";

const app = new App();
const stack = new StoopStack(app, "StoopStack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
  description: "Stoop: Settlement's AWS twins (KMS, DynamoDB, Vault Lambda, Step Functions saga)",
});
Tags.of(stack).add("project", "stoop");

// The public test site + judge site (deploy with: cdk deploy StoopHostStack)
const host = new HostStack(app, "StoopHostStack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
  description: "Stoop: public tester sandboxes and judge sandboxes behind CloudFront",
  repoUrl: "https://github.com/hash066/stoop.git",
});
Tags.of(host).add("project", "stoop");
