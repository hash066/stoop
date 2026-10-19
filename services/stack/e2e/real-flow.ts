// End to end, in real browsers: a seller opens a shop and lists a photo, a phone becomes the porch
// camera, a buyer on another phone haggles, pays and picks up with the pass, and the payment goes
// through once the camera sees the item gone. Three separate browser profiles, one hosted server.
//
//   pnpm --filter @stoop/stack e2e [-- --headed] [-- --shots <dir>]
//   pnpm --filter @stoop/stack e2e -- --target https://<site>   (the live site, real Bedrock)
//
// Against a live site the vision model is real and the camera is Chrome's test pattern, which shows
// no item: the camera can't confirm the pickup, so the run takes the both-people-confirm path.
//
// The server is the real hosted server (sandboxes.ts). Two stand-ins, both labelled here: the vision
// model (this script decides what the "camera" sees, so the run doesn't need Bedrock) and Chrome's
// fake camera feed. Everything else, from MCP tools to Settlement, is the code testers use.
import { serve } from "@hono/node-server";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rulesOnlyChecker } from "@stoop/agents";
import type { VisionAdapter } from "@stoop/verifier";
import { createSandboxServer } from "../src/sandboxes.ts";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const require = createRequire(join(root, "package.json"));
const { chromium } = require("playwright-core") as typeof import("playwright-core");
const args = process.argv.slice(2);
const headed = args.includes("--headed");
const shots = args.includes("--shots") ? resolve(args[args.indexOf("--shots") + 1]!) : mkdtempSync(join(tmpdir(), "stoop-e2e-"));
mkdirSync(shots, { recursive: true });
const target = args.includes("--target") ? args[args.indexOf("--target") + 1]!.replace(/\/$/, "") : undefined;
const PORT = Number(process.env.E2E_PORT ?? 8797);
const BASE = target ?? `http://localhost:${PORT}`;

// What the stand-in vision model "sees" on the porch right now
const scene = { item: "present" as "present" | "absent", person: 0 };
const vision: VisionAdapter = {
  name: "e2e-stand-in",
  async assess() {
    return { presence: scene.item, rationale: "e2e stand-in", personCount: scene.person, adapter: "e2e-stand-in" };
  },
};

const server = target
  ? undefined
  : await createSandboxServer({
      rootDir: root,
      dataDir: mkdtempSync(join(tmpdir(), "stoop-e2e-data-")),
      stackOverrides: { vision, recallChecker: rulesOnlyChecker(), frameDelayScale: 0.2 },
    });
const http = server ? serve({ fetch: server.app.fetch, port: PORT, hostname: "127.0.0.1" }) : undefined;

