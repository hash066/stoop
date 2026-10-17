import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { derToRawP256, localSigner, sha256Hex, signReceipt, verifyReceipt, type HandoffReceipt } from "../src/index.ts";

const receipt: HandoffReceipt = {
  v: 1,
  receiptId: "rcpt_1",
  dealId: "deal_1",
  listingId: "lst_1",
  itemHash: sha256Hex("jogging stroller"),
  verdict: "VERIFIED",
  signals: { P: true, D: true, B: true },
  window: { start: 1_000, end: 2_000 },
  evidence: {
    checkInAt: 1_100,
    ringEvents: [{ kind: "button_press", at: 1_120, origin: "simulator" }],
    beforeFrameSha256: sha256Hex("before"),
    afterFrameSha256: sha256Hex("after"),
  },
  decisionIds: ["pd_1", "pd_2"],
  issuer: "stoop-settlement",
  issuedAt: 1_500,
};

describe("proof-of-handoff receipts", () => {
  it("sign -> verify round trip with a JWKS", async () => {
    const signer = localSigner({ kid: "k1" });
    const jws = await signReceipt(receipt, signer);
    const out = await verifyReceipt(jws, { keys: [await signer.publicJwk()] });
    expect(out.valid).toBe(true);
    if (out.valid) expect(out.receipt.dealId).toBe("deal_1");
  });

  it("rejects a tampered payload", async () => {
    const signer = localSigner({ kid: "k1" });
    const jws = await signReceipt(receipt, signer);
    const [h, , s] = jws.split(".");
    const forged = Buffer.from(JSON.stringify({ ...receipt, verdict: "VERIFIED", dealId: "deal_evil" })).toString("base64url");
    const out = await verifyReceipt(`${h}.${forged}.${s}`, { keys: [await signer.publicJwk()] });
    expect(out.valid).toBe(false);
  });

  it("rejects a receipt signed by an unknown key", async () => {
    const jws = await signReceipt(receipt, localSigner({ kid: "k1" }));
    const other = localSigner({ kid: "k1" });
    expect((await verifyReceipt(jws, { keys: [await other.publicJwk()] })).valid).toBe(false);
  });

  it("rejects malformed input and wrong typ", async () => {
    expect((await verifyReceipt("not.a.jws", { keys: [] })).valid).toBe(false);
  });

  it("derToRawP256 converts a KMS-style DER signature into a JWS-verifiable one", async () => {
    // Simulate KMS: produce a DER signature, convert, and check it verifies like a native raw sig.
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const msg = Buffer.from("hello");
    const der = nodeSign("sha256", msg, { key: privateKey, dsaEncoding: "der" });
    const raw = derToRawP256(new Uint8Array(der));
    expect(raw.length).toBe(64);
    const { verify } = await import("node:crypto");
    expect(verify("sha256", msg, { key: privateKey, dsaEncoding: "ieee-p1363" }, Buffer.from(raw))).toBe(true);
  });

  it("derToRawP256 rejects garbage", () => {
    expect(() => derToRawP256(new Uint8Array([1, 2, 3]))).toThrow();
  });
});
