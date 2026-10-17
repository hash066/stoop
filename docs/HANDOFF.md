# Stoop: handoff for the next build agent

> Written Sat Oct 17 2026. **Deadline: Fri Oct 23 2026, 12:00 PM PT (Sat Oct 24, 00:30 IST).** Target submit time: Fri 09:00 PT, which leaves a 3-hour buffer. Feature freeze: **Tue Oct 20, 18:00 IST**.
>
> Repo: `E:\Winter\stoop` (git, branch `main`, local only and not pushed). Last commit: `ab3cf8a`.

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
  - creating the public GitHub repo (`hash066/stoop`)
  - forking or opening the PR to `AmazonAppDev/ring-api-helloworld`
  - publishing `proof-of-handoff` to npm
  - posting anything publicly
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
- **Bash heredocs that contain an apostrophe (`'`) fail to parse.** Write multi-line edits as a Python script in the scratchpad and run it with `python <path>`, or use the Edit/Write tools.
- Commit messages: write them to a file, then `git commit -F <file>`.

**Packages:**
- pnpm is **11.0.8** (`packageManager`). `pnpm-workspace.yaml` has `allowBuilds: esbuild: true`.
- `apps/firetv` is **excluded** from pnpm. It is a separate **Yarn 4.5** workspace: run `corepack yarn …`. A plain `yarn` on PATH is 1.22, so don't use it.

**Preview servers** (desktop app):
- Configs live at `E:\Winter\.claude\launch.json` (the session root): `stoop-stack` (8787), `stoop-alexa-sim` (5180), `stoop-pass` (5182), `stoop-ops` (5183).
- Start them with `preview_start` by name. **Restart `stoop-stack` after server code changes.**
- Run `pnpm cards` after editing `packages/ui-cards`.

**Tests:** run them inside a PowerShell `Start-Job` with a timeout (see §6). The full suite takes about 1–2 minutes.

**Browser limits:**
- The MCP server returns **405 on GET**, so there is no standalone SSE stream. Browsers allow only 6 connections per host, and the default GET stream stalled `initialize`.
- Server notifications sent outside a request are therefore dropped. Clients poll (this applies to Tasks).

**MCP SDK:**
- The SDK is `@modelcontextprotocol/sdk` **1.32.1**, the v1 line. Don't switch to the v2 split packages: the hackathon requires spec 2025-11-25.
- Experimental Tasks:
  - `registerToolTask` needs a raw zod shape for `inputSchema`. `z.object` types the arguments as `unknown`.
  - `taskSupport: "optional"` makes a plain call block until the task ends, so use `"required"`.
  - Task stores are per actor (`services/mcp-server/src/http.ts`).

**Local runtime:**
- `LLM_MODE` unset = offline (ScriptedModel + templates); `LLM_MODE=bedrock` = live Bedrock.
- Demo tokens: seller `seller-demo-okafor`; buyers `buyer-demo-dana` (purchase code 4821) and `buyer-demo-lee`. These are local demo values in `services/stack/src/compose.ts` (`DEMO`), not real credentials.

## 5. Current state (verified Oct 17, commit `ab3cf8a`)

`pnpm typecheck` is clean and `pnpm test` gives **183 passed**:

| Suite | Tests |
|---|---|
| receipts | 6 |
| policy | 86 |
| ring-bridge | 8 |
| settlement + UCP | 38 |
| verifier | 4 |
| ring-sim | 3 |
| agents | 21 |
| MCP end-to-end (golden, scrutiny, Tasks, my_items) | 17 |

**Evals (offline):**
- Red team: Stoop leaked the address in 0/300 attacks and the floor in 0/300, and accepted 0/70 scams.
- 200 benign buyers: 100 deals, average $95.30.
- PoH confusion matrix: 40/40 correct, 0 false releases.

**Status by module:**

