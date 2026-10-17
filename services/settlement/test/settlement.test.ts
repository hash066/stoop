import { describe, expect, it } from "vitest";
import { verifyReceipt } from "@stoop/proof-of-handoff";
import { ADDRESS, agreedDeal, frame, fundedDeal, liveListing, makeStack, openWindowDeal, ringEvent, WALLET } from "./helpers.ts";

describe("golden path", () => {
  it("list -> negotiate -> approve -> hold -> pass -> verified -> inspection -> capture -> closed", async () => {
    const st = await makeStack();
    const { s, clock, bus } = st;
    const { deal, pass } = await openWindowDeal(st);
    expect(deal.state).toBe("WINDOW_OPEN");

    // address visible only on the bound pass page inside the window
    const view = await s.passView(pass.id, "device-dana");
    expect(view.address).toBe(ADDRESS);

    await s.recordFrame(deal.id, "before", frame("present", clock.now()));
    await s.checkIn(pass.id, "device-dana");
    await s.ingestRingEvent(ringEvent(clock.now() + 20_000, { kind: "button_press", subType: undefined }));
    let d = await s.recordFrame(deal.id, "after", frame("absent", clock.now() + 90_000));
    expect(d.state).toBe("INSPECTION");
    expect(d.receiptIds).toHaveLength(1);

    const rcpt = await s.getReceipt(d.receiptIds[0]!);
    const verified = await verifyReceipt(rcpt.jws, await s.jwks());
    expect(verified.valid).toBe(true);
    if (verified.valid) {
      expect(verified.receipt.signals).toEqual({ P: true, D: true, B: true });
      expect(JSON.stringify(verified.receipt)).not.toContain("Maple");
    }

    d = await s.buyerOutcome(pass.id, "device-dana", "got_it");
    expect(d.state).toBe("CLOSED");
    expect((await s.getListing(d.listingId)).state).toBe("SOLD");
    expect((await st.psp.get(d.holdId!))?.status).toBe("captured");
    expect(bus.recent().some((e) => e.type === "sale_completed")).toBe(true);
    // the address never appears in any emitted event
    expect(JSON.stringify(bus.recent())).not.toContain("Maple Ridge");
  });

  it("captures automatically after the 2 h inspection window", async () => {
    const st = await makeStack();
    const { s, clock, tick } = st;
    const { deal, pass } = await openWindowDeal(st);
    await s.recordFrame(deal.id, "before", frame("present", clock.now()));
    await s.checkIn(pass.id, "device-dana");
    await s.ingestRingEvent(ringEvent(clock.now()));
    await s.recordFrame(deal.id, "after", frame("absent", clock.now()));
    await tick(2 * 60 * 60 * 1000 + 1000);
    expect((await s.getDeal(deal.id)).state).toBe("CLOSED");
  });
});

