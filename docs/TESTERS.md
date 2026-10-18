# Getting testers (targeted, before Friday)

**Goal:** 15–30 people who actually sell secondhand try the tour and answer the 4-question survey at the end. Their numbers and comments go into the Devpost "Potential Impact" section, quoted only as they wrote them (`node tools/feedback-summary.mjs`), never paraphrased into something stronger.

## Who to ask, in order
1. People you know who sell on Marketplace, OLX, Craigslist, Vinted, Buy Nothing groups, or who've moved house recently.
2. Neighbourhood and buy-and-sell groups you're already a member of, where self-promotion is allowed. Check each group's rules first.
3. Builder communities that welcome feedback requests (for example the Devpost forum for this hackathon, r/SideProject, Indie Hackers). Read the posting rules before posting.

## The message (edit freely, keep the honest part)

> Hi! I'm building **Stoop** for an Amazon hackathon: you tell your voice assistant what to sell, AI agents haggle with buyers for you, and the buyer's payment is only released when your doorbell sees them pick the item up from your porch. Nobody meets anybody, and the AI never knows your address.
>
> Could you try it for 3 minutes? It runs in your browser with a private sandbox, no sign-up: **<link>**
>
> It's a prototype: the Alexa+ devices, payments and doorbell are simulated, so nothing is really sold. There's a 4-question survey at the end. Honest "I wouldn't use this because…" answers help the most.

## Before you share the link
- Run `pnpm tour <link> <admin key>` once; it must print `TOUR CHECK PASSED`.
- Open the link on a laptop yourself. The tour is built for a laptop screen; on a phone the steps and devices stack.
- Check `/healthz` shows room (`"worlds"` well under `"maxWorlds"`).

## After
- `node tools/feedback-summary.mjs "<link>/api/feedback.jsonl?key=<admin key>"`
- If someone ticked "you may contact me" and wrote something interesting, ask whether you may quote them by first name in the submission. Without a yes, quote anonymously ("a tester who sells on Marketplace monthly").
