// Canonical terms hashing for approvals (plan §6).
// RFC 8785 (JCS) canonicalization for the JSON value space Stoop uses: objects with sorted keys,
// arrays, strings, finite numbers, booleans, null. Undefined object members are omitted.
import { createHash } from "node:crypto";
import type { ApprovalTerms } from "@stoop/shared";

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("JCS: non-finite numbers are not allowed");
      // ECMAScript Number-to-String matches JCS for the integers/decimals we emit.
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort(); // JCS sorts by UTF-16 code units, which is JS's default string sort.
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`JCS: unsupported type ${typeof value}`);
  }
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Hash of exactly what the human was shown. If any term changes, approvals bound to it die. */
export function termsHash(terms: ApprovalTerms): string {
  return sha256Hex(canonicalize(terms));
}
