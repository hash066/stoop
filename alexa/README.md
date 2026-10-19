# Stoop on Alexa (custom skill)

The skill talks to a real Stoop shop. Its endpoint is the tester site, `POST https://d29kyjvj1jibpu.cloudfront.net/alexa`. The handler (`services/stack/src/alexa.ts`) uses the Alexa Skills Kit SDK and checks every request's Amazon signature and timestamp.

## What it does

A seller links a shop once, then talks to it:

| You say | Stoop does |
|---|---|
| "Alexa, open stoop shop" | Asks for the 6-digit code from your shop page (Talk to your shop on Alexa → Get a Code) |
| "four eight two nine one three" | Links this Alexa account to your shop |
| "Alexa, ask stoop shop if I have any offers" | Reads the newest offer and asks "Accept?" |
| "Yes" | Reads the exact terms (price, Stoop's fee, your payout) and asks again |
| "Yes" | Accepts; the buyer pays next |
| "Alexa, ask stoop shop how my sale is going" | Payment, pickup window, camera check, payout |
| "Alexa, ask stoop shop what I'm selling" | Your items and prices |
| "Alexa, tell stoop shop don't go below ninety dollars on the stroller" | Sets the lowest price (asks for a yes first) |

Every answer comes from the shop's MCP tools, called the way an Alexa-style client calls them: no session, approvals as `approval_required`, and the next yes is sent as `confirm_action`.

## Deploy it (one time, about 5 minutes)

You need a free Amazon developer account (developer.amazon.com, sign in with your Amazon account).

1. In a PowerShell window, sign the ASK CLI in to your developer account. The browser opens; approve it. Answer **No** when it asks about linking an AWS account.

   ```powershell
   $env:npm_config_cache = "E:\Winter\.npm-cache"
   cd E:\Winter\stoop\alexa
   npx -y ask-cli@2 configure
   ```

2. Deploy the skill package (creates the skill, uploads the interaction model and builds it):

   ```powershell
   npx -y ask-cli@2 deploy
   ```

3. Turn the skill's endpoint on in Stoop: set `ALEXA_SKILL_ID` (from `alexa/.ask/ask-states.json`) on the tester site's container and redeploy (`docs/DEPLOY.md`).

4. Test it in the Alexa developer console (Test tab, set to Development), in the Alexa app, or on any Echo signed in to the same Amazon account.