| Area | Path | Status |
|---|---|---|
| Policy Kernel (R1–R13, saga, PoH truth table with presence grace, tokens, oracle, guards) | `packages/policy` | Done |
| Receipts (JCS + JWS ES256, DER→raw, `poh verify` CLI), the OSS package | `packages/proof-of-handoff` | Done; npm publish needs the user's OK |
| Settlement (listings, approvals, negotiation, offer rate limit X2, deals, escrow, pass, evidence, capture/void, jobs) + UCP 2026-04-08 router | `services/settlement` | Done (in-memory twins) |
| Ring bridge (HMAC webhook, v1.1 normalize, dedupe, Partner API client, frame sources) | `services/ring-bridge` | Done; real Playground calls need a token |
| Simulator CLI (`pnpm ring-sim event button / replay / scenario golden`) | `tools/ring-sim` | Done |
| Verifier (label vision offline, Bedrock vision adapter) | `services/verifier` | Done offline |
| Agents (Strands Negotiator with guarded tools, Appraiser, BuyerBot, planner) | `services/agents` | Done offline |
| MCP server (seller + buyer, sessions + stateless, form/URL elicitation, approval fallback, MCP Apps cards, Tasks `watch_handoff`, `my_items`) | `services/mcp-server` | Done |
| Local composition (routes, Marshal, SSE, pass API, `/verify`, `/sim/*`, planner) | `services/stack` | Done |
| 6 MCP Apps cards (single-file HTML) | `packages/ui-cards` | Done |
| Alexa+ simulator (seller/buyer), pickup pass, Ops console | `apps/alexa-sim`, `apps/pass`, `apps/ops` | Done; verified live in the browser pane |
| Red team + PoH evals | `evals/` | Done offline; the naive baseline needs `LLM_MODE=bedrock` |
| Ring starter media-helpers contribution (Python + TS route + tests + `PR_DESCRIPTION.md`) | `oss/ring-api-helloworld` | Ready; PR needs the user's OK |
| Kiro spec + CI workflow | `.kiro/`, `.github/workflows/ci.yml` | Written; CI hasn't run (no remote) |
| **Fire TV Garage Mode** | `apps/firetv` | Installed (Yarn 4, hoisted to root); `corepack yarn typecheck` clean; `expo export -p web` bundles (901 modules); stack serves its MCP calls. Interactive drive/screenshot + Android emulator still pending (see §8 Q1) |
| AWS (CDK stack, KMS/DynamoDB/Step Functions adapters, AgentCore deploy) | `infra/` (doesn't exist yet) | **Not started; blocked on the user's AWS sign-in** |

**Run it locally:**
```
pnpm i
pnpm demo
```
- Seller sim: http://localhost:5180/?role=seller
- Buyer sim: http://localhost:5180/?role=buyer
- Pass: http://localhost:5182
- Ops: http://localhost:5183
- `docs/DEMO_SCRIPT.md` has the 3-minute flow.

## 6. Work queue (do in order; each item has a definition of done)

### P0: no user input needed

**1. Finish Fire TV Garage Mode** (`apps/firetv`, Amazon's `react-native-multi-tv-app-sample`, MIT-0)

What's written:
- `packages/shared-ui/src/stoop/api.ts`: a stateless MCP JSON-RPC client. Defaults are `10.0.2.2:8787` on Android and `localhost:8787` on web. Overridable with `EXPO_PUBLIC_STOOP_URL` and `EXPO_PUBLIC_STOOP_SELLER_TOKEN`.
- `screens/GarageScreen.tsx`:
  - Item grid driven by the D-pad; select toggles an item.
  - "List selected" calls `list_items`, gets `approval_required`, shows an on-screen confirm modal, then sends `confirm_action`.
  - The footer shows the line from `handoff_status`, polled every 4 s.
  - "Use demo photos" calls `/sweep/demo` and then `appraise_photos`.
- Drawer reduced to Garage + Settings; Stoop palette in `theme/colors.ts`.
- The stack allows the origin `http://localhost:8082`.

Steps:
1. `cd apps/firetv`, then `corepack yarn install`. This creates `node_modules` on E:, which is fine.
2. `corepack yarn typecheck`, and fix the errors. Likely spots:
   - `DrawerNavigator.tsx` after the route removal.
   - Unused movie screens that reference old routes. Delete Home/Explore/TV/Details/Player screens and their exports if they get in the way.
3. Run it on the web target with the stack running: `corepack yarn dev:web` serves port 8082. Open it in the browser pane, then:
   - Drive it with the arrow keys and Enter.
   - Check the focus ring, the demo-photo flow, the confirm modal, the listing, and the live-sale line.
   - Check for console errors.
4. Set `app.json` name/slug/package to "Stoop Garage" / `com.stoop.garage`.
5. Optionally replace the sample's banner icons with a plain Stoop wordmark PNG.
6. Add `apps/firetv/README.md`: attribution to the sample (MIT-0), how to run, and that it is an MCP client.
7. **Android TV emulator: ask the user first.** No TV system image is installed. Installing one (for example `system-images;android-34;android-tv;x86`) is about 1.5 GB into the SDK on C:, which has about 11 GB free. The first Gradle build adds about 2 GB; set `GRADLE_USER_HOME=E:\gradle`.
   - With a yes: create an AVD with `ANDROID_AVD_HOME` on E:, run `corepack yarn dev:android`, and screenshot the result.
8. Done when: it typechecks, the web target works end to end against the local stack, docs are updated, and it's committed.

**2. Test `my_items`**
- It's a new read-only seller tool in `services/mcp-server/src/seller.ts`, with no test yet.
- Add an e2e case in `services/stack/test/`:
  - Empty household: spoken "Nothing appraised yet".
  - After the sweep + `appraise_photos`: items with prices and the blocked crib.
  - After `list_items`: `listingState: "LIVE"`.
- Also call it statelessly.

**3. Docs sync**
- `docs/AWS_BUILDER.md`: the Kiro row says "planned", but the spec now exists. Mark the spec as written and say what was spec-first.
- `README.md`: test count, plus a Fire TV section.
- `docs/ARCHITECTURE.md`: `my_items`, `apps/firetv`.
- `skills/stoop/SKILL.md`: `my_items` ("what am I selling?").
- `docs/FRICTION_LOG.md`: add a row whenever the RN/Expo/Yarn setup fights you. These are worth bonus points.

**4. UI QA pass** (the judged surfaces)
- Use the browser pane at 1280×800 and at 390 px width for:
  - alexa-sim (seller and buyer)
  - pass
  - ops
- Run through `docs/DEMO_SCRIPT.md` once on each.
- Capture console errors; fix layout breaks, focus order, and contrast.
- Check the design bar from §3 and the plan's §8 Alexa+ add-on design rules:
  - glanceable cards
  - ≤ 5 voice options
  - no JSON or ids shown to customers outside the Developer view

**5. Recording tool for the video** (`tools/record-demo`)
- A Playwright `recordVideo` script that drives the golden path across the seller sim, buyer sim, pass and ops at 1280×800, and saves the clips.
- The reference pattern is `E:\Winter\bharat\submission\record-scrapform.mjs`.
- Playwright's Chromium download is about 150 MB on C:. Mention it to the user before installing.

**6. Optional, if time:** show `watch_handoff` task progress in the alexa-sim Developer view.
- The sim's MCP client sends `tools/call` with `params.task`, then polls `tasks/get`.
- This makes the Tasks feature visible in the video.

### P1: blocked on the user (ask; never work around it)

**AWS** (the user excluded it until they sign in):
1. The user runs `aws login`.
2. Then `aws sts get-caller-identity` and a Converse ping on `us.amazon.nova-2-lite-v1:0` in us-east-1.
3. File the Service Quotas increase.
4. Then build:
   - `infra/` CDK `StoopStack`: KMS sign/MAC/vault keys, DynamoDB single table, a Settlement Lambda with the **only** vault-decrypt grant, API Gateway, a Step Functions Standard saga (Wait + `TimestampPath`).
   - The KMS `MacProvider`, `Signer` (`MessageType=DIGEST` + `derToRawP256`), DynamoDB `Store`/`SpentTokenStore` (Kiro tasks 7–10), and the AgentCore Runtime deploy for the Strands agents.
5. Then:
   - `LLM_MODE=bedrock pnpm eval:redteam` for the naive baseline. This produces the headline "naive agent leaked X%" stat.
   - Update `docs/AWS_BUILDER.md` statuses.

**Ring:** the user pastes a Playground token (`RING_ACCESS_TOKEN`). Then:
- Run with `FRAME_SOURCE=ring`.
- Get one real snapshot via the 303 flow, plus a WHEP live tile in Ops.
- Add friction-log entries for anything that doesn't work.

**GitHub:**
- The public repo `hash066/stoop` needs permission. Then CI runs.
- Add the repo URL and the "Try it in 60 seconds" instructions to the README.

**OSS PR** to `AmazonAppDev/ring-api-helloworld`:
- Needs permission to fork and open.
- The PR body is in `oss/ring-api-helloworld/PR_DESCRIPTION.md`. It references the existing PRs #31 and #32.

**npm:** publishing `proof-of-handoff` needs permission.

**Assets from the team:**
- Real porch footage: about 15 before/after pairs plus 3 handoff clips. They go in `fixtures/footage/`; see `fixtures/README.md`.
- Real item photos.
- One real human story (a Marketplace no-show or stranger-at-the-door). Never invent one; use a labelled persona if none exists.

### P2: submission (Wed–Fri)

- Devpost text, in this order: problem, product, how it works, real vs simulated, architecture, evals.
- Video ≤ 3:00 per plan §3: public YouTube, English captions, no third-party logos or music, simulations labelled.
- Thumbnails, and an architecture diagram export.
- Final pass on `FRICTION_LOG.md` and `PRODUCT_FEEDBACK.md`. Every tool used needs an entry: MCP SDK, MCP Apps, Ring, Strands, AgentCore, Bedrock, Kiro, and RN TV if shipped.
- Fresh-clone check: `pnpm i && pnpm demo` works from the README in under 10 minutes on Windows.

**Cut order if time slips:** Fire TV → Tasks UI polish → AgentCore Memory (keep the local twin) → live eBay comps → evidence MP4 clips (frames only) → Ops polish.

## 7. Verification commands

```powershell
Set-Location E:\Winter\stoop
$job = Start-Job -ScriptBlock { Set-Location E:\Winter\stoop; pnpm typecheck 2>&1 | Select-String 'error TS' | Out-String; pnpm test 2>&1 | Select-String 'Tests |FAIL|×' | Out-String }
if (Wait-Job $job -Timeout 500) { Receive-Job $job } else { Stop-Job $job; 'TIMED OUT' }; Remove-Job $job -Force
pnpm eval:redteam; pnpm eval:poh          # offline evals -> evals/REPORT.md, evals/POH_REPORT.md
pnpm ring-sim replay                      # against a running stack: 200, duplicate, 401, 401
```

## 8. Open questions for the user (ask, don't assume)

1. OK to download the Android TV system image (about 1.5 GB on C:) and build for the emulator?
2. When will you run `aws login` for the AWS phase? Is Bedrock model access enabled on the account?
3. OK to create the public GitHub repo `hash066/stoop` now?
4. OK to fork `ring-api-helloworld` and open the media-helpers PR, and to publish `proof-of-handoff` to npm?
5. Do you have a Ring Developer account and a Playground token?
6. When will the footage, photos and the real story arrive?
