# Design: Stoop Policy Kernel

Pure TypeScript, no I/O, in `packages/policy`. Settlement calls it; nothing else may cause side effects.

| File | Responsibility |
|---|---|
| `rules.ts` | `decide(input)` → `{ outcome: allow / deny / needs_approval, ruleIds, reasons }` for reveal_address, capture, accept_offer, complete_checkout, issue_pass |
| `handoff.ts` | `evaluateHandoff(evidence, now)`: the truth table (rows checked top-down) and the signals P/D/B |
| `deal.ts` | Deal saga transition table; `CAPTURE_PREDECESSORS` = INSPECTION, DUAL_CONFIRMED, DISPUTE |
| `oracle.ts` | `acceptable`, `autoAcceptable`, `suggestCounter` (floor shield 10%, 40% concession, $5 rounding, monotone) |
| `tokens.ts` | `mintToken` / `verifyAndSpend` with an injected `MacProvider` (KMS `GenerateMac` in AWS) and `SpentTokenStore` (DynamoDB conditional put in AWS) |
| `terms.ts` | RFC 8785 canonicalization + SHA-256 `termsHash` |
| `guards.ts` | `scanBuyerText` (scam/injection/address signals), `guardOutgoing` (address fragments + floor disclosure), the AI disclosure line |

## Testing strategy

- Table-driven tests for every rule and every truth-table row.
- fast-check properties:
  - capture is reachable only through the R3 paths
  - VERIFIED is reachable only through a VERIFIED verdict
  - counters never cross or reveal the floor
- Coverage threshold: 100% of functions, 95% of lines.
