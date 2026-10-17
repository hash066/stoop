// UI QA pass (plan §12.4): load every judged surface at 1280x800 and 390px, drive the key
// interaction, collect console errors/warnings, and screenshot. Needs the stack + sims running
// (`pnpm demo`, or the stack on :8787 and the three Vite apps). Uses the system Chrome.
//
//   node tools/record-demo/qa.mjs
//
// Screenshots -> tools/record-demo/qa-shots/ (gitignored). Exit code is non-zero if any surface
// logged a console error.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { URLS, TOKENS, resolvePlaywright, launchChrome, collectConsole, sleep, mcp, stackJson, otpFor, assertOffer } from './lib.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'qa-shots');
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { label: '1280x800', width: 1280, height: 800 },
  { label: '390w', width: 390, height: 844 },
];

const findings = []; // { surface, viewport, errors[] }

async function setupState() {
  const idRef = { n: 0 };
  await stackJson('POST', '/sweep/demo', undefined, { Authorization: `Bearer ${TOKENS.seller}` });
  await mcp('seller', 'appraise_photos', {}, idRef);
  // A LIVE bike listing so the buyer sim's search returns a result.
  await mcp('seller', 'list_items', { items: ['bike'] }, idRef);
  // A stroller deal driven to the pickup window, for Ops + Pass.
  await mcp('seller', 'list_items', { items: ['stroller'] }, idRef);
  await mcp('seller', 'set_mandate', { item: 'stroller', floorDollars: 90 }, idRef);
  await mcp('seller', 'set_pickup_preferences', { preset: 'evenings' }, idRef);
  const found = await mcp('buyer', 'search_listings', { query: 'jogging stroller', maxPriceDollars: 100 }, idRef);
  const listingId = found.data?.results?.[0]?.listingId;
  if (!listingId) throw new Error(`setup: no stroller listing (${found.text})`);
  assertOffer(await mcp('buyer', 'make_offer', { listingId, amountDollars: 95 }, idRef));
  const accepted = await mcp('seller', 'respond_to_offer', { decision: 'accept' }, idRef);
  const dealId = accepted.data?.dealId;
  await mcp('buyer', 'checkout', {}, idRef);
  let passId;
  for (let i = 0; i < 40 && !passId; i++) {
    const { json } = await stackJson('GET', '/ops/state');
    passId = (json?.deals ?? []).find((d) => d.id === dealId)?.passId;
    if (!passId) await sleep(250);
  }
  return { dealId, passId };
}

async function shoot(context, label, url, drive) {
  for (const vp of VIEWPORTS) {
    const page = await context.newPage();
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const errors = collectConsole(page);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20_000 });
      if (drive) await drive(page, vp);
      await sleep(800);
      await page.screenshot({ path: join(OUT, `${label}-${vp.label}.png`), fullPage: false });
    } catch (e) {
      errors.push({ type: 'driver', text: String(e) });
    }
    findings.push({ surface: label, viewport: vp.label, errors: [...errors] });
    await page.close();
  }
}

const main = async () => {
  const pw = resolvePlaywright();
  console.log('Setting up demo state via the stack…');
  const { dealId, passId } = await setupState();
  console.log(`  deal ${dealId}, pass ${passId}`);
  const otp = passId ? await otpFor(passId).catch(() => undefined) : undefined;

  const browser = await launchChrome(pw, { headless: true });
  const context = await browser.newContext({ colorScheme: 'light', deviceScaleFactor: 1 });

  // Seller sim: appraisal grid after "Demo photos".
  await shoot(context, 'seller', URLS.seller, async (page) => {
    const demo = page.getByText('Demo photos', { exact: true });
    if (await demo.count()) await demo.first().click();
    await sleep(3500); // let the sweep + appraisal card render
  });

  // Seller sim with the Developer view open (policy decisions strip, for judges).
  await shoot(context, 'seller-dev', URLS.seller, async (page) => {
    const dev = page.getByText('Developer view', { exact: true });
    if (await dev.count()) await dev.first().click();
    await sleep(600);
  });

  // Buyer sim: a search utterance returns the live bike.
  await shoot(context, 'buyer', URLS.buyer, async (page) => {
    const input = page.locator('.typebox input');
    if (await input.count()) {
      await input.first().fill('Find me a hybrid bike under $200 nearby');
      await input.first().press('Enter');
      await sleep(3500);
    }
  });

  // Ops console: the stroller deal at the pickup window + the email outbox.
  await shoot(context, 'ops', URLS.ops, async (page) => {
    await sleep(1500);
  });

  // Pass PWA: enter the OTP, consent, then the live pass (window + porch + "I'm here").
  if (passId) {
    await shoot(context, 'pass', URLS.pass(passId), async (page) => {
      await sleep(800);
      const otpInput = page.locator('.otp.num');
      if (otp && (await otpInput.count())) {
        await otpInput.first().fill(otp);
        const open = page.getByText('Open my pass', { exact: true });
        if (await open.count()) await open.first().click();
        await sleep(1500);
      }
      const consent = page.getByText('I understand', { exact: true });
      if (await consent.count()) {
        await consent.first().click();
        await sleep(1500);
      }
    });
  } else {
    console.log('  (no passId — skipping pass screenshots)');
  }

  await context.close();
  await browser.close();

  // Report
  console.log('\n===== UI QA report =====');
  let anyErr = false;
  for (const f of findings) {
    const errs = f.errors;
    if (errs.length) {
      anyErr = true;
      console.log(`\n[FAIL] ${f.surface} @ ${f.viewport} — ${errs.length} issue(s):`);
      for (const e of errs.slice(0, 12)) console.log(`   (${e.type}) ${e.text}`);
    } else {
      console.log(`[ ok ] ${f.surface} @ ${f.viewport}`);
    }
  }
  console.log(`\nScreenshots in ${OUT}`);
  process.exit(anyErr ? 1 : 0);
};

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
