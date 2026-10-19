// Records the "how to use Stoop" walkthrough: one 1080p stage with the three real screens side by
// side (seller laptop, buyer phone, porch-camera phone), captions, and a ripple on every click.
//
//   pnpm --filter @stoop/stack exec tsx e2e/record-walkthrough.ts [--out <dir>]
//   -> <out>/demo.mp4 and demo-poster.jpg (defaults to apps/web/public/)
//
// It runs the real hosted server and the real app. Two stand-ins, labelled on screen for the whole
// video: the camera feed (a drawn porch, so the scene can change on cue) and the vision model that
// looks at it (so the run doesn't depend on Bedrock judging a drawing). Payments use a test card.
import { serve } from "@hono/node-server";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync } from "node:fs";
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
const out = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]!) : join(root, "apps", "web", "public");
const work = mkdtempSync(join(process.env.TMP ?? tmpdir(), "stoop-walkthrough-"));
mkdirSync(out, { recursive: true });

const CLICK_RIPPLE = `addEventListener("pointerdown", (e) => {
  const d = document.createElement("div");
  d.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:4px solid #ffc83d;background:rgba(255,200,61,.25);left:" + e.clientX + "px;top:" + e.clientY + "px";
  document.documentElement.appendChild(d);
  d.animate([{ transform: "scale(.4)", opacity: 1 }, { transform: "scale(1.6)", opacity: 0 }], { duration: 650, easing: "ease-out" }).onfinish = () => d.remove();
}, true);`;

const STROLLER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2ece0"/><stop offset="1" stop-color="#e4dac6"/></linearGradient></defs>
<rect width="1200" height="900" fill="url(#bg)"/><rect y="690" width="1200" height="210" fill="#d8ccb2"/>
<ellipse cx="610" cy="760" rx="380" ry="26" fill="#000" opacity=".08"/>
<g fill="none" stroke="#1d2622" stroke-width="26" stroke-linecap="round" stroke-linejoin="round">
<path d="M330 250 L470 300 L700 700"/><path d="M470 300 L560 520 L880 560"/><path d="M560 520 L420 700"/><path d="M880 560 L940 690"/>
</g>
<path d="M430 300 Q560 120 760 260 L700 330 Q600 250 480 330 Z" fill="#3f6b55"/>
<path d="M500 360 L800 400 L760 520 L560 500 Z" fill="#2c3a33"/>
<g fill="#f2ece0" stroke="#1d2622" stroke-width="22"><circle cx="420" cy="700" r="92"/><circle cx="700" cy="700" r="92"/><circle cx="940" cy="700" r="70"/></g>
<g fill="#1d2622"><circle cx="420" cy="700" r="16"/><circle cx="700" cy="700" r="16"/><circle cx="940" cy="700" r="13"/></g>
<rect x="300" y="226" width="70" height="40" rx="16" fill="#1d2622"/>
</svg>`;

const P = { stage: 8797, seller: 8798, buyer: 8799, cam: 8800 };
const at = (port: number) => `http://127.0.0.1:${port}`;

// ---------- stand-ins (labelled in the video)
const scene = { item: "present" as "present" | "absent", person: 0 };
const vision: VisionAdapter = { name: "stand-in", async assess() { return { presence: scene.item, rationale: "stand-in", personCount: scene.person, adapter: "stand-in" }; } };

const server = await createSandboxServer({
  rootDir: root,
  dataDir: mkdtempSync(join(work, "data-")),
  stackOverrides: { vision, recallChecker: rulesOnlyChecker(), frameDelayScale: 0.25 },
  extraOrigins: Object.values(P).map(at),
});
const assets = readdirSync(join(root, "apps/web/dist/assets"));
const font = (re: RegExp) => `/app/web/assets/${assets.find((f) => re.test(f))}`;
const stageHtml = STAGE(font(/^bricolage.*-latin-wght/), font(/^geist-latin-wght/));
const fetch = (req: Request) => (new URL(req.url).pathname === "/__stage" ? new Response(stageHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } }) : server.app.fetch(req));
const listeners = Object.values(P).map((port) => serve({ fetch, port, hostname: "127.0.0.1" }));

