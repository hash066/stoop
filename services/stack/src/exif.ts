// Strip location and other metadata from uploaded photos (rule R10). Listing photos are public.
// JPEG: drop APP1 (EXIF/XMP), APP13 (IPTC) and COM segments. PNG: drop eXIf and text chunks.

export function stripJpegMetadata(input: Uint8Array): Uint8Array {
  if (input[0] !== 0xff || input[1] !== 0xd8) return input;
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i + 4 <= input.length) {
    if (input[i] !== 0xff) break;
    const marker = input[i + 1]!;
    if (marker === 0xda) {
      // Start of scan: copy the rest verbatim (entropy-coded data + EOI).
      for (let k = i; k < input.length; k++) out.push(input[k]!);
      return new Uint8Array(out);
    }
    const len = (input[i + 2]! << 8) | input[i + 3]!;
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!drop) for (let k = i; k < i + 2 + len; k++) out.push(input[k]!);
    i += 2 + len;
  }
  return new Uint8Array(out);
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DROP = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);

export function stripPngMetadata(input: Uint8Array): Uint8Array {
  if (!PNG_SIG.every((b, k) => input[k] === b)) return input;
  const parts: Uint8Array[] = [input.slice(0, 8)];
  let i = 8;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  while (i + 12 <= input.length) {
    const len = view.getUint32(i);
    const type = String.fromCharCode(input[i + 4]!, input[i + 5]!, input[i + 6]!, input[i + 7]!);
    const end = i + 12 + len;
    if (!PNG_DROP.has(type)) parts.push(input.slice(i, end));
    i = end;
    if (type === "IEND") break;
  }
  const total = parts.reduce((t, p) => t + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function stripMetadata(bytes: Uint8Array, mime: string): Uint8Array {
  if (mime.includes("jpeg") || mime.includes("jpg")) return stripJpegMetadata(bytes);
  if (mime.includes("png")) return stripPngMetadata(bytes);
  return bytes;
}