describe("approvals and policy", () => {
  it("below-floor offers are denied; mid-range needs the seller; above auto-accept creates a deal", async () => {
    const st = await makeStack();
    const { s, buyer } = st;
    const { listing } = await liveListing(st, { floorMinor: 90_00, autoAcceptAboveMinor: 110_00 });
    const n = await s.openNegotiation(listing.id, buyer.id);
    expect((await s.proposeAccept(n.id, 85_00)).decision.outcome).toBe("deny");
    expect((await s.proposeAccept(n.id, 95_00)).approval).toBeDefined();
    const n2 = await s.openNegotiation(listing.id, st.buyer2.id);
    const auto = await s.proposeAccept(n2.id, 115_00);
    expect(auto.deal?.state).toBe("AGREED");
  });

  it("oracle never returns the floor", async () => {
    const st = await makeStack();
    const { listing } = await liveListing(st, { floorMinor: 90_00 });
    const n = await st.s.openNegotiation(listing.id, st.buyer.id);
    const o = await st.s.oracle(n.id, 70_00);
    expect(o).not.toHaveProperty("floorMinor");
    expect(o.counterMinor).toBe(100_00);
    expect(JSON.stringify(o)).not.toContain("9000");
  });

  it("a token approved for $95 can't accept $90 (terms bound) and can't be replayed (X28)", async () => {
    const st = await makeStack();
    const { s, hh, buyer } = st;
    const { listing } = await liveListing(st, { floorMinor: 90_00 });
    const n = await s.openNegotiation(listing.id, buyer.id);
    const res = await s.proposeAccept(n.id, 95_00);
    const { token } = await s.resolveApproval(res.approval!.id, true, `seller:${hh.id}`);
    await expect(s.acceptWithToken(n.id, 90_00, token!, `seller:${hh.id}`)).rejects.toThrow();
    const deal = await s.acceptWithToken(n.id, 95_00, token!, `seller:${hh.id}`);
    expect(deal.state).toBe("AGREED");
    await expect(s.acceptWithToken(n.id, 95_00, token!, `seller:${hh.id}`)).rejects.toThrow();
  });

  it("only the named approver can resolve an approval", async () => {
    const st = await makeStack();
    const { listing } = await liveListing(st, { floorMinor: 90_00 });
    const n = await st.s.openNegotiation(listing.id, st.buyer.id);
    const res = await st.s.proposeAccept(n.id, 95_00);
    await expect(st.s.resolveApproval(res.approval!.id, true, "seller:someone_else")).rejects.toThrow(/not_your_approval/);
  });

  it("two buyers accepted at once: exactly one deal (X5/X29)", async () => {
    const st = await makeStack();
    const { s, buyer, buyer2 } = st;
    const { listing } = await liveListing(st, { floorMinor: 90_00, autoAcceptAboveMinor: 100_00 });
    const n1 = await s.openNegotiation(listing.id, buyer.id);
    const n2 = await s.openNegotiation(listing.id, buyer2.id);
    const results = await Promise.allSettled([s.proposeAccept(n1.id, 105_00), s.proposeAccept(n2.id, 110_00)]);
    const deals = results.filter((r) => r.status === "fulfilled" && r.value.deal).length;
    expect(deals).toBe(1);
    expect((await s.getListing(listing.id)).state).toBe("RESERVED");
  });

  it("editing a listing supersedes pending agreements (X24)", async () => {
    const st = await makeStack();
    const { s, hh, buyer } = st;
    const { listing } = await liveListing(st, { floorMinor: 90_00 });
    const n = await s.openNegotiation(listing.id, buyer.id);
    const res = await s.proposeAccept(n.id, 95_00);
    await s.editListing(listing.id, { askMinor: 130_00 }, `seller:${hh.id}`);
    expect((await s.getNegotiation(n.id)).state).toBe("SUPERSEDED");
    await expect(s.resolveApproval(res.approval!.id, true, `seller:${hh.id}`)).rejects.toThrow(/approval_closed/);
  });

  it("recalled items can't be published (R9)", async () => {
    const st = await makeStack();
    const { s, hh } = st;
    const item = await s.createItem({
      householdId: hh.id,
      title: "Drop-side crib",
      category: "crib",
      condition: "B",
      photoHashes: [],
      photoUrls: [],
      priceBand: { listMinor: 60_00, quickSaleMinor: 40_00, floorSuggestionMinor: 30_00 },
      comps: [],
      compsConfidence: "low",
      recall: { blocked: true, reason: "drop_side_crib_resale_banned_cpsc_2011" },
    });
    const l = await s.draftListing(item.id);
    expect(l.state).toBe("BLOCKED_RECALL");
    const a = await s.requestApproval(s.publishTerms(l), `seller:${hh.id}`, "x");
    const { token } = await s.resolveApproval(a.id, true, `seller:${hh.id}`);
    await expect(s.publishListing(l.id, token!, `seller:${hh.id}`)).rejects.toThrow(/blocked_recall/);
  });

  it("outbound guard blocks the address and the floor, without returning them", async () => {
    const st = await makeStack();
    const { listing } = await liveListing(st, { floorMinor: 90_00 });
    const leak = await st.s.checkOutgoing(listing.id, "Come to 1427 Maple Ridge Dr, I won't go under $90");
    expect(leak.ok).toBe(false);
    expect(leak.violations).toEqual(expect.arrayContaining(["address_fragment", "floor_price_disclosed"]));
    expect(JSON.stringify(leak)).not.toContain("Maple");
  });

  it("two scam strikes block the buyer (R7)", async () => {
    const st = await makeStack();
    const { listing } = await liveListing(st, { floorMinor: 90_00 });
    const n = await st.s.openNegotiation(listing.id, st.buyer.id);
    await st.s.strike(n.id, "gift_card");
    const r = await st.s.strike(n.id, "off_platform_payment");
    expect(r.blocked).toBe(true);
    await expect(st.s.openNegotiation(listing.id, st.buyer.id)).rejects.toThrow(/buyer_blocked/);
  });
});

