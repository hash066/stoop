// Image formats Amazon Bedrock Converse accepts. Anything else (the demo's SVG placeholders, HEIC
// straight off a phone) must not be sent: Bedrock rejects the whole request, not just the image.
export type BedrockImageFormat = "png" | "jpeg" | "gif" | "webp";

const BY_MIME: Record<string, BedrockImageFormat> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** The Bedrock format for an image, or undefined if it can't be sent. Sniffs bytes when there's no MIME type. */
export function bedrockImageFormat(mime: string | undefined, bytes?: Uint8Array): BedrockImageFormat | undefined {
  const m = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  if (m) return BY_MIME[m];
  if (!bytes || bytes.length < 12) return undefined;
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (ascii(0, 4) === "GIF8") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  return undefined;
}
