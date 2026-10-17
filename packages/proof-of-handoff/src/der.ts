// Convert an ASN.1 DER ECDSA signature (what AWS KMS Sign returns) into the raw 64-byte R||S
// form JWS ES256 requires. Getting this wrong is the classic KMS-JWS bug.

export function derToRawP256(der: Uint8Array): Uint8Array {
  let i = 0;
  const expect = (byte: number) => {
    if (der[i] !== byte) throw new Error(`DER: expected 0x${byte.toString(16)} at ${i}`);
    i++;
  };
  const readLen = (): number => {
    const first = der[i++];
    if (first === undefined) throw new Error("DER: truncated");
    if (first < 0x80) return first;
    const n = first & 0x7f;
    let len = 0;
    for (let k = 0; k < n; k++) len = (len << 8) | (der[i++] ?? 0);
    return len;
  };
  const readInt = (): Uint8Array => {
    expect(0x02);
    const len = readLen();
    let bytes = der.slice(i, i + len);
    i += len;
    while (bytes.length > 32 && bytes[0] === 0) bytes = bytes.slice(1); // strip sign padding
    if (bytes.length > 32) throw new Error("DER: integer too long for P-256");
    const out = new Uint8Array(32);
    out.set(bytes, 32 - bytes.length);
    return out;
  };
  expect(0x30);
  readLen();
  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}
