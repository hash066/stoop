// Policy Kernel decisions (plan §6). Pure: callers gather facts, decide() returns allow / deny /
// needs_approval with rule ids. Every decision is persisted as a PolicyDecision by Settlement.
import type { Decision, DealState, HandoffVerdict, Mandate, PickupWindow, RuleId } from "@stoop/shared";
import { acceptable, autoAcceptable } from "./oracle.ts";

export const ADDRESS_LEAD_MS = 30 * 60 * 1000;
export const INSPECTION_MS = 2 * 60 * 60 * 1000;
/** DEGRADED / REVIEW deals settle by dual confirmation only up to this amount. */
export const DUAL_CONFIRM_CAP_MINOR = 150_00;
/** Alexa+ Policy §16: purchases over $100 need a voice code + written confirmation. */
export const HIGH_VALUE_MINOR = 100_00;
export const MAX_ACTIVE_RESERVATIONS = 2;
export const NO_SHOW_BLOCK_THRESHOLD = 2;

const FUNDED_STATES: readonly DealState[] = [
  "FUNDS_HELD", "PASS_ISSUED", "WINDOW_OPEN", "STILL_THERE", "VERIFIED", "INSPECTION",
  "REVIEW", "DEGRADED", "DUAL_CONFIRMED", "DISPUTE",
];

export type DecideInput =
  | {
      action: "reveal_address";
      dealState: DealState;
      window: PickupWindow;
      now: number;
      requester: { buyerId: string; deviceId?: string };
      bound: { buyerId: string; deviceId?: string };
      /** Where the address would be rendered. Only the pass page is allowed. */
      channel: "pass_page" | "mcp" | "chat" | "memory" | "log";
    }
  | {
      action: "capture";
      dealState: DealState;
      verdict?: HandoffVerdict;
      verifiedAt?: number;
      buyerConfirmed: boolean;
      dualConfirmed: boolean;
      disputeOutcome?: "release_to_seller" | "refund_buyer";
      amountMinor: number;
      now: number;
    }
  | {
      action: "accept_offer";
      offerMinor: number;
      mandate?: Mandate;
      /** True only if a capability token bound to this offer's terms verified and was spent. */
      approvalTokenVerified: boolean;
      now: number;
    }
  | {
      action: "complete_checkout";
      quotedTotalMinor: number;
      chargedTotalMinor: number;
      breakdownShown: boolean;
      refundPolicyShown: boolean;
      explicitYes: boolean;
      voiceCodeVerified: boolean;
      onScreenConfirmed: boolean;
      paymentMethodPreconfigured: boolean;
      duplicateOfCompleted: boolean;
    }
  | {
      action: "issue_pass";
      dealState: DealState;
      buyerActiveReservations: number;
      buyerNoShows: number;
      window: PickupWindow;
    };

const allow = (action: Decision["action"], ruleIds: RuleId[], ...reasons: string[]): Decision => ({
  outcome: "allow", action, ruleIds, reasons,
});
const deny = (action: Decision["action"], ruleIds: RuleId[], ...reasons: string[]): Decision => ({
  outcome: "deny", action, ruleIds, reasons,
});
const needsApproval = (action: Decision["action"], ruleIds: RuleId[], ...reasons: string[]): Decision => ({
  outcome: "needs_approval", action, ruleIds, reasons,
});

export function decide(input: DecideInput): Decision {
  switch (input.action) {
    case "reveal_address": {
      const a = input.action;
      if (input.channel !== "pass_page") return deny(a, ["R2", "R8"], `channel_${input.channel}_never_allowed`);
      if (!FUNDED_STATES.includes(input.dealState)) return deny(a, ["R2"], "funds_not_held");
      if (input.requester.buyerId !== input.bound.buyerId) return deny(a, ["R2"], "not_bound_buyer");
      if (!input.bound.deviceId || input.requester.deviceId !== input.bound.deviceId)
        return deny(a, ["R2"], "device_not_bound");
      if (input.now < input.window.start - ADDRESS_LEAD_MS) return deny(a, ["R2"], "before_window_lead");
      if (input.now > input.window.end) return deny(a, ["R2"], "after_window");
      return allow(a, ["R2"], "funded_bound_device_in_window");
    }

    case "capture": {
      const a = input.action;
      if (input.disputeOutcome === "release_to_seller" && input.dealState === "DISPUTE")
        return allow(a, ["R3"], "dispute_verdict_release");
      if (input.dealState === "INSPECTION" && input.verdict === "VERIFIED" && input.verifiedAt !== undefined) {
        if (input.buyerConfirmed) return allow(a, ["R3"], "verified_and_buyer_confirmed");
        if (input.now >= input.verifiedAt + INSPECTION_MS) return allow(a, ["R3"], "verified_and_inspection_elapsed");
        return deny(a, ["R3"], "inspection_window_open");
      }
      if (input.dealState === "DUAL_CONFIRMED" && input.dualConfirmed) {
        return input.amountMinor <= DUAL_CONFIRM_CAP_MINOR
          ? allow(a, ["R3"], "dual_confirmed_under_cap")
          : deny(a, ["R3"], "dual_confirm_over_cap");
      }
      return deny(a, ["R3"], "no_proof_of_handoff");
    }

    case "accept_offer": {
      const a = input.action;
      const m = input.mandate;
      if (m && !acceptable(input.offerMinor, m, input.now)) return deny(a, ["R4", "R5"], "below_floor_or_mandate_expired");
      if (input.approvalTokenVerified) return allow(a, ["R4"], "human_approval_token");
      if (m && autoAcceptable(input.offerMinor, m, input.now)) return allow(a, ["R4"], "mandate_auto_accept");
      return needsApproval(a, ["R4"], "seller_approval_required");
    }

    case "complete_checkout": {
      const a = input.action;
      if (input.duplicateOfCompleted) return deny(a, ["R12", "R13"], "duplicate_transaction");
      if (input.chargedTotalMinor !== input.quotedTotalMinor) return deny(a, ["R13"], "amount_differs_from_quote");
      if (!input.paymentMethodPreconfigured) return deny(a, ["R13"], "payment_method_not_preconfigured");
      if (!input.breakdownShown || !input.refundPolicyShown) return deny(a, ["R13"], "breakdown_or_refund_policy_not_shown");
      if (!input.explicitYes) return needsApproval(a, ["R13"], "explicit_yes_required");
      if (input.quotedTotalMinor > HIGH_VALUE_MINOR) {
        if (!input.voiceCodeVerified) return needsApproval(a, ["R13"], "voice_code_required_over_100");
        if (!input.onScreenConfirmed) return needsApproval(a, ["R13"], "on_screen_confirmation_required_over_100");
      }
      return allow(a, ["R13"], "purchase_confirmed");
    }

    case "issue_pass": {
      const a = input.action;
      if (input.dealState !== "FUNDS_HELD") return deny(a, ["R2"], "funds_not_held");
      if (input.buyerNoShows >= NO_SHOW_BLOCK_THRESHOLD) return deny(a, ["R11"], "buyer_blocked_no_shows");
      if (input.buyerActiveReservations > MAX_ACTIVE_RESERVATIONS) return deny(a, ["R11"], "too_many_reservations");
      if (input.window.end - input.window.start > 2 * 60 * 60 * 1000) return deny(a, ["R11"], "window_too_long");
      return allow(a, ["R2", "R11"], "pass_ok");
    }
  }
}
