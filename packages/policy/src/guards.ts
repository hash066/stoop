// Deterministic text guards: scam patterns (R7) run before any LLM, and an outbound leak guard
// (R2/R5) runs on every message an agent tries to send. The LLM is the second line, never the first.

export type ScamSignal =
  | "off_platform_payment"
  | "gift_card"
  | "verification_code"
  | "overpayment"
  | "shipping_or_courier"
  | "external_link"
  | "address_request"
  | "instruction_injection";

const PATTERNS: Array<[ScamSignal, RegExp]> = [
  ["off_platform_payment", /\b(zelle|venmo|cash\s?app|cashapp|paypal\s+friends|wire\s+transfer|western\s+union|crypto|bitcoin|usdt)\b/i],
  ["gift_card", /\bgift\s?cards?\b|\b(apple|google\s?play|steam|amazon)\s+cards?\b/i],
  ["verification_code", /\b(verification|verify|security|confirmation|6[-\s]?digit|six[-\s]?digit)\s+(code|number)\b|\bsend\s+(me\s+)?(the\s+)?code\b/i],
  ["overpayment", /\b(overpa(y|id)|send\s+(you\s+)?(extra|more)|refund\s+the\s+(difference|rest)|cashier'?s?\s+check)\b/i],
  ["shipping_or_courier", /\b(ship\s+it|shipping\s+label|my\s+(courier|mover|driver|agent)\s+will|courier\s+(will|pickup)|fedex\s+pickup|ups\s+pickup)\b/i],
  ["external_link", /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\.[a-z]{2,}|\bbit\.ly\b/i],
  ["address_request", /\b(what'?s|send|give|tell)\s+(me\s+)?(your|the|ur)\s+(full\s+)?(address|location|house\s+number|street)\b/i],
  ["instruction_injection", /\b(ignore|disregard|forget)\s+(all\s+|your\s+|the\s+|previous\s+|prior\s+)*(rules|instructions|policy|policies|system\s+prompt)\b|\byou\s+are\s+now\b|\bdeveloper\s+mode\b|\bsystem\s*:/i],
];

export function scanBuyerText(text: string): ScamSignal[] {
  return PATTERNS.filter(([, re]) => re.test(text)).map(([s]) => s);
}

/** Signals that earn a strike (2 strikes => ABUSE_BLOCKED). Address requests and injection are refused but not struck. */
export const STRIKE_SIGNALS: ReadonlySet<ScamSignal> = new Set([
  "off_platform_payment",
  "gift_card",
  "verification_code",
  "overpayment",
  "shipping_or_courier",
]);

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export interface LeakSecrets {
  /** Full street address lines, unit numbers, etc. Settlement fills this from the vault at check time. */
  addressFragments: string[];
  /** Seller floor in minor units; any dollar figure at or below it in an acceptance is a leak. */
  floorMinor?: number;
}

export interface LeakCheck {
  ok: boolean;
  violations: string[];
}

const DOLLARS = /\$\s?(\d{1,6}(?:\.\d{2})?)/g;

/**
 * Block outbound agent messages that contain the address (R2) or disclose the floor (R5).
 * The floor check flags any message that names the exact floor price, whatever the context.
 */
export function guardOutgoing(text: string, secrets: LeakSecrets): LeakCheck {
  const violations: string[] = [];
  const hay = normalize(text);
  for (const frag of secrets.addressFragments) {
    const f = normalize(frag);
    if (f.length >= 4 && hay.includes(f)) violations.push("address_fragment");
  }
  if (secrets.floorMinor !== undefined) {
    for (const m of text.matchAll(DOLLARS)) {
      const minor = Math.round(Number(m[1]) * 100);
      if (minor === secrets.floorMinor) violations.push("floor_price_disclosed");
    }
    if (/\b(floor|lowest\s+(i|we|they|seller)\s+(can|will)\s+go|minimum\s+price)\b/i.test(text))
      violations.push("floor_concept_disclosed");
  }
  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

/** Required first-message disclosure (R6). */
export const AI_DISCLOSURE =
  "Hi, I'm an AI assistant selling this on the owner's behalf. I can answer questions and take offers; the owner approves every sale.";