describe("checkout (R13)", () => {
  async function checkout(st: Awaited<ReturnType<typeof makeStack>>, amount: number, conf: Record<string, unknown>, over: Record<string, unknown> = {}) {
    const { deal } = await agreedDeal(st, amount);
    await st.s.openCheckout(deal.id, st.buyer.id, "cs_x");
    const total = amount + 199;
    return st.s.completeCheckout({
      dealId: deal.id,
      buyerId: st.buyer.id,
      quotedTotalMinor: total,
      expectedTotalMinor: total,
      credential: { handler: "com.amazon.payments.stored_payment_method", token: WALLET },
      confirmations: { breakdownShown: true, refundPolicyShown: true, explicitYes: true, ...conf } as never,
      idempotencyKey: `k-${Math.random()}`,
      ...over,
    });
  }

  it("$95: breakdown + refund policy + yes is enough", async () => {
    const st = await makeStack();
    expect((await checkout(st, 95_00, {})).deal?.state).toBe("FUNDS_HELD");
  });

  it("$160: needs the 4-digit voice code and on-screen confirmation (X17)", async () => {
    const st = await makeStack();
    expect((await checkout(st, 160_00, {})).decision.reasons).toContain("voice_code_required_over_100");
    const st2 = await makeStack();
    expect((await checkout(st2, 160_00, { voiceCode: "0000", onScreenConfirmed: true })).decision.outcome).toBe("needs_approval");
    const st3 = await makeStack();
    expect((await checkout(st3, 160_00, { voiceCode: "4821", onScreenConfirmed: true })).deal?.state).toBe("FUNDS_HELD");
  });

  it("tampered amount is blocked (X20); a card not on file is blocked", async () => {
    const st = await makeStack();
    expect((await checkout(st, 95_00, {}, { expectedTotalMinor: 1_00 })).decision.reasons).toContain("amount_differs_from_quote");
    const st2 = await makeStack();
    const r = await checkout(st2, 95_00, {}, { credential: { handler: "x", token: "tok_new_card" } });
    expect(r.decision.reasons).toContain("payment_method_not_preconfigured");
  });

  it("abandoned checkout releases the reservation (X25)", async () => {
    const st = await makeStack();
    const { deal, listing } = await agreedDeal(st);
    await st.s.openCheckout(deal.id, st.buyer.id, "cs_y");
    await st.tick(16 * 60 * 1000);
    expect((await st.s.getDeal(deal.id)).state).toBe("CHECKOUT_ABANDONED");
    expect((await st.s.getListing(listing.id)).state).toBe("LIVE");
  });
});

describe("pickup pass (R2, R11)", () => {
  it("address hidden before the lead window, on unbound devices, and before consent", async () => {
    const st = await makeStack();
    const { s, clock } = st;
    const { deal } = await fundedDeal(st);
    const window = { start: clock.now() + 5 * 3600_000, end: clock.now() + 6 * 3600_000 };
    const { pass, otp } = await s.issuePass(deal.id, window, `seller:${st.hh.id}`);
    await expect(s.passView(pass.id, "device-x")).rejects.toThrow();
    await s.bindPass(pass.id, otp, "device-dana");
    expect((await s.passView(pass.id, "device-dana")).address).toBeUndefined(); // no consent yet
    await s.consentPass(pass.id, "device-dana");
    expect((await s.passView(pass.id, "device-dana")).address).toBeUndefined(); // too early
    await expect(s.bindPass(pass.id, otp, "device-other")).rejects.toThrow(/bound_elsewhere/);
  });

  it("OTP attempts are rate limited", async () => {
    const st = await makeStack();
    const { deal } = await fundedDeal(st);
    const { pass } = await st.s.issuePass(deal.id, { start: st.clock.now() + 3600_000, end: st.clock.now() + 7200_000 }, "seller");
    for (let i = 0; i < 5; i++) await expect(st.s.bindPass(pass.id, "000000", "d")).rejects.toThrow(/otp_invalid/);
    await expect(st.s.bindPass(pass.id, "000000", "d")).rejects.toThrow(/rate_limited/);
  });

  it("windows over 2 h are refused", async () => {
    const st = await makeStack();
    const { deal } = await fundedDeal(st);
    await expect(st.s.issuePass(deal.id, { start: st.clock.now(), end: st.clock.now() + 3 * 3600_000 }, "seller")).rejects.toThrow(/pass_denied/);
  });
});

