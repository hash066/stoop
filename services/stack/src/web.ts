// The web product's own API (mounted at /web in each shop's world): a real seller with a real
// pickup address, buyers who arrive through a listing link, a pickup pass claimed by the buyer's own
// device, and the porch camera. Everything that moves money or reveals the address still goes
// through Settlement and the MCP tools; these routes set people and devices up and read state.
import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { BuyerActor, SellerActor } from "@stoop/mcp-server";
import type { Deal, EventBus, Item, Settlement, Store } from "@stoop/settlement";
import type { VisionAdapter } from "@stoop/verifier";
import { frameFromDataUrl, type PorchCamSource } from "./porchcam.ts";

export interface WebDeps {
  settlement: Settlement;
  store: Store;
  sellers: Map<string, SellerActor>;
  buyers: Map<string, BuyerActor>;
  otps: Map<string, string>;
  porchcam: PorchCamSource;
  vision: VisionAdapter;
  bus: EventBus;
  now: () => number;
  /** The latest before/after porch frame the verifier assessed, for the seller's own dashboard. */
  frame?: (dealId: string, kind: "before" | "after") => { bytes: Uint8Array; mime: string } | undefined;
  /** Camera links (token -> camera) and owners; passed in so a snapshot can save them. */
  camTokens?: Map<string, { cam: string; householdId: string }>;
  camOwner?: Map<string, string>;
}

const ShopInput = z.object({
  displayName: z.string().trim().min(1).max(60),
  address: z.string().trim().min(5).max(200),
  zip: z.string().trim().regex(/^[A-Za-z0-9 -]{3,10}$/),
  porchInstructions: z.string().trim().min(1).max(300),
  /** Optional: a combination lockbox's code; the buyer's pass shows it only after check-in. */
  lockboxCode: z.union([z.literal(""), z.string().trim().regex(/^[A-Za-z0-9 -]{3,12}$/)]).optional(),
});
const ReviewInput = z.object({
  dealId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  text: z.string().trim().max(280).optional(),
});

/** A buyer's review of a pickup. `receiptId` points at the signed proof-of-handoff receipt for it. */
export interface ShopReview {
  dealId: string;
  listingId: string;
  itemTitle: string;
  rating: number;
  text?: string;
  by: string;
  receiptId?: string;
  verified: boolean;
  at: number;
}

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
const DONE = ["CLOSED", "VOIDED", "CHECKOUT_ABANDONED", "SELLER_CANCELLED", "PIRACY_SUSPECTED", "NO_SHOW"];
const priceSource = (it: Item) => (it.comps.length ? "comps" : it.priceBand.listMinor > 0 ? "ai-estimate" : "none");

