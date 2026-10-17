// RFC 8785 JSON Canonicalization Scheme for the value space receipts use.
import { createHash } from "node:crypto";

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("JCS: non-finite number");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
      const o = value as Record<string, unknown>;
      return `{${Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`)
        .join(",")}}`;
    }
    default:
      throw new TypeError(`JCS: unsupported ${typeof value}`);
  }
}

export const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
