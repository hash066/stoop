# AWS Builder mini-challenge: how Stoop uses AWS

> **Status (Oct 17 2026):** everything below is implemented and runs locally. The AWS adapters are written and switch on with `LLM_MODE=bedrock` plus AWS credentials. Deploying to AWS (account activation, Bedrock model access, CDK stack) is the remaining step. Every row says whether it's **running** or **ready to deploy**, so nothing is overstated.

| AWS service | What it does in Stoop | Code | Status |
|---|---|---|---|
| **Amazon Bedrock**, Nova 2 Lite (`us.amazon.nova-2-lite-v1:0`) | Baseline model for every role. Vision: "is this item on the porch?" (present/absent/unsure), photo identification, planner tool use | `services/verifier/src/vision.ts` (`BedrockVision`), `services/agents/src/appraiser.ts` (`BedrockIdentifier`), `services/agents/src/planner.ts` (`planBedrock`) | ready to deploy |
| **Amazon Bedrock**, Claude Sonnet 4.6 (`us.anthropic.claude-sonnet-4-6`) | Negotiator, when the Marketplace subscription is available on the account | `services/agents/src/llm.ts` (`BEDROCK_MODEL_ID_NEGOTIATOR`) | ready to deploy |
| **Strands Agents SDK** (TypeScript) | Negotiator agent loop with three guarded tools, turn and time budgets. `ScriptedModel` drives the same agent offline | `services/agents/src/negotiator.ts`, `llm.ts` | **running** (offline model) |
| **Bedrock AgentCore Runtime** | Hosts the Strands agents (HTTP protocol) and, if the elicitation spike passes, the stateful MCP server (`0.0.0.0:8000/mcp`) | `services/mcp-server`, `services/agents` | ready to deploy |
| **AgentCore Memory** | Seller preferences across sessions (user-preference strategy). Powers "pickup 6 pm to 8 pm like last time". Addresses are redacted before writes | `services/stack/src/memory.ts` (local twin) | local twin running |
| **AgentCore Observability** | OTel traces of agent turns into the CloudWatch GenAI dashboard | Strands telemetry | ready to deploy |
| **AWS KMS** | (1) `ECC_NIST_P256` receipt signing with `MessageType=DIGEST` plus DER→raw for JWS ES256. (2) `GenerateMac`/`VerifyMac` capability tokens. (3) Address vault key whose policy grants `Decrypt` only to Settlement | `packages/proof-of-handoff/src/der.ts`, `packages/policy/src/tokens.ts` (`MacProvider`), `services/settlement/src/infra.ts` (`Vault`) | interfaces + local twins running |
| **AWS Lambda** | Settlement + UCP endpoints (own IAM role); Ring webhook ingest | `services/settlement`, `services/ring-bridge` | ready to deploy |
| **Amazon API Gateway** | HTTPS front for UCP, the pass API, `/verify`, webhooks | `services/stack/src/compose.ts` routes | ready to deploy |
| **AWS Step Functions** (Standard) | Deal saga: window open/close, presence grace, inspection window, reservation expiry, hold renewal (Wait + `TimestampPath`) | `services/settlement` `onJob` + `TickScheduler` (local twin) | local twin running |
| **Amazon DynamoDB** | Single-table store; conditional writes and `TransactWriteItems` (one deal per listing) | `Store` interface, `MemoryStore` twin | local twin running |
| **Amazon EventBridge** | Ring events and deal events fan-out | `EventBus` twin | local twin running |
| **Amazon S3** | EXIF-stripped photos, evidence frames, receipts (versioned) | `LocalPhotoStore` | local twin running |
| **Amazon SES** | Pickup-pass one-time code email | demo email outbox in Ops | local twin running |
| **Kiro** | Spec-first development of the Policy Kernel. `.kiro/specs/policy-kernel/{requirements,design,tasks}.md` are committed; tasks 1–6 (presence-grace truth table, address release + audit, capture + property test, canonical-terms capability tokens, negotiation oracle, R13 purchase policy) were specced before implementation and are done; tasks 7–10 are the AWS adapters (KMS, DynamoDB, Step Functions, CDK) | `.kiro/specs/policy-kernel/`, `packages/policy` | spec written; tasks 1–6 done, 7–10 track the AWS deploy |
| **Claude Code on Bedrock** | Development workflow (organizer-confirmed to count) | n/a | used once Bedrock access is active |

## Why this is a multi-service agentic pipeline, not "one Bedrock call"

The model never touches money or addresses:
- **Strands agents** propose.
- **KMS-backed tokens** bind human approvals to exact terms.
- **Step Functions** waits out pickup windows and webhook lag.
- **Bedrock vision** produces evidence.
- A **KMS-signed** receipt makes the outcome verifiable by anyone.

## Deploy checklist (when the account is active)

1. Run `aws sts get-caller-identity`, then a Converse ping on Nova 2 Lite in us-east-1. File the Service Quotas increase.
2. Claude: submit the Anthropic first-time-use form, then a Converse ping on Sonnet 4.6. If the Marketplace subscription fails on an AISPL account, stay on Nova.
3. CDK `StoopStack`:
   - KMS keys (sign, MAC, vault)
   - DynamoDB table
   - Settlement Lambda (vault-decrypt grant only here)
   - API Gateway, Step Functions state machine
   - S3 bucket, SES identity
   - AgentCore Runtime (agents)
4. Run the spike: elicitation round-trip on AgentCore Runtime stateful MCP. If it fails, use EC2 t4g.small + Caddy for the MCP host.
5. Run `LLM_MODE=bedrock pnpm eval:redteam` and `LLM_MODE=bedrock pnpm eval:poh` (with real footage) for the headline numbers.
