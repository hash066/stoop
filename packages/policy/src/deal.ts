// Deal saga state machine (plan §5). Every transition is executed by the Settlement service.
import type { DealState, HandoffVerdict } from "@stoop/shared";

export type DealEvent =
  | { type: "CHECKOUT_CREATED" }
  | { type: "CHECKOUT_ABANDONED" }
  | { type: "HOLD_PLACED" }
  | { type: "PASS_ISSUED" }
  | { type: "WINDOW_OPENED" }
  | { type: "WINDOW_CLOSED" }
  | { type: "VERDICT"; verdict: HandoffVerdict }
  | { type: "RECEIPT_SIGNED" }
  | { type: "DUAL_CONFIRMED" }
  | { type: "DISPUTE_OPENED" }
  | { type: "CAPTURE_SUCCEEDED" }
  | { type: "PAYOUT_RECORDED" }
  | { type: "CLOSE" }
  | { type: "VOID" }
  | { type: "SELLER_CANCELLED" }
  | { type: "HOLD_EXPIRING" }
  | { type: "REAUTHORIZED" };

export type DealEventType = DealEvent["type"];

/** Verdicts that move a deal out of WINDOW_OPEN / STILL_THERE. RETRY_FRAME and PENDING keep it waiting. */
const VERDICT_TARGET: Partial<Record<HandoffVerdict, DealState>> = {
  VERIFIED: "VERIFIED",
  PIRACY_SUSPECTED: "PIRACY_SUSPECTED",
  STILL_THERE: "STILL_THERE",
  REVIEW: "REVIEW",
  DEGRADED: "DEGRADED",
};

type Table = Partial<Record<DealState, Partial<Record<DealEventType, DealState>>>>;

const CANCELLABLE = { SELLER_CANCELLED: "SELLER_CANCELLED" } as const;

const TABLE: Table = {
  AGREED: { CHECKOUT_CREATED: "CHECKOUT_OPEN", ...CANCELLABLE },
  CHECKOUT_OPEN: { HOLD_PLACED: "FUNDS_HELD", CHECKOUT_ABANDONED: "CHECKOUT_ABANDONED", ...CANCELLABLE },
  FUNDS_HELD: { PASS_ISSUED: "PASS_ISSUED", HOLD_EXPIRING: "HOLD_EXPIRING", ...CANCELLABLE },
  PASS_ISSUED: { WINDOW_OPENED: "WINDOW_OPEN", HOLD_EXPIRING: "HOLD_EXPIRING", ...CANCELLABLE },
  HOLD_EXPIRING: { REAUTHORIZED: "FUNDS_HELD", VOID: "VOIDED" },
  WINDOW_OPEN: { WINDOW_CLOSED: "NO_SHOW", ...CANCELLABLE },
  STILL_THERE: { WINDOW_CLOSED: "VOIDED", ...CANCELLABLE },
  VERIFIED: { RECEIPT_SIGNED: "INSPECTION" },
  INSPECTION: { CAPTURE_SUCCEEDED: "CAPTURED", DISPUTE_OPENED: "DISPUTE" },
  REVIEW: { DUAL_CONFIRMED: "DUAL_CONFIRMED", VOID: "VOIDED" },
  DEGRADED: { DUAL_CONFIRMED: "DUAL_CONFIRMED", VOID: "VOIDED" },
  DUAL_CONFIRMED: { CAPTURE_SUCCEEDED: "CAPTURED" },
  DISPUTE: { CAPTURE_SUCCEEDED: "CAPTURED", VOID: "VOIDED" },
  PIRACY_SUSPECTED: { VOID: "VOIDED" },
  NO_SHOW: { VOID: "VOIDED" },
  SELLER_CANCELLED: { VOID: "VOIDED" },
  CAPTURED: { PAYOUT_RECORDED: "PAYOUT_RECORDED" },
  PAYOUT_RECORDED: { CLOSE: "CLOSED" },
};

/** States from which a capture may legally happen (the only predecessors of CAPTURED). */
export const CAPTURE_PREDECESSORS: readonly DealState[] = ["INSPECTION", "DUAL_CONFIRMED", "DISPUTE"];

export const TERMINAL: readonly DealState[] = ["CLOSED", "VOIDED", "CHECKOUT_ABANDONED"];

export type TransitionResult = { ok: true; next: DealState } | { ok: false; reason: string };

export function transition(state: DealState, event: DealEvent): TransitionResult {
  if (event.type === "VERDICT") {
    if (state !== "WINDOW_OPEN" && state !== "STILL_THERE") {
      return { ok: false, reason: `verdict_not_expected_in_${state}` };
    }
    const target = VERDICT_TARGET[event.verdict];
    // RETRY_FRAME / PENDING keep waiting in the same state.
    return { ok: true, next: target ?? state };
  }
  const next = TABLE[state]?.[event.type];
  return next ? { ok: true, next } : { ok: false, reason: `${event.type}_not_allowed_in_${state}` };
}

export function allowedEvents(state: DealState): DealEventType[] {
  const evs = Object.keys(TABLE[state] ?? {}) as DealEventType[];
  if (state === "WINDOW_OPEN" || state === "STILL_THERE") evs.push("VERDICT");
  return evs;
}
