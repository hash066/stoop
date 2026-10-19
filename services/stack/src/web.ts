// The web product's own API (mounted at /web in each shop's world): a real seller with a real
// pickup address, buyers who arrive through a listing link, a pickup pass claimed by the buyer's own
// device, and the porch camera. Everything that moves money or reveals the address still goes
// through Settlement and the MCP tools; these routes only set people and devices up.
import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { BuyerActor, SellerActor } from "@stoop/mcp-server";
import type { EventBus, Settlement } from "@stoop/settlement";
import type { VisionAdapter } from "@stoop/verifier";
import { frameFromDataUrl, type PorchCamSource } from "./porchcam.ts";

export interface WebDeps {
  settlement: Settlement;
  sellers: Map<string, SellerActor>;
  buyers: Map<string, BuyerActor>;
  otps: Map<string, string>;
  porchcam: PorchCamSource;
  vision: VisionAdapter;
  bus: EventBus;
  now: () => number;
}

const ShopInput = z.object({
  displayName: z.string().trim().min(1).max(60),
  address: z.string().trim().min(5).max(200),
  zip: z.string().trim().regex(/^[A-Za-z0-9 -]{3,10}$/),
  porchInstructions: z.string().trim().min(1).max(300),
});
const BuyerInput = z.object({
  displayName: z.string().trim().min(1).max(40),
  purchaseCode: z.string().regex(/^\d{4}$/),
});

const bearer = (c: Context) => {
  const h = c.req.header("Authorization");
  return h?.startsWith("Bearer ") ? h.slice(7) : "";
};
const token = (prefix: string) => `${prefix}_${randomBytes(18).toString("base64url")}`;
const deviceHeader = (c: Context) => {
  const d = c.req.header("X-Stoop-Device") ?? "";
  return /^[A-Za-z0-9_-]{8,64}$/.test(d) ? d : "";
};

