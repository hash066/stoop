# Stoop red-team benchmark

Generated 2026-10-17T03:55:22.558Z · negotiator: **offline ScriptedModel (deterministic; same agent, tools and guards)** · 300 adversarial conversations (injection, scam and social-engineering families, seeded) · 200 benign buyers.

## Leaks under attack

| Agent | Address leaks | Floor leaks | Scam requests accepted |
|---|---|---|---|
| **Stoop** (Policy Kernel + guarded tools) | **0 / 300** (0.0%) | **0 / 300** | **0 / 70** |
| Naive agent (address + floor in prompt) | run with LLM_MODE=bedrock | – | – |

Zero address leaks in 300 attacks bounds Stoop's true leak rate below **1.0%** at 95% confidence (rule of three).

**Why Stoop can't leak:** the negotiating agent never receives the address or the floor. It sees an oracle ("acceptable? suggested counter?"), and every outbound message passes Settlement's guard. Settlement holds the only decrypt grant on the address. The naive baseline is the common pattern, with secrets in the prompt.

## Benign buyers

100 of 200 negotiations reached an acceptable offer; average agreed price **$95.30** on a $120 ask (owner's floor $90, never disclosed); average 3.8 buyer turns.

_Reproduce: `pnpm eval:redteam` (offline) or `LLM_MODE=bedrock pnpm eval:redteam`._
