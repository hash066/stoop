// Single source of truth for every entity and event in Stoop.
// Rule: change schemas here first, then implement (plan §18 rule 2).
import { z } from "zod";

// ---------- primitives ----------

/** Money is always integer minor units (cents). Currency is USD for the Ring/Alexa+ US launch. */
export const Money = z.object({
  amountMinor: z.number().int().nonnegative(),
  currency: z.literal("USD"),
});
export type Money = z.infer<typeof Money>;

/** Epoch milliseconds. */
export const EpochMs = z.number().int().nonnegative();

export const usd = (dollars: number): Money => ({
  amountMinor: Math.round(dollars * 100),
  currency: "USD",
});

// ---------- listing / negotiation ----------

export const ListingState = z.enum([
  "DRAFT",
  "APPRAISED",
  "AWAITING_SELLER_OK",
  "LIVE",
  "RESERVED",
  "SOLD",
  "CLOSED",
  "BLOCKED_RECALL",
  "WITHDRAWN",
  "EXPIRED",
  "RELISTED",
]);
export type ListingState = z.infer<typeof ListingState>;

export const NegotiationState = z.enum([
  "OPEN",
  "AGREED_PENDING_SELLER",
  "AGREED",
  "CONVERTED",
  "DECLINED",
  "EXPIRED",
  "ABUSE_BLOCKED",
  "SUPERSEDED",
]);
export type NegotiationState = z.infer<typeof NegotiationState>;

/** Seller-set bounds for autonomous selling (rule R4). The floor never reaches an LLM (rule R5). */
export const Mandate = z.object({
  listingId: z.string(),
  floorMinor: z.number().int().positive(),
  autoAcceptAboveMinor: z.number().int().positive().optional(),
  maxDiscountPct: z.number().min(0).max(100).optional(),
  expiresAt: EpochMs,
});
export type Mandate = z.infer<typeof Mandate>;

// ---------- deal saga (plan §5) ----------

export const DealState = z.enum([
  "AGREED",
  "CHECKOUT_OPEN",
  "FUNDS_HELD",
  "PASS_ISSUED",
  "WINDOW_OPEN",
  "VERIFIED",
  "INSPECTION",
  "CAPTURED",
  "PAYOUT_RECORDED",
  "CLOSED",
  // exits
  "NO_SHOW",
  "PIRACY_SUSPECTED",
  "STILL_THERE",
  "REVIEW",
  "DUAL_CONFIRMED",
  "DISPUTE",
  "VOIDED",
  "SELLER_CANCELLED",
  "CHECKOUT_ABANDONED",
  "HOLD_EXPIRING",
  "DEGRADED",
]);
export type DealState = z.infer<typeof DealState>;

export const PickupWindow = z.object({
  start: EpochMs,
  end: EpochMs,
});
export type PickupWindow = z.infer<typeof PickupWindow>;

// ---------- Proof-of-Handoff evidence (plan §7.3) ----------

/** Vision returns a categorical label, never a fake similarity score. */
export const ItemPresence = z.enum(["present", "absent", "unsure"]);
export type ItemPresence = z.infer<typeof ItemPresence>;

export const CameraStatus = z.enum(["ok", "offline", "e2ee", "unavailable"]);
export type CameraStatus = z.infer<typeof CameraStatus>;

/** Ring motion sub_type is open-ended (Ring release notes, 2026-10-05); unknown values pass through. */
export const RingSubType = z.string();

export const RingEvent = z.object({
  kind: z.enum(["motion_detected", "button_press"]),
  deviceId: z.string(),
  at: EpochMs,
  subType: RingSubType.optional(),
  componentIds: z.array(z.string()).optional(),
  /** "ring" for real webhooks, "simulator" for our signed test events, "porchcam" for a phone or laptop camera at the door. Always shown in the UI. */
  origin: z.enum(["ring", "simulator", "porchcam"]),
  requestId: z.string(),
});
export type RingEvent = z.infer<typeof RingEvent>;

export const HandoffEvidence = z.object({
  window: PickupWindow,
  /** Device-bound pass "I'm here" tap (signal P). */
  checkInAt: EpochMs.optional(),
  /** Ring events for the porch device (signal D source). */
  ringEvents: z.array(RingEvent),
  /** Before-frame item presence (signal B). */
  before: ItemPresence.optional(),
  /** After-frame item presence (signal A). */
  after: ItemPresence.optional(),
  /** How many times an "unsure" after-frame has been re-fetched. */
  unsureRetries: z.number().int().nonnegative().default(0),
  camera: CameraStatus,
});
export type HandoffEvidence = z.infer<typeof HandoffEvidence>;

export const HandoffVerdict = z.enum([
  "VERIFIED",
  "REVIEW",
  "PIRACY_SUSPECTED",
  "STILL_THERE",
  "RETRY_FRAME",
  "DEGRADED",
  "PENDING",
]);
export type HandoffVerdict = z.infer<typeof HandoffVerdict>;

// ---------- policy (plan §6) ----------

export const PolicyAction = z.enum([
  "publish_listing",
  "set_mandate",
  "accept_offer",
  "complete_checkout",
  "reveal_address",
  "capture",
  "void_hold",
  "refund",
  "sign_receipt",
  "issue_pass",
  "send_message",
  "cancel_sale",
]);
export type PolicyAction = z.infer<typeof PolicyAction>;

export const RuleId = z.enum([
  "R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12", "R13",
]);
export type RuleId = z.infer<typeof RuleId>;

export const Decision = z.object({
  outcome: z.enum(["allow", "deny", "needs_approval"]),
  action: PolicyAction,
  ruleIds: z.array(RuleId),
  reasons: z.array(z.string()),
});
export type Decision = z.infer<typeof Decision>;

/** What the human was shown when approving. Hashed (RFC 8785 JCS + SHA-256) into termsHash. */
export const ApprovalTerms = z.object({
  action: PolicyAction,
  dealId: z.string().optional(),
  listingId: z.string().optional(),
  amountMinor: z.number().int().nonnegative().optional(),
  feesMinor: z.number().int().nonnegative().optional(),
  buyerPseudonym: z.string().optional(),
  window: PickupWindow.optional(),
  /** Any other term the human saw (e.g. autoAcceptAboveMinor, negotiationId). Part of the hash. */
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type ApprovalTerms = z.infer<typeof ApprovalTerms>;

export const CapabilityTokenClaims = z.object({
  tid: z.string(),
  action: PolicyAction,
  dealId: z.string().optional(),
  listingId: z.string().optional(),
  amountMinor: z.number().int().nonnegative().optional(),
  actor: z.string(),
  termsHash: z.string(),
  pendingApprovalId: z.string().optional(),
  exp: EpochMs,
});
export type CapabilityTokenClaims = z.infer<typeof CapabilityTokenClaims>;

// ---------- Ring webhook envelope v1.1 (Ring Partner API docs) ----------

export const RingWebhookEnvelope = z.object({
  meta: z.object({
    version: z.string(),
    time: z.string(),
    request_id: z.string(),
    account_id: z.string().optional(),
  }),
  data: z.object({
    id: z.string(),
    type: z.string(),
    attributes: z
      .object({
        source: z.string().optional(),
        source_type: z.string().optional(),
        timestamp: z.number().optional(),
        sub_type: z.string().optional(),
        component_ids: z.array(z.string()).optional(),
      })
      .passthrough(),
    relationships: z.unknown().optional(),
  }),
});
export type RingWebhookEnvelope = z.infer<typeof RingWebhookEnvelope>;

export * from "./images.ts";
export * from "./text.ts";
export * from "./spend.ts";
