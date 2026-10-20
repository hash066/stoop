// The address boundary: the only code that turns an address ciphertext into plaintext.
// Locally it runs in-process with the local vault. In AWS it runs in the Vault Lambda, the only
// principal the address KMS key lets decrypt, and it re-checks R2 against stored state itself, so
// the host running the MCP server and the agents cannot read an address even if compromised.
import { decide, guardOutgoing, type DecideInput, type LeakCheck } from "@stoop/policy";
import type { Mandate } from "@stoop/shared";
import type { Store, Vault } from "./infra.ts";
import { K } from "./keys.ts";
import type { Deal, Household, Listing, Pass } from "./types.ts";

export interface AddressBoundary {
  /** R2/R5 guard over an outbound agent message. Returns only the verdict, never the address. */
  checkOutgoing(listingId: string, text: string): Promise<LeakCheck>;
  /** The address for a pass page, only if R2 allows it now (re-checked from stored state). */
  revealForPass(passId: string, deviceId: string): Promise<string | undefined>;
  /** The lockbox code, only once the buyer has checked in on the bound pass, inside the window. */
  revealLockboxForPass(passId: string, deviceId: string): Promise<string | undefined>;
}

const TERMINAL = ["CLOSED", "VOIDED", "CHECKOUT_ABANDONED", "CAPTURED", "PAYOUT_RECORDED"];

/** The R2 question a pass page asks, or undefined when there is nothing to ask (no window or consent yet, or the deal is over). */
export function revealInput(p: Pass, deal: Deal, deviceId: string, now: number): DecideInput | undefined {
  if (!deal.window || p.consentAt === undefined || TERMINAL.includes(deal.state)) return undefined;
  return {
    action: "reveal_address",
    dealState: deal.state,
    window: deal.window,
    now,
    requester: { buyerId: p.buyerId, deviceId },
    bound: { buyerId: deal.buyerId, deviceId: p.deviceId },
    channel: "pass_page",
  };
}

export function addressFragments(address: string): string[] {
  return [address, ...address.split(/,|\n/).map((s) => s.trim())].filter((s) => s.length >= 4);
}

export function storeBoundary(d: { store: Store; vault: Vault; now: () => number }): AddressBoundary {
  const must = async <T>(key: string): Promise<T> => {
    const v = await d.store.get<T>(key);
    if (v === undefined) throw new Error(`not_found: ${key.split("#")[0]}`);
    return v;
  };
  return {
    async checkOutgoing(listingId, text) {
      const l = await must<Listing>(K.listing(listingId));
      const hh = await must<Household>(K.household(l.householdId));
      const address = await d.vault.decrypt(hh.addressCipher);
      const m = await d.store.get<Mandate>(K.mandate(l.id));
      return guardOutgoing(text, { addressFragments: addressFragments(address), floorMinor: m?.floorMinor });
    },
    async revealForPass(passId, deviceId) {
      const p = await must<Pass>(K.pass(passId));
      const deal = await must<Deal>(K.deal(p.dealId));
      const input = revealInput(p, deal, deviceId, d.now());
      if (!input || decide(input).outcome !== "allow") return undefined;
      const hh = await must<Household>(K.household(deal.householdId));
      return d.vault.decrypt(hh.addressCipher);
    },
    async revealLockboxForPass(passId, deviceId) {
      const p = await must<Pass>(K.pass(passId));
      if (p.checkInAt === undefined) return undefined;
      const deal = await must<Deal>(K.deal(p.dealId));
      const input = revealInput(p, deal, deviceId, d.now());
      if (!input || decide(input).outcome !== "allow") return undefined;
      const hh = await must<Household>(K.household(deal.householdId));
      return hh.lockboxCipher ? d.vault.decrypt(hh.lockboxCipher) : undefined;
    },
  };
}