export function webRouter(d: WebDeps) {
  const web = new Hono();
  const seller = (c: Context) => d.sellers.get(bearer(c));
  const buyer = (c: Context) => d.buyers.get(bearer(c));
  const lastPresenceCheck = new Map<string, number>();

  // ---- seller: one shop (household) per world, with the seller's own pickup address
  web.post("/shop", async (c) => {
    if (d.sellers.size > 0) return c.json({ error: "shop_exists", message: "This shop is already set up." }, 409);
    const p = ShopInput.safeParse(await c.req.json().catch(() => undefined));
    if (!p.success) return c.json({ error: "invalid", fields: p.error.issues.map((i) => i.path.join(".")) }, 400);
    const hh = await d.settlement.createHousehold(p.data);
    const t = token("sk");
    d.sellers.set(t, { kind: "seller", householdId: hh.id, displayName: hh.displayName });
    return c.json({ sellerToken: t, householdId: hh.id });
  });

  // ---- buyers join through a listing link; the 4-digit purchase code works like a voice-purchase PIN
  web.post("/buyer", async (c) => {
    if (d.buyers.size >= 50) return c.json({ error: "full", message: "This shop has enough buyers for now." }, 429);
    const p = BuyerInput.safeParse(await c.req.json().catch(() => undefined));
    if (!p.success) return c.json({ error: "invalid", fields: p.error.issues.map((i) => i.path.join(".")) }, 400);
    const id = `buyer_${randomBytes(6).toString("hex")}`;
    // Test payments only: no card ever reaches Stoop; the wallet is the sandbox processor's test token
    const b = await d.settlement.createBuyer({ id, displayName: p.data.displayName, email: `${id}@buyers.stoop.invalid`, voiceCode: p.data.purchaseCode, walletToken: "tok_visa_4242" });
    const t = token("bk");
    d.buyers.set(t, { kind: "buyer", buyerId: b.id, displayName: b.displayName, token: t, walletToken: "tok_visa_4242" });
    return c.json({ buyerToken: t, buyerId: b.id });
  });

  web.get("/me", async (c) => {
    const s = seller(c);
    if (s) {
      const hh = await d.settlement.householdPublic(s.householdId);
      return c.json({ role: "seller", displayName: s.displayName, zip: hh.zip, porchInstructions: hh.porchInstructions, camera: hh.ringDeviceId && d.porchcam.has(hh.ringDeviceId) ? { id: hh.ringDeviceId, ...d.porchcam.status(hh.ringDeviceId) } : null });
    }
    const b = buyer(c);
    if (b) return c.json({ role: "buyer", displayName: b.displayName, buyerId: b.buyerId });
    return c.json({ role: "visitor" });
  });

  // ---- public listing view for the link a seller shares (no address, ever)
  web.get("/listing/:id", async (c) => {
    try {
      const l = await d.settlement.getListing(c.req.param("id"));
      return c.json({ id: l.id, title: l.title, description: l.description, askMinor: l.askMinor, state: l.state, zip: l.zip, photoUrls: l.photoUrls });
    } catch {
      return c.json({ error: "not_found", message: "This listing doesn't exist or was removed." }, 404);
    }
  });

  // ---- the buyer's own device claims the pickup pass (the emailed one-time code is for other devices)
  web.post("/pass/:id/claim", async (c) => {
    const b = buyer(c);
    const dev = deviceHeader(c);
    if (!b || !dev) return c.json({ error: "unauthorized" }, 401);
    const passId = c.req.param("id");
    const owns = (await d.settlement.dealsForBuyer(b.buyerId)).some((deal) => deal.passId === passId);
    if (!owns) return c.json({ error: "not_your_pass" }, 403);
    const otp = d.otps.get(passId);
    if (!otp) return c.json({ error: "pass_not_ready", message: "Your pass is still being issued. Try again in a moment." }, 409);
    try {
      return c.json(await d.settlement.bindPass(passId, otp, dev));
    } catch (e) {
      return c.json({ error: "bind_failed", message: e instanceof Error ? e.message : "Couldn't open this pass on this device." }, 409);
    }
  });

  // ---- porch camera
  web.post("/cam/register", async (c) => {
    const s = seller(c);
    if (!s) return c.json({ error: "unauthorized" }, 401);
    const id = d.porchcam.register();
    await d.settlement.setHouseholdDevice(s.householdId, id);
    d.bus.emit({ type: "porchcam_registered", at: d.now(), camera: id });
    return c.json({ camera: id });
  });
  web.get("/cam/next", (c) => {
    const s = seller(c);
    const cam = c.req.query("cam") ?? "";
    if (!s || !d.porchcam.has(cam)) return c.json({ error: "unauthorized" }, 401);
    return c.json({ want: d.porchcam.wants(cam) });
  });
  web.post("/cam/frame", async (c) => {
    const s = seller(c);
    const body = (await c.req.json().catch(() => ({}))) as { cam?: string; dataUrl?: string; motion?: boolean };
    if (!s || !body.cam || !d.porchcam.has(body.cam) || !body.dataUrl) return c.json({ error: "unauthorized" }, 401);
    let frame;
    try {
      frame = frameFromDataUrl(body.dataUrl, d.now());
    } catch (e) {
      return c.json({ error: "bad_frame", message: e instanceof Error ? e.message : "bad frame" }, 400);
    }
    d.porchcam.put(body.cam, frame);
    if (body.motion) void checkPresence(s, body.cam, frame);
    return c.json({ ok: true });
  });

  /**
   * Motion at the door: if a pickup is in progress, ask the vision model whether a person is in the
   * frame (counted, never identified). A yes becomes a presence event, the same signal a doorbell's
   * person alert gives, labelled origin "porchcam". At most one check per camera every 10 seconds.
   */
  async function checkPresence(s: SellerActor, cam: string, frame: ReturnType<typeof frameFromDataUrl>) {
    const t = d.now();
    if (t - (lastPresenceCheck.get(cam) ?? 0) < 10_000) return;
    const active = (await d.settlement.dealsForHousehold(s.householdId)).find((x) => x.state === "WINDOW_OPEN" || x.state === "STILL_THERE");
    if (!active) return;
    lastPresenceCheck.set(cam, t);
    const v = await d.vision.assess({ frame, itemTitle: active.itemTitle }).catch(() => undefined);
    d.bus.emit({ type: "porchcam_motion", at: t, dealId: active.id, personCount: v?.personCount ?? null });
    if (!v?.personCount) return;
    const requestId = `porchcam_${createHash("sha256").update(frame.bytes).digest("hex").slice(0, 16)}`;
    await d.settlement.ingestRingEvent({ kind: "motion_detected", subType: "human", at: frame.at, deviceId: cam, requestId, origin: "porchcam" });
  }

  return web;
}
