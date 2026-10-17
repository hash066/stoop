// Payment service provider adapters. Escrow = authorization hold (manual capture).
// SandboxPSP mirrors Stripe manual-capture semantics (requires_capture, capture_before, cancel)
// and is always labelled "Test PSP" in the UI. StripeTestPSP is a drop-in for a US test account.
import { newId } from "./infra.ts";

export interface Hold {
  holdId: string;
  amountMinor: number;
  status: "requires_capture" | "captured" | "canceled";
  captureBefore: number;
  createdAt: number;
}

export interface PaymentCredential {
  /** Alexa+-style handler id, e.g. com.amazon.payments.stored_payment_method (simulated). */
  handler: string;
  /** Opaque token: never a raw card number. */
  token: string;
}

export interface PSP {
  readonly label: string;
  authorize(amountMinor: number, cred: PaymentCredential, now: number, idempotencyKey: string): Promise<Hold>;
  capture(holdId: string, amountMinor: number, now: number): Promise<Hold>;
  cancel(holdId: string): Promise<Hold>;
  get(holdId: string): Promise<Hold | undefined>;
}

/** Card holds last ~7 days for online payments (Stripe docs). */
export const HOLD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class SandboxPSP implements PSP {
  readonly label = "Test PSP (sandbox, no real money)";
  private holds = new Map<string, Hold>();
  private byIdem = new Map<string, string>();
  /** Tokens that simulate a declined card. */
  static readonly DECLINE_TOKEN = "tok_decline";

  async authorize(amountMinor: number, cred: PaymentCredential, now: number, idempotencyKey: string): Promise<Hold> {
    const existing = this.byIdem.get(idempotencyKey);
    if (existing) return this.holds.get(existing)!;
    if (cred.token === SandboxPSP.DECLINE_TOKEN) throw new PaymentError("payment_failed", "Card declined (test token)");
    if (!cred.token.startsWith("tok_")) throw new PaymentError("payment_failed", "Unknown payment token");
    const hold: Hold = {
      holdId: newId("hold"),
      amountMinor,
      status: "requires_capture",
      captureBefore: now + HOLD_TTL_MS,
      createdAt: now,
    };
    this.holds.set(hold.holdId, hold);
    this.byIdem.set(idempotencyKey, hold.holdId);
    return hold;
  }

  async capture(holdId: string, amountMinor: number, now: number): Promise<Hold> {
    const h = this.holds.get(holdId);
    if (!h) throw new PaymentError("payment_failed", "Unknown hold");
    if (h.status === "captured") return h; // idempotent
    if (h.status !== "requires_capture") throw new PaymentError("payment_failed", `Hold is ${h.status}`);
    if (now > h.captureBefore) throw new PaymentError("payment_failed", "Hold expired");
    if (amountMinor > h.amountMinor) throw new PaymentError("payment_failed", "Capture exceeds hold");
    h.status = "captured";
    return h;
  }

  async cancel(holdId: string): Promise<Hold> {
    const h = this.holds.get(holdId);
    if (!h) throw new PaymentError("payment_failed", "Unknown hold");
    if (h.status === "requires_capture") h.status = "canceled";
    return h;
  }

  async get(holdId: string) {
    return this.holds.get(holdId);
  }
}

export class PaymentError extends Error {
  constructor(
    readonly code: "payment_failed" | "eligibility_invalid",
    message: string,
  ) {
    super(message);
  }
}
