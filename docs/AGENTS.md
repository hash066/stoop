# Agents and the rules they live under

There are two audiences:
- **runtime agents:** the Negotiator, Appraiser, BuyerBot and host planner
- **coding agents** working in this repo

## Runtime agents

| Agent | Framework | Sees | Can do | Can never |
|---|---|---|---|---|
| Host planner (the sim's "Alexa") | Bedrock Converse tool use, offline intent parser | utterance, MCP tool list, `skills/stoop/SKILL.md` | call MCP tools | see addresses, PSP data |
| Negotiator (one per buyer thread) | Strands TS `Agent` | listing title + ask, buyer text (as data), oracle answers | `evaluate_offer`, `propose_acceptance` (exact evaluated offer only), `send_reply` (guarded) | see the floor or the address; accept another amount; send unguarded text; exceed 6 turns / 20 s |
| Appraiser | Bedrock vision or offline catalog | photos (EXIF stripped) | identify, condition, comps (≥ 3 or "low confidence"), recall verdict | invent prices; describe people |
| BuyerBot | deterministic personas (Bedrock optional) | listing ask, counters | produce buyer messages | (eval/demo only) |

**Safety layering for the Negotiator:**
1. **Deterministic screening runs first.** It catches scams (off-platform payment, gift cards, codes, overpayment, couriers, links) and injection/address requests. Two scam strikes block the buyer.
2. **Tools only.** Numbers come from the Settlement oracle. `propose_acceptance` refuses any amount other than the one the buyer offered.
3. **Every outgoing message passes `Settlement.checkOutgoing`** (address fragments and floor disclosure). If the guard blocks, the model must rephrase. If it keeps failing, a safe template is sent.
4. **Budget:** `limits.turns = 6` and a 20 s `cancelSignal`. A looping model falls through to the template.

**Phases per item:**
1. Capture
2. Appraise
3. List (approval)
4. Negotiate
5. Commit (approval / mandate → UCP → hold)
6. Handoff (pass, window, Ring, frames)
7. Verify and settle (truth table → receipt → inspection → capture)
8. Learn (prefs, reputation)

## Policy rules (excerpt; full table in `docs/PLAN.md` §6)

R1 no direct side effects from LLMs · R2 address release · R3 capture conditions · R4 approval tokens · R5 floor secrecy · R6 AI disclosure · R7 scam patterns · R8 injection is data · R9 recalls · R10 privacy · R11 abuse limits · R12 races/idempotency · R13 Alexa+ purchase policy (breakdown, refund policy, yes; > $100 adds a voice code + on-screen confirmation).

## For coding agents working in this repo

1. Read `docs/ARCHITECTURE.md` and `packages/policy/src/*.ts` before changing behaviour. **No side effect may bypass `services/settlement`.**
2. Schemas first: edit `packages/shared`, then implement.
3. All LLM calls go through `services/agents/src/llm.ts` (`createModel(role, offlineScript)`). Every agent must work offline with a ScriptedModel.
4. Every external adapter (Ring, PSP, comps, recalls, Bedrock) has an interface and an offline implementation.
5. Label simulated things in the UI (Ring events are `origin: "simulator"`; footage is "our footage"; PSP is "Test PSP").
6. Tests:
   - `pnpm test` runs everything.
   - Policy changes need table tests, plus a property test if they touch capture or address release.
   - End-to-end flows live in `services/stack/test`.
7. Commit with the co-author trailer. Never commit `.env*` or `.data/`.
