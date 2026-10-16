# Stoop

**Sell anything without meeting anyone. Money moves only when your doorbell sees it go.**

Stoop is an Alexa+ add-on (MCP server + MCP Apps cards) and a Ring Appstore app:

1. You say "sell the stroller, don't go below $90."
2. Stoop prices it and lists it, then negotiates with buyers, including buyers' own AI assistants.
3. The buyer's payment is **held**.
4. The buyer picks the item up off your porch. Your Ring doorbell provides the **proof of handoff**, and only then is the money released.

The AI never holds the keys. Money, your address and signed receipts are handled by a separate Settlement service under deterministic rules (`packages/policy`).

> Status: under active development for the Amazon "Build, Ship, Shape" hackathon (Oct 2026). See [`docs/PLAN.md`](docs/PLAN.md) for the full architecture, rules and test plan.

## Repo layout

| Path | What |
|---|---|
| `packages/shared` | zod schemas for every entity and event |
| `packages/policy` | Policy Kernel: rules R1–R13, deal state machine, Proof-of-Handoff truth table, capability tokens, text guards. Pure, fully tested |
| `services/*` | MCP server, Strands agents, Settlement, Ring bridge, saga, verifier, receipts *(in progress)* |
| `apps/*` | Alexa+ simulator (seller and buyer), pickup pass, ops console *(in progress)* |
| `docs/` | plan, friction log, product feedback, architecture |

## Develop

Requires Node 22 and pnpm 11.

```bash
pnpm install
pnpm test
```

## What's real and what's simulated

- **Real:** the MCP server, UCP-compatible checkout endpoints, Ring Partner API calls (via the Ring Developer Playground), Amazon Bedrock, AgentCore, Strands, KMS and Step Functions.
- **Simulated (required by the hackathon rules):** the Alexa+ client. Real Alexa+ add-on tooling is limited to select partners.
- **Labelled wherever it appears:**
  - our own porch footage
  - simulator-signed Ring-shaped events (the Playground does not deliver webhooks)
  - the test payment processor

## License

MIT
