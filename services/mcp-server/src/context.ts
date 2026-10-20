// Everything the MCP tools need. The MCP host holds NO money/address keys: it talks to Settlement
// (in-process locally, a separate Lambda in AWS) and to Settlement's UCP endpoints over HTTP.
import type { Appraiser, NegotiationPort } from "@stoop/agents";
import type { EventBus, Settlement } from "@stoop/settlement";
import type { CardRegistry } from "./cards.ts";

export interface SweepPhoto {
  id: string;
  name: string;
  url: string;
  mime: string;
  /** Raw bytes (EXIF-stripped on upload). */
  bytes?: Uint8Array;
  hint?: string;
}

export interface PhotoStore {
  lastSweep(householdId: string): Promise<SweepPhoto[]>;
}

export interface PickupPrefs {
  fromHour: number;
  toHour: number;
  label: string;
  updatedAt: number;
}

/** Seller memory across sessions (AgentCore Memory user-preference strategy in AWS). Never stores addresses. */
export interface PreferenceMemory {
  get(householdId: string): Promise<PickupPrefs | undefined>;
  set(householdId: string, p: PickupPrefs): Promise<void>;
}

export interface UcpClient {
  request(method: string, path: string, buyerToken: string, body?: unknown, idempotencyKey?: string): Promise<{ status: number; json: any }>;
}

export interface StoopContext {
  settlement: Settlement;
  appraiser: Appraiser;
  negotiator: { turn(input: { negotiationId: string; buyerText: string; offerMinor?: number }): Promise<import("@stoop/agents").NegotiatorResult> };
  photos: PhotoStore;
  prefs: PreferenceMemory;
  cards: CardRegistry;
  ucp: UcpClient;
  bus: EventBus;
  publicBaseUrl: string;
  passBaseUrl: string;
  now(): number;
  /** The household's porch camera takes an item's listing photo, checked by vision (hosted shops). */
  porchPhoto?(householdId: string, itemTitle: string): Promise<{ ok: true; hash: string; url: string } | { ok: false; reason: "no_camera" | "offline" | "not_seen" }>;
}

export interface SellerActor {
  kind: "seller";
  householdId: string;
  displayName: string;
}

export interface BuyerActor {
  kind: "buyer";
  buyerId: string;
  displayName: string;
  /** The bearer token this buyer used (forwarded to UCP endpoints, like Alexa's account-linking token). */
  token: string;
  /** Pre-configured wallet reference (Alexa+ stored payment method; never a card number). */
  walletToken: string;
}

export type Actor = SellerActor | BuyerActor;

export type { NegotiationPort };
