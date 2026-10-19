// Stoop Street: one marketplace across every shop on this server.
//   - search what's for sale, nearest ZIP first, with each seller's verified-pickup rating
//   - one buyer profile across shops (the purchase code is kept only as a hash)
//   - buyer agents: "a jogging stroller under $100 near 62704". The agent watches the street and
//     haggles with each seller's assistant inside the buyer's budget. It can agree a price; only the
//     buyer can pay (the checkout still needs their yes, and their code over $100).
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { purchaseCodeHash } from "@stoop/settlement";
import { inSentence } from "@stoop/shared";
import type { Stack } from "./compose.ts";
import { mcpCall, type ToolOut } from "./inproc.ts";

export interface StreetWorld {
  id: string;
  kind: "shop" | "demo";
  stack: Stack;
}

export interface MarketListing {
  shop: string;
  shopName: string;
  listingId: string;
  title: string;
  description: string;
  askMinor: number;
  zip: string;
  photoUrl?: string;
  category?: string;
  rating: { avg: number | null; count: number; verified: number };
  listedAt: number;
}

interface Profile {
  id: string;
  token: string;
  name: string;
  codeHash: string;
  /** shop id -> this person's buyer token in that shop */
  shops: Record<string, string>;
  createdAt: number;
}

type TryState = "talking" | "waiting_owner" | "deal" | "too_high" | "declined" | "gone";
export interface Want {
  id: string;
  profileId: string;
  query: string;
  maxMinor: number;
  zip?: string;
  status: "hunting" | "found" | "bought" | "stopped";
  log: Array<{ at: number; text: string; shop?: string; listingId?: string }>;
  tries: Record<string, { state: TryState; shop: string; listingId: string; title: string; lastOfferMinor?: number; agreedMinor?: number }>;
  createdAt: number;
  updatedAt: number;
}

const $ = (minor: number) => `$${(minor / 100).toFixed(minor % 100 ? 2 : 0)}`;
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/** Everything for sale on the street right now. */
export async function marketListings(worlds: Iterable<StreetWorld>): Promise<MarketListing[]> {
  const out: MarketListing[] = [];
  for (const w of worlds) {
    if (w.kind !== "shop") continue;
    const seller = [...w.stack.sellers.values()][0];
    if (!seller) continue;
    const st = w.stack.settlement;
    const live = (await st.listingsForHousehold(seller.householdId)).filter((l) => l.state === "LIVE");
    if (!live.length) continue;
    const hh = await st.householdPublic(seller.householdId);
    const reviews = await w.stack.store.list<{ rating: number; verified: boolean }>("review#");
    const rating = {
      avg: reviews.length ? Math.round((reviews.reduce((t, r) => t + r.rating, 0) / reviews.length) * 10) / 10 : null,
      count: reviews.length,
      verified: reviews.filter((r) => r.verified).length,
    };
    for (const l of live) {
      const item = await st.getItem(l.itemId).catch(() => undefined);
      out.push({ shop: w.id, shopName: `${hh.displayName}’s porch`, listingId: l.id, title: l.title, description: l.description, askMinor: l.askMinor, zip: l.zip, photoUrl: l.photoUrls[0], category: item?.category, rating, listedAt: l.createdAt });
    }
  }
  return out;
}

/** Words must match; then nearest ZIP (same ZIP, then same area), then cheapest. "Near" is by ZIP code. */
export function searchMarket(all: MarketListing[], q: { query?: string; zip?: string; maxMinor?: number }) {
  const want = words(q.query ?? "");
  const near = (zip: string) => (!q.zip ? 0 : zip === q.zip ? 2 : zip.slice(0, 3) === q.zip.slice(0, 3) ? 1 : 0);
  return all
    .map((l) => ({ l, score: want.length ? want.filter((w) => words(`${l.title} ${l.description} ${l.category ?? ""}`).some((x) => x.startsWith(w) || w.startsWith(x))).length : 1 }))
    .filter(({ l, score }) => score > 0 && (q.maxMinor === undefined || l.askMinor <= q.maxMinor))
    .sort((a, b) => b.score - a.score || near(b.l.zip) - near(a.l.zip) || a.l.askMinor - b.l.askMinor)
    .map(({ l }) => l);
}

export class Street {
  private profiles = new Map<string, Profile>();
  private byToken = new Map<string, string>();
  wants = new Map<string, Want>();
  private busy = new Set<string>();
  private last = "";

