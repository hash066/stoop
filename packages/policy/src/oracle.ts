// Negotiation oracles (rule R5). The Negotiator LLM never sees the floor; it can only ask
// "is this acceptable?" and "what should I counter with?".
import type { Mandate } from "@stoop/shared";

/** Counters never land exactly on the floor, so repeated lowballing can't reveal it. */
const FLOOR_SHIELD_FRACTION = 0.1;
/** Fraction of the gap between offer and ask the seller gives up per counter. */
const CONCESSION = 0.4;

const roundUpTo = (minor: number, step: number) => Math.ceil(minor / step) * step;

export function mandateActive(m: Mandate, now: number): boolean {
  return now <= m.expiresAt;
}

export function acceptable(offerMinor: number, m: Mandate, now: number): boolean {
  return mandateActive(m, now) && offerMinor >= m.floorMinor;
}

/** True when the Mandate lets the agent accept without asking the seller (still needs a token, R4). */
export function autoAcceptable(offerMinor: number, m: Mandate, now: number): boolean {
  return (
    acceptable(offerMinor, m, now) &&
    m.autoAcceptAboveMinor !== undefined &&
    offerMinor >= m.autoAcceptAboveMinor
  );
}

export interface CounterInput {
  offerMinor: number;
  askMinor: number;
  /** Last counter we sent this buyer; counters must never go back up. */
  previousCounterMinor?: number;
}

/**
 * Suggest a counter-offer. Output is always >= floor + shield, <= ask, monotone non-increasing,
 * and rounded up to $5 so it sounds human. Returns null when the offer should just be accepted.
 */
export function suggestCounter(input: CounterInput, m: Mandate): number | null {
  const { offerMinor, askMinor, previousCounterMinor } = input;
  if (offerMinor >= askMinor) return null;
  const shield = m.floorMinor + Math.ceil((askMinor - m.floorMinor) * FLOOR_SHIELD_FRACTION);
  const raw = askMinor - (askMinor - offerMinor) * CONCESSION;
  let counter = roundUpTo(Math.max(raw, shield), 500);
  counter = Math.min(counter, askMinor);
  if (previousCounterMinor !== undefined) counter = Math.min(counter, previousCounterMinor);
  // If the monotone cap pushed us below the shield (shouldn't happen with a fixed ask), hold at the cap.
  if (counter <= offerMinor) return null;
  return counter;
}
