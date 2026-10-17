// JWS ES256 signing over JCS-canonical receipt bytes.
// Signers return the raw 64-byte R||S signature JWS requires. AWS KMS returns DER, so the KMS
// signer computes SHA-256 itself, calls Sign with MessageType=DIGEST, then runs derToRawP256.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";
import { exportJWK, type JWK } from "jose";
import { canonicalize, sha256Hex } from "./jcs.ts";
import { HandoffReceipt } from "./receipt.ts";

export interface ReceiptSigner {
  kid: string;
  /** Sign the JWS signing input (ASCII bytes); return the raw 64-byte P-256 ES256 signature. */
  sign(signingInput: Uint8Array): Promise<Uint8Array>;
  publicJwk(): Promise<JWK>;
}

const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");

export async function signReceipt(receipt: HandoffReceipt, signer: ReceiptSigner): Promise<string> {
  const payload = HandoffReceipt.parse(receipt);
  const header = { alg: "ES256", kid: signer.kid, typ: "poh+jws" };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(canonicalize(payload))}`;
  const sig = await signer.sign(new TextEncoder().encode(signingInput));
  if (sig.length !== 64) throw new Error(`ES256 signature must be 64 bytes, got ${sig.length}`);
  return `${signingInput}.${b64u(sig)}`;
}

/** Hash used for hash-chaining receipts per deal. */
export const receiptHash = (jws: string) => sha256Hex(jws);

/** Local signer for development and tests. Production uses a KMS ECC_NIST_P256 key. */
export function localSigner(opts: { kid?: string; privateKeyPem?: string } = {}): ReceiptSigner {
  const key: KeyObject = opts.privateKeyPem
    ? createPrivateKey(opts.privateKeyPem)
    : generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const kid =
    opts.kid ?? `local-${sha256Hex(key.export({ format: "pem", type: "pkcs8" }) as string).slice(0, 12)}`;
  return {
    kid,
    async sign(signingInput) {
      return new Uint8Array(nodeSign("sha256", signingInput, { key, dsaEncoding: "ieee-p1363" }));
    },
    async publicJwk() {
      const jwk = await exportJWK(createPublicKey(key));
      return { ...jwk, kid, alg: "ES256", use: "sig" };
    },
  };
}