  constructor(
    readonly o: {
      worlds: Map<string, StreetWorld>;
      now: () => number;
      file?: string;
      /** A pairing code that links this profile to someone's Alexa (voice shopping). */
      pairAlexa?: (profileId: string, name: string) => string;
    },
  ) {
    if (o.file && existsSync(o.file)) {
      try {
        const s = JSON.parse(readFileSync(o.file, "utf8")) as { profiles: Profile[]; wants: Want[] };
        for (const p of s.profiles) {
          this.profiles.set(p.id, p);
          this.byToken.set(p.token, p.id);
        }
        for (const w of s.wants) this.wants.set(w.id, w);
      } catch {
        /* a damaged file only means people set up again */
      }
    }
  }

  save() {
    if (!this.o.file) return;
    const json = JSON.stringify({ profiles: [...this.profiles.values()], wants: [...this.wants.values()] });
    if (json === this.last) return;
    writeFileSync(`${this.o.file}.tmp`, json, { mode: 0o600 });
    renameSync(`${this.o.file}.tmp`, this.o.file);
    this.last = json;
  }

  profileByToken(token: string) {
    const id = this.byToken.get(token);
    return id ? this.profiles.get(id) : undefined;
  }
  profile(id: string) {
    return this.profiles.get(id);
  }

  createProfile(name: string, purchaseCode: string): Profile {
    const p: Profile = { id: `bp_${randomBytes(6).toString("hex")}`, token: `pt_${randomBytes(18).toString("base64url")}`, name, codeHash: purchaseCodeHash(purchaseCode), shops: {}, createdAt: this.o.now() };
    this.profiles.set(p.id, p);
    this.byToken.set(p.token, p.id);
    return p;
  }

  /** This person's buyer token in a shop, creating their buyer there the first time. */
  async buyerIn(p: Profile, shop: string): Promise<string | undefined> {
    const w = this.o.worlds.get(shop);
    if (!w || w.kind !== "shop") return undefined;
    const t = p.shops[shop];
    if (t && w.stack.buyers.has(t)) return t;
    p.shops[shop] = await w.stack.addBuyer(p.name, p.codeHash);
    return p.shops[shop];
  }

