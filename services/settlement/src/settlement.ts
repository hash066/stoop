// The Settlement service. The ONLY code path that can: move money, reveal a household's address,
// accept a deal, or sign a Proof-of-Handoff receipt. Agents and the MCP server call it; they never
// hold its keys. In AWS it is its own Lambda + IAM role; the address KMS key grants Decrypt only here.
import { createHash, randomInt } from "node:crypto";
import type { ApprovalTerms, DealState, HandoffEvidence, Mandate, PickupWindow, PolicyAction, RingEvent } from "@stoop/shared";
import {
  acceptable,
  autoAcceptable,
  decide,
  evaluateHandoff,
  guardOutgoing,
  INSPECTION_MS,
  isPresenceEvent,
  suggestCounter,
  termsHash,
  transition,
  verifyAndSpend,
  mintToken,
  type DealEvent,
  type DecideInput,
  type LeakCheck,
  type MacProvider,
  type SpentTokenStore,
} from "@stoop/policy";
import { receiptHash, sha256Hex, signReceipt, type HandoffReceipt, type ReceiptSigner } from "@stoop/proof-of-handoff";
import { newId, type Clock, type EventBus, type Scheduler, type ScheduledJob, type Store, type Vault } from "./infra.ts";
import { PaymentError, type PSP, type PaymentCredential } from "./psp.ts";
import type {
  Buyer,
  Deal,
  Evidence,
  FrameObservation,
  Household,
  Item,
  Listing,
  Negotiation,
  Pass,
  PendingApproval,
  PolicyDecisionRecord,
  ReceiptRecord,
} from "./types.ts";

export const BUYER_FEE_MINOR = 199; // "Verified pickup" fee shown in every breakdown
export const SELLER_FEE_PCT = 5;
export const RESERVATION_TTL_MS = 15 * 60 * 1000;
export const APPROVAL_TTL_MS = 15 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_WINDOW_MS = 15 * 60 * 1000;
export const AFTER_FRAME_DELAY_MS = 45 * 1000;
export const HOLD_RENEW_MARGIN_MS = 12 * 60 * 60 * 1000;

export class SettlementError extends Error {
  constructor(
    readonly code: string,
    message?: string,
    readonly status = 400,
  ) {
    super(message && message !== code ? `${code}: ${message}` : code);
  }

  /** Human-readable part only (for speech / UI). */
  get humanMessage() {
    const i = this.message.indexOf(": ");
    return i === -1 ? this.message : this.message.slice(i + 2);
  }
}

export interface SettlementDeps {
  store: Store;
  psp: PSP;
  macp: MacProvider;
  spent: SpentTokenStore;
  signer: ReceiptSigner;
  vault: Vault;
  clock: Clock;
  bus: EventBus;
  scheduler: Scheduler;
  /** Base URL of the pickup-pass app, e.g. https://pass.stoop.dev */
  passBaseUrl: string;
  issuer?: string;
}

const K = {
  household: (id: string) => `household#${id}`,
  buyer: (id: string) => `buyer#${id}`,
  item: (id: string) => `item#${id}`,
  listing: (id: string) => `listing#${id}`,
  mandate: (listingId: string) => `mandate#${listingId}`,
  nego: (id: string) => `nego#${id}`,
  approval: (id: string) => `approval#${id}`,
  deal: (id: string) => `deal#${id}`,
  activeDeal: (listingId: string) => `activedeal#${listingId}`,
  pass: (id: string) => `pass#${id}`,
  evidence: (dealId: string) => `evidence#${dealId}`,
  receipt: (id: string) => `receipt#${id}`,
  decision: (at: number, id: string) => `decision#${String(at).padStart(15, "0")}#${id}`,
};

const hashSecret = (s: string) => createHash("sha256").update(`stoop:${s}`).digest("hex");

export class Settlement {
  constructor(readonly d: SettlementDeps) {}

  private now() {
    return this.d.clock.now();
  }

  private emit(type: string, data: Record<string, unknown> = {}) {
    this.d.bus.emit({ type, at: this.now(), ...data });
  }

  // ------------------------------------------------------------------ policy plumbing

  private async record(input: DecideInput, actor: string, ids: { dealId?: string; listingId?: string } = {}) {
    const decision = decide(input);
    const rec: PolicyDecisionRecord = { ...decision, id: newId("pd"), at: this.now(), actor, ...ids };
    await this.d.store.put(K.decision(rec.at, rec.id), rec);
    this.emit("policy_decision", { decision: rec, ...ids });
    return rec;
  }

  /** Log an ad-hoc decision (token checks, guard hits) in the same audit stream. */
  private async logDecision(
    action: PolicyAction,
    outcome: "allow" | "deny" | "needs_approval",
    ruleIds: PolicyDecisionRecord["ruleIds"],
    reasons: string[],
    actor: string,
    ids: { dealId?: string; listingId?: string } = {},
  ) {
    const rec: PolicyDecisionRecord = { action, outcome, ruleIds, reasons, id: newId("pd"), at: this.now(), actor, ...ids };
    await this.d.store.put(K.decision(rec.at, rec.id), rec);
    this.emit("policy_decision", { decision: rec, ...ids });
    return rec;
  }

  async decisions(limit = 100): Promise<PolicyDecisionRecord[]> {
    const all = await this.d.store.list<PolicyDecisionRecord>("decision#");
    return all.sort((a, b) => b.at - a.at).slice(0, limit);
  }

  private async spend(token: string | undefined, terms: ApprovalTerms, actor: string, ids: { dealId?: string; listingId?: string }) {
    if (!token) return false;
    const res = await verifyAndSpend(
      token,
      {
        action: terms.action,
        termsHash: termsHash(terms),
        dealId: terms.dealId,
        listingId: terms.listingId,
        amountMinor: terms.amountMinor,
      },
      this.now(),
      this.d.macp,
      this.d.spent,
    );
    if (!res.ok) await this.logDecision(terms.action, "deny", ["R4"], [`token_${res.reason}`], actor, ids);
    return res.ok;
  }

  // ------------------------------------------------------------------ onboarding

  async createHousehold(input: {
    displayName: string;
    address: string;
    zip: string;
    porchInstructions: string;
    ringDeviceId?: string;
    id?: string;
  }): Promise<Household> {
    const h: Household = {
      id: input.id ?? newId("hh"),
      displayName: input.displayName,
      addressCipher: await this.d.vault.encrypt(input.address),
      zip: input.zip,
      porchInstructions: input.porchInstructions,
      ringDeviceId: input.ringDeviceId,
      createdAt: this.now(),
    };
    await this.d.store.put(K.household(h.id), h);
    return h;
  }

  async setHouseholdDevice(householdId: string, ringDeviceId: string) {
    const h = await this.mustGet<Household>(K.household(householdId), "household_not_found");
    h.ringDeviceId = ringDeviceId;
    await this.d.store.put(K.household(h.id), h);
  }

  async createBuyer(input: { displayName: string; email: string; voiceCode: string; walletToken: string; id?: string }): Promise<Buyer> {
    if (!/^\d{4}$/.test(input.voiceCode)) throw new SettlementError("voice_code_must_be_4_digits");
    const b: Buyer = {
      id: input.id ?? newId("buyer"),
      displayName: input.displayName,
      pseudonym: `Buyer ${randomInt(10, 99)}`,
      email: input.email,
      voiceCodeHash: hashSecret(input.voiceCode),
      walletToken: input.walletToken,
      verifiedPickups: 0,
      noShows: 0,
      strikes: 0,
      createdAt: this.now(),
    };
    await this.d.store.put(K.buyer(b.id), b);
    return b;
  }

