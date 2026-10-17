# Stoop

**Sell anything without meeting anyone. Money moves only when your doorbell sees it go.**

Stoop is an **Alexa+ add-on** (MCP server + MCP Apps cards) and a **Ring Appstore app**.

- You tell your assistant *"Sell the stroller and the bike. Don't go below $90 on the stroller."*
- Stoop prices and lists them, then negotiates with buyers, including buyers' own AI assistants. It never knows or reveals your minimum.
- The buyer pays through an Alexa+-style checkout. **The money is held, not charged.**
- The buyer picks the item up off your porch. **Your Ring doorbell provides the proof of handoff**: check-in, doorbell event, item there before and gone after. Only then is the money released, with a signed receipt anyone can verify.

**The AI never holds the keys.** Money, your address and receipts are controlled by a separate Settlement service under deterministic rules. In a 300-attack red team the selling agent leaked the address **0 times**, because it never had it.

![Stoop architecture](docs/architecture.png)

## Run it (Windows, macOS or Linux; Node 22)

```bash
git clone https://github.com/hash066/stoop.git
cd stoop
corepack enable     # provides the pinned pnpm (11.0.8)
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
pnpm test           # 183 tests: policy (property-based), receipts, settlement, UCP, Ring, ring-sim, verifier, agents, MCP end-to-end (incl. Tasks + my_items)
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
  - offer flooding (rate limited before any model call)
  - MCP Tasks: `watch_handoff` follows a sale to CLOSED, stays private to its owner, and can be cancelled

**Browser QA and demo recording** (needs `pnpm demo` running and Google Chrome; uses `playwright-core`, which never downloads a browser):

```bash
pnpm qa       # every judged surface at 1280x800 and 390 px: console/HTTP errors + screenshots
pnpm record   # the golden path as one .webm clip per surface, for the video
```

**Simulated Ring events from the command line** (local or deployed; always labelled simulator-signed):

```bash
pnpm ring-sim event button
pnpm ring-sim replay
pnpm ring-sim scenario golden
```

## Fire TV (Garage Mode)

`apps/firetv` is **Garage Mode**: the household's sellable things on the big screen. Pick items with
the remote's D-pad, press **List selected**, approve on screen, and Stoop lists them — the footer
shows the live sale line through to "Sold". It's built on Amazon's
[`react-native-multi-tv-app-sample`](https://github.com/AmazonAppDev/react-native-multi-tv-app-sample)
(MIT-0) and is a **real stateless MCP client** to the same stack (it holds no money or address keys;
it only proposes). It is a **separate Yarn 4 workspace**, so use `corepack yarn`:

```bash
pnpm --filter @stoop/stack start      # the stack on :8787
cd apps/firetv && corepack yarn install && corepack yarn dev:web   # open http://localhost:8082
```

See [`apps/firetv/README.md`](apps/firetv/README.md) for details and the Android TV build.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): components, protocols, truth table, local-vs-AWS mapping
- [`docs/AGENTS.md`](docs/AGENTS.md): agents, rules R1–R13, guidance for coding agents
- [`skills/stoop/SKILL.md`](skills/stoop/SKILL.md): the Agent Skill for assistants using Stoop
- [`docs/AWS_BUILDER.md`](docs/AWS_BUILDER.md): AWS services, honest status per row
- [`docs/PRODUCT_FEEDBACK.md`](docs/PRODUCT_FEEDBACK.md) · [`docs/FRICTION_LOG.md`](docs/FRICTION_LOG.md)
- [`docs/RING_CERT_NOTES.md`](docs/RING_CERT_NOTES.md) · [`docs/AI_DISCLOSURE.md`](docs/AI_DISCLOSURE.md) · [`docs/PLAN.md`](docs/PLAN.md)
- Open source:
  - [`packages/proof-of-handoff`](packages/proof-of-handoff): verify any receipt with `poh verify`
  - [`oss/ring-api-helloworld`](oss/ring-api-helloworld): a media-helpers contribution to Amazon's Ring starter, open upstream as [AmazonAppDev/ring-api-helloworld#36](https://github.com/AmazonAppDev/ring-api-helloworld/pull/36) (issue [#35](https://github.com/AmazonAppDev/ring-api-helloworld/issues/35))

## Repo layout

```
packages/  shared · policy · proof-of-handoff · ui-cards
services/  settlement · ring-bridge · verifier · agents · mcp-server · stack
tools/     ring-sim (simulator-signed Ring webhooks)
apps/      alexa-sim · pass · ops · firetv (Garage Mode, Yarn 4)
evals/     red team + proof-of-handoff
oss/       ring-api-helloworld contribution
skills/    stoop/SKILL.md
```

## License

MIT
