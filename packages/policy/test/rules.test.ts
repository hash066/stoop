import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { DealState } from "@stoop/shared";
import {
  ADDRESS_LEAD_MS,
  decide,
  DUAL_CONFIRM_CAP_MINOR,
  INSPECTION_MS,
  type DecideInput,
} from "../src/rules.ts";

const T0 = Date.UTC(2026, 9, 20, 18, 0);
const window = { start: T0, end: T0 + 60 * 60 * 1000 };

describe("R2 address release", () => {
  const base: Extract<DecideInput, { action: "reveal_address" }> = {
    action: "reveal_address",
    dealState: "WINDOW_OPEN",
    window,
    now: T0 - 10 * 60 * 1000,
    requester: { buyerId: "b1", deviceId: "d1" },
    bound: { buyerId: "b1", deviceId: "d1" },
    channel: "pass_page",
  };
  it("allows the bound buyer's bound device on the pass page inside the lead window", () => {
    expect(decide(base).outcome).toBe("allow");
  });
  it.each(["mcp", "chat", "memory", "log"] as const)("never via %s", (channel) => {
    const d = decide({ ...base, channel });
    expect(d.outcome).toBe("deny");
    expect(d.ruleIds).toContain("R2");
  });
  it("denies before funds are held", () => {
    expect(decide({ ...base, dealState: "CHECKOUT_OPEN" }).outcome).toBe("deny");
  });
  it("denies another buyer or an unbound device", () => {
    expect(decide({ ...base, requester: { buyerId: "b2", deviceId: "d1" } }).outcome).toBe("deny");
    expect(decide({ ...base, requester: { buyerId: "b1", deviceId: "d9" } }).outcome).toBe("deny");
    expect(decide({ ...base, bound: { buyerId: "b1" }, requester: { buyerId: "b1" } }).outcome).toBe("deny");
  });
  it("denies too early and after the window", () => {
    expect(decide({ ...base, now: T0 - ADDRESS_LEAD_MS - 1 }).outcome).toBe("deny");
    expect(decide({ ...base, now: window.end + 1 }).outcome).toBe("deny");
  });
});

describe("R3 capture", () => {
  const verifiedAt = T0 + 20 * 60 * 1000;
  const base: Extract<DecideInput, { action: "capture" }> = {
    action: "capture",
    dealState: "INSPECTION",
    verdict: "VERIFIED",
    verifiedAt,
    buyerConfirmed: false,
    dualConfirmed: false,
    amountMinor: 95_00,
    now: verifiedAt + 60_000,
  };
  it("waits during inspection", () => expect(decide(base).outcome).toBe("deny"));
  it("captures when the buyer taps Got it", () => expect(decide({ ...base, buyerConfirmed: true }).outcome).toBe("allow"));
  it("captures after the inspection window", () =>
    expect(decide({ ...base, now: verifiedAt + INSPECTION_MS }).outcome).toBe("allow"));
  it("dual confirm is capped", () => {
    const dc = { ...base, dealState: "DUAL_CONFIRMED" as const, verdict: undefined, dualConfirmed: true };
    expect(decide(dc).outcome).toBe("allow");
    expect(decide({ ...dc, amountMinor: DUAL_CONFIRM_CAP_MINOR + 1 }).outcome).toBe("deny");
  });
  it("dispute release only from DISPUTE", () => {
    expect(decide({ ...base, dealState: "DISPUTE", disputeOutcome: "release_to_seller" }).outcome).toBe("allow");
    expect(decide({ ...base, dealState: "PIRACY_SUSPECTED", disputeOutcome: "release_to_seller" }).outcome).toBe("deny");
  });
  it("never captures on piracy, still-there, no-show", () => {
    for (const dealState of ["PIRACY_SUSPECTED", "STILL_THERE", "NO_SHOW", "FUNDS_HELD"] as DealState[]) {
      expect(decide({ ...base, dealState, buyerConfirmed: true, dualConfirmed: true }).outcome).toBe("deny");
    }
  });

  it("property: allow implies a proof path (fuzzed)", () => {
    const states = ["INSPECTION", "DUAL_CONFIRMED", "DISPUTE", "PIRACY_SUSPECTED", "STILL_THERE", "REVIEW", "WINDOW_OPEN", "FUNDS_HELD"] as const;
    fc.assert(
      fc.property(
        fc.record({
          dealState: fc.constantFrom(...states),
          verdict: fc.option(fc.constantFrom("VERIFIED", "REVIEW", "PIRACY_SUSPECTED", "STILL_THERE"), { nil: undefined }),
          verifiedAt: fc.option(fc.integer({ min: T0, max: T0 + 10 * INSPECTION_MS }), { nil: undefined }),
          buyerConfirmed: fc.boolean(),
          dualConfirmed: fc.boolean(),
          disputeOutcome: fc.option(fc.constantFrom("release_to_seller", "refund_buyer"), { nil: undefined }),
          amountMinor: fc.integer({ min: 1, max: 1_000_00 }),
          now: fc.integer({ min: T0, max: T0 + 20 * INSPECTION_MS }),
        }),
        (ctx) => {
          const d = decide({ action: "capture", ...ctx } as DecideInput);
          if (d.outcome !== "allow") return true;
          const verifiedPath =
            ctx.dealState === "INSPECTION" &&
            ctx.verdict === "VERIFIED" &&
            ctx.verifiedAt !== undefined &&
            (ctx.buyerConfirmed || ctx.now >= ctx.verifiedAt + INSPECTION_MS);
          const dualPath = ctx.dealState === "DUAL_CONFIRMED" && ctx.dualConfirmed && ctx.amountMinor <= DUAL_CONFIRM_CAP_MINOR;
          const disputePath = ctx.dealState === "DISPUTE" && ctx.disputeOutcome === "release_to_seller";
          return verifiedPath || dualPath || disputePath;
        },
      ),
      { numRuns: 5000 },
    );
  });
});

