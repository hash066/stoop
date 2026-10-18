# Stoop: handoff for the next build agent

> Written Sat Oct 17 2026, updated 22:30 IST the same day. **Deadline: Fri Oct 23 2026, 12:00 PM PT (Sat Oct 24, 00:30 IST).** Target submit time: Fri 09:00 PT, which leaves a 3-hour buffer. Feature freeze: **Tue Oct 20, 18:00 IST**.
>
> Repo: `E:\Winter\stoop`, pushed to https://github.com/hash066/stoop (public, branch `main`).

## 1. What Stoop is (30 seconds)

**Pitch:** "Sell anything without meeting anyone. Money moves only when your doorbell sees it go."

**How it works:**
- An Alexa+ add-on (an MCP server) appraises photos, lists items, and haggles inside the owner's private limits.
- It sells to other people's AI assistants over MCP, and takes payment through an Alexa+-compatible UCP checkout as a **hold**.
- The money is captured only after a **Proof-of-Handoff**: a pickup-pass check-in, a Ring doorbell event, and before/after porch frames, combined in a truth table.
- The outcome is a signed receipt (JWS ES256) that anyone can verify.
- A separate **Settlement** service holds every key. The AI only proposes.

**Hackathon target:**
- Primary: Amazon "Build, Ship, Shape", **Alexa+ track, 1st place**.
- Also entered: the Ring track, and the AWS Builder and Open Source minis.
- A project wins at most 1 track + 1 mini. The friction log is worth up to a 10% bonus.

## 2. Read these first (in order)

1. **The plan:** `docs/PLAN.md`, a copy of the approved master plan. The original is `C:\Users\asus\.claude\plans\create-a-crazy-plan-snazzy-haven.md`.
   - §0–§2: context, scoring, moat.
   - §6: Policy Kernel rules R1–R13.
   - §7.3: PoH truth table.
   - §12.2: scrutiny matrix X1–X29.
   - §14: schedule and cut order.
2. `docs/ARCHITECTURE.md`: components, protocols, and the local-vs-AWS mapping.
3. `docs/AGENTS.md`: agent roster, rules, and guidance for coding agents.
4. `README.md`: run commands and what is real vs simulated.
5. `docs/AWS_BUILDER.md`: AWS status per service. Honest "running" vs "ready to deploy".
6. `docs/FRICTION_LOG.md` and `docs/PRODUCT_FEEDBACK.md`: append to these as you go.
7. `.kiro/specs/policy-kernel/{requirements,design,tasks}.md`: tasks 7–10 are the AWS adapters.

## 3. Ground rules (non-negotiable)

**Security and outward-facing actions:**
- **Never type or handle credentials.** The user signs in to AWS (`aws login` / `aws configure sso`) and pastes Ring tokens themselves. Never commit secrets: `.env*` and `.data/` are gitignored.
  - A dev signing key was once committed and had to be scrubbed from history. Run `git diff --cached` before every commit.
