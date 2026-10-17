# proof-of-handoff

Signed, independently verifiable receipts for contactless porch handoffs.

A receipt records that an item changed hands at a door: the pickup window, the buyer's check-in time, doorbell events, and SHA-256 hashes of the before/after porch frames. It never contains addresses or images. Receipts are [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (JCS) canonical JSON, signed as a compact JWS with ES256, so anyone holding the issuer's public JWKS can check one offline.

Built for [Stoop](https://github.com/hash066/stoop), which releases a buyer's payment only after a verified handoff.

## Verify a receipt from the command line

```sh
npx proof-of-handoff verify receipt.jws --jwks jwks.json
# or straight from an issuer
npx proof-of-handoff verify https://issuer.example/receipts/rcpt_123 --jwks https://issuer.example/.well-known/jwks.json
```

```
VALID  kid=local-3f9c0a1b2c4d
deal=deal_303417b3ad044c8a verdict=VERIFIED signals=P:true D:true B:true
issued=2026-10-17T13:30:20.000Z issuer=https://issuer.example
```

Exit code `0` means valid, `1` invalid (with a reason), `2` usage error. Installed globally, the binary is `poh`.

## Use it in code

```ts
import { localSigner, signReceipt, verifyReceipt } from "proof-of-handoff";

const signer = localSigner(); // dev/test only: an in-memory P-256 key
const jws = await signReceipt(receipt, signer);

const outcome = await verifyReceipt(jws, { keys: [await signer.publicJwk()] });
if (outcome.valid) console.log(outcome.receipt.verdict);
else console.error(outcome.reason);
```

`verifyReceipt` checks, in order:

1. the protected header is `alg: ES256` and `typ: poh+jws`
2. the signature, against the JWKS (by `kid`)
3. the payload against the `HandoffReceipt` schema
4. that the payload bytes are exactly the JCS canonical form, so alternate encodings of the same JSON are rejected

Failure reasons: `malformed`, `alg_not_es256`, `wrong_typ`, `bad_signature`, `schema`, `not_canonical`, `verify_failed`.

## Production signers

`signReceipt` takes any `ReceiptSigner`:

```ts
interface ReceiptSigner {
  kid: string;
  sign(signingInput: Uint8Array): Promise<Uint8Array>; // raw 64-byte R||S
  publicJwk(): Promise<JWK>;
}
```

AWS KMS (`ECC_NIST_P256`, `ECDSA_SHA_256`) returns DER signatures. Hash the signing input yourself, call `Sign` with `MessageType=DIGEST`, then convert with the exported `derToRawP256`.

## Receipt fields

| Field | Meaning |
|---|---|
| `v` | schema version, `1` |
| `receiptId`, `dealId`, `listingId` | identifiers from the issuer |
| `itemHash` | SHA-256 of the listing's canonical item description and photo hashes |
| `verdict` | `VERIFIED`, `DUAL_CONFIRMED` or `DISPUTE_RELEASED` |
| `signals` | `P` device-bound pass check-in inside the window, `D` doorbell/person event within ±3 min of the check-in, `B` the before frame shows the item |
| `window` | pickup window start/end (epoch ms) |
| `evidence` | check-in time, doorbell events (each labelled `ring` or `simulator`), frame hashes |
| `decisionIds` | the policy decisions that authorized the receipt |
| `prevReceiptHash` | hash chain to the previous receipt for the same deal (`receiptHash(jws)`) |
| `issuer`, `issuedAt` | who signed it and when |

Other exports: `canonicalize` (JCS), `sha256Hex`, `receiptHash`, `HandoffReceipt` (zod schema and type).

## License

MIT