describe("R4/R5 accept offer", () => {
  const mandate = { listingId: "l1", floorMinor: 90_00, autoAcceptAboveMinor: 110_00, expiresAt: T0 + 1e9 };
  const base = { action: "accept_offer" as const, mandate, approvalTokenVerified: false, now: T0 };
  it("below floor is denied even with a human token", () =>
    expect(decide({ ...base, offerMinor: 85_00, approvalTokenVerified: true }).outcome).toBe("deny"));
  it("between floor and auto-accept needs approval", () =>
    expect(decide({ ...base, offerMinor: 95_00 }).outcome).toBe("needs_approval"));
  it("approval token allows", () =>
    expect(decide({ ...base, offerMinor: 95_00, approvalTokenVerified: true }).outcome).toBe("allow"));
  it("mandate auto-accept allows", () => expect(decide({ ...base, offerMinor: 115_00 }).outcome).toBe("allow"));
  it("expired mandate denies", () =>
    expect(decide({ ...base, offerMinor: 115_00, now: mandate.expiresAt + 1 }).outcome).toBe("deny"));
  it("no mandate always needs a human", () =>
    expect(decide({ action: "accept_offer", offerMinor: 500_00, approvalTokenVerified: false, now: T0 }).outcome).toBe("needs_approval"));
});

describe("R13 Alexa+ purchase policy", () => {
  const ok: Extract<DecideInput, { action: "complete_checkout" }> = {
    action: "complete_checkout",
    quotedTotalMinor: 95_00,
    chargedTotalMinor: 95_00,
    breakdownShown: true,
    refundPolicyShown: true,
    explicitYes: true,
    voiceCodeVerified: false,
    onScreenConfirmed: false,
    paymentMethodPreconfigured: true,
    duplicateOfCompleted: false,
  };
  it("<= $100 needs breakdown, refund policy and a yes", () => expect(decide(ok).outcome).toBe("allow"));
  it("> $100 also needs voice code and on-screen confirmation", () => {
    const big = { ...ok, quotedTotalMinor: 160_00, chargedTotalMinor: 160_00 };
    expect(decide(big).reasons).toContain("voice_code_required_over_100");
    expect(decide({ ...big, voiceCodeVerified: true }).reasons).toContain("on_screen_confirmation_required_over_100");
    expect(decide({ ...big, voiceCodeVerified: true, onScreenConfirmed: true }).outcome).toBe("allow");
  });
  it("amount tampering is denied (X20)", () => expect(decide({ ...ok, chargedTotalMinor: 9_00 }).outcome).toBe("deny"));
  it("duplicates are denied (X12)", () => expect(decide({ ...ok, duplicateOfCompleted: true }).outcome).toBe("deny"));
  it("adding a new card mid-checkout is denied", () =>
    expect(decide({ ...ok, paymentMethodPreconfigured: false }).outcome).toBe("deny"));
});

describe("R11 pass issuance", () => {
  const base = {
    action: "issue_pass" as const,
    dealState: "FUNDS_HELD" as const,
    buyerActiveReservations: 1,
    buyerNoShows: 0,
    window,
  };
  it("ok", () => expect(decide(base).outcome).toBe("allow"));
  it("blocks repeat no-shows", () => expect(decide({ ...base, buyerNoShows: 2 }).outcome).toBe("deny"));
  it("blocks reservation hoarding", () => expect(decide({ ...base, buyerActiveReservations: 3 }).outcome).toBe("deny"));
  it("blocks windows over 2 h", () =>
    expect(decide({ ...base, window: { start: T0, end: T0 + 3 * 3600_000 } }).outcome).toBe("deny"));
  it("requires funds held", () => expect(decide({ ...base, dealState: "AGREED" }).outcome).toBe("deny"));
});
