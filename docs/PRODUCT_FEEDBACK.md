# Product feedback (required per tool)

## Model Context Protocol: TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.1)

- **Used for:**
  - Both MCP servers (Streamable HTTP, spec 2025-11-25): sessions, form and URL elicitation, structured output, resources.
  - The browser MCP client inside the Alexa+ simulator.
- **Worked well:**
  - `WebStandardStreamableHTTPServerTransport` dropped straight into Hono.
  - `extra.sendRequest` sends the elicitation on the tool call's own stream, which is exactly what stateful elicitation needs.
  - Zod v4 schemas work for input and output.
  - Experimental Tasks: `server.experimental.tasks.registerToolTask` plus `InMemoryTaskStore` gave us `tasks/get|result|list|cancel` with little code.
- **Needs work:**
  - The ecosystem is mid-split. v2 (`@modelcontextprotocol/server` / `client` 2.x) targets a newer spec where elicitation becomes "input required" results, while hackathon rules require 2025-11-25. It took time to establish that v1.32 is the right line for 2025-11-25 sessions and elicitation.
  - `registerToolTask` with a `z.object(...)` input schema types the handler's arguments as `unknown`, while a raw shape works. `registerTool` accepts both.
  - `taskSupport: "optional"` makes a plain `tools/call` block until the task finishes (automatic polling). For a watcher that lasts hours, that's a trap, so we used `"required"`.
  - The client opens a standalone GET SSE stream by default. In a browser with several tabs this exhausts the 6-per-host connection limit and silently stalls `initialize`. We now return 405 on GET (allowed by the spec). A client option to skip the standalone stream would help.
- **Onboarding:** about 30 minutes to a working tool; about half a day to understand sessions, elicitation and the v1/v2 situation.
- **Build again?** Yes. It's the standard, and the same server runs in Alexa+-style clients and Claude Desktop.

## MCP Apps (`@modelcontextprotocol/ext-apps` 2.0.3)

- **Used for:** six interactive cards (`ui://stoop/*`), plus a spec-compliant host bridge and sandbox proxy in the simulator.
- **Worked well:** the `App` class (`ontoolresult`, `callServerTool`, `openLink`, auto-resize) is pleasant. Single-file builds with `vite-plugin-singlefile` work.
- **Needs work:**
  - Peer dependencies are on the v2 SDK packages even for apps paired with v1 servers.
  - Each card bundles about 240 KB (mostly zod).
  - Spec examples disagree on `capabilities` vs `appCapabilities` in `ui/initialize`, and on the protocol version string.
- **Build again?** Yes.

## Alexa+ add-on documentation (MCP add-on design guide, checkout integration)

- **Used for:**
  - The design rules: glanceable cards, at most 5 voice options, voice-only mode, no ids shown.
  - Purchase policy R13 (breakdown, refund policy, > $100 voice code).
  - UCP checkout endpoints and headers.
- **Worked well:** concrete, testable requirements (idempotency 24 h, 409 on conflict, `Cache-Control: no-store`, six statuses).
- **Needs work:**
  - The add-on tooling, Web Simulator and CLI are partner-only, so there's no way to test against the real client.
  - The client-lifecycle example initializes with protocol 2025-03-26 and no session id, while the hackathon requires 2025-11-25. We support both.
  - No escrow or hold-then-release in the payments model. Marketplace-style add-ons need one.
- **Build again?** Yes, if a sandbox opens up.

## Ring Partner API and Developer Playground

- **Used for:**
  - Device discovery, snapshots (303 flow), clips (416/425), WHEP live view, event history.
  - HMAC-signed webhooks: `motion_detected` with `sub_type`, and `button_press`.
- **Worked well:** clear docs on webhook signing (`X-Signature`, raw body, `meta.request_id` dedupe, 5 s ack); release notes are detailed and current.
- **Needs work:** see `FRICTION_LOG.md`.
  - The Playground doesn't deliver webhooks.
  - Simulated streams can't drive motion or doorbell events.
  - Real devices are US-only.
- **Onboarding:** **(to fill in after the team's Playground session.)**
- **Build again?** Yes. Ring as a *commerce sensor* is a large non-security category.

## Strands Agents (TypeScript, `@strands-agents/sdk` 1.21)

- **Used for:** the Negotiator agent (Zod tools, `limits.turns`, `cancelSignal`) with BedrockModel in AWS, and a custom `ScriptedModel` offline.
- **Worked well:**
  - Implementing a custom `Model` (`stream()` yielding events) let the same agent run deterministically offline.
  - `cancelSignal` doubles as an early exit: aborting it as soon as the final `send_reply` tool succeeds skips the model call that would only end the turn. Live Nova 2 Lite turns went from ~9–10 s to ~3.5 s (from India).
- **Needs work:**
  - There's no default turn cap, so a misbehaving model loops until you set `limits.turns`. A safe default would help.
  - We found no documented way for a tool to end the loop ("this was the final step"). Aborting makes `invoke` throw, so the caller has to tell a deliberate stop from a failure itself.
  - Peer dependency on the v2 MCP client even when unused.
- **Build again?** Yes.

## Amazon Bedrock (Nova 2 Lite), AWS CLI, AWS KMS, AWS CDK

- **Used for:** every model role on Nova 2 Lite through Converse: the Strands Negotiator (`BedrockModel`), photo identification and porch vision (images in Converse), the host planner, and the red-team's naive baseline. KMS adapters for receipts (ECC P-256), capability tokens (HMAC) and the address vault; a CDK stack for all of it.
- **Worked well:**
  - `aws login` (console credentials, no access keys) worked first try, and the JS SDK v3.1152 picked the profile up with no extra code. Ideal for a hackathon.
  - The new-account message on Bedrock was clear ("Your account is currently being verified... normally less than 2 hours") and it unlocked in under an hour.
  - Converse is uniform across text, images and tools; Nova 2 Lite answered short prompts in ~0.7 s server-side (`metrics.latencyMs`), with a 200 requests/minute default quota.
  - CDK's `NodejsFunction` bundled a Lambda straight from TypeScript source in a pnpm monorepo (`.ts` import specifiers included) with no extra config.
- **Needs work:**
  - One unsupported image (an SVG) makes Converse reject the whole request, even though the service already detects the real type ("The detected file MIME type image/svg+xml is not supported"). A per-block error, or skipping the block with a warning, would make vision pipelines more robust. We now sniff formats before sending.
  - The account activation state is opaque: Bedrock worked while CloudFormation, KMS, DynamoDB, Lambda, Step Functions and SQS answered `OptInRequired` for hours (friction #15).
  - KMS: the documented key-administrator statement includes `kms:CreateGrant`, a side door to Decrypt (friction #16). JWS ES256 from KMS needs a DER → raw conversion that every team rewrites; we published ours in `proof-of-handoff` (`derToRawP256`).
  - CDK: what a custom key `policy` replaces depends on a feature flag (friction #17).
- **AgentCore:** the control plane answered, but Runtime, Memory and Observability wait for the rest of the account to activate.
- **Onboarding:** minutes for Bedrock once unlocked; the AWS deploy is still blocked on activation.
- **Build again?** Yes.