  async buyerPublic(buyerId: string) {
    const b = await this.mustGet<Buyer>(K.buyer(buyerId), "buyer_not_found");
    return {
      id: b.id,
      label: `${b.pseudonym} (${b.verifiedPickups} verified pickup${b.verifiedPickups === 1 ? "" : "s"}${b.noShows ? `, ${b.noShows} no-show` : ""})`,
      verifiedPickups: b.verifiedPickups,
      noShows: b.noShows,
      blocked: b.blockedUntil !== undefined && b.blockedUntil > this.now(),
    };
  }

  // ------------------------------------------------------------------ items & listings

  async createItem(input: Omit<Item, "id" | "createdAt" | "itemHash">): Promise<Item> {
    const item: Item = {
      ...input,
      id: newId("item"),
      itemHash: sha256Hex(`${input.title}|${input.category}|${input.photoHashes.join(",")}`),
      createdAt: this.now(),
    };
    await this.d.store.put(K.item(item.id), item);
    return item;
  }

  async getItem(itemId: string) {
    return this.mustGet<Item>(K.item(itemId), "item_not_found");
  }

  async draftListing(itemId: string, overrides: { title?: string; description?: string; askMinor?: number } = {}): Promise<Listing> {
    const item = await this.getItem(itemId);
    const hh = await this.mustGet<Household>(K.household(item.householdId), "household_not_found");
    const blocked = item.recall.blocked;
    const listing: Listing = {
      id: newId("lst"),
      householdId: item.householdId,
      itemId,
      title: overrides.title ?? item.title,
      description: overrides.description ?? `${item.title}. Condition ${item.condition}. Porch pickup only, verified by doorbell camera.`,
      askMinor: overrides.askMinor ?? item.priceBand.listMinor,
      state: blocked ? "BLOCKED_RECALL" : "AWAITING_SELLER_OK",
      version: 1,
      zip: hh.zip,
      photoUrls: item.photoUrls,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    await this.d.store.put(K.listing(listing.id), listing);
    if (blocked) {
      await this.logDecision("publish_listing", "deny", ["R9"], [item.recall.reason ?? "prohibited_item"], `seller:${hh.id}`, {
        listingId: listing.id,
      });
    }
    this.emit("listing_drafted", { listingId: listing.id, state: listing.state, title: listing.title });
    return listing;
  }

  async getListing(listingId: string) {
    return this.mustGet<Listing>(K.listing(listingId), "listing_not_found");
  }

  publishTerms(l: Listing): ApprovalTerms {
    return { action: "publish_listing", listingId: l.id, amountMinor: l.askMinor, details: { title: l.title, version: l.version } };
  }

  mandateTerms(m: Mandate): ApprovalTerms {
    return {
      action: "set_mandate",
      listingId: m.listingId,
      amountMinor: m.floorMinor,
      details: { autoAcceptAboveMinor: m.autoAcceptAboveMinor ?? 0, expiresAt: m.expiresAt },
    };
  }

  async publishListing(listingId: string, token: string, actor: string): Promise<Listing> {
    const l = await this.getListing(listingId);
    if (l.state === "BLOCKED_RECALL") throw new SettlementError("blocked_recall", "This item can't be sold", 409);
    if (l.state !== "AWAITING_SELLER_OK" && l.state !== "RELISTED")
      throw new SettlementError("not_publishable", `Listing is ${l.state}`, 409);
    if (!(await this.spend(token, this.publishTerms(l), actor, { listingId })))
      throw new SettlementError("approval_invalid", "Approval token invalid or terms changed", 403);
    const next = { ...l, state: "LIVE" as const, version: l.version + 1, updatedAt: this.now() };
    if (!(await this.d.store.put(K.listing(l.id), next, { ifVersion: l.version }))) throw new SettlementError("conflict", "Listing changed", 409);
    await this.logDecision("publish_listing", "allow", ["R4"], ["human_approval_token"], actor, { listingId });
    this.emit("listing_live", { listingId, title: l.title, askMinor: l.askMinor });
    return next;
  }

  async setMandate(m: Mandate, token: string, actor: string) {
    await this.getListing(m.listingId);
    if (!(await this.spend(token, this.mandateTerms(m), actor, { listingId: m.listingId })))
      throw new SettlementError("approval_invalid", "Approval token invalid or terms changed", 403);
    await this.d.store.put(K.mandate(m.listingId), m);
    await this.logDecision("set_mandate", "allow", ["R4", "R5"], ["mandate_stored_floor_sealed"], actor, { listingId: m.listingId });
    this.emit("mandate_set", { listingId: m.listingId, autoAccept: m.autoAcceptAboveMinor !== undefined });
  }

  /** Seller edits a live listing: version bump supersedes open agreements (X24). */
  async editListing(listingId: string, patch: { title?: string; description?: string; askMinor?: number }, actor: string) {
    const l = await this.getListing(listingId);
    const next: Listing = { ...l, ...patch, version: l.version + 1, updatedAt: this.now() };
    if (!(await this.d.store.put(K.listing(l.id), next, { ifVersion: l.version }))) throw new SettlementError("conflict", "Listing changed", 409);
    for (const n of await this.negotiationsFor(listingId)) {
      if (n.state === "AGREED_PENDING_SELLER" || n.state === "OPEN") {
        await this.saveNego({ ...n, state: "SUPERSEDED", pendingAmountMinor: undefined });
        if (n.pendingApprovalId) await this.expireApproval(n.pendingApprovalId);
      }
    }
    await this.logDecision("publish_listing", "allow", ["R4"], ["listing_edited_open_agreements_superseded"], actor, { listingId });
    this.emit("listing_edited", { listingId });
    return next;
  }

  async withdrawListing(listingId: string, actor: string) {
    const l = await this.getListing(listingId);
    if (l.state === "RESERVED") throw new SettlementError("reserved", "Cancel the sale instead", 409);
    await this.d.store.put(K.listing(l.id), { ...l, state: "WITHDRAWN", version: l.version + 1, updatedAt: this.now() }, { ifVersion: l.version });
    this.emit("listing_withdrawn", { listingId, actor });
  }

  async listingsForHousehold(householdId: string): Promise<Listing[]> {
    return (await this.d.store.list<Listing>("listing#")).filter((l) => l.householdId === householdId).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Public search: ZIP-level location only, no seller identity, no floor. */
  async searchListings(q: { query?: string; zip?: string; maxPriceMinor?: number; limit?: number }) {
    const words = (q.query ?? "").toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const live = (await this.d.store.list<Listing>("listing#")).filter((l) => l.state === "LIVE");
    const scored = live
      .map((l) => {
        const hay = `${l.title} ${l.description}`.toLowerCase();
        const score = words.length ? words.filter((w) => hay.includes(w)).length : 1;
        return { l, score };
      })
      .filter(({ l, score }) => score > 0 && (q.maxPriceMinor === undefined || l.askMinor <= q.maxPriceMinor * 1.25))
      .sort((a, b) => b.score - a.score || a.l.askMinor - b.l.askMinor)
      .slice(0, q.limit ?? 5);
    return scored.map(({ l }) => this.publicListing(l));
  }

  publicListing(l: Listing) {
    return {
      listingId: l.id,
      title: l.title,
      description: l.description,
      askMinor: l.askMinor,
      zip: l.zip,
      photoUrls: l.photoUrls,
      pickup: "Contactless porch pickup. Your payment is held until the doorbell camera verifies the handoff.",
    };
  }

  // ------------------------------------------------------------------ approvals

  async requestApproval(terms: ApprovalTerms, approver: string, summary: string): Promise<PendingApproval> {
    const a: PendingApproval = {
      id: newId("appr"),
      terms,
      termsHash: termsHash(terms),
      approver,
      status: "pending",
      createdAt: this.now(),
      expiresAt: this.now() + APPROVAL_TTL_MS,
      summary,
    };
    await this.d.store.put(K.approval(a.id), a);
    await this.logDecision(terms.action, "needs_approval", ["R4"], ["approval_requested"], approver, {
      listingId: terms.listingId,
      dealId: terms.dealId,
    });
    this.emit("approval_requested", { approvalId: a.id, summary, approver, listingId: terms.listingId });
    return a;
  }

  async getApproval(id: string) {
    return this.mustGet<PendingApproval>(K.approval(id), "approval_not_found");
  }

  private async expireApproval(id: string) {
    const a = await this.d.store.get<PendingApproval>(K.approval(id));
    if (a && a.status === "pending") await this.d.store.put(K.approval(id), { ...a, status: "expired" });
  }

  /**
   * A human answered an approval (MCP elicitation accept, voice "yes", or confirm_action).
   * Returns a single-use capability token bound to exactly the terms they were shown.
   */
  async resolveApproval(approvalId: string, accept: boolean, actor: string): Promise<{ token?: string; approval: PendingApproval }> {
    const a = await this.getApproval(approvalId);
    if (a.approver !== actor) throw new SettlementError("not_your_approval", undefined, 403);
    if (a.status !== "pending") throw new SettlementError("approval_closed", `Approval is ${a.status}`, 409);
    if (this.now() > a.expiresAt) {
      await this.expireApproval(a.id);
      throw new SettlementError("approval_expired", undefined, 409);
    }
    const resolved: PendingApproval = { ...a, status: accept ? "approved" : "declined" };
    await this.d.store.put(K.approval(a.id), resolved);
    this.emit("approval_resolved", { approvalId: a.id, accept, actor });
    if (!accept) return { approval: resolved };
    const token = await mintToken(
      {
        action: a.terms.action,
        actor,
        termsHash: a.termsHash,
        dealId: a.terms.dealId,
        listingId: a.terms.listingId,
        amountMinor: a.terms.amountMinor,
        pendingApprovalId: a.id,
        now: this.now(),
      },
      this.d.macp,
    );
    return { token, approval: resolved };
  }

  // ------------------------------------------------------------------ negotiation

  private async saveNego(n: Negotiation) {
    await this.d.store.put(K.nego(n.id), { ...n, updatedAt: this.now() });
  }

  async getNegotiation(id: string) {
    return this.mustGet<Negotiation>(K.nego(id), "negotiation_not_found");
  }

  async negotiationsFor(listingId: string): Promise<Negotiation[]> {
    return (await this.d.store.list<Negotiation>("nego#")).filter((n) => n.listingId === listingId);
  }

  async openNegotiation(listingId: string, buyerId: string): Promise<Negotiation> {
    const l = await this.getListing(listingId);
    if (l.state !== "LIVE") throw new SettlementError("not_live", "This item isn't available", 409);
    const b = await this.mustGet<Buyer>(K.buyer(buyerId), "buyer_not_found");
    if (b.blockedUntil && b.blockedUntil > this.now()) throw new SettlementError("buyer_blocked", "Buyer is temporarily blocked", 403);
    const existing = (await this.negotiationsFor(listingId)).find((n) => n.buyerId === buyerId && (n.state === "OPEN" || n.state === "AGREED_PENDING_SELLER"));
    if (existing) return existing;
    const n: Negotiation = {
      id: newId("neg"),
      listingId,
      buyerId,
      state: "OPEN",
      offers: [],
      strikes: 0,
      version: 1,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    await this.saveNego(n);
    this.emit("negotiation_opened", { listingId, negotiationId: n.id });
    return n;
  }

  async recordOffer(negotiationId: string, by: "buyer" | "seller", amountMinor: number, message: string) {
    const n = await this.getNegotiation(negotiationId);
    n.offers.push({ by, amountMinor, at: this.now(), message });
    if (by === "seller") n.lastCounterMinor = amountMinor;
    await this.saveNego(n);
    this.emit(by === "buyer" ? "offer_received" : "counter_sent", { listingId: n.listingId, negotiationId, amountMinor });
    return n;
  }

  /** The negotiation oracle (R5): answers questions about an offer without ever exposing the floor. */
  async oracle(negotiationId: string, offerMinor: number) {
    const n = await this.getNegotiation(negotiationId);
    const l = await this.getListing(n.listingId);
    const m = await this.d.store.get<Mandate>(K.mandate(l.id));
    const now = this.now();
    if (!m) {
      // No mandate: anything at or above ask is acceptable (still needs the seller's yes), counter at ask.
      return { acceptable: offerMinor >= l.askMinor, autoAcceptable: false, counterMinor: offerMinor >= l.askMinor ? null : l.askMinor, askMinor: l.askMinor };
    }
    return {
      acceptable: acceptable(offerMinor, m, now),
      autoAcceptable: autoAcceptable(offerMinor, m, now),
      counterMinor: suggestCounter({ offerMinor, askMinor: l.askMinor, previousCounterMinor: n.lastCounterMinor }, m),
      askMinor: l.askMinor,
    };
  }

  /** Outbound message guard (R2/R5). Secrets are checked here and never returned. */
  async checkOutgoing(listingId: string, text: string): Promise<LeakCheck> {
    const l = await this.getListing(listingId);
    const hh = await this.mustGet<Household>(K.household(l.householdId), "household_not_found");
    const address = await this.d.vault.decrypt(hh.addressCipher);
    const m = await this.d.store.get<Mandate>(K.mandate(l.id));
    const fragments = [address, ...address.split(/,|\n/).map((s) => s.trim())].filter((s) => s.length >= 4);
    const res = guardOutgoing(text, { addressFragments: fragments, floorMinor: m?.floorMinor });
    if (!res.ok) await this.logDecision("send_message", "deny", ["R2", "R5"], res.violations, "agent:negotiator", { listingId });
    return res;
  }

  /** Record a scam/abuse strike (R7). Two strikes block the buyer for 30 days. */
  async strike(negotiationId: string, signal: string) {
    const n = await this.getNegotiation(negotiationId);
    const b = await this.mustGet<Buyer>(K.buyer(n.buyerId), "buyer_not_found");
    n.strikes += 1;
    b.strikes += 1;
    let blocked = false;
    if (n.strikes >= 2) {
      n.state = "ABUSE_BLOCKED";
      b.blockedUntil = this.now() + 30 * 24 * 60 * 60 * 1000;
      blocked = true;
    }
    await this.saveNego(n);
    await this.d.store.put(K.buyer(b.id), b);
    await this.logDecision("send_message", "deny", ["R7"], [`scam_signal_${signal}`, ...(blocked ? ["buyer_blocked"] : [])], "agent:negotiator", {
      listingId: n.listingId,
    });
    return { strikes: n.strikes, blocked };
  }

  /** Log a refused request that earns no strike (address request R2, prompt injection R8, links). */
  async noteRefusal(negotiationId: string, signal: string) {
    const n = await this.getNegotiation(negotiationId);
    const rules: PolicyDecisionRecord["ruleIds"] =
      signal === "address_request" ? ["R2"] : signal === "instruction_injection" ? ["R8"] : ["R7"];
    return this.logDecision(signal === "address_request" ? "reveal_address" : "send_message", "deny", rules, [`refused_${signal}`], `buyer:${n.buyerId}`, {
      listingId: n.listingId,
    });
  }

  acceptTerms(n: Negotiation, l: Listing, amountMinor: number, buyerLabel: string): ApprovalTerms {
    return {
      action: "accept_offer",
      listingId: l.id,
      amountMinor,
      buyerPseudonym: buyerLabel,
      details: { negotiationId: n.id, listingVersion: l.version },
    };
  }

  /**
   * The Negotiator proposes accepting an offer. Settlement decides:
   *  - deny (below floor / expired mandate),
   *  - allow via Mandate auto-accept (creates the Deal now),
   *  - or needs the seller's approval (returns a PendingApproval for an elicitation card).
   */
  async proposeAccept(negotiationId: string, amountMinor: number, actor = "agent:negotiator") {
    const n = await this.getNegotiation(negotiationId);
    const l = await this.getListing(n.listingId);
    const m = await this.d.store.get<Mandate>(K.mandate(l.id));
    const decision = await this.record(
      { action: "accept_offer", offerMinor: amountMinor, mandate: m, approvalTokenVerified: false, now: this.now() },
      actor,
      { listingId: l.id },
    );
    if (decision.outcome === "deny") return { decision };
    if (decision.outcome === "allow") {
      const deal = await this.createDeal(n, l, amountMinor, actor);
      return { decision, deal };
    }
    const buyer = await this.buyerPublic(n.buyerId);
    const terms = this.acceptTerms(n, l, amountMinor, buyer.label);
    const approval = await this.requestApproval(
      terms,
      `seller:${l.householdId}`,
      `${buyer.label} offers $${(amountMinor / 100).toFixed(0)} for the ${l.title}. Accept?`,
    );
    await this.saveNego({ ...n, state: "AGREED_PENDING_SELLER", pendingAmountMinor: amountMinor, pendingApprovalId: approval.id });
    return { decision, approval };
  }

  /** Seller approved (token) -> create the Deal. Terms must match exactly what the seller saw. */
  async acceptWithToken(negotiationId: string, amountMinor: number, token: string, actor: string) {
    const n = await this.getNegotiation(negotiationId);
    const l = await this.getListing(n.listingId);
    const buyer = await this.buyerPublic(n.buyerId);
    const terms = this.acceptTerms(n, l, amountMinor, buyer.label);
    const m = await this.d.store.get<Mandate>(K.mandate(l.id));
    const ok = await this.spend(token, terms, actor, { listingId: l.id });
    const decision = await this.record(
      { action: "accept_offer", offerMinor: amountMinor, mandate: m, approvalTokenVerified: ok, now: this.now() },
      actor,
      { listingId: l.id },
    );
    if (decision.outcome !== "allow") throw new SettlementError("not_allowed", decision.reasons.join(","), 403);
    return this.createDeal(n, l, amountMinor, actor);
  }

  async declineOffer(negotiationId: string, actor: string) {
    const n = await this.getNegotiation(negotiationId);
    if (n.pendingApprovalId) await this.expireApproval(n.pendingApprovalId);
    await this.saveNego({ ...n, state: "OPEN", pendingAmountMinor: undefined, pendingApprovalId: undefined });
    this.emit("offer_declined", { listingId: n.listingId, negotiationId, actor });
  }

  /** Atomic: one active deal per listing (X5, X29). Losers get "just sold". */
  private async createDeal(n: Negotiation, l: Listing, amountMinor: number, actor: string): Promise<Deal> {
    const deal: Deal = {
      id: newId("deal"),
      listingId: l.id,
      negotiationId: n.id,
      householdId: l.householdId,
      buyerId: n.buyerId,
      itemTitle: l.title,
      amountMinor,
      buyerFeeMinor: BUYER_FEE_MINOR,
      sellerFeeMinor: Math.round((amountMinor * SELLER_FEE_PCT) / 100),
      state: "AGREED",
      version: 1,
      buyerConfirmed: false,
      dual: { buyer: false, seller: false },
      receiptIds: [],
      history: [{ state: "AGREED", at: this.now(), event: `accepted_by_${actor}` }],
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    const ok = await this.d.store.transact([
      { key: K.listing(l.id), value: { ...l, state: "RESERVED", version: l.version + 1, updatedAt: this.now() }, ifVersion: l.version },
      { key: K.activeDeal(l.id), value: { dealId: deal.id, version: 1 }, ifAbsent: true },
      { key: K.deal(deal.id), value: deal, ifAbsent: true },
      {
        key: K.nego(n.id),
        value: { ...n, state: "CONVERTED", pendingAmountMinor: undefined, version: n.version + 1, updatedAt: this.now() },
        ifVersion: n.version,
      },
    ]);
    if (!ok) throw new SettlementError("already_accepted", "This item was just sold to someone else", 409);
    for (const other of await this.negotiationsFor(l.id)) {
      if (other.id !== n.id && (other.state === "OPEN" || other.state === "AGREED_PENDING_SELLER")) {
        await this.saveNego({ ...other, state: "SUPERSEDED" });
        if (other.pendingApprovalId) await this.expireApproval(other.pendingApprovalId);
      }
    }
    this.d.scheduler.schedule({ kind: "reservation_expired", at: this.now() + RESERVATION_TTL_MS, dealId: deal.id });
    this.emit("deal_created", { dealId: deal.id, listingId: l.id, amountMinor, title: l.title });
    return deal;
  }

  // ------------------------------------------------------------------ deals

  async getDeal(dealId: string) {
    return this.mustGet<Deal>(K.deal(dealId), "deal_not_found");
  }

  private async move(deal: Deal, event: DealEvent, note?: string): Promise<Deal> {
    const r = transition(deal.state, event);
    if (!r.ok) throw new SettlementError("bad_transition", r.reason, 409);
    const next: Deal = {
      ...deal,
      state: r.next,
      version: deal.version + 1,
      updatedAt: this.now(),
      history: [...deal.history, { state: r.next, at: this.now(), event: note ?? (event.type === "VERDICT" ? `VERDICT_${event.verdict}` : event.type) }],
    };
    if (!(await this.d.store.put(K.deal(deal.id), next, { ifVersion: deal.version }))) throw new SettlementError("conflict", "Deal changed", 409);
    if (next.state !== deal.state) this.emit("deal_state", { dealId: deal.id, from: deal.state, to: next.state, listingId: deal.listingId });
    return next;
  }

  private async patchDeal(deal: Deal, patch: Partial<Deal>): Promise<Deal> {
    const next = { ...deal, ...patch, version: deal.version + 1, updatedAt: this.now() };
    if (!(await this.d.store.put(K.deal(deal.id), next, { ifVersion: deal.version }))) throw new SettlementError("conflict", "Deal changed", 409);
    return next;
  }

  async dealsForHousehold(householdId: string) {
    return (await this.d.store.list<Deal>("deal#")).filter((d) => d.householdId === householdId);
  }

  async dealsForBuyer(buyerId: string) {
    return (await this.d.store.list<Deal>("deal#")).filter((d) => d.buyerId === buyerId);
  }

  private async releaseListing(listingId: string, to: "LIVE" | "WITHDRAWN" | "SOLD" | "CLOSED") {
    const l = await this.getListing(listingId);
    await this.d.store.put(K.listing(l.id), { ...l, state: to, version: l.version + 1, updatedAt: this.now() });
    if (to === "LIVE" || to === "WITHDRAWN") await this.d.store.delete(K.activeDeal(listingId));
    this.emit(to === "LIVE" ? "listing_relisted" : "listing_state", { listingId, state: to });
  }

  // ------------------------------------------------------------------ checkout (used by ucp.ts)

  buyerTotalMinor(deal: Deal) {
    return deal.amountMinor + deal.buyerFeeMinor;
  }

  async openCheckout(dealId: string, buyerId: string, checkoutId: string): Promise<Deal> {
    const deal = await this.getDeal(dealId);
    if (deal.buyerId !== buyerId) throw new SettlementError("not_your_deal", undefined, 403);
    if (deal.state === "CHECKOUT_OPEN" && deal.checkoutId) return deal;
    const moved = await this.move(deal, { type: "CHECKOUT_CREATED" });
    return this.patchDeal(moved, { checkoutId });
  }

  /** Complete a checkout: R13 confirmations, then place the escrow hold. */
  async completeCheckout(input: {
    dealId: string;
    buyerId: string;
    quotedTotalMinor: number;
    expectedTotalMinor: number;
    credential: PaymentCredential;
    confirmations: { breakdownShown: boolean; refundPolicyShown: boolean; explicitYes: boolean; voiceCode?: string; onScreenConfirmed?: boolean };
    idempotencyKey: string;
  }) {
    const deal = await this.getDeal(input.dealId);
    const buyer = await this.mustGet<Buyer>(K.buyer(input.buyerId), "buyer_not_found");
    if (deal.buyerId !== buyer.id) throw new SettlementError("not_your_deal", undefined, 403);
    const voiceOk = input.confirmations.voiceCode !== undefined && hashSecret(input.confirmations.voiceCode) === buyer.voiceCodeHash;
    const decision = await this.record(
      {
        action: "complete_checkout",
        quotedTotalMinor: input.quotedTotalMinor,
        chargedTotalMinor: input.expectedTotalMinor,
        breakdownShown: input.confirmations.breakdownShown,
        refundPolicyShown: input.confirmations.refundPolicyShown,
        explicitYes: input.confirmations.explicitYes,
        voiceCodeVerified: voiceOk,
        onScreenConfirmed: input.confirmations.onScreenConfirmed === true,
        paymentMethodPreconfigured: input.credential.token === buyer.walletToken,
        duplicateOfCompleted: deal.state !== "CHECKOUT_OPEN",
      },
      `buyer:${buyer.id}`,
      { dealId: deal.id, listingId: deal.listingId },
    );
    if (decision.outcome !== "allow") return { decision };
    let hold;
    try {
      hold = await this.d.psp.authorize(input.quotedTotalMinor, input.credential, this.now(), input.idempotencyKey);
    } catch (e) {
      if (e instanceof PaymentError) return { decision, paymentError: e.message };
      throw e;
    }
    let next = await this.move(deal, { type: "HOLD_PLACED" });
    next = await this.patchDeal(next, { holdId: hold.holdId, captureBefore: hold.captureBefore });
    this.d.scheduler.cancelFor(deal.id, "reservation_expired");
    this.emit("funds_held", { dealId: deal.id, amountMinor: input.quotedTotalMinor, psp: this.d.psp.label });
    return { decision, deal: next, hold };
  }

  async abandonCheckout(dealId: string) {
    const deal = await this.getDeal(dealId);
    if (deal.state !== "CHECKOUT_OPEN" && deal.state !== "AGREED") return deal;
    const moved = await this.move(deal, { type: "CHECKOUT_ABANDONED" }, "reservation_expired");
    await this.releaseListing(deal.listingId, "LIVE");
    return moved;
  }

  // ------------------------------------------------------------------ pickup pass

  async issuePass(dealId: string, window: PickupWindow, actor: string) {
    const deal = await this.getDeal(dealId);
    const buyer = await this.mustGet<Buyer>(K.buyer(deal.buyerId), "buyer_not_found");
    const active = (await this.dealsForBuyer(buyer.id)).filter((d) => ["FUNDS_HELD", "PASS_ISSUED", "WINDOW_OPEN"].includes(d.state)).length;
    const decision = await this.record(
      { action: "issue_pass", dealState: deal.state, buyerActiveReservations: active, buyerNoShows: buyer.noShows, window },
      actor,
      { dealId, listingId: deal.listingId },
    );
    if (decision.outcome !== "allow") throw new SettlementError("pass_denied", decision.reasons.join(","), 403);
    const otp = String(randomInt(100000, 999999));
    const pass: Pass = {
      id: newId("pass"),
      dealId,
      buyerId: buyer.id,
      otpHash: hashSecret(otp),
      otpAttempts: 0,
      otpWindowStart: this.now(),
      createdAt: this.now(),
    };
    await this.d.store.put(K.pass(pass.id), pass);
    let next = await this.move(deal, { type: "PASS_ISSUED" });
    next = await this.patchDeal(next, { passId: pass.id, window });
    this.d.scheduler.schedule({ kind: "open_window", at: window.start - 30 * 60 * 1000, dealId });
    this.d.scheduler.schedule({ kind: "close_window", at: window.end, dealId });
    if (deal.captureBefore && deal.captureBefore - HOLD_RENEW_MARGIN_MS < window.end)
      this.d.scheduler.schedule({ kind: "hold_check", at: Math.max(this.now(), deal.captureBefore - HOLD_RENEW_MARGIN_MS), dealId });
    const url = `${this.d.passBaseUrl.replace(/\/$/, "")}/p/${pass.id}`;
    // The OTP goes to the buyer's email (SES in AWS). Locally it is emitted for the demo console, labelled.
    this.emit("pass_issued", { dealId, passId: pass.id, url, otpForEmail: otp, email: buyer.email, window });
    return { pass, url, otp };
  }

  private async getPass(passId: string) {
    return this.mustGet<Pass>(K.pass(passId), "pass_not_found");
  }

  /** First open: bind the device with the emailed one-time code (rate limited, R11). */
  async bindPass(passId: string, otp: string, deviceId: string) {
    const p = await this.getPass(passId);
    if (p.deviceId) {
      if (p.deviceId === deviceId) return { bound: true };
      throw new SettlementError("pass_bound_elsewhere", "This pass is already open on another device", 403);
    }
    if (this.now() - p.otpWindowStart > OTP_WINDOW_MS) {
      p.otpAttempts = 0;
      p.otpWindowStart = this.now();
    }
    if (p.otpAttempts >= OTP_MAX_ATTEMPTS) throw new SettlementError("otp_rate_limited", "Too many attempts. Try again in 15 minutes.", 429);
    p.otpAttempts += 1;
    if (hashSecret(otp) !== p.otpHash) {
      await this.d.store.put(K.pass(p.id), p);
      await this.logDecision("reveal_address", "deny", ["R11"], ["otp_mismatch"], `buyer:${p.buyerId}`, { dealId: p.dealId });
      throw new SettlementError("otp_invalid", "That code didn't match", 403);
    }
    p.deviceId = deviceId;
    await this.d.store.put(K.pass(p.id), p);
    this.emit("pass_bound", { dealId: p.dealId, passId });
    return { bound: true };
  }

  async consentPass(passId: string, deviceId: string) {
    const p = await this.getPass(passId);
    if (p.deviceId !== deviceId) throw new SettlementError("device_not_bound", undefined, 403);
    p.consentAt = this.now();
    await this.d.store.put(K.pass(p.id), p);
  }

  /** What the pass page shows. The address appears only when R2 allows it. */
  async passView(passId: string, deviceId: string) {
    const p = await this.getPass(passId);
    if (p.deviceId !== deviceId) throw new SettlementError("device_not_bound", "Open the link from your email and enter the code", 403);
    const deal = await this.getDeal(p.dealId);
    const hh = await this.mustGet<Household>(K.household(deal.householdId), "household_not_found");
    let address: string | undefined;
    let porchInstructions: string | undefined;
    if (deal.window && p.consentAt) {
      const decision = await this.record(
        {
          action: "reveal_address",
          dealState: deal.state,
          window: deal.window,
          now: this.now(),
          requester: { buyerId: p.buyerId, deviceId },
          bound: { buyerId: deal.buyerId, deviceId: p.deviceId },
          channel: "pass_page",
        },
        `buyer:${p.buyerId}`,
        { dealId: deal.id },
      );
      if (decision.outcome === "allow") {
        address = await this.d.vault.decrypt(hh.addressCipher);
        porchInstructions = hh.porchInstructions;
      }
    }
    const receipts = await Promise.all(deal.receiptIds.map((id) => this.mustGet<ReceiptRecord>(K.receipt(id), "receipt_not_found")));
    return {
      passId,
      dealId: deal.id,
      state: deal.state,
      itemTitle: deal.itemTitle,
      breakdown: { itemMinor: deal.amountMinor, feeMinor: deal.buyerFeeMinor, taxMinor: 0, totalMinor: this.buyerTotalMinor(deal) },
      window: deal.window,
      consented: p.consentAt !== undefined,
      checkedIn: p.checkInAt !== undefined,
      address,
      porchInstructions,
      verdict: deal.verdict,
      inspectionEndsAt: deal.verifiedAt ? deal.verifiedAt + INSPECTION_MS : undefined,
      receiptIds: receipts.map((r) => r.id),
    };
  }

  /** Signal P: device-bound "I'm here" inside the window. */
  async checkIn(passId: string, deviceId: string) {
    const p = await this.getPass(passId);
    if (p.deviceId !== deviceId) throw new SettlementError("device_not_bound", undefined, 403);
    const deal = await this.getDeal(p.dealId);
    if (!deal.window || this.now() < deal.window.start || this.now() > deal.window.end)
      throw new SettlementError("outside_window", "Check-in opens at the start of your pickup window", 409);
    p.checkInAt = this.now();
    await this.d.store.put(K.pass(p.id), p);
    this.emit("buyer_checked_in", { dealId: deal.id, passId });
    const hh = await this.mustGet<Household>(K.household(deal.householdId), "household_not_found");
    // Ask for an after-frame even if the camera never fires, so a missed event still resolves (REVIEW, not limbo).
    this.emit("frame_needed", { dealId: deal.id, kind: "after", notBefore: this.now() + AFTER_FRAME_DELAY_MS, deviceId: hh.ringDeviceId });
    return this.evaluate(deal.id);
  }

  /** Buyer's verdict on the item during inspection, or their confirmation in REVIEW/DEGRADED. */
  async buyerOutcome(passId: string, deviceId: string, outcome: "got_it" | "not_as_described" | "not_received", note?: string) {
    const p = await this.getPass(passId);
    if (p.deviceId !== deviceId) throw new SettlementError("device_not_bound", undefined, 403);
    let deal = await this.getDeal(p.dealId);
    this.emit("buyer_outcome", { dealId: deal.id, outcome, note });
    if (outcome === "got_it") {
      if (deal.state === "INSPECTION") {
        deal = await this.patchDeal(deal, { buyerConfirmed: true });
        return this.tryCapture(deal.id, `buyer:${p.buyerId}`);
      }
      if (deal.state === "REVIEW" || deal.state === "DEGRADED") return this.dualConfirm(deal.id, "buyer");
      throw new SettlementError("nothing_to_confirm", `Deal is ${deal.state}`, 409);
    }
    if (deal.state !== "INSPECTION") throw new SettlementError("not_in_inspection", `Deal is ${deal.state}`, 409);
    deal = await this.move(deal, { type: "DISPUTE_OPENED" }, `buyer_${outcome}`);
    if (outcome === "not_received") {
      // The receipt shows the buyer's own check-in, a Ring presence event and the item gone: evidence supports the seller.
      const outcomeRule = deal.verdict === "VERIFIED" ? "release_to_seller" : "refund_buyer";
      return this.resolveDispute(deal.id, outcomeRule, "rules:evidence_bundle");
    }
    this.emit("dispute_opened", { dealId: deal.id, reason: outcome, note });
    return deal;
  }

  async resolveDispute(dealId: string, outcome: "release_to_seller" | "refund_buyer", actor: string) {
    let deal = await this.getDeal(dealId);
    if (deal.state !== "DISPUTE") throw new SettlementError("not_in_dispute", undefined, 409);
    deal = await this.patchDeal(deal, { disputeOutcome: outcome });
    this.emit("dispute_resolved", { dealId, outcome, actor });
    if (outcome === "release_to_seller") return this.tryCapture(dealId, actor);
    await this.voidHold(deal, "dispute_refund_buyer", actor);
    return this.getDeal(dealId);
  }

  async dualConfirm(dealId: string, party: "buyer" | "seller") {
    let deal = await this.getDeal(dealId);
    if (deal.state !== "REVIEW" && deal.state !== "DEGRADED") throw new SettlementError("not_in_review", `Deal is ${deal.state}`, 409);
    deal = await this.patchDeal(deal, { dual: { ...deal.dual, [party]: true } });
    this.emit("dual_confirm", { dealId, party });
    if (deal.dual.buyer && deal.dual.seller) {
      deal = await this.move(deal, { type: "DUAL_CONFIRMED" });
      return this.tryCapture(dealId, "rules:dual_confirmed");
    }
    return deal;
  }

  cancelTerms(deal: Deal): ApprovalTerms {
    return { action: "cancel_sale", dealId: deal.id, listingId: deal.listingId, amountMinor: deal.amountMinor };
  }

  /** Seller cancels after the buyer paid (X21): void the hold, notify the buyer. Requires the seller's approval token. */
  async sellerCancel(dealId: string, token: string, actor: string) {
    const deal = await this.getDeal(dealId);
    if (!(await this.spend(token, this.cancelTerms(deal), actor, { dealId })))
      throw new SettlementError("approval_invalid", undefined, 403);
    const moved = await this.move(deal, { type: "SELLER_CANCELLED" });
    await this.logDecision("cancel_sale", "allow", ["R4"], ["seller_cancelled_hold_voided"], actor, { dealId });
    await this.voidHold(moved, "seller_cancelled", actor);
    await this.releaseListing(deal.listingId, "WITHDRAWN");
    this.d.scheduler.cancelFor(dealId);
    return this.getDeal(dealId);
  }

  private async voidHold(deal: Deal, reason: string, actor: string) {
    if (deal.holdId) await this.d.psp.cancel(deal.holdId);
    const fresh = await this.getDeal(deal.id);
    if (fresh.state !== "VOIDED") {
      try {
        await this.move(fresh, { type: "VOID" }, reason);
      } catch {
        // Some states void implicitly (e.g. STILL_THERE on window close); record the hold cancel regardless.
      }
    }
    await this.logDecision("void_hold", "allow", ["R3"], [reason], actor, { dealId: deal.id });
    this.emit("hold_voided", { dealId: deal.id, reason });
  }

  // ------------------------------------------------------------------ evidence & proof of handoff

  private async evidence(dealId: string): Promise<Evidence> {
    return (await this.d.store.get<Evidence>(K.evidence(dealId))) ?? { dealId, ringEvents: [], unsureRetries: 0, camera: "ok" };
  }

  private async saveEvidence(e: Evidence) {
    await this.d.store.put(K.evidence(e.dealId), e);
  }

  async getEvidence(dealId: string) {
    return this.evidence(dealId);
  }

  /** Match a normalized Ring event to the deal whose window is open at that household's device. */
  async ingestRingEvent(evt: RingEvent) {
    const households = (await this.d.store.list<Household>("household#")).filter((h) => h.ringDeviceId === evt.deviceId);
    const touched: string[] = [];
    for (const hh of households) {
      for (const deal of await this.dealsForHousehold(hh.id)) {
        if (deal.state !== "WINDOW_OPEN" && deal.state !== "STILL_THERE") continue;
        const ev = await this.evidence(deal.id);
        if (ev.ringEvents.some((e) => e.requestId === evt.requestId)) continue;
        ev.ringEvents.push(evt);
        await this.saveEvidence(ev);
        touched.push(deal.id);
        this.emit("ring_event_matched", { dealId: deal.id, kind: evt.kind, subType: evt.subType, origin: evt.origin });
        if (isPresenceEvent(evt)) this.emit("frame_needed", { dealId: deal.id, kind: "after", notBefore: evt.at + AFTER_FRAME_DELAY_MS, deviceId: evt.deviceId });
        await this.evaluate(deal.id);
      }
    }
    return { matchedDeals: touched };
  }

  async recordFrame(dealId: string, kind: "before" | "after", obs: FrameObservation) {
    const ev = await this.evidence(dealId);
    if (kind === "before") ev.before = obs;
    else ev.after = obs;
    await this.saveEvidence(ev);
    this.emit("frame_recorded", { dealId, kind, presence: obs.presence, origin: obs.origin, sha256: obs.sha256 });
    return this.evaluate(dealId);
  }

  async setCameraStatus(dealId: string, camera: Evidence["camera"]) {
    const ev = await this.evidence(dealId);
    ev.camera = camera;
    await this.saveEvidence(ev);
    this.emit("camera_status", { dealId, camera });
    return this.evaluate(dealId);
  }

  /** Run the PoH truth table and move the deal. Idempotent: safe to call on every new signal. */
  async evaluate(dealId: string): Promise<Deal> {
    let deal = await this.getDeal(dealId);
    if (deal.state !== "WINDOW_OPEN" && deal.state !== "STILL_THERE") return deal;
    const ev = await this.evidence(dealId);
    const pass = deal.passId ? await this.getPass(deal.passId) : undefined;
    const input: HandoffEvidence = {
      window: deal.window!,
      checkInAt: pass?.checkInAt,
      ringEvents: ev.ringEvents,
      before: ev.before?.presence,
      after: ev.after?.presence,
      unsureRetries: ev.unsureRetries,
      camera: ev.camera,
    };
    const result = evaluateHandoff(input);
    this.emit("handoff_evaluated", { dealId, verdict: result.verdict, signals: result.signals, reasons: result.reasons });

    switch (result.verdict) {
      case "PENDING":
        return deal;
      case "RETRY_FRAME":
        ev.unsureRetries += 1;
        ev.after = undefined;
        await this.saveEvidence(ev);
        this.emit("frame_needed", { dealId, kind: "after", notBefore: this.now() + 60_000, retry: ev.unsureRetries });
        return deal;
      case "VERIFIED": {
        deal = await this.move(deal, { type: "VERDICT", verdict: "VERIFIED" });
        deal = await this.patchDeal(deal, { verdict: "VERIFIED", verifiedAt: this.now() });
        const receipt = await this.issueReceipt(deal, ev, input, "VERIFIED", result.signals);
        deal = await this.getDeal(dealId);
        deal = await this.move(deal, { type: "RECEIPT_SIGNED" });
        this.d.scheduler.cancelFor(dealId, "close_window");
        this.d.scheduler.schedule({ kind: "inspection_elapsed", at: this.now() + INSPECTION_MS, dealId });
        this.emit("handoff_verified", { dealId, receiptId: receipt.id });
        return deal;
      }
      case "PIRACY_SUSPECTED":
        deal = await this.move(deal, { type: "VERDICT", verdict: "PIRACY_SUSPECTED" });
        deal = await this.patchDeal(deal, { verdict: "PIRACY_SUSPECTED" });
        this.emit("piracy_alert", { dealId, listingId: deal.listingId, evidence: { ringEvents: ev.ringEvents.length, after: ev.after?.sha256 } });
        await this.voidHold(deal, "piracy_suspected_no_capture", "rules:poh");
        await this.releaseListing(deal.listingId, "CLOSED");
        this.d.scheduler.cancelFor(dealId);
        return this.getDeal(dealId);
      case "STILL_THERE":
        if (deal.state === "STILL_THERE") return deal;
        deal = await this.move(deal, { type: "VERDICT", verdict: "STILL_THERE" });
        this.emit("item_still_there", { dealId });
        return this.patchDeal(deal, { verdict: "STILL_THERE" });
      case "REVIEW":
      case "DEGRADED":
        deal = await this.move(deal, { type: "VERDICT", verdict: result.verdict });
        this.emit("handoff_review", { dealId, verdict: result.verdict, reasons: result.reasons });
        return this.patchDeal(deal, { verdict: result.verdict });
    }
  }

  private async issueReceipt(
    deal: Deal,
    ev: Evidence,
    input: HandoffEvidence,
    verdict: HandoffReceipt["verdict"],
    signals: { P: boolean; D: boolean; B: boolean },
  ): Promise<ReceiptRecord> {
    const item = await this.getItem((await this.getListing(deal.listingId)).itemId);
    const decisions = (await this.decisions(500)).filter((d) => d.dealId === deal.id).map((d) => d.id);
    const signDecision = await this.logDecision("sign_receipt", "allow", ["R3"], [`verdict_${verdict}`], "rules:poh", { dealId: deal.id });
    const prev = deal.receiptIds.length
      ? await this.d.store.get<ReceiptRecord>(K.receipt(deal.receiptIds[deal.receiptIds.length - 1]!))
      : undefined;
    const payload: HandoffReceipt = {
      v: 1,
      receiptId: newId("rcpt"),
      dealId: deal.id,
      listingId: deal.listingId,
      itemHash: item.itemHash,
      verdict,
      signals,
      window: deal.window!,
      evidence: {
        checkInAt: input.checkInAt,
        ringEvents: ev.ringEvents.map((e) => ({ kind: e.kind, subType: e.subType, at: e.at, origin: e.origin })),
        beforeFrameSha256: ev.before?.sha256,
        afterFrameSha256: ev.after?.sha256,
      },
      decisionIds: [...decisions, signDecision.id],
      prevReceiptHash: prev?.hash,
      issuer: this.d.issuer ?? "stoop-settlement",
      issuedAt: this.now(),
    };
    const jws = await signReceipt(payload, this.d.signer);
    const rec: ReceiptRecord = { id: payload.receiptId, dealId: deal.id, jws, hash: receiptHash(jws), createdAt: this.now() };
    await this.d.store.put(K.receipt(rec.id), rec);
    const fresh = await this.getDeal(deal.id);
    await this.patchDeal(fresh, { receiptIds: [...fresh.receiptIds, rec.id] });
    this.emit("receipt_signed", { dealId: deal.id, receiptId: rec.id, verdict });
    return rec;
  }

  async getReceipt(id: string) {
    return this.mustGet<ReceiptRecord>(K.receipt(id), "receipt_not_found");
  }

  async jwks() {
    return { keys: [await this.d.signer.publicJwk()] };
  }

  // ------------------------------------------------------------------ capture

  async tryCapture(dealId: string, actor: string): Promise<Deal> {
    let deal = await this.getDeal(dealId);
    const decision = await this.record(
      {
        action: "capture",
        dealState: deal.state,
        verdict: deal.verdict,
        verifiedAt: deal.verifiedAt,
        buyerConfirmed: deal.buyerConfirmed,
        dualConfirmed: deal.dual.buyer && deal.dual.seller,
        disputeOutcome: deal.disputeOutcome,
        amountMinor: deal.amountMinor,
        now: this.now(),
      },
      actor,
      { dealId, listingId: deal.listingId },
    );
    if (decision.outcome !== "allow") return deal;
    await this.d.psp.capture(deal.holdId!, this.buyerTotalMinor(deal), this.now());
    deal = await this.move(deal, { type: "CAPTURE_SUCCEEDED" });
    this.d.scheduler.cancelFor(dealId);
    const payoutMinor = deal.amountMinor - deal.sellerFeeMinor;
    deal = await this.move(deal, { type: "PAYOUT_RECORDED" }, `payout_${payoutMinor}_test_ledger`);
    deal = await this.move(deal, { type: "CLOSE" });
    await this.releaseListing(deal.listingId, "SOLD");
    const buyer = await this.mustGet<Buyer>(K.buyer(deal.buyerId), "buyer_not_found");
    await this.d.store.put(K.buyer(buyer.id), { ...buyer, verifiedPickups: buyer.verifiedPickups + 1 });
    this.emit("sale_completed", { dealId, listingId: deal.listingId, title: deal.itemTitle, payoutMinor, amountMinor: deal.amountMinor });
    return deal;
  }

  // ------------------------------------------------------------------ scheduled jobs (Step Functions in AWS)

  async onJob(job: ScheduledJob) {
    const deal = await this.d.store.get<Deal>(K.deal(job.dealId));
    if (!deal) return;
    switch (job.kind) {
      case "reservation_expired":
        if (deal.state === "AGREED" || deal.state === "CHECKOUT_OPEN") {
          await this.abandonCheckout(deal.id);
          this.emit("reservation_released", { dealId: deal.id, listingId: deal.listingId });
        }
        return;
      case "open_window":
        if (deal.state === "PASS_ISSUED") {
          await this.move(deal, { type: "WINDOW_OPENED" });
          const hh = await this.mustGet<Household>(K.household(deal.householdId), "household_not_found");
          this.emit("window_opened", { dealId: deal.id });
          this.emit("frame_needed", { dealId: deal.id, kind: "before", notBefore: this.now(), deviceId: hh.ringDeviceId });
        }
        return;
      case "close_window": {
        if (deal.state === "WINDOW_OPEN") {
          const pass = deal.passId ? await this.getPass(deal.passId) : undefined;
          if (!pass?.checkInAt) {
            const moved = await this.move(deal, { type: "WINDOW_CLOSED" }, "no_show");
            await this.voidHold(moved, "no_show", "rules:window_closed");
            await this.releaseListing(deal.listingId, "LIVE");
            const b = await this.mustGet<Buyer>(K.buyer(deal.buyerId), "buyer_not_found");
            const noShows = b.noShows + 1;
            await this.d.store.put(K.buyer(b.id), {
              ...b,
              noShows,
              blockedUntil: noShows >= 2 ? this.now() + 30 * 24 * 60 * 60 * 1000 : b.blockedUntil,
            });
            this.emit("no_show", { dealId: deal.id, listingId: deal.listingId });
          } else {
            // Checked in but no verdict: needs both parties to confirm.
            const moved = await this.move(deal, { type: "VERDICT", verdict: "REVIEW" }, "window_closed_after_check_in");
            await this.patchDeal(moved, { verdict: "REVIEW" });
          }
        } else if (deal.state === "STILL_THERE") {
          const moved = await this.move(deal, { type: "WINDOW_CLOSED" }, "item_never_collected");
          await this.voidHold(moved, "item_never_collected", "rules:window_closed");
          await this.releaseListing(deal.listingId, "LIVE");
        }
        return;
      }
      case "inspection_elapsed":
        if (deal.state === "INSPECTION") await this.tryCapture(deal.id, "rules:inspection_elapsed");
        return;
      case "hold_check":
        if (["FUNDS_HELD", "PASS_ISSUED"].includes(deal.state) && deal.holdId) {
          // Sandbox: re-authorize a fresh hold before the old one lapses (X22).
          const moved = await this.move(deal, { type: "HOLD_EXPIRING" });
          await this.d.psp.cancel(deal.holdId);
          const buyer = await this.mustGet<Buyer>(K.buyer(deal.buyerId), "buyer_not_found");
          const hold = await this.d.psp.authorize(this.buyerTotalMinor(deal), { handler: "com.amazon.payments.stored_payment_method", token: buyer.walletToken }, this.now(), `reauth_${deal.id}_${this.now()}`);
          let back = await this.move(moved, { type: "REAUTHORIZED" });
          if (deal.state === "PASS_ISSUED") back = await this.move(back, { type: "PASS_ISSUED" }, "pass_still_valid_after_reauth");
          await this.patchDeal(back, { holdId: hold.holdId, captureBefore: hold.captureBefore });
          this.emit("hold_reauthorized", { dealId: deal.id });
        }
        return;
    }
  }

  /** Seller-side helper for the PASS_ISSUED state machine: deals in FUNDS_HELD need a pass. */
  dealStateLabel(state: DealState) {
    return state.replace(/_/g, " ").toLowerCase();
  }

  // ------------------------------------------------------------------ helpers

  private async mustGet<T>(key: string, code: string): Promise<T> {
    const v = await this.d.store.get<T>(key);
    if (v === undefined) throw new SettlementError(code, code, 404);
    return v;
  }
}
