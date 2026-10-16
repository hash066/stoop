// Capability tokens (plan §6). Single-use, 5-minute, bound to the exact terms a human saw.
// The MAC is injected: KMS GenerateMac/VerifyMac (HMAC_SHA_256) in production, node HMAC locally.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { CapabilityTokenClaims, type PolicyAction } from "@stoop/shared";

export const TOKEN_TTL_MS = 5 * 60 * 1000;

export interface MacProvider {
  mac(data: Uint8Array): Promise<Uint8Array>;
  verify(data: Uint8Array, mac: Uint8Array): Promise<boolean>;
}

/** Records spent token ids. markUsed returns true only the first time (DynamoDB conditional put in prod). */
export interface SpentTokenStore {
  markUsed(tid: string, expiresAt: number): Promise<boolean>;
}

export function localHmacProvider(key: string | Buffer): MacProvider {
  const mac = (data: Uint8Array) => new Uint8Array(createHmac("sha256", key).update(data).digest());
  return {
    async mac(data) {
      return mac(data);
    },
    async verify(data, given) {
      const want = mac(data);
      return want.length === given.length && timingSafeEqual(want, given);
    },
  };
}

export function memorySpentStore(): SpentTokenStore & { size(): number } {
  const used = new Map<string, number>();
  return {
    async markUsed(tid, expiresAt) {
      if (used.has(tid)) return false;
      used.set(tid, expiresAt);
      return true;
    },
    size: () => used.size,
  };
}

const enc = new TextEncoder();
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

export interface MintInput {
  action: PolicyAction;
  actor: string;
  termsHash: string;
  dealId?: string;
  listingId?: string;
  amountMinor?: number;
  pendingApprovalId?: string;
  now: number;
}

export async function mintToken(input: MintInput, macp: MacProvider): Promise<string> {
  const { now, ...rest } = input;
  const claims = CapabilityTokenClaims.parse({ ...rest, tid: randomUUID(), exp: now + TOKEN_TTL_MS });
  const body = b64u(enc.encode(JSON.stringify(claims)));
  const sig = await macp.mac(enc.encode(body));
  return `${body}.${b64u(sig)}`;
}

export interface Expectation {
  action: PolicyAction;
  termsHash: string;
  dealId?: string;
  listingId?: string;
  amountMinor?: number;
}

export type VerifyResult =
  | { ok: true; claims: CapabilityTokenClaims }
  | { ok: false; reason: string };

/**
 * Verify MAC, expiry, binding to action/deal/amount/terms, then burn the token id.
 * Burning happens last so a token that fails a binding check can't be used to DoS the real one.
 */
export async function verifyAndSpend(
  token: string,
  expect: Expectation,
  now: number,
  macp: MacProvider,
  store: SpentTokenStore,
): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [body, sig] = parts as [string, string];
  if (!(await macp.verify(enc.encode(body), unb64u(sig)))) return { ok: false, reason: "bad_mac" };

  let claims: CapabilityTokenClaims;
  try {
    claims = CapabilityTokenClaims.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
  } catch {
    return { ok: false, reason: "bad_claims" };
  }
  if (now > claims.exp) return { ok: false, reason: "expired" };
  if (claims.action !== expect.action) return { ok: false, reason: "action_mismatch" };
  if (claims.termsHash !== expect.termsHash) return { ok: false, reason: "terms_mismatch" };
  if (expect.dealId !== undefined && claims.dealId !== expect.dealId) return { ok: false, reason: "deal_mismatch" };
  if (expect.listingId !== undefined && claims.listingId !== expect.listingId)
    return { ok: false, reason: "listing_mismatch" };
  if (expect.amountMinor !== undefined && claims.amountMinor !== expect.amountMinor)
    return { ok: false, reason: "amount_mismatch" };
  if (!(await store.markUsed(claims.tid, claims.exp))) return { ok: false, reason: "already_used" };
  return { ok: true, claims };
}
