// Proof-of-Handoff truth table (plan §7.3).
// Deterministic: the LLM only writes the human-readable explanation, never the verdict.
import type { HandoffEvidence, HandoffVerdict, RingEvent } from "@stoop/shared";

/** A Ring event counts as "someone was at the door" within this window around the pass check-in. */
export const PRESENCE_WINDOW_MS = 3 * 60 * 1000;
/** Re-fetch an "unsure" after-frame this many times before falling back to REVIEW. */
export const MAX_UNSURE_RETRIES = 3;

/** Motion sub_types that do NOT indicate a person at the door. Unknown values count as generic motion. */
const NON_PERSON_SUBTYPES = new Set(["vehicle", "package_delivery", "other_motion"]);

export interface HandoffSignals {
  /** P: device-bound pass check-in inside the pickup window. */
  P: boolean;
  /** D: Ring person/doorbell event within ±3 min of the check-in. */
  D: boolean;
  /** B: before-frame shows the item. */
  B: boolean;
}

export interface HandoffResult {
  verdict: HandoffVerdict;
  signals: HandoffSignals;
  /** Machine-readable reasons, stable strings for tests and the Ops console. */
  reasons: string[];
}

export function isPresenceEvent(e: RingEvent): boolean {
  if (e.kind === "button_press") return true;
  // Ring docs: with Smart Alerts off every motion is "motion"; the set is open-ended, so
  // unknown sub_types are treated as generic motion (counts), known non-person types do not.
  return e.subType === undefined || !NON_PERSON_SUBTYPES.has(e.subType);
}

export function deriveSignals(ev: HandoffEvidence): HandoffSignals {
  const { window, checkInAt } = ev;
  const P = checkInAt !== undefined && checkInAt >= window.start && checkInAt <= window.end;
  const D =
    P &&
    ev.ringEvents.some(
      (e) => isPresenceEvent(e) && Math.abs(e.at - (checkInAt as number)) <= PRESENCE_WINDOW_MS,
    );
  const B = ev.before === "present";
  return { P, D, B };
}

/**
 * Evaluate the truth table. Rows are checked top-down; the first match wins.
 *  1. camera offline / E2EE / unavailable          -> DEGRADED (dual-confirm path, capped)
 *  2. no after-frame yet                           -> PENDING
 *  3. after = unsure                               -> RETRY_FRAME (x3), then REVIEW
 *  4. after = present                              -> STILL_THERE if the buyer checked in, else PENDING
 *                                                     (a passer-by triggering a frame isn't a failed pickup)
 *  5. after = absent, before != present            -> REVIEW (bad baseline: can't attribute removal)
 *  6. after = absent, no valid check-in            -> PIRACY_SUSPECTED
 *  7. after = absent, check-in but no Ring presence -> REVIEW (camera may have missed it)
 *  8. after = absent, check-in + Ring presence     -> VERIFIED
 */
export function evaluateHandoff(ev: HandoffEvidence): HandoffResult {
  const signals = deriveSignals(ev);
  const r = (verdict: HandoffVerdict, ...reasons: string[]): HandoffResult => ({
    verdict,
    signals,
    reasons,
  });

  if (ev.camera !== "ok") return r("DEGRADED", `camera_${ev.camera}`);
  if (ev.after === undefined) return r("PENDING", "awaiting_after_frame");
  if (ev.after === "unsure") {
    return ev.unsureRetries < MAX_UNSURE_RETRIES
      ? r("RETRY_FRAME", "after_frame_unsure", `retry_${ev.unsureRetries + 1}_of_${MAX_UNSURE_RETRIES}`)
      : r("REVIEW", "after_frame_unsure_after_retries");
  }
  if (ev.after === "present") {
    return signals.P ? r("STILL_THERE", "item_still_on_porch") : r("PENDING", "item_present_no_check_in_yet");
  }
  // after === "absent"
  if (!signals.B) return r("REVIEW", "bad_baseline_item_not_seen_before");
  if (!signals.P) return r("PIRACY_SUSPECTED", "item_gone_without_valid_check_in");
  if (!signals.D) return r("REVIEW", "check_in_without_ring_presence");
  return r("VERIFIED", "check_in", "ring_presence", "item_seen_before", "item_gone_after");
}
