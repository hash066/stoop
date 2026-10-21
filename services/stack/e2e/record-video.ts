// Records the real app for the submission video: a seller laptop, a buyer phone and a porch-camera
// phone, each as its own crisp clip (Chrome screencast frames, not Playwright's low-bitrate video),
// plus a marks.json so the editor can cut and speed up the waits.
//
//   AWS_PROFILE=stoop AWS_REGION=us-east-1 LLM_MODE=bedrock \
//     pnpm --filter @stoop/stack exec tsx e2e/record-video.ts --out E:/Winter/stoop-video/rec
//
// What is real: the hosted server and web app, Amazon Bedrock (pricing the photo, the seller's
// assistant, the vision check), Settlement, the signed receipt. What is staged, and said so in the
// video: the porch photos are our own (a real photo before, frames from an AI-generated clip for the
// pickup), uploaded through the same camera endpoints the porch-camera page uses. Payments are the
// app's test payments: nothing is charged.
import { serve } from "@hono/node-server";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rulesOnlyChecker } from "@stoop/agents";
import { createSandboxServer } from "../src/sandboxes.ts";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const require = createRequire(join(root, "package.json"));
const { chromium } = require("playwright-core") as typeof import("playwright-core");
type Page = import("playwright-core").Page;
type Locator = import("playwright-core").Locator;

const args = process.argv.slice(2);
const arg = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1]! : d);
const OUT = resolve(arg("--out", "E:/Winter/stoop-video/rec"));
const ASSETS = resolve(arg("--assets", "E:/Winter/stoop-video/assets"));
const PORT = Number(arg("--port", "8797"));
const BASE = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });
const work = mkdtempSync(join(process.env.TMP ?? tmpdir(), "stoop-video-"));

// ---------------------------------------------------------------- the server: the real hosted app
const server = await createSandboxServer({
  rootDir: root,
  dataDir: mkdtempSync(join(work, "data-")),
  stackOverrides: { recallChecker: rulesOnlyChecker(), frameDelayScale: 0.15 },
});
const http = serve({ fetch: server.app.fetch, port: PORT, hostname: "127.0.0.1" });

const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", process.env.STOOP_CHROME].find((p) => p && existsSync(p));
// Screencast frames come out at the browser's device scale, so each device gets its own Chrome
// (the context option alone doesn't change what the screencast delivers)
const launch = (dsf: number) => chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : { channel: "chrome" }), args: ["--autoplay-policy=no-user-gesture-required", `--force-device-scale-factor=${dsf}`] });
const browsers = { laptop: await launch(1.5), phone: await launch(2) };

// ---------------------------------------------------------------- recording
const marks: Array<{ who: string; label: string; t: number }> = [];
const mark = (who: string, label: string) => {
  marks.push({ who, label, t: Date.now() / 1000 });
  console.log(`  [${who}] ${label}`);
};
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

const CURSOR = (arrow: boolean) => `(() => {
  var __name = (f) => f;
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><path d="M3 2 L3 20 L8 15.5 L11.5 23 L14.5 21.6 L11 14.2 L18 14 Z" fill="#0f1813" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  let el;
  addEventListener("mousemove", (e) => {
    if (!${arrow}) return;
    if (!el) { el = document.createElement("div"); el.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;left:0;top:0;width:26px;height:26px"; el.innerHTML = SVG; document.documentElement.appendChild(el); }
    el.style.transform = "translate(" + e.clientX + "px," + e.clientY + "px)";
  }, true);
  addEventListener("pointerdown", (e) => {
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:4px solid #ffc83d;background:rgba(255,200,61,.28);left:" + e.clientX + "px;top:" + e.clientY + "px";
    document.documentElement.appendChild(d);
    d.animate([{ transform: "scale(.4)", opacity: 1 }, { transform: "scale(1.7)", opacity: 0 }], { duration: 650, easing: "ease-out" }).onfinish = () => d.remove();
  }, true);
})();`;

