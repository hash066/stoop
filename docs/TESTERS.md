# Getting testers (targeted, before Friday)

**Goal:** 15 to 30 people who actually sell secondhand open a shop, sell one thing to a friend through Stoop, and answer the short survey. Their numbers and comments go into the Devpost "Potential Impact" section, quoted only as they wrote them (`node tools/feedback-summary.mjs`), never paraphrased into something stronger.

## Who to ask, in order
1. People you know who sell on Marketplace, OLX, Craigslist, Vinted, Buy Nothing groups, or who've moved house recently. Best of all: a pair (seller and a friend as the buyer).
2. Neighbourhood and buy-and-sell groups you're already a member of, where self-promotion is allowed. Check each group's rules first.
3. Builder communities that welcome feedback requests (for example the Devpost forum for this hackathon, r/SideProject, Indie Hackers). Read the posting rules before posting.

## The message (edit freely, keep the honest part)

> Hi! I'm building **Stoop** for an Amazon hackathon. You photograph something you want to sell, an AI assistant prices it and haggles with buyers for you, and the buyer picks it up from your porch while you're out. The money only moves once your porch camera (an old phone or laptop at the window) sees it go. Nobody meets anybody, and the AI never knows your address.
>
> Could you try it with a friend as the buyer? Open a shop here, add a photo of something real, and send your friend the link: **<link>**
>
> It's an early test: payments use a test card and are never charged, so nothing is really sold or paid. There's a short survey on the page. Honest "I wouldn't use this because..." answers help the most.

## What a full test looks like (10 to 15 minutes, two people)
1. Seller: Open Your Shop, then Add Photos (one photo per thing), check the suggested price, set the lowest price, List It.
2. Seller: Porch camera, then Use Your Phone. Scan the code with a spare phone and point it at the spot where the item sits. Keep that page open.
3. Seller: Copy Link and send it to the buyer.
4. Buyer (their own phone): open the link, ask a question, make an offer. The seller accepts on their shop page.
5. Buyer: Review and Pay, then Open Pickup Pass, Agree and Show Address. At the porch: **tap I'm Here first**, then take the item.
6. A minute later the buyer sees Got It; the seller sees Paid out. Both fill in the survey.

## Before you share the link
- Run `pnpm --filter @stoop/stack e2e` locally; it must print `PASS: real flow end to end`.
- Do one real run yourself on the live site with two phones.
- Check `/healthz` shows room (`"shops"` well under `"maxShops"`, `"modelCalls"` well under the daily cap).
- Don't redeploy while testers have open shops: shops live in memory and a new container closes them.

## After
- `node tools/feedback-summary.mjs "<link>/api/feedback.jsonl?key=<admin key>"`
- If someone ticked "You can email me about my answer" and wrote something interesting, ask whether you may quote them by first name in the submission. Without a yes, quote anonymously ("a tester who sells on Marketplace monthly").
