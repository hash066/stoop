import { localHmacProvider, memorySpentStore } from "@stoop/policy";
import { localSigner } from "proof-of-handoff";
import type { RingEvent } from "@stoop/shared";
import { EventBus, localVault, ManualClock, MemoryStore, SandboxPSP, Settlement, TickScheduler, type SettlementDeps } from "../src/index.ts";

export const T0 = Date.UTC(2026, 9, 20, 22, 0); // 6 pm EDT
export const ADDRESS = "1427 Maple Ridge Dr, Columbus, OH 43215";
export const WALLET = "tok_visa_4242";

/** `over` swaps Settlement deps (e.g. a boundary or vault) given the stack's store and clock. */
export async function makeStack(over: (d: { store: MemoryStore; clock: ManualClock }) => Partial<SettlementDeps> = () => ({})) {
  const clock = new ManualClock(T0);
  const store = new MemoryStore();
  const bus = new EventBus();
  const scheduler = new TickScheduler();
  const psp = new SandboxPSP();
  const s = new Settlement({
    store,
    psp,
    macp: localHmacProvider("test-mac-key"),
    spent: memorySpentStore(),
    signer: localSigner({ kid: "test-key" }),
    vault: localVault("test-vault-key"),
    clock,
    bus,
    scheduler,
    passBaseUrl: "http://pass.local",
    ...over({ store, clock }),
  });
  scheduler.onFire((j) => s.onJob(j));
  const tick = async (ms: number) => {
    clock.advance(ms);
    await scheduler.runDue(clock.now());
  };
  const hh = await s.createHousehold({
    displayName: "The Okafors",
    address: ADDRESS,
    zip: "43215",
    porchInstructions: "Stroller is by the bench, left of the door.",
    ringDeviceId: "ring_dev_1",
  });
  const buyer = await s.createBuyer({ displayName: "Dana", email: "dana@example.com", voiceCode: "4821", walletToken: WALLET });
  const buyer2 = await s.createBuyer({ displayName: "Lee", email: "lee@example.com", voiceCode: "1111", walletToken: "tok_mc_5555" });
  return { s, clock, store, bus, scheduler, psp, tick, hh, buyer, buyer2 };
}

export type Stack = Awaited<ReturnType<typeof makeStack>>;

export async function liveListing(st: Stack, opts: { askMinor?: number; floorMinor?: number; autoAcceptAboveMinor?: number; title?: string } = {}) {
  const { s, hh } = st;
  const item = await s.createItem({
    householdId: hh.id,
    title: opts.title ?? "BOB Revolution jogging stroller",
    category: "stroller",
    condition: "B",
    photoHashes: ["a".repeat(64)],
    photoUrls: ["/fixtures/stroller.jpg"],
    priceBand: { listMinor: opts.askMinor ?? 120_00, quickSaleMinor: 95_00, floorSuggestionMinor: 85_00 },
    comps: [],
    compsConfidence: "high",
    recall: { blocked: false },
  });
  const draft = await s.draftListing(item.id);
  const appr = await s.requestApproval(s.publishTerms(draft), `seller:${hh.id}`, "Publish?");
  const { token } = await s.resolveApproval(appr.id, true, `seller:${hh.id}`);
  const listing = await s.publishListing(draft.id, token!, `seller:${hh.id}`);
  if (opts.floorMinor) {
    const m = { listingId: listing.id, floorMinor: opts.floorMinor, autoAcceptAboveMinor: opts.autoAcceptAboveMinor, expiresAt: T0 + 7 * 86400_000 };
    const ma = await s.requestApproval(s.mandateTerms(m), `seller:${hh.id}`, "Mandate?");
    const mt = await s.resolveApproval(ma.id, true, `seller:${hh.id}`);
    await s.setMandate(m, mt.token!, `seller:${hh.id}`);
  }
  return { item, listing: await s.getListing(listing.id) };
}

/** Negotiate to an agreed deal at `amount` with seller approval. */
export async function agreedDeal(st: Stack, amount = 95_00, buyerId = st.buyer.id) {
  const { s, hh } = st;
  const { listing } = await liveListing(st, { floorMinor: 90_00, autoAcceptAboveMinor: 110_00 });
  const n = await s.openNegotiation(listing.id, buyerId);
  await s.recordOffer(n.id, "buyer", amount, `I can do $${amount / 100}`);
  const res = await s.proposeAccept(n.id, amount);
  if (res.deal) return { listing, negotiation: n, deal: res.deal }; // Mandate auto-accept
  if (!res.approval) throw new Error(`expected approval, got ${JSON.stringify(res.decision.reasons)}`);
  const { token } = await s.resolveApproval(res.approval.id, true, `seller:${hh.id}`);
  const deal = await s.acceptWithToken(n.id, amount, token!, `seller:${hh.id}`);
  return { listing, negotiation: n, deal };
}

export async function fundedDeal(st: Stack, amount = 95_00) {
  const { s, buyer } = st;
  const { deal, listing } = await agreedDeal(st, amount);
  await s.openCheckout(deal.id, buyer.id, "cs_test");
  const total = amount + 199;
  const res = await s.completeCheckout({
    dealId: deal.id,
    buyerId: buyer.id,
    quotedTotalMinor: total,
    expectedTotalMinor: total,
    credential: { handler: "com.amazon.payments.stored_payment_method", token: WALLET },
    confirmations: { breakdownShown: true, refundPolicyShown: true, explicitYes: true, voiceCode: "4821", onScreenConfirmed: true },
    idempotencyKey: `idem-${deal.id}`,
  });
  if (!res.deal) throw new Error(`checkout failed: ${JSON.stringify(res.decision)}`);
  return { deal: res.deal, listing };
}

/** Funded deal with a pass bound to a device and the window open. */
export async function openWindowDeal(st: Stack) {
  const { s, tick } = st;
  const { deal, listing } = await fundedDeal(st);
  const window = { start: st.clock.now() + 60 * 60 * 1000, end: st.clock.now() + 2 * 60 * 60 * 1000 };
  const { pass, otp } = await s.issuePass(deal.id, window, `seller:${st.hh.id}`);
  await s.bindPass(pass.id, otp, "device-dana");
  await s.consentPass(pass.id, "device-dana");
  await tick(60 * 60 * 1000 + 1000); // into the window
  return { deal: await s.getDeal(deal.id), pass, window, listing };
}

let reqN = 0;
export const ringEvent = (at: number, over: Partial<RingEvent> = {}): RingEvent => ({
  kind: "motion_detected",
  deviceId: "ring_dev_1",
  at,
  subType: "human",
  origin: "simulator",
  requestId: `req_${++reqN}`,
  ...over,
});

export const frame = (presence: "present" | "absent" | "unsure", at: number) => ({
  presence,
  sha256: (presence + at).padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "a"),
  at,
  origin: "our_footage" as const,
});