const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", process.env.STOOP_CHROME].find((p) => p && require("node:fs").existsSync(p));
const browser = await chromium.launch({
  headless: !headed,
  ...(exe ? { executablePath: exe } : { channel: "chrome" }),
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const errors: string[] = [];
async function open(name: string, opts: Parameters<typeof browser.newContext>[0]) {
  const ctx = await browser.newContext({ ...opts, permissions: ["camera", "clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message} | ${(e.stack ?? "").split(/\r?\n/).slice(1, 5).join(" | ")}`));
  page.on("console", (m) => m.type() === "error" && !/favicon/.test(m.text()) && errors.push(`${name} console: ${m.text()}`));
  return page;
}
let n = 0;
const shot = async (page: import("playwright-core").Page, label: string) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(shots, `${String(++n).padStart(2, "0")}-${label}.png`), fullPage: true, animations: "disabled", timeout: 90_000 });
};
const step = (s: string) => console.log(`- ${s}`);
const until = async (what: string, fn: () => Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out: ${what}`);
};

let failed = false;
try {
  // ---------- landing at three widths
  const seller = await open("seller", { viewport: { width: 1440, height: 900 } });
  await seller.goto(`${BASE}/`);
  await shot(seller, "landing-1440");
  for (const [w, h] of [
    [768, 1024],
    [390, 844],
  ] as const) {
    const p = await open(`landing-${w}`, { viewport: { width: w, height: h } });
    await p.goto(`${BASE}/`);
    await shot(p, `landing-${w}`);
    await p.context().close();
  }

  // ---------- seller opens a shop
  step("seller opens a shop");
  await seller.getByRole("link", { name: "Open Your Shop" }).first().click();
  await seller.getByRole("button", { name: "Open Shop" }).click();
  await seller.getByText("Add the full pickup address").waitFor();
  await shot(seller, "sell-errors-1440");
  await seller.getByLabel("Your first name or shop name").fill("Ana");
  await seller.getByLabel("Pickup address").fill("12 Elm St, Springfield, IL");
  await seller.getByLabel("ZIP code").fill("62704");
  await seller.getByLabel("Where you’ll leave things").fill("On the bench, left of the front door.");
  await seller.getByRole("button", { name: "Open Shop" }).click();
  await seller.waitForURL(/\/shop\/[A-Za-z0-9_-]+$/);
  const shopId = new URL(seller.url()).pathname.split("/")[2]!;
  await seller.getByRole("button", { name: /Add Photos/ }).waitFor();
  await shot(seller, "shop-empty-1440");

  step("seller adds a photo; Stoop identifies and prices it");
  await seller.locator('input[type="file"]').setInputFiles(join(root, "fixtures/photos/01-jogging-stroller.svg"));
  await seller.getByRole("button", { name: /^List It at \$/ }).waitFor({ timeout: 60_000 });
  await shot(seller, "shop-priced-1440");
  await seller.getByLabel("Lowest you’ll take").fill("90");
  await seller.getByLabel("Sell right away to anyone who offers the full price").uncheck();
  await seller.getByRole("button", { name: /^List It at \$/ }).click();
  await seller.getByRole("heading", { name: "For sale now" }).waitFor({ timeout: 30_000 });
  const listingUrl = (await seller.getByRole("link", { name: "Open listing" }).getAttribute("href"))!;
  await shot(seller, "shop-listed-1440");

  // ---------- a phone becomes the porch camera (what the QR code on the dashboard opens)
  step("a phone becomes the porch camera");
  const sellerToken = (await seller.evaluate((id) => localStorage.getItem(`stoop:seller:${id}`), shopId))!;
  const reg = (await (await fetch(`${BASE}/s/${shopId}/web/cam/register`, { method: "POST", headers: { Authorization: `Bearer ${sellerToken}`, "Content-Type": "application/json" }, body: "{}" })).json()) as { camToken: string };
  const cam = await open("camera", phone);
  await cam.goto(`${BASE}/shop/${shopId}/camera#ck=${reg.camToken}`);
  await shot(cam, "camera-start-390");
  await cam.getByRole("button", { name: "Start Camera" }).click();
  await cam.getByText("On, waiting for a pickup").waitFor({ timeout: 15_000 });
  await seller.locator("#camera .badge.sun").waitFor({ timeout: 10_000 });
  await shot(cam, "camera-on-390");

  // ---------- buyer on their phone: asks, offers
  step("buyer opens the link, asks a question, offers $95");
  const buyer = await open("buyer", phone);
  await buyer.goto(listingUrl);
  await shot(buyer, "item-visitor-390");
  await buyer.getByLabel("Your first name").fill("Ben");
  await buyer.getByLabel("Choose a 4-digit purchase code").fill("2580");
  await buyer.getByRole("button", { name: "Continue" }).click();
  await buyer.getByLabel("Message the seller’s assistant").fill("Does it fold flat for a car trunk?");
  await buyer.getByRole("button", { name: "Send" }).click();
  await until("assistant answers the question", async () => (await buyer.locator(".bubble-row:not(.me)").count()) > 0, 60_000);
  await buyer.getByLabel("Your offer").fill("95");
  await buyer.getByRole("button", { name: "Send Offer" }).click();
  await buyer.getByText(/Waiting for the owner to say yes/).waitFor({ timeout: 30_000 });
  await shot(buyer, "item-offered-390");

  // ---------- seller accepts
  step("seller accepts $95");
  await seller.getByRole("button", { name: "Accept $95" }).waitFor({ timeout: 10_000 });
  await shot(seller, "shop-offer-1440");
  await seller.getByRole("button", { name: "Accept $95" }).click();

  // ---------- buyer pays and opens the pass
  step("buyer pays (held, not charged) and opens the pickup pass");
  await buyer.getByRole("button", { name: "Review and Pay" }).click({ timeout: 15_000 });
  await buyer.getByRole("button", { name: /^Pay \$/ }).waitFor();
  await shot(buyer, "item-checkout-390");
  await buyer.getByRole("button", { name: /^Pay \$/ }).click();
  await buyer.getByRole("link", { name: "Open Pickup Pass" }).click({ timeout: 20_000 });
  await buyer.getByRole("button", { name: "Use This Phone" }).click();
  await buyer.getByRole("button", { name: "Agree and Show Address" }).click();
  await buyer.getByRole("heading", { name: "12 Elm St, Springfield, IL" }).waitFor();
  await shot(buyer, "pass-window-390");

  // the camera took the before photo when the window opened (item on the porch)
  const state = async () => (await (await fetch(`${BASE}/s/${shopId}/web/seller/state`, { headers: { Authorization: `Bearer ${sellerToken}` } })).json()) as { sales: Array<{ state: string; before: { presence: string } | null; presenceEvents: number }> };
  if (!target) await until("before photo", async () => (await state()).sales[0]?.before?.presence === "present");
  else await until("before photo", async () => !!(await state()).sales[0]?.before || (await state()).sales[0]?.state === "DEGRADED", 60_000);
  await shot(seller, "shop-sale-window-1440");

  // ---------- pickup: I'm here, someone at the door, item gone
  step("buyer taps I'm Here; the camera sees a person, then the porch empty");
  await buyer.getByRole("button", { name: "I’m Here" }).click();
  await buyer.getByText("You’re checked in").waitFor();
  if (!target) {
    scene.person = 1;
    scene.item = "absent";
    await until("presence from the camera's motion", async () => (await state()).sales[0]!.presenceEvents > 0, 40_000);
    scene.person = 0;
    await buyer.getByRole("button", { name: "Got It" }).waitFor({ timeout: 40_000 });
    await shot(buyer, "pass-verified-390");
    await buyer.getByRole("button", { name: "Got It" }).click();
  } else {
    // real vision on a test pattern: no item seen, so both people confirm (waits out the presence window)
    step("live: the camera can't confirm a test pattern, so seller and buyer both confirm");
    await until("needs confirmation", async () => ["REVIEW", "DEGRADED"].includes((await state()).sales[0]!.state), 6 * 60_000);
    await seller.reload();
    await seller.getByRole("button", { name: "The Buyer Has It" }).click({ timeout: 15_000 });
    await buyer.getByRole("button", { name: "I Have It" }).click({ timeout: 15_000 });
  }
  await buyer.getByText("All done. It’s yours.").waitFor({ timeout: 15_000 });
  await shot(buyer, "pass-done-390");

  step("seller sees it paid out");
  await until("paid out", async () => ["CAPTURED", "PAYOUT_RECORDED", "CLOSED"].includes((await state()).sales[0]!.state));
  await seller.reload();
  await seller.getByRole("heading", { name: "Past sales" }).waitFor({ timeout: 10_000 });
  await shot(seller, "shop-paid-1440");
  for (const [w, h] of [
    [768, 1024],
    [390, 844],
  ] as const) {
    await seller.setViewportSize({ width: w, height: h });
    await shot(seller, `shop-paid-${w}`);
  }
  console.log(`\nPASS: real flow end to end. Final deal state: ${(await state()).sales[0]!.state}`);
} catch (e) {
  failed = true;
  console.error(`\nFAIL: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (errors.length) console.log(`\nBrowser errors (${errors.length}):\n  ${[...new Set(errors)].slice(0, 20).join("\n  ")}`);
  console.log(`\nScreenshots: ${shots}`);
  await browser.close();
  server?.stop();
  http?.close();
  process.exit(failed ? 1 : 0);
}
