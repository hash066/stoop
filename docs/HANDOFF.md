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
- **AWS is active since Oct 19** (support cleared the account sign-up). `aws login` sessions expire overnight: re-run `aws login --profile stoop` (the user approves in the browser). Check services by exit code, not `| head -1`: CLI errors start with a blank line.
- Budget: `stoop-hackathon-25usd` ($25/month, credits excluded, emails at 80% and 100% actual and 100% forecast). The account has $100 of credits.
- Docker 29.4 is installed (x86_64 daemon; use `docker buildx --platform linux/arm64` for AgentCore images).

**MCP SDK:**
- The SDK is `@modelcontextprotocol/sdk` **1.32.1**, the v1 line. Don't switch to the v2 split packages: the hackathon requires spec 2025-11-25.
- Experimental Tasks: `registerToolTask` needs a raw zod shape for `inputSchema`; `taskSupport: "optional"` makes a plain call block until the task ends, so use `"required"`; task stores are per actor (`services/mcp-server/src/http.ts`).
- The MCP server returns **405 on GET** (no standalone SSE stream: browsers allow 6 connections per host). Server notifications outside a request are dropped, so clients poll; the alexa-sim Tasks panel polls `tasks/get`.

**Runtime modes:**
- `LLM_MODE` unset = offline (ScriptedModel + templates); `LLM_MODE=bedrock` = live Bedrock (Nova 2 Lite).
- Demo tokens: seller `seller-demo-okafor`; buyers `buyer-demo-dana` (purchase code 4821) and `buyer-demo-lee`. Local demo values in `services/stack/src/compose.ts` (`DEMO`), not real credentials.

## 5. Current state (verified Oct 19; newest first)

