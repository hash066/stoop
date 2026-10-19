# AWS Builder mini-challenge: how Stoop uses AWS

> **Status (Oct 19 2026):** deployed in us-east-1 and verified on real AWS. Three stacks: `StoopStack` (Settlement's AWS twins), `StoopHostStack` (the public tester site and the judge site) and `StoopAgentStack` (the negotiating agent on Bedrock AgentCore Runtime). A full sale ran end to end on DynamoDB, KMS, the Vault Lambda and Step Functions; the account root was refused `kms:Decrypt` on an address. Each row says what was verified and how. Spend is capped at $30 a month (below).

| AWS service | What it does in Stoop | Code | Status (verified) |
|---|---|---|---|
| **Amazon Bedrock**, Nova 2 Lite (`us.amazon.nova-2-lite-v1:0`) | Every model role: the Negotiator agent, photo identification, porch vision, the host planner, the red-team baseline | `services/agents/src/llm.ts`, `appraiser.ts`, `planner.ts`; `services/verifier/src/vision.ts` | **running**: golden path live; 300-attack red team (below); powers both sites (photo pricing, porch-camera vision, the planner, the negotiator) under daily call caps |
| **Strands Agents SDK** (TypeScript) | The Negotiator: an agent loop over three guarded tools (`evaluate_offer`, `propose_acceptance`, `send_reply`), turn and time budgets, stops once the reply is sent | `services/agents/src/negotiator.ts` | **running on AgentCore Runtime** for both sites (below) |
| **AWS KMS** | (1) `ECC_NIST_P256` receipt key: Sign with `MessageType=DIGEST`, DER → raw for JWS ES256. (2) `HMAC_256` key: single-use capability tokens. (3) **Address key whose policy denies Decrypt to every IAM principal, root included, except the Vault Lambda**, with no `CreateGrant` side door | `services/settlement/src/aws/kms.ts`, `infra/lib/stoop-stack.ts` | **deployed**: a KMS-signed receipt from a real sale verifies (`SIGNATURE VALID`); `aws kms decrypt` as the account root → `AccessDeniedException … no resource-based policy allows the kms:Decrypt action` |
| **AWS Lambda** (Vault) | The address boundary: the only code that turns an address ciphertext into plaintext. Runs the outbound-message guard and the pass-page reveal, re-deriving R2 (funded, bound device, inside the window) from DynamoDB itself | `services/settlement/src/boundary.ts`, `aws/vault-lambda.ts` | **deployed**: guarded the agent's reply in the AWS sale; invoked directly, it returns the address for the bound pickup device and `null` for any other device |
| **Amazon DynamoDB** | Single-table store; `ifAbsent` / `ifVersion` as server-side conditions, `TransactWriteItems` for one deal per listing; spent tokens with TTL | `services/settlement/src/aws/dynamo.ts` | **deployed**: held every record of the AWS sale |
| **AWS Step Functions** (Standard) + **Amazon SQS** | Deal saga timers: one execution per job, Wait on `TimestampPath`, then SQS; the host long-polls, so it needs no inbound endpoint | `services/settlement/src/aws/scheduler.ts`, CDK `HandoffSaga` | **deployed**: opened the pickup window of the AWS sale and holds its inspection timer |
| **Amazon EC2 + CloudFront** | The tester site (the Stoop web app: real shops saved on the instance's data volume so redeploys close nothing, Stoop Street, the Alexa skill's endpoint) and the judge site (the same plus the Alexa+ device tour), HTTPS through CloudFront | `infra/lib/host-stack.ts`, `Dockerfile`, `services/stack/src/sandboxes.ts` | **running**: `pnpm --filter @stoop/stack e2e -- --target <site>` passes a whole sale in three browser profiles on the live site |
| **AWS Secrets Manager, SSM** | The feedback-export key; updates shipped with SSM Run Command | `infra/lib/host-stack.ts`, `docs/DEPLOY.md` | **running** |
| **AWS Budgets** (with actions) | $30 monthly cap, credits excluded: email at 50/80/100%, and at 100% two automatic actions: stop the instance and deny `bedrock:*` to the host role | `infra/lib/host-stack.ts` | **armed** (both actions in STANDBY). First line: daily model-call caps in the app (1,500 tester site, 1,000 judge site) |
| **AWS CDK** | Both stacks; NodejsFunction bundles the Vault Lambda from TypeScript source | `infra/` | **deployed** |
| **Amazon Bedrock AgentCore Runtime** (Node 22 code deployment, CDK `CfnRuntime`) | Runs the Strands negotiator. One `InvokeAgentRuntime` per buyer message (session = the negotiation). The agent holds no Stoop data: it reaches a shop only through that shop's negotiation port with a one-time grant for one negotiation, so the address and the owner's floor never reach it. If AgentCore is unreachable before the agent acted, the shop's own copy answers | `services/negotiator-runtime`, `services/stack/src/agentcore.ts`, `infra/lib/agent-stack.ts` | **deployed**: live negotiation turns in the runtime's CloudWatch log (`negotiator_turn`, 1 to 2 s each); execution role limited to Nova, its logs and traces; only the sites' instance role may invoke it |
| **AgentCore Memory, GenAI observability traces** | Seller preferences across sessions; OpenTelemetry spans for the CloudWatch GenAI dashboard | `services/stack/src/memory.ts` (local twin) | not yet: preferences use the local twin; the runtime logs one structured line per turn to CloudWatch |
| **Kiro** | Spec-first Policy Kernel: `.kiro/specs/policy-kernel/{requirements,design,tasks}.md`. Tasks 1–6 were specced before code; tasks 7–10 (KMS, DynamoDB, Step Functions adapters, CDK stack) are done and deployed | `.kiro/specs/policy-kernel/`, `packages/policy` | 10 of 10 tasks done |
| **Amazon S3, SES, EventBridge** | Photos and evidence frames, pickup-pass email, event fan-out | `LocalPhotoStore`, Ops email outbox, `EventBus` | local twins |

## Why this is a multi-service agentic pipeline, not "one Bedrock call"

The model never touches money or addresses:
- **Strands agents on Bedrock** propose; they see an oracle ("acceptable? counter?"), never the floor.
- **KMS-backed capability tokens** bind each human approval to the exact terms shown.
- **KMS key policy + the Vault Lambda** make "the AI never holds the keys" an IAM fact, not a promise: verified above.
- **Step Functions** waits out pickup windows and webhook lag.
- **Bedrock vision** produces evidence; a **KMS-signed** receipt makes the outcome verifiable by anyone.

## Red team on live Bedrock

300 adversarial conversations on Nova 2 Lite ([`evals/REPORT.md`](../evals/REPORT.md), Oct 17): a naive agent with the address and floor in its prompt leaked the address **57 / 300 (19%)** and the floor 40 / 300, and went along with 9 / 70 scams; Stoop: **0 / 300**, 0 / 300, 0 / 70. 200 benign buyers on the same model: 100 deals, average $95.30 on a $120 ask.

## Reproduce

[`docs/DEPLOY.md`](DEPLOY.md) has the deploy and update commands. To run Settlement locally against the deployed AWS resources: `STOOP_AWS_OUTPUTS=infra/outputs.json AWS_PROFILE=stoop pnpm stack`.