type Rec = { name: string; page: Page; dir: string; frames: Array<{ file: string; t: number }>; stop(): Promise<void> };
const recs: Rec[] = [];
async function open(name: string, kind: "laptop" | "phone") {
  const phone = kind === "phone";
  const ctx = await browsers[kind].newContext(
    phone
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light", permissions: ["clipboard-read", "clipboard-write"] }
      : { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, colorScheme: "light", permissions: ["clipboard-read", "clipboard-write"] },
  );
  await ctx.addInitScript(CURSOR(!phone));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`[${name} pageerror] ${e.message}`));
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  const cdp = await ctx.newCDPSession(page);
  const frames: Rec["frames"] = [];
  cdp.on("Page.screencastFrame", (e: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    const file = join(dir, `${String(frames.length).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(e.data, "base64"));
    frames.push({ file, t: e.metadata.timestamp ?? Date.now() / 1000 });
    void cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => undefined);
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: phone ? 780 : 1920, maxHeight: phone ? 1688 : 1080, everyNthFrame: 1 });
  const rec: Rec = {
    name,
    page,
    dir,
    frames,
    async stop() {
      await cdp.send("Page.stopScreencast").catch(() => undefined);
    },
  };
  recs.push(rec);
  return rec;
}
function encode(r: Rec) {
  if (!r.frames.length) return;
  const lines: string[] = [];
  r.frames.forEach((f, i) => {
    const d = i + 1 < r.frames.length ? Math.max(0.005, r.frames[i + 1]!.t - f.t) : 0.8;
    lines.push(`file '${f.file.replace(/\\/g, "/")}'`, `duration ${d.toFixed(4)}`);
  });
  lines.push(`file '${r.frames.at(-1)!.file.replace(/\\/g, "/")}'`);
  const list = join(r.dir, "list.txt");
  writeFileSync(list, lines.join("\n"));
  const out = join(OUT, `${r.name}.mp4`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "15", "-preset", "medium", out], { stdio: "inherit" });
  writeFileSync(join(OUT, `${r.name}.start.txt`), String(r.frames[0]!.t));
  console.log(`  wrote ${out} (${r.frames.length} frames)`);
}

// ---------------------------------------------------------------- human-paced input
async function hclick(p: Page, loc: Locator, steps = 24) {
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  if (b) await p.mouse.move(b.x + b.width * rnd(0.35, 0.65), b.y + b.height * rnd(0.4, 0.6), { steps });
  await p.waitForTimeout(rnd(160, 320));
  await loc.click();
}
async function htype(p: Page, loc: Locator, text: string, delay = 52) {
  await hclick(p, loc, 16);
  await loc.fill(""); // some fields start with a suggestion (the offer starts at the asking price)
  await loc.pressSequentially(text, { delay });
  await p.waitForTimeout(260);
}
const until = async (what: string, fn: () => Promise<boolean>, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
};
const dataUrl = (file: string, mime = "image/jpeg") => `data:${mime};base64,${readFileSync(file).toString("base64")}`;

// ---------------------------------------------------------------- the run
let failed = false;
const result: Record<string, unknown> = {};
try {
  const seller = await open("seller", "laptop");
  const sp = seller.page;

  mark("seller", "landing");
  await sp.goto(`${BASE}/`);
  await sp.waitForTimeout(2600);
  await hclick(sp, sp.getByRole("link", { name: "Open Your Shop" }).first());
  await sp.getByRole("button", { name: "Open Shop" }).waitFor();
  await sp.waitForTimeout(900);

  mark("seller", "form");
  await htype(sp, sp.getByLabel("Your first name or shop name"), "Asha");
  await htype(sp, sp.getByLabel("Pickup address"), "14 Jasmine Lane, Bengaluru");
  await htype(sp, sp.getByLabel("ZIP code"), "560001");
  await htype(sp, sp.getByLabel("Where you’ll leave things"), "On the porch, left of the front door.");
  await hclick(sp, sp.getByRole("button", { name: "Open Shop" }));
  await sp.waitForURL(/\/shop\/[A-Za-z0-9_-]+$/);
  const shopId = new URL(sp.url()).pathname.split("/")[2]!;
  result.shopId = shopId;
  await sp.getByRole("button", { name: /Add Photos/ }).waitFor();
  await sp.waitForTimeout(1400);
  mark("seller", "shop-open");

  // the photo of the real chair
  const [chooser] = await Promise.all([sp.waitForEvent("filechooser"), hclick(sp, sp.getByRole("button", { name: /Add Photos/ }))]);
  await chooser.setFiles(join(ASSETS, "chair.jpg"));
  mark("seller", "photo-added");
  const listBtn = sp.getByRole("button", { name: /^List It at \$/ });
  await listBtn.waitFor({ timeout: 90_000 });
  mark("seller", "appraised");
  await sp.waitForTimeout(2200);
  const ask = Number(/\$(\d+)/.exec((await listBtn.textContent()) ?? "")?.[1] ?? 20);
  const floor = Math.max(1, Math.round(ask * 0.75));
  const offer = Math.max(floor, Math.round(ask * 0.85));
  result.ask = ask;
  result.floor = floor;
  result.offer = offer;
  console.log(`  ask $${ask}, lowest $${floor}, buyer offers $${offer}`);
  await hclick(sp, sp.getByLabel("Lowest you’ll take"), 16);
  await sp.keyboard.press("Control+A");
  await sp.keyboard.type(String(floor), { delay: 90 });
  await sp.waitForTimeout(500);
  const auto = sp.getByLabel("Sell right away to anyone who offers the full price");
  if (await auto.isChecked().catch(() => false)) await hclick(sp, auto);
  mark("seller", "floor-set");
  await sp.waitForTimeout(1200);
  await hclick(sp, listBtn);
  await sp.getByRole("heading", { name: "For sale now" }).waitFor({ timeout: 40_000 });
  const listingUrl = (await sp.getByRole("link", { name: "Open listing" }).getAttribute("href"))!;
  await sp.waitForTimeout(2200);
  mark("seller", "listed");

  // the phone becomes the porch camera: a one-time code, as a QR, opened on the phone
  const sellerToken = (await sp.evaluate((id) => localStorage.getItem(`stoop:seller:${id}`), shopId))!;
  const camP = sp.waitForResponse((r) => r.url().includes("/api/camera/code") && r.request().method() === "POST");
  await sp.locator("#camera").scrollIntoViewIfNeeded();
  await sp.waitForTimeout(700);
  await hclick(sp, sp.getByRole("button", { name: "Use Your Phone" }));
  const pair = (await (await camP).json()) as { code: string };
  mark("seller", "qr");
  await sp.waitForTimeout(2600);

  const camRec = await open("camera", "phone");
  const cp = camRec.page;
  mark("camera", "start");
  await cp.goto(`${BASE}/camera#c=${pair.code}`);
  await cp.getByRole("button", { name: "Start Camera" }).waitFor({ timeout: 20_000 });
  await cp.waitForTimeout(1300);
  mark("camera", "paired");
  // the phone's camera sees the porch (our photo); the page's own capture loop answers Stoop's photo requests
  await cp.evaluate("window.__name = (f) => f");
  await cp.evaluate(
    ([still]) => {
      const md = navigator.mediaDevices;
      md.getUserMedia = async () => {
        const c = document.createElement("canvas");
        c.width = 1280;
        c.height = 704;
        const g = c.getContext("2d")!;
        const img = new Image();
        img.src = still!;
        const draw = () => {
          if (img.complete) g.drawImage(img, 0, 0, 1280, 704);
          requestAnimationFrame(draw);
        };
        draw();
        return c.captureStream(25);
      };
    },
    [dataUrl(join(ASSETS, "porch-before.jpg"))],
  );
  await hclick(cp, cp.getByRole("button", { name: "Start Camera" }));
  await cp.getByText("On, waiting for a pickup").waitFor({ timeout: 20_000 }).catch(async (e) => {
    console.error("camera page text:", (await cp.locator("body").innerText()).slice(0, 600));
    throw e;
  });
  await sp.locator("#camera .badge.sun").waitFor({ timeout: 15_000 });
  mark("camera", "on");
  mark("seller", "camera-on");
  await cp.waitForTimeout(2600);

  // ----- the buyer, on their phone
  const buyer = await open("buyer", "phone");
  const bp = buyer.page;
  mark("buyer", "start");
  await bp.goto(listingUrl);
  await bp.waitForTimeout(2600);
  mark("buyer", "listing");
  await htype(bp, bp.getByLabel("Your first name"), "Ravi");
  await htype(bp, bp.getByLabel("Choose a 4-digit purchase code"), "2580");
  await hclick(bp, bp.getByRole("button", { name: "Continue" }));
  await htype(bp, bp.getByLabel("Message the seller’s assistant"), "Is it sturdy? Any cracks?", 48);
  mark("buyer", "ask");
  await hclick(bp, bp.getByRole("button", { name: "Send" }));
  await until("assistant answers", async () => (await bp.locator(".bubble-row:not(.me)").count()) > 0, 90_000);
  mark("buyer", "answered");
  await bp.waitForTimeout(2600);
  await htype(bp, bp.getByLabel("Your offer"), String(offer));
  await hclick(bp, bp.getByRole("button", { name: "Send Offer" }));
  await bp.getByText(/Waiting for the owner to say yes/).waitFor({ timeout: 40_000 });
  mark("buyer", "offered");
  await bp.waitForTimeout(1800);

  // ----- the seller says yes
  mark("seller", "offer-in");
  await sp.getByRole("button", { name: `Accept $${offer}` }).waitFor({ timeout: 20_000 });
  await sp.waitForTimeout(1600);
  await hclick(sp, sp.getByRole("button", { name: `Accept $${offer}` }));
  mark("seller", "accepted");
  await sp.waitForTimeout(1800);

  // ----- the buyer pays (held, never charged) and opens the pass
  await hclick(bp, bp.getByRole("button", { name: "Review and Pay" }), 18);
  await bp.getByRole("button", { name: /^Pay \$/ }).waitFor();
  await bp.waitForTimeout(2200);
  mark("buyer", "checkout");
  await hclick(bp, bp.getByRole("button", { name: /^Pay \$/ }));
  await hclick(bp, bp.getByRole("link", { name: "Open Pickup Pass" }));
  await hclick(bp, bp.getByRole("button", { name: "Use This Phone" }));
  await bp.waitForTimeout(1200);
  mark("buyer", "consent");
  await hclick(bp, bp.getByRole("button", { name: "Agree and Show Address" }));
  await bp.getByRole("heading", { name: "14 Jasmine Lane, Bengaluru" }).waitFor();
  await bp.waitForTimeout(2600);
  mark("buyer", "pass");

  // the camera phone took the "before" photo when the window opened
  const state = async () => (await (await fetch(`${BASE}/s/${shopId}/web/seller/state`, { headers: { Authorization: `Bearer ${sellerToken}` } })).json()) as { sales: Array<{ state: string; before: { presence: string } | null; presenceEvents: number; verdict?: string }> };
  await until("before photo", async () => (await state()).sales[0]?.before?.presence === "present", 120_000);
  mark("seller", "before-photo");
  await sp.waitForTimeout(2200);
  mark("seller", "sale-window");

  // from here the porch frames come from a script: the page's own motion check is rate limited
  // (one check per 15 s) and would waste its one look before anyone is in view
  await camRec.stop();
  await cp.context().close();
  const camToken = (await (await fetch(`${BASE}/s/${shopId}/web/cam/register`, { method: "POST", headers: { Authorization: `Bearer ${sellerToken}`, "Content-Type": "application/json" }, body: "{}" })).json()) as { camToken: string };
  const camAuth = { Authorization: `Bearer ${camToken.camToken}`, "Content-Type": "application/json" };
  let scene: "before" | "after" = "before";
  const frames = { before: dataUrl(join(ASSETS, "porch-before.jpg")), person: dataUrl(join(ASSETS, "porch-person.jpg")), after: dataUrl(join(ASSETS, "porch-after.jpg")) };
  let loop = true;
  const camLoop = (async () => {
    while (loop) {
      const r = (await (await fetch(`${BASE}/s/${shopId}/web/cam/next`, { headers: camAuth })).json().catch(() => ({}))) as { want?: boolean };
      if (r.want) await fetch(`${BASE}/s/${shopId}/web/cam/frame`, { method: "POST", headers: camAuth, body: JSON.stringify({ dataUrl: frames[scene] }) });
      await new Promise((r2) => setTimeout(r2, 400));
    }
  })();

  // ----- at the door
  await hclick(bp, bp.getByRole("button", { name: "I’m Here" }));
  await bp.getByText("You’re checked in").waitFor();
  mark("buyer", "checked-in");
  await bp.waitForTimeout(1500);
  scene = "after";
  await fetch(`${BASE}/s/${shopId}/web/cam/frame`, { method: "POST", headers: camAuth, body: JSON.stringify({ dataUrl: frames.person, motion: true }) });
  mark("seller", "person-seen");
  await until("presence event", async () => (await state()).sales[0]!.presenceEvents > 0, 90_000);
  mark("seller", "presence");
  await bp.getByRole("button", { name: "Got It" }).waitFor({ timeout: 120_000 }).catch(async (e) => {
    console.error("sale state:", JSON.stringify((await state()).sales[0]));
    throw e;
  });
  mark("buyer", "verified");
  await bp.waitForTimeout(2200);
  await hclick(bp, bp.getByRole("button", { name: "Got It" }));
  await bp.getByText("All done. It’s yours.").waitFor({ timeout: 20_000 });
  mark("buyer", "done");
  const receiptHref = await bp.getByRole("link", { name: /Signed Pickup Receipt/i }).first().getAttribute("href").catch(() => null);
  result.receiptHref = receiptHref;
  // keep the real signed receipt and the public keys: the server goes away when this script ends,
  // and the video's "anyone can check it" scene runs the open-source verifier on exactly these
  await bp.waitForTimeout(2600);
  if (receiptHref) {
    const id = receiptHref.split("/").pop()!;
    const jws = await (await fetch(`${BASE}/s/${shopId}/receipts/${id}`)).text();
    const jwks = await (await fetch(`${BASE}/s/${shopId}/.well-known/jwks.json`)).text();
    writeFileSync(join(OUT, "receipt.jws"), jws.trim());
    writeFileSync(join(OUT, "jwks.json"), jwks);
    result.receiptId = id;
    // the public page anyone can open to check a receipt
    mark("buyer", "receipt-page");
    await bp.goto(new URL(receiptHref, BASE).toString());
    await bp.waitForTimeout(4200);
    mark("buyer", "receipt-page-end");
  }

  await until("paid out", async () => ["CAPTURED", "PAYOUT_RECORDED", "CLOSED"].includes((await state()).sales[0]!.state), 90_000);
  mark("seller", "paid");
  await sp.reload();
  await sp.getByRole("heading", { name: "Past sales" }).waitFor({ timeout: 20_000 });
  await sp.waitForTimeout(1200);
  await sp.getByRole("heading", { name: "Past sales" }).scrollIntoViewIfNeeded();
  await sp.waitForTimeout(3200);
  mark("seller", "past-sales");
  result.finalState = (await state()).sales[0]!.state;
  loop = false;
  await camLoop;
  console.log(`\nDONE. Final deal state: ${result.finalState}`);
} catch (e) {
  failed = true;
  console.error(`\nFAIL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
} finally {
  for (const r of recs) await r.stop();
  await new Promise((r) => setTimeout(r, 600));
  writeFileSync(join(OUT, "marks.json"), JSON.stringify({ marks, result }, null, 2));
  for (const r of recs) encode(r);
  await browsers.laptop.close();
  await browsers.phone.close();
  server.stop();
  http.close();
  process.exit(failed ? 1 : 0);
}
