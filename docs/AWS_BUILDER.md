# AWS Builder mini-challenge: how Stoop uses AWS

> **Status (Oct 17 2026, 22:30 IST):** Amazon Bedrock is **running** (live Nova 2 Lite runs of the golden path and the red team). Every other AWS piece is **written and tested against mocked AWS clients**, with a CDK stack that synthesizes cleanly, but **not deployed yet**: the AWS account's activation is incomplete, so CloudFormation, KMS, DynamoDB, Lambda, Step Functions and SQS still answer `OptInRequired` (friction log #15). Each row says exactly which state it is in.

| AWS service | What it does in Stoop | Code | Status |
|---|---|---|---|
| **Amazon Bedrock**, Nova 2 Lite (`us.amazon.nova-2-lite-v1:0`) | Every model role: the Negotiator agent, photo identification, porch vision ("is the item still there?"), the host planner, the red-team baseline | `services/agents/src/llm.ts`, `appraiser.ts`, `planner.ts`; `services/verifier/src/vision.ts` | **running**: full golden path verified live (appraise → haggle incl. an injection attempt → hold → doorbell → VERIFIED → receipt VALID) |
| **Strands Agents SDK** (TypeScript) | The Negotiator: an agent loop over three guarded tools (`evaluate_offer`, `propose_acceptance`, `send_reply`), with turn and time budgets; stops as soon as the reply is sent. `ScriptedModel` drives the same agent offline | `services/agents/src/negotiator.ts` | **running** on Bedrock and offline |
| **Bedrock AgentCore Runtime + Observability** | Host the Strands agents; OTel traces into the CloudWatch GenAI dashboard | `services/agents` | waiting: the Negotiator's tools call Settlement, so it moves together with the host once the account can run compute in us-east-1 |
| **AgentCore Memory** | Seller preferences across sessions ("pickup 6 pm to 8 pm like last time"); addresses redacted before writes | `services/stack/src/memory.ts` (local twin) | local twin running |
| **AWS KMS** | (1) `ECC_NIST_P256` receipt key: Sign with `MessageType=DIGEST`, DER → raw for JWS ES256. (2) `HMAC_256` key: single-use capability tokens. (3) **Address key whose policy denies Decrypt to every IAM principal, root included, except the Vault Lambda** (and has no `CreateGrant` side door) | `services/settlement/src/aws/kms.ts`, `infra/lib/stoop-stack.ts` | adapters unit-tested (a KMS-signed receipt verifies offline); keys defined in CDK; deploy pending |
| **AWS Lambda** (Vault) | The address boundary: the only code that turns an address ciphertext into plaintext. Runs the outbound-message guard and the pass-page reveal, and re-derives R2 (funded, bound device, inside the window) from DynamoDB itself, so a compromised host or agent still can't get an address | `services/settlement/src/boundary.ts`, `aws/vault-lambda.ts` | boundary running locally; Lambda bundled by CDK (456 KB, arm64, Node 22); deploy pending |
| **Amazon DynamoDB** | Single-table store; `ifAbsent` / `ifVersion` as server-side conditions, `TransactWriteItems` for one-deal-per-listing; spent-token table with TTL | `services/settlement/src/aws/dynamo.ts` | adapter unit-tested; deploy pending |
| **AWS Step Functions** (Standard) + **Amazon SQS** | Deal saga timers (window open/close, presence grace, inspection, reservation expiry): one execution per job, Wait on `TimestampPath`, then SQS; the host long-polls, so it needs no inbound endpoint | `services/settlement/src/aws/scheduler.ts`, CDK `HandoffSaga` | adapter unit-tested; deploy pending |
| **AWS CDK** | `StoopStack`: the keys, table, Vault Lambda, saga, job queue and a host policy that has no `kms:Decrypt` | `infra/` | `cdk synth` clean; deploy pending |
| **AWS Budgets** | $25/month alert for the hackathon account (credits excluded) | – | **running** |
| **Kiro** | Spec-first Policy Kernel: `.kiro/specs/policy-kernel/{requirements,design,tasks}.md`. Tasks 1–6 (truth table with presence grace, address release + audit, capture + property test, canonical-terms tokens, negotiation oracle, R13 purchase policy) were specced before code; tasks 7–9 (KMS, DynamoDB, Step Functions adapters) are done; task 10 (CDK) is written | `.kiro/specs/policy-kernel/`, `packages/policy` | spec written; 9 of 10 tasks done |
| **Amazon S3, SES, EventBridge** | Photos and evidence frames, pickup-pass email, event fan-out | `LocalPhotoStore`, Ops email outbox, `EventBus` | local twins running |

## Why this is a multi-service agentic pipeline, not "one Bedrock call"

The model never touches money or addresses:
- **Strands agents on Bedrock** propose; they see an oracle ("acceptable? counter?"), never the floor.
- **KMS-backed capability tokens** bind each human approval to the exact terms shown.
- **KMS key policy + the Vault Lambda** make "the AI never holds the keys" an IAM fact, not a promise.
- **Step Functions** waits out pickup windows and webhook lag.
- **Bedrock vision** produces evidence; a **KMS-signed** receipt makes the outcome verifiable by anyone.

## Red team on live Bedrock

300 adversarial conversations on Nova 2 Lite ([`evals/REPORT.md`](../evals/REPORT.md), Oct 17): a naive agent with the address and floor in its prompt leaked the address **57 / 300 (19%)** and the floor 40 / 300, and went along with 9 / 70 scams; Stoop: **0 / 300**, 0 / 300, 0 / 70. 200 benign buyers on the same model: 100 deals, average $95.30 on a $120 ask.

## Deploy (once the account is active)

```bash
aws sts get-caller-identity --profile stoop
pnpm --filter @stoop/infra exec cdk bootstrap aws://<account>/us-east-1 --profile stoop
pnpm --filter @stoop/infra deploy                 # writes infra/outputs.json
STOOP_AWS_OUTPUTS=infra/outputs.json LLM_MODE=bedrock AWS_PROFILE=stoop pnpm stack
# The boundary, live: even the account root can't read an address
aws kms decrypt --profile stoop --key-id alias/stoop-address-vault --ciphertext-blob fileb://cipher.bin --encryption-context purpose=stoop-address   # AccessDenied
```