export function webRouter(d: WebDeps) {
  const web = new Hono();
  const seller = (c: Context) => d.sellers.get(bearer(c));
  const buyer = (c: Context) => d.buyers.get(bearer(c));
  const lastPresenceCheck = new Map<string, number>();
  // camera link tokens: they can only send porch frames, nothing else
  const camTokens = d.camTokens ?? new Map<string, { cam: string; householdId: string }>();
  const camOwner = d.camOwner ?? new Map<string, string>(); // camera id -> household id

  /** The porch camera page authenticates with its own camera token, or the seller's token plus the camera id. */
  const camAuth = (c: Context, cam?: string) => {
    const t = camTokens.get(bearer(c));
    if (t) return t;
    const s = seller(c);
    if (s && cam && camOwner.get(cam) === s.householdId) return { cam, householdId: s.householdId };
    return undefined;
  };

  // ---- seller: one shop (household) per world, with the seller's own pickup address
  web.post("/shop", async (c) => {
    if (d.sellers.size > 0) return c.json({ error: "shop_exists", message: "This shop is already set up." }, 409);
    const p = ShopInput.safeParse(await c.req.json().catch(() => undefined));
    if (!p.success) return c.json({ error: "invalid", fields: p.error.issues.map((i) => i.path.join(".")) }, 400);
    const hh = await d.settlement.createHousehold({ ...p.data, lockboxCode: p.data.lockboxCode || undefined });
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
      return c.json({ role: "seller", displayName: s.displayName, zip: hh.zip, porchInstructions: hh.porchInstructions, camera: cameraOf(hh.ringDeviceId) });
    }
    const b = buyer(c);
    if (b) return c.json({ role: "buyer", displayName: b.displayName, buyerId: b.buyerId });
    return c.json({ role: "visitor" });
  });

  const cameraOf = (id?: string) => (id && d.porchcam.has(id) ? { id, ...d.porchcam.status(id) } : null);

  // ---- public storefront and listing view for the links a seller shares (no address, ever)
  web.get("/storefront", async (c) => {
    const s = [...d.sellers.values()][0];
    if (!s) return c.json({ error: "not_found", message: "This shop doesn't exist." }, 404);
    const hh = await d.settlement.householdPublic(s.householdId);
    const listings = (await d.settlement.listingsForHousehold(s.householdId)).filter((l) => l.state === "LIVE" || l.state === "RESERVED");
    return c.json({
      displayName: hh.displayName,
      zip: hh.zip,
      ...(await reviewSummary(true)),
      listings: listings.map((l) => ({ id: l.id, title: l.title, askMinor: l.askMinor, state: l.state, photoUrl: l.photoUrls[0] })),
    });
  });
  // ---- reviews: only the buyer of a finished sale can write one, once; a camera-verified pickup's
  // review carries its signed receipt, so anyone can check it happened (like a verified purchase, provable)
  web.post("/review", async (c) => {
    const b = buyer(c);
    if (!b) return c.json({ error: "unauthorized" }, 401);
    const p = ReviewInput.safeParse(await c.req.json().catch(() => undefined));
    if (!p.success) return c.json({ error: "invalid", fields: p.error.issues.map((i) => i.path.join(".")) }, 400);
    const deal = await d.settlement.getDeal(p.data.dealId).catch(() => undefined);
    if (!deal || deal.buyerId !== b.buyerId) return c.json({ error: "not_found" }, 404);
    if (!["INSPECTION", "CAPTURED", "PAYOUT_RECORDED", "CLOSED"].includes(deal.state)) return c.json({ error: "too_early", message: "You can review once you have the item." }, 409);
    const receiptId = deal.receiptIds.at(-1);
    const review: ShopReview = {
      dealId: deal.id,
      listingId: deal.listingId,
      itemTitle: deal.itemTitle,
      rating: p.data.rating,
      text: p.data.text || undefined,
      by: b.displayName.split(/\s+/)[0]!.slice(0, 24),
      receiptId,
      verified: !!receiptId && deal.verdict === "VERIFIED",
      at: d.now(),
    };
    if (!(await d.store.put(`review#${deal.id}`, review, { ifAbsent: true }))) return c.json({ error: "already_reviewed", message: "You already reviewed this pickup." }, 409);
    d.bus.emit({ type: "review_posted", at: d.now(), dealId: deal.id, rating: review.rating, verified: review.verified });
    return c.json({ ok: true, review });
  });
  web.get("/reviews", async (c) => c.json(await reviewSummary(true)));
  async function reviewSummary(withList = false) {
    const all = (await d.store.list<ShopReview>("review#")).sort((a, b) => b.at - a.at);
    const avg = all.length ? Math.round((all.reduce((t, r) => t + r.rating, 0) / all.length) * 10) / 10 : null;
    return { rating: { avg, count: all.length, verified: all.filter((r) => r.verified).length }, ...(withList ? { reviews: all.slice(0, 30) } : {}) };
  }

  web.get("/listing/:id", async (c) => {
    try {
      const l = await d.settlement.getListing(c.req.param("id"));
      return c.json({ id: l.id, title: l.title, description: l.description, askMinor: l.askMinor, state: l.state, zip: l.zip, photoUrls: l.photoUrls });
    } catch {
      return c.json({ error: "not_found", message: "This listing doesn't exist or was removed." }, 404);
    }
  });

  // ---- the seller's dashboard: their items, offers, conversations and sales (their own data only)
  web.get("/seller/state", async (c) => {
    const s = seller(c);
    if (!s) return c.json({ error: "unauthorized" }, 401);
    const st = d.settlement;
    const hh = await st.householdPublic(s.householdId);
    const [items, listings, deals] = await Promise.all([st.itemsForHousehold(s.householdId), st.listingsForHousehold(s.householdId), st.dealsForHousehold(s.householdId)]);
    const label = async (buyerId: string) => (await st.buyerPublic(buyerId).catch(() => undefined))?.label ?? "A buyer";
    const offers = [];
    const conversations = [];
    for (const l of listings) {
      for (const n of await st.negotiationsFor(l.id)) {
        const who = await label(n.buyerId);
        if (n.offers.length) conversations.push({ listingId: l.id, title: l.title, buyer: who, state: n.state, updatedAt: n.updatedAt, offers: n.offers.slice(-8) });
        if (n.state !== "AGREED_PENDING_SELLER" || !n.pendingApprovalId) continue;
        const appr = await st.getApproval(n.pendingApprovalId).catch(() => undefined);
        if (appr?.status !== "pending") continue;
        offers.push({ approvalId: appr.id, listingId: l.id, title: l.title, amountMinor: n.pendingAmountMinor!, askMinor: l.askMinor, buyer: who, at: appr.createdAt });
      }
    }
    const sales = [];
    for (const deal of deals.sort((a, b) => b.createdAt - a.createdAt)) sales.push({ ...(await saleView(deal)), buyer: await label(deal.buyerId) });
    return c.json({
      shop: { displayName: hh.displayName, zip: hh.zip, porchInstructions: hh.porchInstructions, camera: cameraOf(hh.ringDeviceId), lockbox: hh.lockbox },
      items: items.map((it) => {
        const l = listings.filter((x) => x.itemId === it.id).sort((a, b) => b.updatedAt - a.updatedAt)[0];
        return {
          itemId: it.id,
          title: it.title,
          category: it.category,
          condition: it.condition,
          photoUrl: it.photoUrls[0],
          listMinor: it.priceBand.listMinor,
          quickSaleMinor: it.priceBand.quickSaleMinor,
          floorSuggestionMinor: it.priceBand.floorSuggestionMinor,
          priceSource: priceSource(it),
          comps: it.comps.length,
          blocked: it.recall.blocked,
          blockedReason: it.recall.reason,
          alternative: it.recall.alternative,
          listing: l ? { id: l.id, state: l.state, askMinor: l.askMinor } : null,
        };
      }),
      offers: offers.sort((a, b) => b.at - a.at),
      conversations: conversations.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12),
      sales,
    });
  });

  // ---- the buyer's view of one listing: their conversation with the seller's assistant and their purchases
  web.get("/buyer/state", async (c) => {
    const b = buyer(c);
    if (!b) return c.json({ error: "unauthorized" }, 401);
    const listingId = c.req.query("listing");
    const st = d.settlement;
    const negos = listingId ? (await st.negotiationsFor(listingId)).filter((n) => n.buyerId === b.buyerId).sort((a, x) => x.updatedAt - a.updatedAt) : [];
    const n = negos[0];
    const deals = (await st.dealsForBuyer(b.buyerId)).sort((a, x) => x.createdAt - a.createdAt);
    const reviewed = new Set((await d.store.list<ShopReview>("review#")).map((r) => r.dealId));
    return c.json({
      me: { displayName: b.displayName },
      negotiation: n ? { state: n.state, offers: negos.flatMap((x) => x.offers).sort((a, x) => a.at - x.at).slice(-16), lastCounterMinor: n.lastCounterMinor, pendingAmountMinor: n.pendingAmountMinor } : null,
      deals: deals.map((deal) => ({
        dealId: deal.id,
        listingId: deal.listingId,
        title: deal.itemTitle,
        state: deal.state,
        amountMinor: deal.amountMinor,
        totalMinor: st.buyerTotalMinor(deal),
        window: deal.window ?? null,
        passId: deal.passId ?? null,
        verdict: deal.verdict ?? null,
        active: !DONE.includes(deal.state),
        reviewed: reviewed.has(deal.id),
      })),
    });
  });

  async function saleView(deal: Deal) {
    const ev = await d.settlement.getEvidence(deal.id).catch(() => undefined);
    const checkInAt = await d.settlement.checkInAt(deal.id).catch(() => undefined);
    return {
      dealId: deal.id,
      listingId: deal.listingId,
      title: deal.itemTitle,
      state: deal.state,
      amountMinor: deal.amountMinor,
      feeMinor: deal.sellerFeeMinor,
      payoutMinor: deal.amountMinor - deal.sellerFeeMinor,
      window: deal.window ?? null,
      verdict: deal.verdict ?? null,
      checkInAt: checkInAt ?? null,
      camera: ev?.camera ?? null,
      before: ev?.before ? { presence: ev.before.presence, at: ev.before.at } : null,
      after: ev?.after ? { presence: ev.after.presence, at: ev.after.at } : null,
      presenceEvents: ev?.ringEvents.length ?? 0,
      dual: deal.dual,
      receiptId: deal.receiptIds.at(-1) ?? null,
      history: deal.history.map((h) => ({ state: h.state, at: h.at })),
      active: !DONE.includes(deal.state),
    };
  }

  // ---- the porch photos of a sale, for that sale's seller only (never shown to buyers)
  web.get("/frame/:dealId/:kind", async (c) => {
    const s = seller(c);
    const kind = c.req.param("kind");
    if (!s || (kind !== "before" && kind !== "after")) return c.json({ error: "unauthorized" }, 401);
    const deal = await d.settlement.getDeal(c.req.param("dealId")).catch(() => undefined);
    if (!deal || deal.householdId !== s.householdId) return c.json({ error: "not_found" }, 404);
    const f = d.frame?.(deal.id, kind);
    if (!f) return c.json({ error: "not_found" }, 404);
    return new Response(Buffer.from(f.bytes), { headers: { "Content-Type": f.mime, "Cache-Control": "private, no-store" } });
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

  // ---- lockbox code: set, change or remove (empty). Encrypted like the address.
  web.post("/lockbox", async (c) => {
    const s = seller(c);
    if (!s) return c.json({ error: "unauthorized" }, 401);
    const code = String(((await c.req.json().catch(() => ({}))) as { code?: unknown }).code ?? "").trim();
    if (code && !/^[A-Za-z0-9 -]{3,12}$/.test(code)) return c.json({ error: "invalid", fields: ["code"], message: "Use 3 to 12 letters or digits." }, 400);
    await d.settlement.setLockboxCode(s.householdId, code || undefined);
    d.bus.emit({ type: "lockbox_set", at: d.now(), on: !!code });
    return c.json({ ok: true, lockbox: !!code });
  });

  // ---- porch camera
  // One camera per shop. Registering again (a new phone) replaces the old one, whose page then stops.
  web.post("/cam/register", async (c) => {
    const s = seller(c);
    if (!s) return c.json({ error: "unauthorized" }, 401);
    const hh = await d.settlement.householdPublic(s.householdId);
    const fresh = ((await c.req.json().catch(() => ({}))) as { fresh?: boolean }).fresh === true;
    const current = hh.ringDeviceId && camOwner.get(hh.ringDeviceId) === s.householdId ? hh.ringDeviceId : undefined;
    let id = current;
    if (!id || fresh) {
      id = d.porchcam.register();
      camOwner.set(id, s.householdId);
      await d.settlement.setHouseholdDevice(s.householdId, id);
      d.bus.emit({ type: "porchcam_registered", at: d.now(), camera: id });
    }
    let camToken = [...camTokens.entries()].find(([, v]) => v.cam === id)?.[0];
    if (!camToken) {
      camToken = token("ck");
      camTokens.set(camToken, { cam: id, householdId: s.householdId });
    }
    return c.json({ camera: id, camToken });
  });
  // A one-time invitation for a new camera phone (10 minutes, single use). The site turns it into a
  // 6-digit code or a QR; whoever redeems it first becomes this shop's camera, and nobody can after.
  const camInvites = new Map<string, { householdId: string; exp: number }>();
  web.post("/cam/invite", async (c) => {
    const s = seller(c);
    if (!s) return c.json({ error: "unauthorized" }, 401);
    const t = d.now();
    for (const [k, v] of camInvites) if (v.exp < t || v.householdId === s.householdId) camInvites.delete(k);
    const secret = token("ci");
    camInvites.set(secret, { householdId: s.householdId, exp: t + 10 * 60_000 });
    return c.json({ secret, expiresAt: t + 10 * 60_000 });
  });
  web.post("/cam/claim", async (c) => {
    const { secret } = (await c.req.json().catch(() => ({}))) as { secret?: string };
    const inv = secret ? camInvites.get(secret) : undefined;
    if (!inv || inv.exp < d.now()) return c.json({ error: "expired", message: "That code has expired or was already used. Get a new one." }, 410);
    camInvites.delete(secret!);
    const id = d.porchcam.register();
    camOwner.set(id, inv.householdId);
    await d.settlement.setHouseholdDevice(inv.householdId, id);
    d.bus.emit({ type: "porchcam_registered", at: d.now(), camera: id, via: "one_time_code" });
    const camToken = token("ck");
    camTokens.set(camToken, { cam: id, householdId: inv.householdId });
    return c.json({ camera: id, camToken });
  });
  web.get("/cam/next", async (c) => {
    const a = camAuth(c, c.req.query("cam"));
    if (!a || !d.porchcam.has(a.cam)) return c.json({ error: "unauthorized" }, 401);
    const hh = await d.settlement.householdPublic(a.householdId);
    if (hh.ringDeviceId !== a.cam) return c.json({ error: "replaced", message: "Another device is now this shop's porch camera." }, 410);
    const active = (await d.settlement.dealsForHousehold(a.householdId)).filter((x) => x.state === "WINDOW_OPEN" || x.state === "STILL_THERE");
    return c.json({ want: d.porchcam.wants(a.cam), watching: active.map((x) => x.itemTitle), placement: hh.porchInstructions });
  });
  web.post("/cam/frame", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { cam?: string; dataUrl?: string; motion?: boolean };
    const a = camAuth(c, body.cam);
    if (!a || !d.porchcam.has(a.cam) || !body.dataUrl) return c.json({ error: "unauthorized" }, 401);
    if ((await d.settlement.householdPublic(a.householdId)).ringDeviceId !== a.cam) return c.json({ error: "replaced", message: "Another device is now this shop's porch camera." }, 410);
    let frame;
    try {
      frame = frameFromDataUrl(body.dataUrl, d.now());
    } catch (e) {
      return c.json({ error: "bad_frame", message: e instanceof Error ? e.message : "bad frame" }, 400);
    }
    d.porchcam.put(a.cam, frame);
    if (body.motion) void checkPresence(a.householdId, a.cam, frame);
    return c.json({ ok: true });
  });

  // The before photo is the baseline. A pickup window opens the moment the buyer pays, often before
  // the seller has put the item out, so while the buyer hasn't arrived the camera looks again every
  // minute (at most 10 times) until it sees the item. The seller can also ask for a new look.
  const beforeLooks = new Map<string, number>();
  d.bus.on((e) => {
    if (e.type !== "frame_assessed" || e.kind !== "before" || e.presence === "present" || e.origin !== "porchcam") return;
    const dealId = String(e.dealId);
    const n = (beforeLooks.get(dealId) ?? 0) + 1;
    if (n > 10) return;
    beforeLooks.set(dealId, n);
    setTimeout(() => void lookAgain(dealId).catch(() => undefined), 60_000).unref?.();
  });
  async function lookAgain(dealId: string) {
    const deal = await d.settlement.getDeal(dealId);
    if (deal.state !== "WINDOW_OPEN" || (await d.settlement.checkInAt(dealId)) !== undefined) return false;
    const hh = await d.settlement.householdPublic(deal.householdId);
    d.bus.emit({ type: "frame_needed", at: d.now(), dealId, kind: "before", notBefore: d.now(), deviceId: hh.ringDeviceId });
    return true;
  }
  web.post("/sale/:dealId/before", async (c) => {
    const s = seller(c);
    const deal = s ? await d.settlement.getDeal(c.req.param("dealId")).catch(() => undefined) : undefined;
    if (!s || !deal || deal.householdId !== s.householdId) return c.json({ error: "not_found" }, 404);
    if (!(await lookAgain(deal.id))) return c.json({ error: "too_late", message: "The buyer has already checked in, so the first photo can't change now." }, 409);
    return c.json({ ok: true });
  });

  /**
   * Motion at the door: if a pickup is in progress, ask the vision model whether a person is in the
   * frame (counted, never identified). A yes becomes a presence event, the same signal a doorbell's
   * person alert gives, labelled origin "porchcam". A camera that also sees a busy street would fire
   * all day, so checks are spaced (one per camera every 15 seconds) and capped per sale: 20 while
   * waiting for the buyer, 15 more once they've checked in.
   */
  const presenceChecks = new Map<string, { before: number; after: number }>();
  async function checkPresence(householdId: string, cam: string, frame: ReturnType<typeof frameFromDataUrl>) {
    const t = d.now();
    if (t - (lastPresenceCheck.get(cam) ?? 0) < 15_000) return;
    const active = (await d.settlement.dealsForHousehold(householdId)).find((x) => x.state === "WINDOW_OPEN" || x.state === "STILL_THERE");
    if (!active) return;
    const used = presenceChecks.get(active.id) ?? { before: 0, after: 0 };
    const phase = (await d.settlement.checkInAt(active.id)) === undefined ? "before" : "after";
    if (used[phase] >= (phase === "before" ? 20 : 15)) return;
    used[phase] += 1;
    presenceChecks.set(active.id, used);
    lastPresenceCheck.set(cam, t);
    const v = await d.vision.assess({ frame, itemTitle: active.itemTitle }).catch(() => undefined);
    d.bus.emit({ type: "porchcam_motion", at: t, dealId: active.id, personCount: v?.personCount ?? null });
    if (!v?.personCount) return;
    const requestId = `porchcam_${createHash("sha256").update(frame.bytes).digest("hex").slice(0, 16)}`;
    await d.settlement.ingestRingEvent({ kind: "motion_detected", subType: "human", at: frame.at, deviceId: cam, requestId, origin: "porchcam" });
  }

  return web;
}