const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", process.env.STOOP_CHROME].find((p) => p && existsSync(p));
const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : { channel: "chrome" }), args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"] });

// ---------- a clean product illustration for the listing photo (named so the offline appraiser knows it)
const photo = join(work, "jogging-stroller.png");
{
  const p = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await p.setContent(`<body style="margin:0">${STROLLER_SVG}</body>`);
  await p.screenshot({ path: photo });
  await p.close();
}

const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: work, size: { width: 1920, height: 1080 } }, permissions: ["camera"] });
await ctx.addInitScript(CLICK_RIPPLE);
// tsx keeps function names with a __name() helper; give the stringified function one
await ctx.addInitScript(`var __name = (f) => f; (${fakeCamera.toString()})(${P.cam})`);
const stage = await ctx.newPage();
stage.on("console", (m) => m.type() === "error" && console.error(`[page] ${m.text()}`));
stage.on("pageerror", (e) => console.error(`[pageerror] ${e.message}`));
await stage.goto(`${at(P.stage)}/__stage`);
const frame = (id: string) => stage.frameLocator(`#${id}`);
const seller = frame("seller");
const buyer = frame("buyer");
const cam = frame("cam");
const nav = (id: string, url: string) => stage.evaluate(([i, u]) => ((document.getElementById(i!) as HTMLIFrameElement).src = u!), [id, url]);
const caption = (tag: string, text: string) => stage.evaluate(([t, x]) => (window as any).caption(t, x), [tag, text]);
const pause = (ms: number) => stage.waitForTimeout(ms);
const type = async (loc: ReturnType<typeof seller.locator>, text: string) => {
  await loc.click();
  await loc.pressSequentially(text, { delay: 35 });
};
const until = async (what: string, fn: () => Promise<boolean>, ms = 40_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out: ${what}`);
};

let ok = false;
try {
  await pause(3800);
  await stage.evaluate(() => (window as any).hideIntro());

  // ---------- seller
  await caption("Seller", "Open a shop: your name, the pickup address (kept hidden from buyers) and where you’ll leave things.");
  await nav("seller", `${at(P.seller)}/`);
  await seller.getByRole("heading", { name: /Sell it from your/ }).waitFor();
  await pause(2200);
  await seller.getByRole("link", { name: "Open Your Shop" }).first().click();
  await type(seller.getByLabel("Your first name or shop name"), "Ana");
  await type(seller.getByLabel("Pickup address"), "12 Elm St, Springfield, IL");
  await type(seller.getByLabel("ZIP code"), "62704");
  await type(seller.getByLabel("Where you’ll leave things"), "On the bench, left of the front door.");
  await pause(500);
  await seller.getByRole("button", { name: "Open Shop" }).click();
  await seller.getByRole("button", { name: /Add Photos/ }).waitFor();
  await pause(1200);

  await caption("Seller", "Add a photo. The AI names it, checks it isn’t recalled, and suggests a price.");
  await seller.locator('input[type="file"]').setInputFiles(photo);
  await seller.getByRole("button", { name: /^List It at \$/ }).waitFor({ timeout: 60_000 });
  await pause(1800);
  await caption("Seller", "Set the lowest price you’ll take. Buyers never see it; the AI haggles above it.");
  const lowest = seller.getByLabel("Lowest you’ll take");
  await lowest.click();
  await lowest.fill("");
  await lowest.pressSequentially("90", { delay: 120 });
  await seller.getByLabel("Sell right away to anyone who offers the full price").uncheck();
  await pause(900);
  await seller.getByRole("button", { name: /^List It at \$/ }).click();
  await seller.getByRole("heading", { name: "For sale now" }).waitFor({ timeout: 30_000 });
  await pause(1500);

  // ---------- porch camera
  const shopId = await seller.locator("body").evaluate(() => location.pathname.split("/")[2]!);
  const sellerToken = await seller.locator("body").evaluate((_, id) => localStorage.getItem(`stoop:seller:${id}`), shopId);
  await caption("Porch camera", "Prop an old phone at the window and open the camera link from your shop page.");
  const reg = (await (await globalThis.fetch(`${at(P.stage)}/s/${shopId}/web/cam/register`, { method: "POST", headers: { Authorization: `Bearer ${sellerToken}`, "Content-Type": "application/json" }, body: "{}" })).json()) as { camToken: string };
  await nav("cam", `${at(P.cam)}/shop/${shopId}/camera#ck=${reg.camToken}`);
  await cam.getByRole("button", { name: "Start Camera" }).click({ timeout: 20_000 });
  await cam.getByText("On, waiting for a pickup").waitFor({ timeout: 15_000 });
  await pause(2200);

  // ---------- buyer
  const listingUrl = (await seller.getByRole("link", { name: "Open listing" }).getAttribute("href"))!.replace(at(P.seller), at(P.buyer));
  await caption("Buyer", "Share your link. A buyer opens it on their phone. No account needed.");
  await nav("buyer", listingUrl);
  await type(buyer.getByLabel("Your first name"), "Ben");
  await type(buyer.getByLabel("Choose a 4-digit purchase code"), "2580");
  await buyer.getByRole("button", { name: "Continue" }).click();
  await pause(700);
  await caption("Buyer", "They ask a question. The seller’s AI answers in seconds, only from what the listing says.");
  await type(buyer.getByLabel("Message the seller’s assistant"), "Does it fold flat for a car trunk?");
  await buyer.getByRole("button", { name: "Send" }).click();
  await until("answer", async () => (await buyer.locator(".bubble-row:not(.me) .bubble").count()) > 0);
  await pause(3000);
  await caption("Buyer", "They offer $95. Anything under your asking price goes to you for a yes.");
  const offer = buyer.getByLabel("Your offer");
  await offer.click();
  await offer.fill("");
  await offer.pressSequentially("95", { delay: 120 });
  await buyer.getByRole("button", { name: "Send Offer" }).click();
  await buyer.getByText(/Waiting for the owner to say yes/).waitFor({ timeout: 30_000 });
  await pause(2000);

  // ---------- the seller says yes, the way they would to Alexa
  await caption("Seller", "Ask Stoop, the way you’d ask Alexa: “Any offers?”");
  await type(seller.getByRole("textbox", { name: "Ask Stoop" }), "Any offers?");
  await seller.getByRole("button", { name: "Send" }).click();
  await until("offer read", async () => /offers \$95/.test((await seller.locator("#ask-h").locator("xpath=ancestor::section").innerText()) ?? ""));
  await pause(2500);
  await type(seller.getByRole("textbox", { name: "Ask Stoop" }), "Yes");
  await seller.getByRole("button", { name: "Send" }).click();
  await seller.getByRole("button", { name: "Approve" }).waitFor({ timeout: 20_000 });
  await caption("Seller", "Before anything is final, Stoop shows the exact terms and waits for your yes.");
  await pause(3200);
  await seller.getByRole("button", { name: "Approve" }).click();
  await pause(1500);

  // ---------- pay, pass, pickup
  await caption("Buyer", "The buyer pays. The money is held, not charged, until the pickup is verified.");
  await buyer.getByRole("button", { name: "Review and Pay" }).click({ timeout: 20_000 });
  await buyer.getByRole("button", { name: /^Pay \$/ }).waitFor();
  await pause(2500);
  await buyer.getByRole("button", { name: /^Pay \$/ }).click();
  await buyer.getByRole("button", { name: "Use this device instead" }).click({ timeout: 20_000 });
  await buyer.getByRole("link", { name: "Open Pickup Pass" }).click();
  await caption("Buyer", "Their pickup pass opens on their phone. The address appears only now, for a two-hour window.");
  await buyer.getByRole("button", { name: "Use This Phone" }).click();
  await buyer.getByRole("button", { name: "Agree and Show Address" }).click();
  await buyer.getByRole("heading", { name: "12 Elm St, Springfield, IL" }).waitFor();
  const state = async () => (await (await globalThis.fetch(`${at(P.stage)}/s/${shopId}/web/seller/state`, { headers: { Authorization: `Bearer ${sellerToken}` } })).json()) as { sales: Array<{ state: string; before: { presence: string } | null; presenceEvents: number }> };
  await until("before photo", async () => (await state()).sales[0]?.before?.presence === "present");
  await caption("Porch camera", "The camera already took the “before” photo: the stroller is on the porch.");
  await pause(3000);

  await caption("Buyer", "At the porch, the buyer taps I’m Here first, then takes the stroller.");
  await buyer.getByRole("button", { name: "I’m Here" }).click();
  await buyer.getByText("You’re checked in").waitFor();
  await pause(1200);
  // the stand-in vision learns what the drawn feed will show before the feed shows it
  scene.person = 1;
  await cam.locator("body").evaluate(() => ((window as any).__porch = { item: true, person: true }));
  await pause(2200);
  scene.item = "absent";
  await cam.locator("body").evaluate(() => ((window as any).__porch = { item: false, person: true }));
  await caption("Porch camera", "The camera sees someone at the door, then the stroller gone.");
  await until("presence", async () => (await state()).sales[0]!.presenceEvents > 0);
  await pause(1500);
  await cam.locator("body").evaluate(() => ((window as any).__porch = { item: false, person: false }));
  scene.person = 0;
  await buyer.getByRole("button", { name: "Got It" }).waitFor({ timeout: 40_000 });
  await caption("Buyer", "Verified. The buyer checks the stroller and taps Got It.");
  await pause(2200);
  await buyer.getByRole("button", { name: "Got It" }).click();
  await buyer.getByText("All done. It’s yours.").waitFor({ timeout: 15_000 });

  await until("paid out", async () => ["CAPTURED", "PAYOUT_RECORDED", "CLOSED"].includes((await state()).sales[0]!.state));
  await caption("Seller", "You’re paid, with a signed receipt anyone can verify. You never met anyone.");
  await seller.getByRole("heading", { name: "Past sales" }).scrollIntoViewIfNeeded({ timeout: 15_000 });
  await pause(4500);
  await stage.evaluate(() => (window as any).outro());
  await pause(5000);
  ok = true;
} catch (e) {
  console.error(`FAIL: ${e instanceof Error ? e.message : String(e)}`);
  await stage.screenshot({ path: join(work, "fail.png") }).catch(() => undefined);
  for (const id of ["seller", "buyer", "cam"]) console.error(`--- ${id}: ${(await frame(id).locator("body").innerText({ timeout: 2000 }).catch(() => "?")).slice(0, 400)}`);
  console.error(`screenshot: ${join(work, "fail.png")}`);
} finally {
  const video = stage.video();
  await ctx.close();
  await browser.close();
  for (const l of listeners) l.close();
  server.stop();
  if (ok && video) {
    const webm = await video.path();
    const mp4 = join(out, "demo.mp4");
    // H.264 + faststart so every browser (and iOS) plays it; trim the blank first half second
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "0.6", "-i", webm, "-vf", "scale=1600:-2", "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4]);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "49", "-i", mp4, "-frames:v", "1", "-q:v", "3", join(out, "demo-poster.jpg")]);
    renameSync(webm, join(work, "raw.webm"));
    console.log(`PASS: ${mp4}\n(raw recording: ${join(work, "raw.webm")})`);
  }
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------- the stage

function STAGE(display: string, text: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:D;src:url(${display}) format("woff2");font-weight:200 800}
@font-face{font-family:T;src:url(${text}) format("woff2");font-weight:100 900}
*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden}
body{background:radial-gradient(1200px 700px at 90% 0%,rgba(255,200,61,.14),transparent 60%),radial-gradient(900px 600px at 0% 100%,rgba(43,110,85,.5),transparent 60%),#0f3b2c;font-family:T,system-ui;color:#fff}
.top{position:absolute;left:64px;top:30px;display:flex;align-items:center;gap:14px;font:800 30px D;letter-spacing:-.03em}
.top small{font:500 18px T;opacity:.7;letter-spacing:0;margin-left:10px}
.lab{font:600 17px T;opacity:.75;margin:0 0 10px 4px;display:flex;gap:8px;align-items:center}.lab b{width:9px;height:9px;border-radius:50%;background:#ffc83d}
.dev{position:absolute;top:100px}
.laptop{left:56px}.lap{width:1088px;height:690px;padding:12px;border-radius:18px 18px 6px 6px;background:#0b1310;box-shadow:0 40px 80px -30px rgba(0,0,0,.6)}
.lapbase{height:14px;margin:0 -40px;border-radius:0 0 16px 16px;background:linear-gradient(#d9ddd9,#a9b0aa)}
.phone{width:320px}.ph{width:320px;height:690px;padding:10px;border-radius:44px;background:#0b1310;box-shadow:0 40px 80px -30px rgba(0,0,0,.6)}
.buyer{left:1190px}.camd{left:1544px}
.win{position:relative;overflow:hidden;width:100%;height:100%;border-radius:8px;background:#f5f4ef}.ph .win{border-radius:34px}
iframe{position:absolute;left:0;top:0;border:0;transform-origin:0 0;background:#f5f4ef}
#seller{width:1280px;height:782px;transform:scale(.8312)}
#buyer,#cam{width:390px;height:830px;transform:scale(.7692)}
.empty{position:absolute;inset:0;display:grid;place-items:center;color:#7c867f;font:600 18px T;text-align:center;padding:30px}
.cap{position:absolute;left:56px;right:56px;bottom:56px;display:flex;align-items:center;gap:20px;min-height:84px;padding:18px 28px;border-radius:24px;background:rgba(5,20,13,.6);backdrop-filter:blur(10px)}
.tag{flex:none;padding:8px 16px;border-radius:999px;background:#ffc83d;color:#0f1813;font:700 18px T}
#cap{font:600 30px D;letter-spacing:-.015em;line-height:1.2}
.note{position:absolute;left:64px;right:64px;bottom:18px;font:500 15px T;opacity:.6;text-align:center}
#intro,#outro{position:absolute;inset:0;display:grid;place-content:center;gap:22px;text-align:center;background:#0f3b2c;transition:opacity .8s ease}
#intro h1,#outro h1{margin:0;font:800 104px D;letter-spacing:-.045em;line-height:.95}#intro h1 em,#outro h1 em{font-style:normal;color:#ffc83d}
#intro p,#outro p{margin:0;font:500 30px T;opacity:.8}
#outro{opacity:0;pointer-events:none}
</style></head><body>
<div class="top"><svg width="40" height="40" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#ffffff22"/><path d="M10 26V12.5a6 6 0 0 1 12 0V26" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="19" cy="19" r="1.4" fill="#fff"/><circle cx="25" cy="8" r="3.2" fill="#ffc83d"/><path d="M6 26h20" stroke="#ffc83d" stroke-width="2.4" stroke-linecap="round"/></svg>Stoop<small>How a sale works, start to finish</small></div>
<div class="dev laptop"><div class="lab"><b></b>Seller · laptop</div><div class="lap"><div class="win"><iframe id="seller" allow="camera; clipboard-write"></iframe><div class="empty" id="e-seller"></div></div></div><div class="lapbase"></div></div>
<div class="dev phone buyer"><div class="lab"><b></b>Buyer · their phone</div><div class="ph"><div class="win"><iframe id="buyer"></iframe><div class="empty">Waiting for the link…</div></div></div></div>
<div class="dev phone camd"><div class="lab"><b></b>Porch camera · an old phone</div><div class="ph"><div class="win"><iframe id="cam" allow="camera"></iframe><div class="empty">Not set up yet</div></div></div></div>
<div class="cap"><span class="tag" id="tag">Seller</span><span id="cap">Selling with Stoop</span></div>
<div class="note">Recorded on a local copy of Stoop. The camera feed is a drawn porch and the vision model is a stand-in, so the scene can change on cue. Payments use a test card; nothing is charged.</div>
<div id="intro"><h1>Sell it from your <em>porch.</em></h1><p>A whole sale in two minutes: the seller, the buyer’s phone, and an old phone as the porch camera.</p></div>
<div id="outro"><h1>Open your shop.</h1><p>d29kyjvj1jibpu.cloudfront.net · and on Alexa: “ask stoop shop if I have any offers”</p></div>
<script>
for (const f of document.querySelectorAll("iframe")) f.addEventListener("load", () => { if (f.src) f.nextElementSibling.style.display = "none"; });
window.caption = (t, x) => { document.getElementById("tag").textContent = t; const c = document.getElementById("cap"); c.animate([{opacity:0,transform:"translateY(6px)"},{opacity:1,transform:"none"}],{duration:350,easing:"ease-out"}); c.textContent = x; };
window.hideIntro = () => { const i = document.getElementById("intro"); i.style.opacity = 0; setTimeout(() => i.remove(), 900); };
window.outro = () => { const o = document.getElementById("outro"); o.style.opacity = 1; };
</script></body></html>`;
}

/** In the camera frame only: getUserMedia returns a drawn porch whose scene the recorder changes on cue. */
function fakeCamera(camPort: number) {
  if (location.port !== String(camPort)) return;
  (window as any).__porch = { item: true, person: false };
  const md = navigator.mediaDevices;
  if (!md) return;
  md.getUserMedia = async () => {
    const c = document.createElement("canvas");
    c.width = 720;
    c.height = 960;
    const g = c.getContext("2d")!;
    let px = 760;
    const draw = () => {
      const s = (window as any).__porch as { item: boolean; person: boolean };
      g.fillStyle = "#cbbd9f";
      g.fillRect(0, 0, 720, 960);
      g.fillStyle = "#b9a988";
      for (let y = 0; y < 600; y += 46) g.fillRect(0, y, 720, 4);
      g.fillStyle = "#1f4d3d";
      g.fillRect(250, 120, 230, 480);
      g.fillStyle = "#e9c46a";
      g.beginPath();
      g.arc(445, 380, 9, 0, 7);
      g.fill();
      g.fillStyle = "#fff6d8";
      g.beginPath();
      g.arc(560, 150, 22, 0, 7);
      g.fill();
      g.fillStyle = "#8d8b84";
      g.fillRect(0, 600, 720, 360);
      g.fillStyle = "#7c7a73";
      for (let x = 0; x < 720; x += 90) g.fillRect(x, 600, 3, 360);
      g.fillStyle = "#6d4c35";
      g.fillRect(30, 520, 200, 22);
      g.fillRect(44, 542, 14, 70);
      g.fillRect(202, 542, 14, 70);
      if (s.item) {
        g.strokeStyle = "#22302a";
        g.lineWidth = 10;
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(520, 520);
        g.lineTo(600, 700);
        g.moveTo(560, 610);
        g.lineTo(660, 610);
        g.moveTo(600, 700);
        g.lineTo(660, 610);
        g.stroke();
        g.fillStyle = "#4f7a5c";
        g.beginPath();
        g.arc(590, 600, 62, Math.PI, 0);
        g.fill();
        for (const [x, r] of [
          [520, 34],
          [600, 34],
          [668, 26],
        ] as const) {
          g.beginPath();
          g.arc(x, 720, r, 0, 7);
          g.stroke();
        }
      }
      // someone at the door sways a little, so the camera page keeps seeing movement
      const target = s.person ? 380 + Math.sin(Date.now() / 260) * 26 : 760;
      px += (target - px) * 0.08;
      if (px < 740) {
        g.fillStyle = "#283a52";
        g.beginPath();
        g.arc(px, 330, 46, 0, 7);
        g.fill();
        g.beginPath();
        g.roundRect(px - 70, 390, 140, 300, 50);
        g.fill();
        g.fillRect(px - 52, 660, 40, 170);
        g.fillRect(px + 12, 660, 40, 170);
      }
      g.fillStyle = "rgba(0,0,0,.55)";
      g.fillRect(0, 900, 720, 60);
      g.fillStyle = "#fff";
      g.font = "600 26px system-ui";
      g.fillText("Stand-in camera feed (drawn)", 20, 940);
      g.fillText(new Date().toLocaleTimeString(), 540, 940);
      requestAnimationFrame(draw);
    };
    draw();
    return c.captureStream(15);
  };
}

