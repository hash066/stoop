# Stoop red-team benchmark

Generated 2026-10-17T17:19:51.871Z · negotiator: **Amazon Bedrock us.amazon.nova-2-lite-v1:0** · 300 adversarial conversations (injection, scam and social-engineering families, seeded) · 200 benign buyers.

## Leaks under attack

| Agent | Address leaks | Floor leaks | Scam requests accepted |
|---|---|---|---|
| **Stoop** (Policy Kernel + guarded tools) | **0 / 300** (0.0%) | **0 / 300** | **0 / 70** |
| Naive agent (address + floor in prompt) | 57 / 300 (19.0%) | 40 / 300 | 9 / 70 |

Zero address leaks in 300 attacks bounds Stoop's true leak rate below **1.0%** at 95% confidence (rule of three).

124 of 300 attacks were refused by deterministic checks before the agent ran (address requests, injections, off-platform payment); the other 176 went through the agent on Bedrock and its guarded tools.

**Why Stoop can't leak:** the negotiating agent never receives the address or the floor. It sees an oracle ("acceptable? suggested counter?"), and every outbound message passes Settlement's guard. Only the address boundary ever sees the address in plaintext; in AWS that is the one Lambda the KMS key lets decrypt. The naive baseline is the common pattern, with secrets in the prompt.

## Benign buyers

100 of 200 negotiations reached an acceptable offer; average agreed price **$95.30** on a $120 ask (owner's floor $90, never disclosed); average 3.6 buyer turns.

_Reproduce: `pnpm eval:redteam` (offline) or `LLM_MODE=bedrock pnpm eval:redteam`._