describe("handoff failures", () => {
  it("no-show: hold voided, item relisted, buyer strike (X6)", async () => {
    const st = await makeStack();
    const { deal, window, listing } = await openWindowDeal(st);
    await st.tick(window.end - st.clock.now() + 1000);
    const d = await st.s.getDeal(deal.id);
    expect(d.state).toBe("VOIDED");
    expect((await st.psp.get(d.holdId!))?.status).toBe("canceled");
    expect((await st.s.getListing(listing.id)).state).toBe("LIVE");
    expect((await st.s.buyerPublic(st.buyer.id)).noShows).toBe(1);
  });

  it("stranger takes the item without a pass: PIRACY, never captured (X7)", async () => {
    const st = await makeStack();
    const { s, clock } = st;
    const { deal } = await openWindowDeal(st);
    await s.recordFrame(deal.id, "before", frame("present", clock.now()));
    await s.ingestRingEvent(ringEvent(clock.now() + 5_000));
    const d = await s.recordFrame(deal.id, "after", frame("absent", clock.now() + 60_000));
    expect(d.state).toBe("VOIDED");
    expect(d.verdict).toBe("PIRACY_SUSPECTED");
    expect((await st.psp.get(d.holdId!))?.status).toBe("canceled");
    expect(st.bus.recent().some((e) => e.type === "piracy_alert")).toBe(true);
  });

  it("buyer arrives but item still there: no capture; later success works (X8)", async () => {
    const st = await makeStack();
    const { s, clock } = st;
    const { deal, pass } = await openWindowDeal(st);
    await s.recordFrame(deal.id, "before", frame("present", clock.now()));
    await s.checkIn(pass.id, "device-dana");
    await s.ingestRingEvent(ringEvent(clock.now() + 1000));
    let d = await s.recordFrame(deal.id, "after", frame("present", clock.now() + 30_000));
    expect(d.state).toBe("STILL_THERE");
    d = await s.recordFrame(deal.id, "after", frame("absent", clock.now() + 120_000));
    expect(d.state).toBe("INSPECTION");
  });

  it("late Ring webhook: waits out the presence window instead of jumping to REVIEW", async () => {
    const st = await makeStack();
    const { s, clock, tick } = st;
    const { deal, pass } = await openWindowDeal(st);
    await s.recordFrame(deal.id, "before", frame("present", clock.now()));
    await s.checkIn(pass.id, "device-dana");
    let d = await s.recordFrame(deal.id, "after", frame("absent", clock.now() + 1));
    expect(d.state).toBe("WINDOW_OPEN"); // pending: the doorbell event may still be on its way
    await tick(60_000);
    d = (await s.ingestRingEvent(ringEvent(clock.now(), { kind: "button_press", subType: undefined }))) && (await s.getDeal(deal.id));
    expect(d.state).toBe("INSPECTION");
  });

  it("no Ring event at all: REVIEW once the presence window passes", async () => {
    const st = await makeStack();
    const { s, clock, tick } = st;
    const { deal, pass } = await openWindowDeal(st);
    await s.recordFrame(deal.id, "before", frame("present", clock.now()));
    await s.checkIn(pass.id, "device-dana");
    await s.recordFrame(deal.id, "after", frame("absent", clock.now()));
    await tick(3 * 60_000 + 2000);
    expect((await s.getDeal(deal.id)).state).toBe("REVIEW");
  });

  it("after-frame unsure: retries, then REVIEW", async () => {
    const st = await makeStack();
    const { s, clock } = st;
    const { deal, pass } = await openWindowDeal(st);
    await s.recordFrame(deal.id, "before", frame("present", clock.now()));
    await s.checkIn(pass.id, "device-dana");
    await s.ingestRingEvent(ringEvent(clock.now()));
    for (let i = 0; i < 3; i++) await s.recordFrame(deal.id, "after", frame("unsure", clock.now() + i));
    expect((await s.getEvidence(deal.id)).unsureRetries).toBe(3);
    const d = await s.recordFrame(deal.id, "after", frame("unsure", clock.now() + 9));
    expect(d.state).toBe("REVIEW");
  });

  it("buyer claims 'not received' after VERIFIED: evidence releases to seller (X9)", async () => {
    const st = await makeStack();
    const { s, clock } = st;
    const { deal, pass } = await openWindowDeal(st);
    await s.recordFrame(deal.id, "before", frame("present", clock.now()));
    await s.checkIn(pass.id, "device-dana");
    await s.ingestRingEvent(ringEvent(clock.now()));
    await s.recordFrame(deal.id, "after", frame("absent", clock.now()));
    const d = await s.buyerOutcome(pass.id, "device-dana", "not_received");
    expect(d.state).toBe("CLOSED");
    expect(d.disputeOutcome).toBe("release_to_seller");
  });

  it("not as described: dispute stays open for review, refund voids the hold", async () => {
    const st = await makeStack();
    const { s, clock } = st;
    const { deal, pass } = await openWindowDeal(st);
    await s.recordFrame(deal.id, "before", frame("present", clock.now()));
    await s.checkIn(pass.id, "device-dana");
    await s.ingestRingEvent(ringEvent(clock.now()));
    await s.recordFrame(deal.id, "after", frame("absent", clock.now()));
    expect((await s.buyerOutcome(pass.id, "device-dana", "not_as_described", "wheel broken")).state).toBe("DISPUTE");
    const d = await s.resolveDispute(deal.id, "refund_buyer", "ops:reviewer");
    expect(d.state).toBe("VOIDED");
  });

  it("camera offline: DEGRADED -> dual confirm under $150 cap (X11)", async () => {
    const st = await makeStack();
    const { s } = st;
    const { deal, pass } = await openWindowDeal(st);
    await s.checkIn(pass.id, "device-dana");
    let d = await s.setCameraStatus(deal.id, "offline");
    expect(d.state).toBe("DEGRADED");
    await s.buyerOutcome(pass.id, "device-dana", "got_it");
    d = await s.dualConfirm(deal.id, "seller");
    expect(d.state).toBe("CLOSED");
  });

  it("forged-looking duplicate Ring events are deduped by request id", async () => {
    const st = await makeStack();
    const { s, clock } = st;
    const { deal } = await openWindowDeal(st);
    const e = ringEvent(clock.now());
    await s.ingestRingEvent(e);
    await s.ingestRingEvent(e);
    expect((await s.getEvidence(deal.id)).ringEvents).toHaveLength(1);
  });

  it("seller cancels after the hold: voided with an approval token (X21)", async () => {
    const st = await makeStack();
    const { s, hh } = st;
    const { deal } = await fundedDeal(st);
    const a = await s.requestApproval(s.cancelTerms(deal), `seller:${hh.id}`, "Cancel?");
    const { token } = await s.resolveApproval(a.id, true, `seller:${hh.id}`);
    const d = await s.sellerCancel(deal.id, token!, `seller:${hh.id}`);
    expect(d.state).toBe("VOIDED");
    expect((await st.psp.get(d.holdId!))?.status).toBe("canceled");
  });

  it("hold renewal before it lapses (X22)", async () => {
    const st = await makeStack();
    const { s, clock, tick } = st;
    const { deal } = await fundedDeal(st);
    const window = { start: deal.captureBefore! - 3600_000, end: deal.captureBefore! + 3600_000 - 3600_000 };
    await s.issuePass(deal.id, { start: window.start, end: window.start + 3600_000 }, "seller");
    const oldHold = deal.holdId;
    await tick(deal.captureBefore! - 12 * 3600_000 - clock.now() + 1000);
    const d = await s.getDeal(deal.id);
    expect(d.holdId).not.toBe(oldHold);
    expect(d.state).toBe("PASS_ISSUED");
  });
});