  /** Purchases across every shop this person bought from. */
  async purchases(p: Profile) {
    const out = [];
    for (const [shop, token] of Object.entries(p.shops)) {
      const w = this.o.worlds.get(shop);
      const b = w?.stack.buyers.get(token);
      if (!w || !b) continue;
      const hh = [...w.stack.sellers.values()][0];
      const shopName = hh ? `${(await w.stack.settlement.householdPublic(hh.householdId)).displayName}’s porch` : "A porch";
      for (const d of await w.stack.settlement.dealsForBuyer(b.buyerId))
        out.push({ shop, shopName, dealId: d.id, listingId: d.listingId, title: d.itemTitle, state: d.state, amountMinor: d.amountMinor, totalMinor: w.stack.settlement.buyerTotalMinor(d), passId: d.passId ?? null, createdAt: d.createdAt });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  addWant(p: Profile, query: string, maxMinor: number, zip?: string): Want {
    const w: Want = { id: `want_${randomBytes(6).toString("hex")}`, profileId: p.id, query, maxMinor, zip, status: "hunting", log: [], tries: {}, createdAt: this.o.now(), updatedAt: this.o.now() };
    this.say(w, `Looking for ${query} up to ${$(maxMinor)}${zip ? ` near ${zip}` : ""}. I’ll haggle with sellers’ assistants and never go over your limit.`);
    this.wants.set(w.id, w);
    return w;
  }

  private say(w: Want, text: string, shop?: string, listingId?: string) {
    w.log.push({ at: this.o.now(), text, shop, listingId });
    if (w.log.length > 40) w.log.splice(0, w.log.length - 40);
    w.updatedAt = this.o.now();
  }

  /** One round of every agent: follow up open talks, then try one new listing per want. A call while a
   * round is running waits for that round instead of starting another. */
  tick(): Promise<void> {
    this.running ??= this.round().finally(() => (this.running = undefined));
    return this.running;
  }
  private running?: Promise<void>;

  private async round() {
    const all = await marketListings(this.o.worlds.values());
    for (const w of this.wants.values()) {
      if (w.status === "stopped" || w.status === "bought" || this.busy.has(w.id)) continue;
      this.busy.add(w.id);
      try {
        await this.step(w, all);
      } catch (e) {
        this.say(w, `Something went wrong talking to a seller (${String(e).slice(0, 80)}). I’ll try again.`);
      } finally {
        this.busy.delete(w.id);
      }
    }
  }

  private async step(want: Want, all: MarketListing[]) {
    const p = this.profiles.get(want.profileId);
    if (!p) return;
    // follow up: did an owner answer? did the buyer pay?
    for (const t of Object.values(want.tries)) {
      if (t.state !== "waiting_owner" && t.state !== "deal") continue;
      const w = this.o.worlds.get(t.shop);
      const b = w && p.shops[t.shop] ? w.stack.buyers.get(p.shops[t.shop]!) : undefined;
      if (!w || !b) {
        t.state = "gone";
        continue;
      }
      const deals = (await w.stack.settlement.dealsForBuyer(b.buyerId)).filter((d) => d.listingId === t.listingId);
      const deal = deals.sort((a, x) => x.createdAt - a.createdAt)[0];
      if (deal && ["AGREED", "CHECKOUT_OPEN"].includes(deal.state) && t.state !== "deal") {
        t.state = "deal";
        t.agreedMinor = deal.amountMinor;
        want.status = "found";
        this.say(want, `The owner said yes: ${t.title} for ${$(deal.amountMinor)}. Tap Pay to buy it.`, t.shop, t.listingId);
      } else if (deal && !["AGREED", "CHECKOUT_OPEN", "CHECKOUT_ABANDONED", "VOIDED"].includes(deal.state)) {
        want.status = "bought";
        t.state = "deal";
        this.say(want, `Bought: ${t.title} for ${$(deal.amountMinor)}. Your pickup pass is in your purchases.`, t.shop, t.listingId);
        return;
      } else if (!deal && t.state === "waiting_owner") {
        const n = (await w.stack.settlement.negotiationsFor(t.listingId)).find((x) => x.buyerId === b.buyerId);
        if (n && n.state !== "AGREED_PENDING_SELLER" && n.state !== "OPEN") {
          t.state = "declined";
          this.say(want, `The owner of the ${inSentence(t.title)} said no to ${$(t.lastOfferMinor ?? 0)}. I’ll keep looking.`, t.shop, t.listingId);
        }
      }
    }
    if (want.status !== "hunting") return;
    if (Object.keys(want.tries).length >= 6) return; // enough sellers for one want
    const next = searchMarket(all, { query: want.query, zip: want.zip, maxMinor: Math.round(want.maxMinor * 1.3) }).find((l) => !want.tries[`${l.shop}:${l.listingId}`]);
    if (!next) return;
    const token = await this.buyerIn(p, next.shop);
    if (!token) return;
    const w = this.o.worlds.get(next.shop)!;
    const t: Want["tries"][string] = { state: "talking", shop: next.shop, listingId: next.listingId, title: next.title };
    want.tries[`${next.shop}:${next.listingId}`] = t;
    this.say(want, `Found ${next.title} for ${$(next.askMinor)} at ${next.shopName} (${next.zip}). Talking to the seller’s assistant.`, next.shop, next.listingId);
    const offer = async (minor: number, message: string) => {
      t.lastOfferMinor = minor;
      return mcpCall(async (r) => w.stack.app.fetch(r), "buyer", token, "make_offer", { listingId: next.listingId, amountDollars: minor / 100, message });
    };
    const roundDown5 = (m: number) => Math.floor(m / 500) * 500;
    const opening = Math.min(want.maxMinor, Math.max(500, roundDown5(next.askMinor * 0.85)));
    let r = await offer(opening, `Hi, I’m ${p.name}’s shopping assistant, an AI. Would you take ${$(opening)}? ${p.name} can pick it up today.`);
    for (let round = 0; round < 2; round++) {
      const out = this.outcome(want, t, r);
      if (out !== "counter" && out !== "low") return;
      const counter = r.data.counterMinor as number | undefined;
      if (out === "counter" && counter && counter <= want.maxMinor) {
        r = await offer(counter, `${$(counter)} works for ${p.name}. Deal.`);
        continue;
      }
      if ((t.lastOfferMinor ?? 0) < want.maxMinor) {
        r = await offer(want.maxMinor, `${p.name}’s best is ${$(want.maxMinor)}.`);
        continue;
      }
      break;
    }
    if (t.state === "talking") {
      t.state = "too_high";
      this.say(want, `The seller wants more than your ${$(want.maxMinor)} for the ${inSentence(next.title)}. I stopped there.`, next.shop, next.listingId);
    }
  }

  /** Read one reply from the seller's assistant; returns what to do next. */
  private outcome(want: Want, t: Want["tries"][string], r: ToolOut): "done" | "counter" | "low" {
    const d = r.data;
    if (r.isError || d.kind !== "negotiation") {
      t.state = "declined";
      this.say(want, `The seller’s assistant didn’t take offers for the ${inSentence(t.title)}: ${r.text.slice(0, 140)}`, t.shop, t.listingId);
      return "done";
    }
    if (d.action === "accepted") {
      t.state = "deal";
      t.agreedMinor = t.lastOfferMinor;
      want.status = "found";
      this.say(want, `Deal: the ${inSentence(t.title)} for ${$(t.lastOfferMinor!)}. Tap Pay to buy it; nothing is charged until the pickup is verified.`, t.shop, t.listingId);
      return "done";
    }
    if (d.action === "awaiting_seller") {
      t.state = "waiting_owner";
      this.say(want, `The seller’s assistant says ${$(t.lastOfferMinor!)} could work for the ${inSentence(t.title)}. Waiting for the owner’s yes.`, t.shop, t.listingId);
      return "done";
    }
    if (d.action === "counter") {
      this.say(want, `They countered at ${$(d.counterMinor)} for the ${inSentence(t.title)}.`, t.shop, t.listingId);
      return "counter";
    }
    if (d.action === "declined") return "low";
    t.state = "declined";
    this.say(want, `The seller’s assistant ended the talk about the ${inSentence(t.title)}.`, t.shop, t.listingId);
    return "done";
  }
}

// ---------------------------------------------------------------- HTTP

const ProfileInput = z.object({ name: z.string().trim().min(1).max(40), purchaseCode: z.string().regex(/^\d{4}$/) });
const WantInput = z.object({ query: z.string().trim().min(2).max(80), maxDollars: z.number().positive().max(20_000), zip: z.string().trim().regex(/^[A-Za-z0-9 -]{3,10}$/).optional() });

export function streetRouter(street: Street, o: { worlds: Map<string, StreetWorld>; allow(key: string, limit: number): boolean; ipOf(c: Context): string }) {
  const app = new Hono();
  const me = (c: Context) => {
    const h = c.req.header("Authorization");
    return street.profileByToken(h?.startsWith("Bearer ") ? h.slice(7) : "");
  };

  app.get("/market", async (c) => {
    const max = Number(c.req.query("max"));
    const all = await marketListings(o.worlds.values());
    const results = searchMarket(all, { query: c.req.query("q"), zip: c.req.query("zip")?.trim() || undefined, maxMinor: max > 0 ? Math.round(max * 100) : undefined });
    return c.json({ results: results.slice(0, 60), total: all.length });
  });

  app.post("/profile", async (c) => {
    if (!o.allow(`profile:${o.ipOf(c)}`, 20)) return c.json({ error: "rate_limited", message: "Too many new profiles from here. Try again later." }, 429);
    const p = ProfileInput.safeParse(await c.req.json().catch(() => undefined));
    if (!p.success) return c.json({ error: "invalid", fields: p.error.issues.map((i) => i.path.join(".")) }, 400);
    const prof = street.createProfile(p.data.name, p.data.purchaseCode);
    return c.json({ token: prof.token, name: prof.name });
  });

  app.get("/profile", async (c) => {
    const p = me(c);
    if (!p) return c.json({ error: "unauthorized" }, 401);
    const wants = [...street.wants.values()].filter((w) => w.profileId === p.id).sort((a, b) => b.createdAt - a.createdAt);
    return c.json({ name: p.name, wants, purchases: await street.purchases(p) });
  });

  /** A buyer token for one shop, so the listing page can go straight to "make an offer". */
  app.post("/profile/join", async (c) => {
    const p = me(c);
    const { shop } = (await c.req.json().catch(() => ({}))) as { shop?: string };
    if (!p || !shop) return c.json({ error: "unauthorized" }, 401);
    const buyerToken = await street.buyerIn(p, shop);
    if (!buyerToken) return c.json({ error: "not_found", message: "This shop has closed." }, 404);
    return c.json({ buyerToken });
  });

  app.post("/profile/alexa", async (c) => {
    const p = me(c);
    if (!p) return c.json({ error: "unauthorized" }, 401);
    if (!street.o.pairAlexa) return c.json({ error: "not_found" }, 404);
    return c.json({ code: street.o.pairAlexa(p.id, p.name), invocation: "stoop shop", expiresInMinutes: 10 });
  });

  app.post("/wants", async (c) => {
    const p = me(c);
    if (!p) return c.json({ error: "unauthorized" }, 401);
    const v = WantInput.safeParse(await c.req.json().catch(() => undefined));
    if (!v.success) return c.json({ error: "invalid", fields: v.error.issues.map((i) => i.path.join(".")) }, 400);
    const active = [...street.wants.values()].filter((w) => w.profileId === p.id && (w.status === "hunting" || w.status === "found"));
    if (active.length >= 3) return c.json({ error: "too_many", message: "You have three agents out already. Stop one first." }, 409);
    if (street.wants.size >= 300) return c.json({ error: "full", message: "Stoop is at capacity for this test." }, 503);
    const w = street.addWant(p, v.data.query, Math.round(v.data.maxDollars * 100), v.data.zip);
    void street.tick();
    return c.json(w);
  });

  app.post("/wants/:id/stop", (c) => {
    const p = me(c);
    const w = street.wants.get(c.req.param("id"));
    if (!p || !w || w.profileId !== p.id) return c.json({ error: "not_found" }, 404);
    w.status = "stopped";
    w.updatedAt = Date.now();
    return c.json(w);
  });

  return app;
}
