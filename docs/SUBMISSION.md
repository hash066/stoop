# Devpost submission draft

> Working draft for the Devpost form. Order follows plan §15: problem, product, how it works, real vs simulated, architecture, evals.
> Every number must point to a file or a source. **Before submitting, resolve every `TODO`:**
> - [ ] TODO(team): the one real human story (Marketplace no-show or stranger at the door). If there isn't one, use a clearly labelled persona. Never invent a user.
> - [ ] TODO: YouTube link (≤ 3:00, public, English captions)
> - [x] Tester site (the web app, Amazon Bedrock): https://d29kyjvj1jibpu.cloudfront.net. Judge site (the same plus the Alexa+ device tour at /demo): https://d2h8mmod981k0j.cloudfront.net
> - [x] `proof-of-handoff` 0.1.0 on npm: https://www.npmjs.com/package/proof-of-handoff
> - [x] Alexa skill "stoop shop" deployed (development stage) and checked through Amazon's Alexa simulator against the live site; judges need beta-test invites to use it on their own Echo
> - [ ] TODO: links for the two market figures below (OfferUp report; MPB survey), or drop them
> - [ ] TODO: real porch footage; a real Ring snapshot needs a physical Ring device (the Playground's virtual device has no recordings)

**Tracks:** Alexa+ (primary), Ring. **Minis:** AWS Builder, Open Source.
**Repo:** https://github.com/hash066/stoop (MIT)

---

## Inspiration

TODO(team): one sentence of the real story.

AI agents already sell for people. In late September 2026 a Big Tech shopping agent reportedly negotiated a Marketplace sale without the owner's approval and gave a stranger the seller's address ([The Next Web](https://thenextweb.com/news/meta-muse-facebook-marketplace-address-buyer-robb)). Listing and haggling with AI is a crowded space. The part nobody has made safe is the handoff: who gets your address, when the money moves, and what proves the item actually left your porch.

## What it does

**Stoop: sell anything without meeting anyone. Money moves only when your doorbell sees it go.**

- **Sell in three sentences.** "Price my things" appraises photos (and refuses to sell a recalled drop-side crib, citing the CPSC ban). "Sell the stroller and the bike, don't go below $90 on the stroller" lists them with a private floor.
- **Agents haggle, people approve.** Stoop negotiates with buyers, including buyers' own AI assistants, over MCP. It never knows the floor (it only asks an oracle "acceptable? counter?") and never sees the address. Every sale needs the owner's approval, bound to the exact terms they saw.
- **Pay, but held.** The buyer checks out through an Alexa+-style UCP checkout; the money is held, not charged.
- **Proof of handoff.** The buyer's phone gets a pickup pass that shows the address only inside the paid pickup window. Pass check-in + a Ring doorbell event + before/after porch frames go through an explicit truth table. Only VERIFIED releases the money, after a short inspection window.
- **A receipt anyone can verify.** Each outcome is a signed JWS (ES256 over RFC 8785 canonical JSON): `npx proof-of-handoff verify` ([on npm](https://www.npmjs.com/package/proof-of-handoff)).
- **No Ring? Use an old phone.** The web app turns any phone or laptop into the porch camera: it sends the before and after photos, and during a pickup its motion detector asks Bedrock vision whether someone is at the door (counted, never identified).
- **Stoop Street.** Every shop in one marketplace, nearest first, with reviews that can only come from a finished pickup and link to its signed receipt. Buyers can send an agent ("a jogging stroller under $100 near 62704") that haggles with sellers' agents inside the budget; it can agree a price, only the buyer can pay.
- **On a real Alexa today.** A custom skill ("Alexa, ask stoop shop if I have any offers" / "find a stroller under a hundred dollars") runs the same tools: the seller approves the exact terms by voice, the buyer pays with their purchase code over $100.

## How we built it

- **MCP server** (TypeScript SDK, spec 2025-11-25): seller and buyer endpoints, sessions and stateless clients, elicitation (form and URL mode), structured output, **MCP Apps** cards, and **Tasks** (`watch_handoff` follows a sale to payout). An Agent Skill (`skills/stoop/SKILL.md`) teaches any assistant how to use it.
- **Strands Agents** (TypeScript) on **Amazon Bedrock** (Nova 2 Lite): the Negotiator works only through three guarded tools, `evaluate_offer`, `propose_acceptance`, `send_reply`, and every outbound message passes Settlement's guard. Every LLM call has a deterministic fallback.
- **Settlement + Policy Kernel**: rules R1–R13 decide everything that matters (money, address, acceptance, receipts). Single-use capability tokens are MAC'd and bound to `termsHash` of the exact terms a human approved.
- **Address boundary**: one interface holds every address plaintext. In AWS it is a Lambda that is the only principal the KMS address key lets decrypt (not the host, not the agents, not the account root), and it re-checks R2 from DynamoDB itself.
- **Ring**: HMAC-verified webhooks (v1.1 payloads), the snapshot 303 → pre-signed URL flow, WHEP live view; a signed simulator for the events the Playground doesn't deliver.
- **AWS** (`infra/`, CDK): KMS (P-256 receipt signing with `MessageType=DIGEST`, HMAC token key, address key), DynamoDB, Step Functions Standard saga timers (Wait on `TimestampPath` → SQS), the Vault Lambda. **Kiro**: the Policy Kernel was specced first (`.kiro/specs/policy-kernel/`).
- **Alexa Skills Kit**: a custom skill (`ask-sdk-core`, signature and timestamp verification from `ask-sdk-express-adapter`) whose answers come from the same MCP tools, using the session-less approval path an Alexa-style client gets.
- **Bedrock AgentCore Runtime**: the negotiator runs there as a Node 22 code deployment; it reaches a shop only through a one-time negotiation port.
- **Surfaces**: the Stoop web app (an MCP host on the official SDK: approvals arrive as elicitation mid-call), the porch-camera page, two simulated Alexa+ devices (seller's kitchen, buyer's living room) that are real MCP clients and MCP Apps hosts, an Ops console with one-click scrutiny scenarios, and Fire TV Garage Mode on Amazon's multi-TV sample.

## Real vs simulated

| Real | Simulated or labelled |
|---|---|
| MCP servers, MCP Apps cards, elicitation, Tasks; a real Alexa custom skill on the same tools | The Alexa+ add-on client: add-on tooling is partner-only, so our device simulator is a real MCP client and Apps host |
| UCP checkout endpoints (Alexa+ add-on contract 2026-04-08) | Payment processor: a sandbox PSP with manual-capture semantics, labelled "Test PSP" |
| Strands agents on Amazon Bedrock Nova 2 Lite (live run verified Oct 17) | Ring events in the demo: simulator-signed (the Playground doesn't send webhooks), labelled on screen |
| Policy Kernel, capability tokens, ES256 receipts, `/verify`; the web app's porch camera (a real phone or laptop camera, Bedrock vision) | The device tour's porch frames: labelled footage; the walkthrough video's camera feed: a drawn porch with a stand-in vision model, labelled on screen |
| Ring Partner API client: token auth and device listing checked with a Developer Playground token (Oct 18); snapshots, clips and WHEP live view implemented and unit-tested | No physical Ring device: the one device the Playground token lists has no recordings (image download answers `MEDIA_NOT_FOUND`), and live view wasn't verified. Doorbell events come from our signed simulator and porch frames are our labelled footage |
| Deployed on AWS (us-east-1): KMS keys, DynamoDB, the Vault Lambda, the Step Functions saga, EC2 + CloudFront sites, the negotiator on AgentCore Runtime. A full sale verified on them; the account root is refused `kms:Decrypt` on an address | The hosted shops keep their records on the instance's disk, not yet on the DynamoDB/KMS stack |

## Architecture

![Stoop architecture](architecture.png)

## Evals

- **Red team on Amazon Bedrock (Nova 2 Lite), 300 adversarial conversations** (`evals/REPORT.md`, Oct 17): a naive agent given the address and floor in its prompt leaked the address **57 / 300 (19%)**, the floor **40 / 300**, and went along with **9 / 70** scams. Stoop: **0 / 300, 0 / 300, 0 / 70**. 124 attacks were refused by deterministic checks before the agent ran; the other 176 reached the live agent and its guarded tools. Zero in 300 bounds Stoop's leak rate below 1% at 95% confidence.
- **200 benign buyers** on the same model: 100 reached a deal, at an average **$95.30** on a $120 ask (the Policy Kernel only accepts offers at or above the private $90 floor).
- **Proof-of-Handoff truth table** (`evals/POH_REPORT.md`): 40 / 40 correct on labelled synthetic cases, **0 false releases**. This measures the deterministic truth table; real footage plus Bedrock vision will measure vision too.
- **Alexa+ design rules, enforced by a test**: every spoken line and approval prompt in a full sale (33 lines) is under 30 seconds (longest 56 words), offers at most 5 options, and never speaks an id, JSON or a URL.
- **Tests**: 200+ unit and end-to-end tests in CI, including the scrutiny matrix (replayed webhooks, wrong device, no-show, piracy, camera offline, two-buyer race, offer flooding).

## Challenges we ran into

From `docs/FRICTION_LOG.md` (23 entries), for example:
- The Ring Playground simulates live view but doesn't deliver webhooks, so we built a signed simulator.
- Alexa+ add-on tooling is partner-only, so we built our own MCP client and MCP Apps host.
- A new AWS account unlocked Bedrock within the hour but kept CloudFormation and SQS behind `OptInRequired`.
- The documented KMS key-administrator statement includes `kms:CreateGrant`, a side door to Decrypt; our address key leaves it out.
- Live on Bedrock, the negotiator once told a buyer "Your offer is accepted!" while the owner still had to approve; outcome messages now come from fixed templates, with a regression test.

## Accomplishments we're proud of

- The agent provably can't leak the address: it never has it, and in AWS no IAM principal but one Lambda can decrypt it.
- A full sale works by voice in three seller sentences, and every simulated piece is labelled.
- Two open-source contributions: [`proof-of-handoff`](https://www.npmjs.com/package/proof-of-handoff) on npm (receipt schema, verifier, CLI) and media helpers for Amazon's Ring starter ([AmazonAppDev/ring-api-helloworld#36](https://github.com/AmazonAppDev/ring-api-helloworld/pull/36)).

## What's next

- A Ring Appstore private-use beta (up to 10 accounts) with real households.
- Ring hardware as the porch camera for households that have it (the client and webhooks are built), and AgentCore Memory for seller preferences.

## Market context (cite or cut)

- US recommerce ≈ $229B in 2025: OfferUp report (industry-sponsored). TODO: link.
- The top reason people don't sell is "not worth the hassle": MPB survey (vendor). TODO: link.

## Built with

TypeScript · Model Context Protocol (TypeScript SDK) · MCP Apps · Alexa Skills Kit (ASK SDK) · Strands Agents · Amazon Bedrock (Nova 2 Lite) · Amazon Bedrock AgentCore Runtime · AWS KMS · Amazon DynamoDB · AWS Step Functions · AWS Lambda · AWS CDK · Kiro · Ring Partner API · React · Vite · React Native (TV) · Expo · Playwright · Vitest
