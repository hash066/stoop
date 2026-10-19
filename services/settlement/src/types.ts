import type {
  ApprovalTerms,
  DealState,
  Decision,
  HandoffVerdict,
  ItemPresence,
  ListingState,
  NegotiationState,
  PickupWindow,
  RingEvent,
} from "@stoop/shared";

export interface Household {
  id: string;
  displayName: string;
  /** Encrypted with the Settlement-only vault key. Never leaves Settlement in plaintext except to a bound pass page. */
  addressCipher: string;
  /** Public, coarse location only. */
  zip: string;
  porchInstructions: string;
  ringDeviceId?: string;
  createdAt: number;
}

export interface Buyer {
  id: string;
  displayName: string;
  /** What sellers see, e.g. "Buyer 7 (3 verified pickups)". */
  pseudonym: string;
  email: string;
  /** Alexa+-style 4-digit purchase code (stored hashed) for purchases over $100. */
  voiceCodeHash: string;
  /** Pre-configured payment method token (Alexa+ policy: no adding cards mid-checkout). */
  walletToken: string;
  verifiedPickups: number;
  noShows: number;
  strikes: number;
  blockedUntil?: number;
  createdAt: number;
}

export interface Comp {
  source: string;
  title: string;
  priceMinor: number;
  url?: string;
}

export interface RecallVerdict {
  blocked: boolean;
  reason?: string;
  source?: string;
  alternative?: string;
}

export interface Item {
  id: string;
  householdId: string;
  title: string;
  category: string;
  condition: "A" | "B" | "C" | "D";
  photoHashes: string[];
  /** Fixture or uploaded photo URLs (EXIF stripped). */
  photoUrls: string[];
  priceBand: { listMinor: number; quickSaleMinor: number; floorSuggestionMinor: number };
  comps: Comp[];
  compsConfidence: "high" | "low";
  recall: RecallVerdict;
  itemHash: string;
  createdAt: number;
}

export interface Listing {
  id: string;
  householdId: string;
  itemId: string;
  title: string;
  description: string;
  askMinor: number;
  state: ListingState;
  version: number;
  zip: string;
  photoUrls: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Offer {
  by: "buyer" | "seller";
  amountMinor: number;
  at: number;
  message: string;
}

export interface Negotiation {
  id: string;
  listingId: string;
  buyerId: string;
  state: NegotiationState;
  offers: Offer[];
  lastCounterMinor?: number;
  /** Highest acceptable buyer offer awaiting the seller. */
  pendingAmountMinor?: number;
  pendingApprovalId?: string;
  /** When the buyer was first told they're talking to an AI assistant. */
  disclosedAt?: number;
  strikes: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface PendingApproval {
  id: string;
  terms: ApprovalTerms;
  termsHash: string;
  /** Who must approve, e.g. "seller:hh_123". */
  approver: string;
  status: "pending" | "approved" | "declined" | "expired";
  createdAt: number;
  expiresAt: number;
  /** Human-readable summary shown on the approval card. */
  summary: string;
}

export interface DealHistoryEntry {
  state: DealState;
  at: number;
  event: string;
}

export interface Deal {
  id: string;
  listingId: string;
  negotiationId: string;
  householdId: string;
  buyerId: string;
  itemTitle: string;
  amountMinor: number;
  buyerFeeMinor: number;
  sellerFeeMinor: number;
  state: DealState;
  version: number;
  window?: PickupWindow;
  checkoutId?: string;
  holdId?: string;
  captureBefore?: number;
  passId?: string;
  verdict?: HandoffVerdict;
  verifiedAt?: number;
  buyerConfirmed: boolean;
  dual: { buyer: boolean; seller: boolean };
  disputeOutcome?: "release_to_seller" | "refund_buyer";
  receiptIds: string[];
  history: DealHistoryEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface Pass {
  id: string;
  dealId: string;
  buyerId: string;
  /** One-time code sent by email to bind the first device; stored hashed. */
  otpHash: string;
  otpAttempts: number;
  otpWindowStart: number;
  deviceId?: string;
  consentAt?: number;
  checkInAt?: number;
  /** Last recorded address-release outcome; decisions are logged only when it changes. */
  lastAddressOutcome?: "allow" | "deny";
  createdAt: number;
}

export interface FrameObservation {
  presence: ItemPresence;
  sha256: string;
  at: number;
  rationale?: string;
  origin: "ring" | "our_footage" | "simulator" | "porchcam";
}

export interface Evidence {
  dealId: string;
  ringEvents: RingEvent[];
  before?: FrameObservation;
  after?: FrameObservation;
  unsureRetries: number;
  camera: "ok" | "offline" | "e2ee" | "unavailable";
}

export interface ReceiptRecord {
  id: string;
  dealId: string;
  jws: string;
  hash: string;
  createdAt: number;
}

export interface PolicyDecisionRecord extends Decision {
  id: string;
  at: number;
  actor: string;
  dealId?: string;
  listingId?: string;
}
