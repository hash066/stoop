# Proof-of-Handoff evaluation

Cases: **40** from synthetic labelled frames (add real footage to fixtures/footage/eval.json). Vision: `offline-footage-label` (offline: frames carry their labels, so this measures the deterministic truth table, not vision).

Accuracy **40/40**. **False releases (money released when it shouldn't be): 0.**

| expected \ predicted | VERIFIED | PIRACY_SUSPECTED | STILL_THERE | REVIEW |
|---|---|---|---|---|
| VERIFIED | 12 | 0 | 0 | 0 |
| PIRACY_SUSPECTED | 0 | 12 | 0 | 0 |
| STILL_THERE | 0 | 0 | 8 | 0 |
| REVIEW | 0 | 0 | 0 | 8 |

- VERIFIED: precision 100%, recall 100%
- PIRACY_SUSPECTED: precision 100%, recall 100%
- STILL_THERE: precision 100%, recall 100%
- REVIEW: precision 100%, recall 100%

_Reproduce: `pnpm eval:poh` · with real footage + Bedrock: `LLM_MODE=bedrock pnpm eval:poh`._
