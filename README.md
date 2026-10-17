# Stoop

**Sell anything without meeting anyone. Money moves only when your doorbell sees it go.**

Stoop is an **Alexa+ add-on** (MCP server + MCP Apps cards) and a **Ring Appstore app**.

- You tell your assistant *"Sell the stroller and the bike. Don't go below $90 on the stroller."*
- Stoop prices and lists them, then negotiates with buyers, including buyers' own AI assistants. It never knows or reveals your minimum.
- The buyer pays through an Alexa+-style checkout. **The money is held, not charged.**
- The buyer picks the item up off your porch. **Your Ring doorbell provides the proof of handoff**: check-in, doorbell event, item there before and gone after. Only then is the money released, with a signed receipt anyone can verify.

**The AI never holds the keys.** Money, your address and receipts are controlled by a separate Settlement service under deterministic rules. In a 300-attack red team the selling agent leaked the address **0 times**, because it never had it.

## Run it (Windows, macOS or Linux; Node 22, pnpm)

```bash
pnpm install
pnpm demo
```

| Open | What |
|---|---|
| http://localhost:5180/?role=seller | Simulated Alexa+ device, seller's kitchen |
| http://localhost:5180/?role=buyer | Simulated Alexa+ device, buyer's living room |
| http://localhost:5183 | Mission control: events, Policy Kernel decisions, scenarios, Ring live view |
| pickup pass | opened by the buyer device ("send my pickup pass"); one-time code in the Ops email outbox |

Follow [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) for the 3-minute flow. Everything runs offline by default. `LLM_MODE=bedrock` switches agents and vision to Amazon Bedrock (see [`.env.example`](.env.example)).

## What's real and what's simulated

| Real | Simulated (by hackathon rule or necessity), always labelled |
|---|---|
| MCP servers (spec 2025-11-25, Streamable HTTP, sessions, form + URL elicitation, structured output, MCP Apps) | The Alexa+ client: add-on tooling is partner-only, so we built a device simulator that is a **real MCP client and MCP Apps host** |
| UCP checkout endpoints matching the Alexa+ add-on contract (2026-04-08) | Payment processor: `SandboxPSP` with Stripe manual-capture semantics ("Test PSP") |
| Ring Partner API client (snapshots, clips, WHEP live view), HMAC webhook ingest | Ring events from our signed simulator (the Playground doesn't deliver webhooks; a judge confirmed own simulators are fine), plus our own labelled porch footage |
| Strands agents, the Policy Kernel, KMS-style tokens and ES256 receipts | Offline `ScriptedModel` and footage-label vision until Bedrock access is active |

## Tests and evals

```bash
pnpm test           # 173 tests: policy (property-based), receipts, settlement, UCP, Ring, verifier, agents, MCP end-to-end
pnpm eval:redteam   # 300 adversarial conversations + 200 benign buyers -> evals/REPORT.md
pnpm eval:poh       # proof-of-handoff confusion matrix -> evals/POH_REPORT.md
```

**End-to-end:**
- The golden path runs through two real MCP clients: sweep → appraise → list → mandate → haggle → approve → UCP checkout → pass → doorbell → VERIFIED → paid.
- The scrutiny path covers:
  - 401/403/404 protocol hardening
  - an Alexa-style session-less client
  - the > $100 voice code
  - scam blocking and the two-buyer race
  - piracy, no-show, item still there, camera offline, and webhook replay

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): components, protocols, truth table, local-vs-AWS mapping
- [`docs/AGENTS.md`](docs/AGENTS.md): agents, rules R1–R13, guidance for coding agents
- [`skills/stoop/SKILL.md`](skills/stoop/SKILL.md): the Agent Skill for assistants using Stoop
- [`docs/AWS_BUILDER.md`](docs/AWS_BUILDER.md): AWS services, honest status per row
- [`docs/PRODUCT_FEEDBACK.md`](docs/PRODUCT_FEEDBACK.md) · [`docs/FRICTION_LOG.md`](docs/FRICTION_LOG.md)
- [`docs/RING_CERT_NOTES.md`](docs/RING_CERT_NOTES.md) · [`docs/AI_DISCLOSURE.md`](docs/AI_DISCLOSURE.md) · [`docs/PLAN.md`](docs/PLAN.md)
- Open source:
  - [`packages/proof-of-handoff`](packages/proof-of-handoff): verify any receipt with `poh verify`
  - [`oss/ring-api-helloworld`](oss/ring-api-helloworld): a media-helpers contribution to Amazon's Ring starter

## Repo layout

```
packages/  shared · policy · proof-of-handoff · ui-cards
services/  settlement · ring-bridge · verifier · agents · mcp-server · stack
apps/      alexa-sim · pass · ops
evals/     red team + proof-of-handoff
oss/       ring-api-helloworld contribution
skills/    stoop/SKILL.md
```

## License

MIT