- **Oct 20–21 (committed, NOT deployed yet; the AWS sign-in expired):** selling by voice on Alexa from start to finish (estimate → price → lowest price → shop from the Alexa address with permission → "it's out" takes the listing photo), one-time camera pairing codes (10 minutes, single use), lockbox codes (encrypted like the address, released through the boundary only to the bound pass after "I'm here"), and a passkey lock on the pickup pass (`services/stack/src/passkeys.ts`; RP ID = the request's host). The Alexa voice model is already on Amazon, so **the new voice phrases fail until the server is deployed.** 238 tests pass. To deploy: the user runs `aws login --profile stoop`, then the SSM update (`docs/DEPLOY.md`; the full parameter file with every env var is `C:/Users/asus/.claude/jobs/158ff822/tmp/ssm-update.json`), then the live e2e and the voice-sell run in Amazon's Alexa simulator.
- **Submission (Oct 21):** market figure sourced (OfferUp 2025 Recommerce Report); MPB line dropped. Still waiting on the user: the real story, the video, real testers, and beta-test invites for judges.

- **Judge audit (Oct 19, late):** fresh clone installs in 37 s and passes typecheck and all tests; the live e2e ends CLOSED; Amazon's Alexa simulator runs the seller conversation on the live site; the official MCP Inspector connects to the live server (protocol 2025-11-25, sessions, tasks, 6 `ui://` cards). Fixed from it: the judge-site device tour failed at step 3 (Nova answered "$95?" with a question; friction #24); `pnpm tour` now opens `/demo`; Bedrock was asked for "brand model" titles and invented one, and the offline catalog used real brands, so titles are generic now (no third-party trademarks in the demo or video); both MCP servers send `instructions`; README claims match the live product. Known and by design: the browser console shows a 405 for the MCP SDK's optional GET stream and a 403 when a pass is opened on a phone it isn't bound to yet.
- **After deploying `f6b25de`:** the judge-site device tour passes all 7 steps (60 s, receipt VALID); the live e2e ends CLOSED; Bedrock now names the placeholder "Green three-wheel jogging stroller" (no invented brand); `npx proof-of-handoff verify` (from npm) says VALID for a live receipt and `bad_signature` once its verdict is edited; the AgentCore runtime was redeployed with the same ARN. My test shops (Ana, Bo, Judge) were closed, so Stoop Street starts empty for real testers. Receipts on the hosted sites are signed with the server's own P-256 key (`kid` `stoop-local-1`), not KMS; only camera-verified pickups get one (both-confirm sales close without a receipt).
- **Admin:** `GET /api/admin/shops?key=…` lists shops (names, live listings); `DELETE /api/admin/shops/<id>?key=…` closes a test shop for good so it leaves Stoop Street. The key is in Secrets Manager (`docs/DEPLOY.md`).
- **Real testers: none yet** (both sites' feedback holds only automated tour checks). This is the biggest gap for Potential Impact.
- **Stoop Street** (`/street`, `/me`): every shop in one market, receipt-bound reviews, buyer agents that haggle within a budget (`services/stack/src/street.ts`), Post Everywhere, link previews.
- **Shops persist** under `/opt/stoop-data-<site>/worlds` and come back after a redeploy (checked on the live site). Deploys stop containers gracefully; expect about 20 s of 504s while they start.
- **Alexa skill** "stoop shop": deployed to the user's developer account (`alexa/`, skill `amzn1.ask.skill.ab1fff90-...`, development stage). Checked through Amazon's Alexa simulator against the live site: link by code, offers, two yeses; find, offer, buy, purchase code. Redeploy the package with `ask deploy` from `alexa/` (profile in `C:\Users\asus\.ask\cli_config`).
- **AgentCore Runtime**: `StoopAgentStack` (`infra/lib/agent-stack.ts`), runtime `stoop_negotiator-e2dr9EHj7e`; both sites set `NEGOTIATOR_RUNTIME_ARN`. Rebuild with `pnpm --filter @stoop/negotiator-runtime build`, then `cdk deploy StoopAgentStack` (env `STOOP_HOST_ROLE_NAME`).
- Not done: AgentCore Memory and GenAI traces; hosted shops on DynamoDB/KMS (they use the instance disk); Alexa beta-test invites for judges.

- **The tester product is the web app** (`apps/web`, served at the site root): real shops (seller's own address, encrypted), photos priced by Bedrock (AI estimates labelled), a private lowest price, share links, a buyer on another device who messages the seller's assistant, pays (held, never charged), opens a phone-bound pickup pass and taps I'm Here, and a **phone or laptop as the porch camera** (before/after photos, person counts from Bedrock vision). The Alexa+ device tour is at `/demo`, linked only on the judge site.
- Verified: `pnpm --filter @stoop/stack e2e` (three Chrome profiles: seller 1440 px, buyer phone, camera phone) ends CLOSED locally; with `-- --target https://d29kyjvj1jibpu.cloudfront.net` it ends CLOSED on the live site with real Bedrock (both-confirm path, because Chrome's fake camera shows no item).
- **Shops live in memory: a redeploy closes every open shop.** Batch fixes; don't deploy while testers are mid-sale.

- **Public repo:** https://github.com/hash066/stoop (MIT). CI (`.github/workflows/ci.yml`) is green on every push: typecheck, all tests, offline evals, the OSS helper tests.
- `pnpm typecheck` is clean and the suite is **211 tests**: receipts 6, policy 86, ring-bridge 9, settlement + UCP + AWS adapters 52, verifier 6, ring-sim 3, agents 24, MCP end-to-end + hosted mode + design rules 25.
- **Live Bedrock golden path verified:** appraise → list → haggle (incl. an injection attempt) → $95 → hold → doorbell → VERIFIED → receipt VALID, 18.6 s from India (each negotiator turn ~3.5 s for about two model calls; Bedrock itself answers in ~0.7 s per call, the rest is the network from India). Found and fixed: SVG placeholders sent to Bedrock broke the appraisal.
- **Red team on live Bedrock** (`evals/REPORT.md`, 300 attacks, Nova 2 Lite): naive agent leaked the address 57/300 (19%), floor 40/300, scams 9/70; Stoop 0/300, 0/300, 0/70 (124 refused before the agent ran, 176 reached it). Benign: 100/200 deals, avg $95.30. The run took 101 minutes.

| Area | Path | Status |
|---|---|---|
| Policy Kernel, receipts, Settlement, UCP, Ring bridge, ring-sim, verifier, agents, MCP server, stack | see README | Done; agents verified on live Bedrock |
| **Address boundary** | `services/settlement/src/boundary.ts` | Done. All address plaintext goes through it; re-derives R2 from the store |
| **AWS adapters** (Kiro tasks 7–9) | `services/settlement/src/aws/` (`@stoop/settlement/aws`) | Done, unit-tested with `aws-sdk-client-mock` |
| **CDK StoopStack** (task 10) | `infra/` | **Deployed Oct 19** (`infra/outputs.json`, gitignored). Verified: full sale on DynamoDB/KMS/Vault Lambda/SFN→SQS; root `kms:Decrypt` → AccessDenied; Lambda reveals the address only to the bound device |
| Ring Playground run (Oct 18) | `/ring/snapshot/:deviceId`, `/ring/bind`, Ops buttons | Token auth + device listing work (one device listed; the user owns no Ring hardware). Image download returns 416 MEDIA_NOT_FOUND, now handled as "no recording" → camera unavailable → dual-confirm path. **Live view NOT verified.** Real media needs a physical Ring device; the demo uses the built-in signed simulator + labelled footage |
| MCP Tasks UI | alexa-sim Developer view → "Watch my sale as a task" | Done, checked in Chrome |
| Architecture diagram | `docs/architecture.svg` + `.png` | Done (solid = running, dashed = AWS pending) |
| Devpost draft | `docs/SUBMISSION.md` | Drafted; TODOs listed at the top |
| **Hosted mode** (Oct 18) | `services/stack/src/{sandboxes,site,serve}.ts`, `Dockerfile` | Landing + guided tour + private sandbox per visitor + feedback survey. `pnpm tour` passes in 44 s (also from a fresh clone with the image's exact commands). Not online yet: see `docs/DEPLOY.md` |
| Alexa+ design rules test | `services/stack/test/design-rules.test.ts` | 33 spoken lines: ≤75 words (longest 56), ≤5 options, no ids/JSON/URLs |
| **Web app** (Oct 19) | `apps/web`, `services/stack/src/{web,porchcam,sandboxes}.ts`, `services/stack/e2e/real-flow.ts` | Live on both sites. Server tests: `e2e.real.test.ts`, `sandboxes.test.ts` |
| AWS host stack | `infra/lib/host-stack.ts` (`StoopHostStack`) | **Deployed Oct 19.** Tester site https://d29kyjvj1jibpu.cloudfront.net (Bedrock, 1500 calls/day, 80 shops), judge site https://d2h8mmod981k0j.cloudfront.net (Bedrock, 1000 calls/day, 40 shops, `/demo` linked). Instance i-0aa13f2eaf63c246d; update with SSM (`docs/DEPLOY.md`). $30 budget `stoop-cap-30usd` with stop-instance + deny-Bedrock actions armed |
| OSS: Ring starter media helpers | `oss/ring-api-helloworld` | **PR open:** AmazonAppDev/ring-api-helloworld#36 (issue #35) |
| OSS: `proof-of-handoff` (renamed from `@stoop/…`) | `packages/proof-of-handoff` | **Published Oct 19: 0.1.0 on npm** (https://www.npmjs.com/package/proof-of-handoff), the `pnpm pack` tarball (same shasum). Installed from the registry in a clean folder: `npx proof-of-handoff verify` gives VALID on a signed receipt and `bad_signature` on a forged one; types compile under strict NodeNext |
| Fire TV Garage Mode | `apps/firetv` | Web target works; Android TV emulator deferred (user decides later) |
| AgentCore Runtime / Memory | – | Not done: agents run in the host containers. Optional if time allows |

## 6. Work queue

### P0: no user input needed
1. ~~Red-team numbers into the docs~~ **Done** (README, AWS_BUILDER, SUBMISSION, DEMO_SCRIPT). Running `pnpm eval:redteam` offline overwrites `evals/REPORT.md`; restore the Bedrock version from git afterwards.
2. ~~AWS_BUILDER statuses~~ **Done.**
3. ~~DEMO_SCRIPT~~ **Done.**
4. ~~Wire the stack to AWS~~ **Done:** `STOOP_AWS_OUTPUTS=infra/outputs.json pnpm stack` runs Settlement on DynamoDB, KMS, the Vault Lambda and Step Functions → SQS (`awsSettlementDeps` in `services/settlement/src/aws/wiring.ts`); Ops shows a "settlement: AWS" chip. Unit-tested; first real run happens after the deploy.

### P1: blocked on the user (ask; never work around it)
- **Testers:** the user does one real two-phone run on the tester site, then sends `docs/TESTERS.md`'s message (pairs: a seller plus a friend as buyer).
- **Photos for the landing page** (taste rules want real imagery): 4 of the user's own photos (an item on a porch or stoop, a close-up of an item, someone picking something up, an old phone propped at a window).
- ~~AWS activation~~ **Done Oct 19**: both stacks deployed and verified (see §5).
- **Hosting in us-east-1** (EC2 + CloudFront, or AgentCore for the agents) once EC2 activates. Then the Negotiator on AgentCore Runtime with tools calling Settlement over HTTP, AgentCore Observability screenshots, and a judge URL in the README.
- ~~npm~~ **Done Oct 19** (0.1.0 live). For a later version: the user is logged in (`hashherrr`, 2FA on). Bump the version, then publish only with pnpm or a pnpm-made tarball: `publishConfig` swaps `bin`/`exports` to `dist/` and plain `npm publish` ignores it (a `prepublishOnly` guard refuses it; friction #23). The user runs, in their own terminal, `pnpm pack` in the package, then `npm publish proof-of-handoff-<v>.tgz --access public` and types the authenticator code when asked. Afterwards add the npm link to README and SUBMISSION.
- **Ring:** the user gets a Playground token (30-minute lifetime). Procedure: restart the stack with `FRAME_SOURCE=ring`; the user pastes the token in Ops (localhost:5183) → Connect → **Snapshot** (real 303 flow) → **Use for pickups** → **Live view** (WHEP). Log what breaks in the friction log.
- **Assets:** porch footage (~15 before/after pairs + 3 handoff clips → `fixtures/footage/`), real item photos, the real story (or approval of a labelled persona), a narrator.
- **Fire TV emulator** (1.5 GB on C:): the user decides "depending on the updates".

### P2: submission (Wed–Fri)
- Resolve the TODOs in `docs/SUBMISSION.md`; video ≤ 3:00 (public YouTube, captions, no third-party logos or music, simulations labelled); thumbnails.
- Final pass on `FRICTION_LOG.md` (24 entries) and `PRODUCT_FEEDBACK.md`.
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
2. ~~npm~~ Done: `proof-of-handoff` 0.1.0 is on npm.
3. Ring: when you have a Playground token, say so; the run takes about 10 minutes of the token's 30.
4. When will the footage, photos, story and narrator arrive?
5. Fire TV emulator: yes or no (deferred by the user on Oct 17).
