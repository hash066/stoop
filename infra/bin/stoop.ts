// CDK app: `pnpm --filter @stoop/infra deploy` (us-east-1, profile `stoop`).
import { App, Tags } from "aws-cdk-lib";
import { AgentStack } from "../lib/agent-stack.ts";
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
  // spending guardrails: STOOP_BUDGET_EMAIL=you@example.com at deploy time (kept out of git)
  budgetEmail: process.env.STOOP_BUDGET_EMAIL,
  monthlyCapUsd: 30,
  judgeDailyModelCalls: 1000,
  publicDailyModelCalls: 1500,
  alexaSkillId: process.env.STOOP_ALEXA_SKILL_ID,
  negotiatorRuntimeArn: process.env.STOOP_NEGOTIATOR_RUNTIME_ARN,
});
Tags.of(host).add("project", "stoop");

// The negotiating agent on Bedrock AgentCore Runtime (build first: pnpm --filter @stoop/negotiator-runtime build)
const agent = new AgentStack(app, "StoopAgentStack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
  description: "Stoop: the negotiating agent on Amazon Bedrock AgentCore Runtime",
  hostRoleName: process.env.STOOP_HOST_ROLE_NAME,
});
Tags.of(agent).add("project", "stoop");
