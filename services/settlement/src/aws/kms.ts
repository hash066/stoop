// KMS twins of the local vault, MAC provider and receipt signer (Kiro task 7).
//   vault   SYMMETRIC_DEFAULT key; the key policy grants Decrypt only to the Vault Lambda
//   mac     HMAC_256 key; GenerateMac / VerifyMac for capability tokens
//   signer  ECC_NIST_P256 key; Sign with MessageType=DIGEST, DER -> raw R||S for JWS ES256
import { createHash, createPublicKey } from "node:crypto";
import {
  DecryptCommand,
  EncryptCommand,
  GenerateMacCommand,
  GetPublicKeyCommand,
  KMSClient,
  KMSInvalidMacException,
  SignCommand,
  VerifyMacCommand,
} from "@aws-sdk/client-kms";
import type { MacProvider } from "@stoop/policy";
import { derToRawP256, type ReceiptSigner } from "proof-of-handoff";
import type { Vault } from "../infra.ts";

type Jwk = Awaited<ReturnType<ReceiptSigner["publicJwk"]>>;

/** Bound into every address ciphertext; a ciphertext lifted into another context won't decrypt. */
export const ADDRESS_CONTEXT = { purpose: "stoop-address" } as const;
const PREFIX = "kms1.";

export function kmsVault(kms: KMSClient, keyId: string): Vault {
  return {
    async encrypt(plain) {
      const r = await kms.send(new EncryptCommand({ KeyId: keyId, Plaintext: Buffer.from(plain, "utf8"), EncryptionContext: { ...ADDRESS_CONTEXT } }));
      return PREFIX + Buffer.from(r.CiphertextBlob!).toString("base64url");
    },
    async decrypt(cipher) {
      if (!cipher.startsWith(PREFIX)) throw new Error("vault: not a KMS ciphertext");
      const r = await kms.send(
        new DecryptCommand({ KeyId: keyId, CiphertextBlob: Buffer.from(cipher.slice(PREFIX.length), "base64url"), EncryptionContext: { ...ADDRESS_CONTEXT } }),
      );
      return Buffer.from(r.Plaintext!).toString("utf8");
    },
  };
}

export function kmsMacProvider(kms: KMSClient, keyId: string): MacProvider {
  return {
    async mac(data) {
      const r = await kms.send(new GenerateMacCommand({ KeyId: keyId, MacAlgorithm: "HMAC_SHA_256", Message: data }));
      return new Uint8Array(r.Mac!);
    },
    async verify(data, mac) {
      try {
        const r = await kms.send(new VerifyMacCommand({ KeyId: keyId, MacAlgorithm: "HMAC_SHA_256", Message: data, Mac: mac }));
        return r.MacValid === true;
      } catch (e) {
        if (e instanceof KMSInvalidMacException) return false;
        throw e;
      }
    },
  };
}

export function kmsReceiptSigner(kms: KMSClient, keyId: string, kid = `kms-${keyId.split("/").pop()!.slice(0, 12)}`): ReceiptSigner {
  let jwk: Jwk | undefined;
  return {
    kid,
    async sign(signingInput) {
      const digest = createHash("sha256").update(signingInput).digest();
      const r = await kms.send(new SignCommand({ KeyId: keyId, Message: digest, MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }));
      return derToRawP256(new Uint8Array(r.Signature!));
    },
    async publicJwk() {
      if (!jwk) {
        const r = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
        const key = createPublicKey({ key: Buffer.from(r.PublicKey!), format: "der", type: "spki" });
        jwk = { ...(key.export({ format: "jwk" }) as Jwk), kid, alg: "ES256", use: "sig" };
      }
      return jwk;
    },
  };
}