- **Ask the user first** before:
  - posting anything publicly (the repo, the upstream PR #36 and npm were approved on Oct 17)
  - creating AWS resources beyond the approved `StoopStack` and AgentCore deploys
  - large downloads onto C: (only about 11 GB free; see Fire TV)
- **No third-party logos** (Amazon, Alexa, Ring, Meta) in UI or video.
- **Label everything simulated:** "Simulator-signed event", "Our footage", "Test PSP", "Alexa+ simulator".
- **Never invent users, quotes or statistics.** Cite each stat with source and date.

**Architecture:**
- **No side effect bypasses `services/settlement`:** reveal address, accept, charge, capture, refund, sign.
- Capability tokens are bound to `termsHash` (RFC 8785 JCS). Don't loosen this.
- Every external adapter has an interface plus a fake: Ring, PSP, Bedrock, eBay, CPSC, SES.
- All LLM calls go through `services/agents/src/llm.ts` and keep their deterministic fallbacks.

**Code style:**
- TypeScript strict, NodeNext, zod schemas in `packages/shared`.
- Match the surrounding code's comment density and naming.

**Commits:**
- Commit every 30–45 minutes, ending every commit message with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```
- A module is "done" when unit tests and an end-to-end path through it are green.

**Design bar: "estate-sale ledger meets porch light".**
- Warm paper, ink, one amber accent.
- Fraunces (display) + IBM Plex Mono (prices and times).
- 1 px rules, no shadows.
- Banned: purple gradients, glassmorphism, emoji icons, "AI-powered" copy.
- Fire TV uses a dark "porch at night" variant (`apps/firetv/.../theme/colors.ts`).

## 4. Environment gotchas (Windows 11, learned the hard way)

**Shell:**
- The PowerShell tool is primary; the Bash tool (Git Bash) also works.
- **Bash heredocs mangle quotes and `\r\n` escapes.** Write multi-line scripts with the Write tool into the job's scratch dir and run them (`python -I <path>`), or use the Edit tool.
- Many files are CRLF in the working copy (`core.autocrlf=true`). Patch scripts must normalise `\r\n`, edit, then restore.
- Commit messages: write them to a file, then `git commit -F <file>`.
- `vitest` output is coloured: strip ANSI (`sed 's/\x1b\[[0-9;]*m//g'`) before grepping for `Tests`.

**Packages:**
- pnpm is **11.0.8** (`packageManager`). `pnpm-workspace.yaml` has `allowBuilds: esbuild: true`; the store is on E:.
- `apps/firetv` is **excluded** from pnpm. It is a separate **Yarn 4.5** workspace: run `corepack yarn …`. A plain `yarn` on PATH is 1.22, so don't use it.

**Local stacks:**
- `pnpm stack` serves :8787 (offline models). The three Vite apps run on 5180 (alexa-sim), 5182 (pass), 5183 (ops).
- **Restart the stack after server code changes.** Its state is in memory; after many QA runs the demo buyer hits the offer rate limit (X2) and `make_offer` is refused. Restart before recording.
- A second stack on live Bedrock: `cd services/stack; PORT=8797 LLM_MODE=bedrock AWS_PROFILE=stoop AWS_REGION=us-east-1 npx tsx src/main.ts`. The tools take `STOOP_STACK_URL=http://localhost:8797`.
- Run `pnpm cards` after editing `packages/ui-cards`.

**Browser tools** (`tools/record-demo`, system Chrome via the `playwright-core` devDependency, no browser download):
- `pnpm qa`: every judged surface at 1280×800 and 390 px, console/HTTP errors, screenshots in `tools/record-demo/qa-shots/` (gitignored).
- `pnpm record`: the golden path as one `.webm` per surface in `tools/record-demo/clips/` (gitignored).
- `node tools/record-demo/diagram.mjs`: re-render `docs/architecture.png` from `docs/architecture.svg`.

**AWS:**
- Profile **`stoop`**, created with `aws login` (console credentials; account `428516841578`, root user; temporary credentials refresh automatically). Use `--profile stoop` or `AWS_PROFILE=stoop`; the JS SDK v3.1152 reads it.
- **Account activation is incomplete** (as of Oct 17, 22:15 IST): only STS, IAM, ECR, Bedrock, Budgets and the AgentCore control plane answer. CloudFormation, KMS, DynamoDB, Lambda, Step Functions, SQS, S3, CloudWatch Logs, EC2 and Lightsail return `OptInRequired` / `SubscriptionRequired`. **Check with exit codes**, not `| head -1`: CLI errors start with a blank line, which once made blocked calls look like empty successes.
- Budget: `stoop-hackathon-25usd` ($25/month, credits excluded, emails at 80% and 100% actual and 100% forecast). The account has $100 of credits.
- Docker 29.4 is installed (x86_64 daemon; use `docker buildx --platform linux/arm64` for AgentCore images).

**MCP SDK:**
- The SDK is `@modelcontextprotocol/sdk` **1.32.1**, the v1 line. Don't switch to the v2 split packages: the hackathon requires spec 2025-11-25.
- Experimental Tasks: `registerToolTask` needs a raw zod shape for `inputSchema`; `taskSupport: "optional"` makes a plain call block until the task ends, so use `"required"`; task stores are per actor (`services/mcp-server/src/http.ts`).
- The MCP server returns **405 on GET** (no standalone SSE stream: browsers allow 6 connections per host). Server notifications outside a request are dropped, so clients poll; the alexa-sim Tasks panel polls `tasks/get`.

**Runtime modes:**
- `LLM_MODE` unset = offline (ScriptedModel + templates); `LLM_MODE=bedrock` = live Bedrock (Nova 2 Lite).
- Demo tokens: seller `seller-demo-okafor`; buyers `buyer-demo-dana` (purchase code 4821) and `buyer-demo-lee`. Local demo values in `services/stack/src/compose.ts` (`DEMO`), not real credentials.

## 5. Current state (verified Oct 17, 22:30 IST)

- **Public repo:** https://github.com/hash066/stoop (MIT). CI (`.github/workflows/ci.yml`) is green on every push: typecheck, all tests, offline evals, the OSS helper tests.
- `pnpm typecheck` is clean and the suite is **205 tests**: receipts 6, policy 86, ring-bridge 9, settlement + UCP + AWS adapters 52, verifier 6, ring-sim 3, agents 24, MCP end-to-end 19.
- **Live Bedrock golden path verified:** appraise → list → haggle (incl. an injection attempt) → $95 → hold → doorbell → VERIFIED → receipt VALID, 18.6 s from India (each negotiator turn ~3.5 s for about two model calls; Bedrock itself answers in ~0.7 s per call, the rest is the network from India). Found and fixed: SVG placeholders sent to Bedrock broke the appraisal.
- **Red team on live Bedrock** (`evals/REPORT.md`, 300 attacks, Nova 2 Lite): naive agent leaked the address 57/300 (19%), floor 40/300, scams 9/70; Stoop 0/300, 0/300, 0/70 (124 refused before the agent ran, 176 reached it). Benign: 100/200 deals, avg $95.30. The run took 101 minutes.

| Area | Path | Status |
|---|---|---|
| Policy Kernel, receipts, Settlement, UCP, Ring bridge, ring-sim, verifier, agents, MCP server, stack | see README | Done; agents verified on live Bedrock |
| **Address boundary** | `services/settlement/src/boundary.ts` | Done. All address plaintext goes through it; re-derives R2 from the store |
| **AWS adapters** (Kiro tasks 7–9) | `services/settlement/src/aws/` (`@stoop/settlement/aws`) | Done, unit-tested with `aws-sdk-client-mock` |
| **CDK StoopStack** (task 10) | `infra/` | `cdk synth` clean; **not deployed** (activation) |
| Ring Playground run (Oct 18) | `/ring/snapshot/:deviceId`, `/ring/bind`, Ops buttons | Token auth + device listing work (one device listed; the user owns no Ring hardware). Image download returns 416 MEDIA_NOT_FOUND, now handled as "no recording" → camera unavailable → dual-confirm path. **Live view NOT verified.** Real media needs a physical Ring device; the demo uses the built-in signed simulator + labelled footage |
| MCP Tasks UI | alexa-sim Developer view → "Watch my sale as a task" | Done, checked in Chrome |
| Architecture diagram | `docs/architecture.svg` + `.png` | Done (solid = running, dashed = AWS pending) |
| Devpost draft | `docs/SUBMISSION.md` | Drafted; TODOs listed at the top |
| OSS: Ring starter media helpers | `oss/ring-api-helloworld` | **PR open:** AmazonAppDev/ring-api-helloworld#36 (issue #35) |
| OSS: `proof-of-handoff` (renamed from `@stoop/…`) | `packages/proof-of-handoff` | Publish-ready (tarball tested in a clean dir); **the user publishes** |
| Fire TV Garage Mode | `apps/firetv` | Web target works; Android TV emulator deferred (user decides later) |
| AgentCore Runtime / Memory, hosting | – | Waiting for activation; see §6 |

## 6. Work queue

### P0: no user input needed
1. ~~Red-team numbers into the docs~~ **Done** (README, AWS_BUILDER, SUBMISSION, DEMO_SCRIPT). Running `pnpm eval:redteam` offline overwrites `evals/REPORT.md`; restore the Bedrock version from git afterwards.
2. ~~AWS_BUILDER statuses~~ **Done.**
3. ~~DEMO_SCRIPT~~ **Done.**
4. ~~Wire the stack to AWS~~ **Done:** `STOOP_AWS_OUTPUTS=infra/outputs.json pnpm stack` runs Settlement on DynamoDB, KMS, the Vault Lambda and Step Functions → SQS (`awsSettlementDeps` in `services/settlement/src/aws/wiring.ts`); Ops shows a "settlement: AWS" chip. Unit-tested; first real run happens after the deploy.

### P1: blocked on the user (ask; never work around it)
- **AWS activation.** The user checks the console/billing for a pending verification step or contacts AWS Support. Then: `pnpm --filter @stoop/infra exec cdk bootstrap aws://428516841578/us-east-1 --profile stoop`, `pnpm --filter @stoop/infra deploy`, an integration run against real AWS, and the video shot: `aws kms decrypt` on an address as root → AccessDenied.
- **Hosting in us-east-1** (EC2 + CloudFront, or AgentCore for the agents) once EC2 activates. Then the Negotiator on AgentCore Runtime with tools calling Settlement over HTTP, AgentCore Observability screenshots, and a judge URL in the README.
- **npm:** the user runs `npm login`, then `pnpm --filter proof-of-handoff publish --no-git-checks` (the `prepack` builds `dist/`). Afterwards add the npm link to README and SUBMISSION.
- **Ring:** the user gets a Playground token (30-minute lifetime). Procedure: restart the stack with `FRAME_SOURCE=ring`; the user pastes the token in Ops (localhost:5183) → Connect → **Snapshot** (real 303 flow) → **Use for pickups** → **Live view** (WHEP). Log what breaks in the friction log.
- **Assets:** porch footage (~15 before/after pairs + 3 handoff clips → `fixtures/footage/`), real item photos, the real story (or approval of a labelled persona), a narrator.
- **Fire TV emulator** (1.5 GB on C:): the user decides "depending on the updates".

### P2: submission (Wed–Fri)
- Resolve the TODOs in `docs/SUBMISSION.md`; video ≤ 3:00 (public YouTube, captions, no third-party logos or music, simulations labelled); thumbnails.
- Final pass on `FRICTION_LOG.md` (18 entries) and `PRODUCT_FEEDBACK.md`.
- Fresh-clone check: `git clone … && corepack enable && pnpm install && pnpm demo` on Windows in under 10 minutes.

**Cut order if time slips:** Fire TV → AgentCore Memory (keep the local twin) → live eBay comps → evidence MP4 clips (frames only) → Ops polish.

## 7. Verification commands

```powershell
Set-Location E:\Winter\stoop
$job = Start-Job -ScriptBlock { Set-Location E:\Winter\stoop; pnpm typecheck 2>&1 | Select-String 'error TS' | Out-String; pnpm test 2>&1 | Select-String 'Tests |FAIL|×' | Out-String }
if (Wait-Job $job -Timeout 500) { Receive-Job $job } else { Stop-Job $job; 'TIMED OUT' }; Remove-Job $job -Force
pnpm eval:redteam; pnpm eval:poh          # offline evals -> evals/REPORT.md, evals/POH_REPORT.md
pnpm ring-sim replay                      # against a running stack: 200, duplicate, 401, 401
pnpm qa                                   # browser QA of every surface (needs pnpm demo running)
```

## 8. Open questions for the user

1. AWS: can you see why activation is pending (billing or verification step in the console)? Otherwise, open an AWS Support case.
2. npm: please run `npm login`, then `pnpm --filter proof-of-handoff publish --no-git-checks`.
3. Ring: when you have a Playground token, say so; the run takes about 10 minutes of the token's 30.
4. When will the footage, photos, story and narrator arrive?
5. Fire TV emulator: yes or no (deferred by the user on Oct 17).
