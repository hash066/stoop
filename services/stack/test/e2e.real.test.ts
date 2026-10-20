// The real product, end to end, with no demo data: a seller sets up a shop with their own pickup
// address, a buyer joins through the listing, pays, claims the pickup pass on their own device, and
// a phone/laptop porch camera provides the before/after photos and the presence signal.
import { describe, expect, it } from "vitest";
import type { VisionAdapter } from "@stoop/verifier";
import { bootStack, http, waitFor } from "./harness.ts";
import { softPasskey } from "./webauthn.ts";
import type { Stack } from "../src/index.ts";

// Stand-in for the vision model: reads markers in the frame bytes (the real one is Bedrock)
const vision: VisionAdapter = {
  name: "test-vision",
  async assess({ frame }) {
    const s = Buffer.from(frame.bytes).toString();
    return { presence: s.includes("ITEM") ? "present" : "absent", rationale: "test", personCount: s.includes("PERSON") ? 1 : 0, adapter: "test-vision" };
  },
};
const img = (text: string) => `data:image/jpeg;base64,${Buffer.from(text).toString("base64")}`;

async function call(stack: Stack, role: "seller" | "buyer", token: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; data: any }> {
  const res = await stack.app.fetch(
    new Request(`http://stoop.test/mcp/${role}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, "MCP-Protocol-Version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const raw = await res.text();
  const msg = JSON.parse(raw.startsWith("{") ? raw : (raw.split("\n").find((l) => l.startsWith("data:")) ?? "data:{}").slice(5));
  const data = msg.result?.structuredContent ?? {};
  // stateless clients get approval_required; the seller (or buyer) confirming is the human "yes"
  // (a purchase code, when the purchase needs one, comes with the yes, as on a voice device)
  if (data.kind === "approval_required" && data.pendingActionId)
    return call(stack, role, token, "confirm_action", { approvalId: data.pendingActionId, decision: "accept", ...(args.voiceCode ? { voiceCode: args.voiceCode } : {}) });
  return { text: (msg.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join(" "), data };
}

describe("real two-device flow with a porch camera (no demo data)", () => {
  it("shop -> photos -> list -> buyer joins -> pays -> claims pass -> porch camera verifies", async () => {
    let skew = 0; // lets the test step past the pass's Face ID unlock
    const stack = await bootStack({ seedDemo: false, frameSource: "porchcam", vision, clock: { now: () => Date.now() + skew } });
    const run = { on: true, scene: "ITEM on the porch" };
    try {
      // Seller: a shop with a real pickup address (encrypted; never in any reply)
      expect((await http(stack, "POST", "/web/shop", { displayName: "Ana", address: "x" })).status).toBe(400);
      const shop = await http(stack, "POST", "/web/shop", { displayName: "Ana", address: "12 Elm St, Springfield, IL", zip: "62704", porchInstructions: "On the bench, left of the door", lockboxCode: "4219" });
      expect(shop.status).toBe(200);
      const seller = shop.json.sellerToken as string;
      // the lockbox code is stored like the address: the shop knows one is set, never what it is
      const st0 = (await http(stack, "GET", "/web/seller/state", undefined, { Authorization: `Bearer ${seller}` })).json;
      expect(st0.shop.lockbox).toBe(true);
      expect(JSON.stringify(st0)).not.toMatch(/4219/);
      expect((await http(stack, "POST", "/web/lockbox", { code: "x" }, { Authorization: `Bearer ${seller}` })).status).toBe(400);
      expect((await http(stack, "POST", "/web/shop", { displayName: "Eve", address: "1 Other St", zip: "11111", porchInstructions: "x" })).status).toBe(409);

      await http(stack, "POST", "/sweep", { photos: [{ name: "jogging-stroller.jpg", dataUrl: img("stroller photo") }] }, { Authorization: `Bearer ${seller}` });
      expect((await call(stack, "seller", seller, "appraise_photos")).text).toMatch(/1 thing you can sell/);
      expect((await call(stack, "seller", seller, "list_items", { items: ["stroller"] })).text).toMatch(/is live at \$120/);
      expect((await call(stack, "seller", seller, "set_mandate", { item: "stroller", floorDollars: 90 })).text).toMatch(/won't go below \$90/);

      // The porch camera page: answers Stoop's frame requests with whatever is on the porch now
      // (the page on the seller's phone gets a camera-only token; it can send porch frames and nothing else)
      const reg = (await http(stack, "POST", "/web/cam/register", {}, { Authorization: `Bearer ${seller}` })).json as { camera: string; camToken: string };
      const cam = reg.camera;
      const camAuth = { Authorization: `Bearer ${reg.camToken}` };
      expect((await http(stack, "POST", "/web/cam/register", {}, { Authorization: `Bearer ${seller}` })).json).toEqual(reg); // same camera until replaced
      expect((await http(stack, "GET", "/web/cam/next", undefined, { Authorization: "Bearer ck_wrong" })).status).toBe(401);
      expect((await http(stack, "GET", "/web/seller/state", undefined, camAuth)).status).toBe(401);
      const camLoop = (async () => {
        while (run.on) {
          const next = await http(stack, "GET", "/web/cam/next", undefined, camAuth);
          if (next.json?.want) await http(stack, "POST", "/web/cam/frame", { dataUrl: img(run.scene) }, camAuth);
          await new Promise((r) => setTimeout(r, 20));
        }
      })();

      // Buyer: joins through the listing (public view has no address), haggles, pays
      const found = await call(stack, "buyer", "nobody", "search_listings", { query: "stroller" }).catch(() => ({ text: "", data: {} }));
      expect(found.text).not.toMatch(/stroller/i); // unauthenticated: nothing
      const buyer = (await http(stack, "POST", "/web/buyer", { displayName: "Ben", purchaseCode: "2580" })).json.buyerToken as string;
      const search = await call(stack, "buyer", buyer, "search_listings", { query: "stroller", maxPriceDollars: 150 });
      const listingId = search.data.results[0].listingId as string;
      const pub = await http(stack, "GET", `/web/listing/${listingId}`);
      expect(pub.json).toMatchObject({ title: "Three-wheel jogging stroller", askMinor: 120_00, zip: "62704" });
      expect(JSON.stringify(pub.json)).not.toMatch(/Elm St/);
      await call(stack, "buyer", buyer, "make_offer", { listingId, amountDollars: 95 });
      // both dashboards see the offer waiting on the seller
      const sst = (await http(stack, "GET", "/web/seller/state", undefined, { Authorization: `Bearer ${seller}` })).json;
      expect(sst.offers).toEqual([expect.objectContaining({ listingId, amountMinor: 95_00, askMinor: 120_00 })]);
      expect(sst.items[0]).toMatchObject({ title: "Three-wheel jogging stroller", priceSource: "comps", listing: { id: listingId, state: "LIVE" } });
      expect(sst.conversations[0].offers[0]).toMatchObject({ by: "buyer", amountMinor: 95_00 });
      const bst = (await http(stack, "GET", `/web/buyer/state?listing=${listingId}`, undefined, { Authorization: `Bearer ${buyer}` })).json;
      expect(bst).toMatchObject({ me: { displayName: "Ben" }, negotiation: { state: "AGREED_PENDING_SELLER", pendingAmountMinor: 95_00 }, deals: [] });
      expect((await http(stack, "GET", "/web/seller/state", undefined, { Authorization: `Bearer ${buyer}` })).status).toBe(401);
      const accepted = await call(stack, "seller", seller, "respond_to_offer", { decision: "accept" });
      const dealId = accepted.data.dealId as string;
      expect((await call(stack, "buyer", buyer, "checkout", {})).text).toMatch(/held, not charged/);

      // Window opens at once; the porch camera supplies the before photo
      await waitFor(async () => (await stack.settlement.getDeal(dealId)).state === "WINDOW_OPEN", 5000, "window", stack);
      await waitFor(async () => (await stack.store.get<{ before?: unknown }>(`evidence#${dealId}`))?.before, 5000, "before frame", stack);

      // The buyer's own device claims the pass, consents, sees the address inside the window
      const passId = (await stack.settlement.getDeal(dealId)).passId!;
      const dev = { "X-Stoop-Device": "ben-phone-000001" };
      expect((await http(stack, "POST", `/web/pass/${passId}/claim`, {}, { Authorization: `Bearer ${seller}`, ...dev })).status).toBe(401);
      expect((await http(stack, "POST", `/web/pass/${passId}/claim`, {}, { Authorization: `Bearer ${buyer}`, ...dev })).status).toBe(200);
      await http(stack, "POST", `/pass/${passId}/consent`, {}, dev);
      const beforeCheckIn = (await http(stack, "GET", `/pass/${passId}`, undefined, dev)).json;
      expect(beforeCheckIn).toMatchObject({ address: "12 Elm St, Springfield, IL", hasLockbox: true });
      expect(beforeCheckIn.lockbox).toBeUndefined(); // only after "I'm here"

      // The buyer locks the pass with Face ID (a passkey that stays on their phone). Afterwards the
      // address, the lockbox code and the check-in need a fresh unlock on that same phone.
      const phone = softPasskey("http://localhost:5180");
      expect((await http(stack, "POST", `/pass/${passId}/lock/options`, {}, { "X-Stoop-Device": "someone-elses-phone" })).status).toBe(403);
      const lockOpts = (await http(stack, "POST", `/pass/${passId}/lock/options`, {}, dev)).json;
      expect(lockOpts.authenticatorSelection).toMatchObject({ authenticatorAttachment: "platform", userVerification: "required" });
      expect((await http(stack, "POST", `/pass/${passId}/lock`, phone.register(lockOpts), dev)).json).toMatchObject({ locked: true });
      expect((await http(stack, "GET", `/pass/${passId}`, undefined, dev)).json).toMatchObject({ passkey: true, locked: false, address: "12 Elm St, Springfield, IL" });
      skew = 11 * 60_000; // the unlock lasts ten minutes
      const locked = (await http(stack, "GET", `/pass/${passId}`, undefined, dev)).json;
      expect(locked).toMatchObject({ passkey: true, locked: true });
      expect(locked.address).toBeUndefined();
      expect((await http(stack, "POST", `/pass/${passId}/checkin`, {}, dev)).status).toBe(423);
      // a response without user verification (no Face ID, no fingerprint) doesn't unlock it
      const opts1 = (await http(stack, "POST", `/pass/${passId}/unlock/options`, {}, dev)).json;
      expect((await http(stack, "POST", `/pass/${passId}/unlock`, phone.authenticate(opts1, { verified: false }), dev)).status).toBe(400);
      // nor does replaying an old answer; a fresh Face ID does
      const opts2 = (await http(stack, "POST", `/pass/${passId}/unlock/options`, {}, dev)).json;
      const answer = phone.authenticate(opts2);
      expect((await http(stack, "POST", `/pass/${passId}/unlock`, answer, dev)).status).toBe(200);
      expect((await http(stack, "POST", `/pass/${passId}/unlock`, answer, dev)).status).toBe(410);
      expect((await http(stack, "GET", `/pass/${passId}`, undefined, dev)).json).toMatchObject({ locked: false, address: "12 Elm St, Springfield, IL" });

      // At the door: the buyer taps "I'm here" first (a pickup without a check-in is treated as
      // someone else taking the item), takes it, and the camera's motion frame shows a person
      expect((await http(stack, "POST", `/pass/${passId}/checkin`, {}, dev)).status).toBe(200);
      expect((await http(stack, "GET", `/pass/${passId}`, undefined, dev)).json.lockbox).toBe("4219");
      expect((await http(stack, "GET", `/pass/${passId}`, undefined, { "X-Stoop-Device": "someone-elses-phone" })).status).toBe(403);
      run.scene = "empty porch";
      await http(stack, "POST", "/web/cam/frame", { dataUrl: img("PERSON at the door"), motion: true }, camAuth);
      await waitFor(async () => ((await stack.store.get<{ ringEvents: unknown[] }>(`evidence#${dealId}`))?.ringEvents ?? []).length > 0, 5000, "presence", stack);
      await waitFor(async () => ["VERIFIED", "INSPECTION"].includes((await stack.settlement.getDeal(dealId)).state), 8000, "verified", stack);

      const ev = await stack.store.get<{ ringEvents: Array<{ origin: string; subType?: string }>; before: { presence: string; origin: string }; after: { presence: string } }>(`evidence#${dealId}`);
      expect(ev?.ringEvents[0]).toMatchObject({ origin: "porchcam", subType: "human" });
      expect(ev?.before).toMatchObject({ presence: "present", origin: "porchcam" });
      expect(ev?.after.presence).toBe("absent");
      const deal = await stack.settlement.getDeal(dealId);
      expect(deal.verdict).toBe("VERIFIED");
      expect(deal.receiptIds).toHaveLength(1);

      // the buyer reviews the pickup; the review carries the signed receipt (a verified pickup, provable)
      expect((await http(stack, "POST", "/web/review", { dealId, rating: 5, text: "Easy pickup" }, { Authorization: `Bearer ${seller}` })).status).toBe(401);
      const rev = await http(stack, "POST", "/web/review", { dealId, rating: 5, text: "Easy pickup" }, { Authorization: `Bearer ${buyer}` });
      expect(rev.status).toBe(200);
      expect(rev.json.review).toMatchObject({ rating: 5, verified: true, receiptId: deal.receiptIds[0], by: "Ben" });
      expect((await http(stack, "POST", "/web/review", { dealId, rating: 1 }, { Authorization: `Bearer ${buyer}` })).status).toBe(409);
      expect((await http(stack, "GET", "/web/storefront")).json.rating).toMatchObject({ avg: 5, count: 1, verified: 1 });

      // the seller's dashboard shows the whole path and the porch photos; buyers never get the photos
      const sale = (await http(stack, "GET", "/web/seller/state", undefined, { Authorization: `Bearer ${seller}` })).json.sales[0];
      expect(sale).toMatchObject({ dealId, verdict: "VERIFIED", before: { presence: "present" }, after: { presence: "absent" }, presenceEvents: 1, payoutMinor: 95_00 - 4_75 });
      expect(sale.checkInAt).toBeGreaterThan(0);
      const photo = await stack.app.fetch(new Request(`http://stoop.test/web/frame/${dealId}/before`, { headers: { Authorization: `Bearer ${seller}` } }));
      expect(photo.status).toBe(200);
      expect(Buffer.from(await photo.arrayBuffer()).toString()).toContain("ITEM");
      expect((await http(stack, "GET", `/web/frame/${dealId}/before`, undefined, { Authorization: `Bearer ${buyer}` })).status).toBe(401);
      const mine = (await http(stack, "GET", `/web/buyer/state?listing=${listingId}`, undefined, { Authorization: `Bearer ${buyer}` })).json.deals[0];
      expect(mine).toMatchObject({ dealId, passId, state: "INSPECTION", active: true });

      // a new phone takes over as the camera; the old page is told it was replaced
      const next = (await http(stack, "POST", "/web/cam/register", { fresh: true }, { Authorization: `Bearer ${seller}` })).json as { camera: string; camToken: string };
      expect(next.camera).not.toBe(cam);
      run.on = false;
      await camLoop;
      expect((await http(stack, "GET", "/web/cam/next", undefined, camAuth)).status).toBe(410);
      expect((await http(stack, "POST", "/web/cam/frame", { dataUrl: img("x") }, camAuth)).status).toBe(410);
      expect((await http(stack, "GET", "/web/cam/next", undefined, { Authorization: `Bearer ${next.camToken}` })).status).toBe(200);
    } finally {
      run.on = false;
      stack.stop();
    }
  }, 30_000);

  it("without a porch camera the pickup falls back to both people confirming (never a guess)", async () => {
    const stack = await bootStack({ seedDemo: false, frameSource: "porchcam", vision });
    try {
      const seller = (await http(stack, "POST", "/web/shop", { displayName: "Ana", address: "12 Elm St, Springfield, IL", zip: "62704", porchInstructions: "Bench" })).json.sellerToken as string;
      await http(stack, "POST", "/sweep", { photos: [{ name: "jogging-stroller.jpg", dataUrl: img("stroller") }] }, { Authorization: `Bearer ${seller}` });
      await call(stack, "seller", seller, "appraise_photos");
      await call(stack, "seller", seller, "list_items", { items: ["stroller"] });
      const buyer = (await http(stack, "POST", "/web/buyer", { displayName: "Ben", purchaseCode: "2580" })).json.buyerToken as string;
      const listingId = (await call(stack, "buyer", buyer, "search_listings", { query: "stroller" })).data.results[0].listingId;
      await call(stack, "buyer", buyer, "make_offer", { listingId, amountDollars: 120 });
      const dealId = (await call(stack, "seller", seller, "respond_to_offer", { decision: "accept" })).data.dealId;
      expect((await call(stack, "buyer", buyer, "checkout", { voiceCode: "2580" })).text).toMatch(/held, not charged/);
      // no camera was ever connected: "unavailable", so the deal needs both people's confirmation
      await waitFor(async () => (await stack.store.get<{ camera?: string }>(`evidence#${dealId}`))?.camera === "unavailable", 5000, "camera unavailable", stack);
      expect((await stack.settlement.getDeal(dealId)).state).toBe("DEGRADED");
    } finally {
      stack.stop();
    }
  }, 30_000);
});
