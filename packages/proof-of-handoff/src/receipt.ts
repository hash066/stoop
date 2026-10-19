import { z } from "zod";

/** A Proof-of-Handoff receipt. Contains hashes and timestamps only, never addresses or images. */
export const HandoffReceipt = z.object({
  v: z.literal(1),
  receiptId: z.string(),
  dealId: z.string(),
  listingId: z.string(),
  /** SHA-256 of the listing's canonical item description + photo hashes. */
  itemHash: z.string().regex(/^[0-9a-f]{64}$/),
  verdict: z.enum(["VERIFIED", "DUAL_CONFIRMED", "DISPUTE_RELEASED"]),
  signals: z.object({ P: z.boolean(), D: z.boolean(), B: z.boolean() }),
  window: z.object({ start: z.number().int(), end: z.number().int() }),
  evidence: z.object({
    checkInAt: z.number().int().optional(),
    ringEvents: z.array(
      z.object({
        kind: z.enum(["motion_detected", "button_press"]),
        subType: z.string().optional(),
        at: z.number().int(),
        origin: z.enum(["ring", "simulator", "porchcam"]),
      }),
    ),
    beforeFrameSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    afterFrameSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  }),
  /** Ids of the Policy Kernel decisions that authorized this receipt. */
  decisionIds: z.array(z.string()),
  /** Hash of the previous receipt for this deal (hash chain), if any. */
  prevReceiptHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  issuer: z.string(),
  issuedAt: z.number().int(),
});
export type HandoffReceipt = z.infer<typeof HandoffReceipt>;
