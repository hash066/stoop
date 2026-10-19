// The real product, end to end, with no demo data: a seller sets up a shop with their own pickup
// address, a buyer joins through the listing, pays, claims the pickup pass on their own device, and
// a phone/laptop porch camera provides the before/after photos and the presence signal.
import { describe, expect, it } from "vitest";
import type { VisionAdapter } from "@stoop/verifier";
import { bootStack, http, waitFor } from "./harness.ts";
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
    const stack = await bootStack({ seedDemo: false, frameSource: "porchcam", vision });
    const run = { on: true, scene: "ITEM on the porch" };
    try {
      // Seller: a shop with a real pickup address (encrypted; never in any reply)
      expect((await http(stack, "POST", "/web/shop", { displayName: "Ana", address: "x" })).status).toBe(400);
      const shop = await http(stack, "POST", "/web/shop", { displayName: "Ana", address: "12 Elm St, Springfield, IL", zip: "62704", porchInstructions: "On the bench, left of the door" });
      expect(shop.status).toBe(200);
      const seller = shop.json.sellerToken as string;
      expect((await http(stack, "POST", "/web/shop", { displayName: "Eve", address: "1 Other St", zip: "11111", porchInstructions: "x" })).status).toBe(409);

      await http(stack, "POST", "/sweep", { photos: [{ name: "jogging-stroller.jpg", dataUrl: img("stroller photo") }] }, { Authorization: `Bearer ${seller}` });
      expect((await call(stack, "seller", seller, "appraise_photos")).text).toMatch(/1 thing you can sell/);
      expect((await call(stack, "seller", seller, "list_items", { items: ["stroller"] })).text).toMatch(/is live at \$120/);
      expect((await call(stack, "seller", seller, "set_mandate", { item: "stroller", floorDollars: 90 })).text).toMatch(/won't go below \$90/);

      // The porch camera page: answers Stoop's frame requests with whatever is on the porch now
      const cam = (await http(stack, "POST", "/web/cam/register", {}, { Authorization: `Bearer ${seller}` })).json.camera as string;
      const camLoop = (async () => {
        while (run.on) {
          const next = await http(stack, "GET", `/web/cam/next?cam=${cam}`, undefined, { Authorization: `Bearer ${seller}` });
          if (next.json?.want) await http(stack, "POST", "/web/cam/frame", { cam, dataUrl: img(run.scene) }, { Authorization: `Bearer ${seller}` });
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
      expect(pub.json).toMatchObject({ title: "BOB Revolution jogging stroller", askMinor: 120_00, zip: "62704" });
      expect(JSON.stringify(pub.json)).not.toMatch(/Elm St/);
      await call(stack, "buyer", buyer, "make_offer", { listingId, amountDollars: 95 });
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
      expect((await http(stack, "GET", `/pass/${passId}`, undefined, dev)).json.address).toBe("12 Elm St, Springfield, IL");

      // At the door: the buyer taps "I'm here" first (a pickup without a check-in is treated as
      // someone else taking the item), takes it, and the camera's motion frame shows a person
      expect((await http(stack, "POST", `/pass/${passId}/checkin`, {}, dev)).status).toBe(200);
      run.scene = "empty porch";
      await http(stack, "POST", "/web/cam/frame", { cam, dataUrl: img("PERSON at the door"), motion: true }, { Authorization: `Bearer ${seller}` });
      await waitFor(async () => ((await stack.store.get<{ ringEvents: unknown[] }>(`evidence#${dealId}`))?.ringEvents ?? []).length > 0, 5000, "presence", stack);
      await waitFor(async () => ["VERIFIED", "INSPECTION"].includes((await stack.settlement.getDeal(dealId)).state), 8000, "verified", stack);

      const ev = await stack.store.get<{ ringEvents: Array<{ origin: string; subType?: string }>; before: { presence: string; origin: string }; after: { presence: string } }>(`evidence#${dealId}`);
      expect(ev?.ringEvents[0]).toMatchObject({ origin: "porchcam", subType: "human" });
      expect(ev?.before).toMatchObject({ presence: "present", origin: "porchcam" });
      expect(ev?.after.presence).toBe("absent");
      const deal = await stack.settlement.getDeal(dealId);
      expect(deal.verdict).toBe("VERIFIED");
      expect(deal.receiptIds).toHaveLength(1);
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
