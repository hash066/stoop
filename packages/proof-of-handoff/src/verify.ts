import { compactVerify, createLocalJWKSet, decodeProtectedHeader, type JSONWebKeySet } from "jose";
import { canonicalize } from "./jcs.ts";
import { HandoffReceipt } from "./receipt.ts";

export type VerifyOutcome =
  | { valid: true; receipt: HandoffReceipt; kid: string }
  | { valid: false; reason: string };

/**
 * Verify a receipt offline against a JWKS: signature (ES256), header type, schema, and that the
 * payload bytes are exactly the JCS canonical form (so nobody can smuggle in alternate encodings).
 */
export async function verifyReceipt(jws: string, jwks: JSONWebKeySet): Promise<VerifyOutcome> {
  let header;
  try {
    header = decodeProtectedHeader(jws);
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (header.alg !== "ES256") return { valid: false, reason: "alg_not_es256" };
  if (header.typ !== "poh+jws") return { valid: false, reason: "wrong_typ" };
  try {
    const { payload } = await compactVerify(jws, createLocalJWKSet(jwks), { algorithms: ["ES256"] });
    const text = new TextDecoder().decode(payload);
    const parsed = HandoffReceipt.safeParse(JSON.parse(text));
    if (!parsed.success) return { valid: false, reason: "schema" };
    if (canonicalize(parsed.data) !== text) return { valid: false, reason: "not_canonical" };
    return { valid: true, receipt: parsed.data, kid: String(header.kid) };
  } catch (e) {
    return { valid: false, reason: e instanceof Error && /signature/i.test(e.message) ? "bad_signature" : "verify_failed" };
  }
}
