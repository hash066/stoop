// A software passkey for tests: a P-256 key pair that answers WebAuthn registration and authentication
// the way a phone's Face ID / fingerprint authenticator does ("none" attestation, user verified).
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

const sha256 = (b: Uint8Array | string) => new Uint8Array(createHash("sha256").update(b).digest());
const b64u = (b: Uint8Array) => isoBase64URL.fromBuffer(new Uint8Array(b));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

export function softPasskey(origin: string) {
  const rpId = new URL(origin).hostname;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const credId = sha256(`cred:${Math.random()}`).slice(0, 16);
  let count = 0;
  const clientData = (type: string, challenge: string) => new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const authData = (flags: number, extra: Uint8Array = new Uint8Array()) => concat(sha256(rpId), new Uint8Array([flags]), u32(count++), extra);

  return {
    id: b64u(credId),
    register(options: { challenge: string }) {
      const cose = isoCBOR.encode(
        new Map<number, number | Uint8Array>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, isoBase64URL.toBuffer(jwk.x)],
          [-3, isoBase64URL.toBuffer(jwk.y)],
        ]),
      );
      // user present + user verified + attested credential data
      const data = authData(0x45, concat(new Uint8Array(16), new Uint8Array([0, credId.length]), credId, cose));
      const attestationObject = isoCBOR.encode(
        new Map<string, Parameters<typeof isoCBOR.encode>[0]>([
          ["fmt", "none"],
          ["attStmt", new Map<string, never>()],
          ["authData", data],
        ]),
      );
      return {
        id: b64u(credId),
        rawId: b64u(credId),
        type: "public-key",
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientData("webauthn.create", options.challenge)), attestationObject: b64u(attestationObject), transports: ["internal"] },
      };
    },
    authenticate(options: { challenge: string }, opts: { verified?: boolean } = {}) {
      const data = authData(opts.verified === false ? 0x01 : 0x05);
      const cd = clientData("webauthn.get", options.challenge);
      const signature = new Uint8Array(sign("sha256", concat(data, sha256(cd)), privateKey));
      return {
        id: b64u(credId),
        rawId: b64u(credId),
        type: "public-key",
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
        response: { clientDataJSON: b64u(cd), authenticatorData: b64u(data), signature: b64u(signature) },
      };
    },
  };
}
