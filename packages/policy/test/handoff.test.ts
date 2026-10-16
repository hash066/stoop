import { describe, expect, it } from "vitest";
import type { HandoffEvidence, ItemPresence, RingEvent } from "@stoop/shared";
import { evaluateHandoff, isPresenceEvent, MAX_UNSURE_RETRIES } from "../src/handoff.ts";

const T0 = Date.UTC(2026, 9, 20, 18, 0); // 6:00 pm window start
const window = { start: T0, end: T0 + 2 * 60 * 60 * 1000 };
const CHECK_IN = T0 + 10 * 60 * 1000;

const ring = (over: Partial<RingEvent> = {}): RingEvent => ({
  kind: "motion_detected",
  deviceId: "dev-1",
  at: CHECK_IN + 30_000,
  subType: "human",
  origin: "simulator",
  requestId: `req-${Math.random()}`,
  ...over,
});

const ev = (over: Partial<HandoffEvidence> = {}): HandoffEvidence => ({
  window,
  checkInAt: CHECK_IN,
  ringEvents: [ring()],
  before: "present",
  after: "absent",
  unsureRetries: 0,
  camera: "ok",
  ...over,
});

describe("Proof-of-Handoff truth table (plan §7.3)", () => {
  const rows: Array<[string, Partial<HandoffEvidence>, string]> = [
    ["golden: P, D, B, A=absent", {}, "VERIFIED"],
    ["doorbell press counts as presence", { ringEvents: [ring({ kind: "button_press", subType: undefined })] }, "VERIFIED"],
    ["Smart Alerts off: sub_type=motion counts", { ringEvents: [ring({ subType: "motion" })] }, "VERIFIED"],
    ["unknown future sub_type passes through as motion", { ringEvents: [ring({ subType: "pet" })] }, "VERIFIED"],
    ["check-in but no Ring presence", { ringEvents: [] }, "REVIEW"],
    ["only a vehicle event", { ringEvents: [ring({ subType: "vehicle" })] }, "REVIEW"],
    ["only a package_delivery event", { ringEvents: [ring({ subType: "package_delivery" })] }, "REVIEW"],
    ["presence event > 3 min from check-in", { ringEvents: [ring({ at: CHECK_IN + 4 * 60 * 1000 })] }, "REVIEW"],
    ["item gone, nobody checked in", { checkInAt: undefined }, "PIRACY_SUSPECTED"],
    ["item gone, check-in outside window", { checkInAt: window.end + 60_000 }, "PIRACY_SUSPECTED"],
    ["item gone, Ring saw a person but no pass", { checkInAt: undefined, ringEvents: [ring()] }, "PIRACY_SUSPECTED"],
    ["item still there", { after: "present" }, "STILL_THERE"],
    ["after unsure, first try", { after: "unsure" }, "RETRY_FRAME"],
    ["after unsure, retries exhausted", { after: "unsure", unsureRetries: MAX_UNSURE_RETRIES }, "REVIEW"],
    ["bad baseline", { before: "unsure" }, "REVIEW"],
    ["bad baseline beats piracy (can't attribute)", { before: "absent", checkInAt: undefined }, "REVIEW"],
    ["no after-frame yet", { after: undefined }, "PENDING"],
    ["camera offline", { camera: "offline" }, "DEGRADED"],
    ["E2EE device", { camera: "e2ee" }, "DEGRADED"],
    ["camera degraded beats everything", { camera: "unavailable", after: "present" }, "DEGRADED"],
  ];

  it.each(rows)("%s", (_name, over, verdict) => {
    expect(evaluateHandoff(ev(over)).verdict).toBe(verdict);
  });

  it("VERIFIED requires every signal (exhaustive over the 4 inputs)", () => {
    const presences: Array<ItemPresence | undefined> = ["present", "absent", "unsure", undefined];
    for (const after of presences)
      for (const before of presences)
        for (const checkInAt of [CHECK_IN, undefined])
          for (const ringEvents of [[ring()], []]) {
            const res = evaluateHandoff(ev({ after, before, checkInAt, ringEvents }));
            const allSignals = after === "absent" && before === "present" && checkInAt !== undefined && ringEvents.length > 0;
            expect(res.verdict === "VERIFIED").toBe(allSignals);
          }
  });

  it("exposes derived signals for the Ops console", () => {
    const res = evaluateHandoff(ev({ ringEvents: [] }));
    expect(res.signals).toEqual({ P: true, D: false, B: true });
  });

  it("isPresenceEvent", () => {
    expect(isPresenceEvent(ring({ subType: "human" }))).toBe(true);
    expect(isPresenceEvent(ring({ subType: "other_motion" }))).toBe(false);
    expect(isPresenceEvent(ring({ kind: "button_press", subType: undefined }))).toBe(true);
  });
});
