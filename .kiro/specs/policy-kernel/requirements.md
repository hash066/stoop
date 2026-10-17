# Requirements: Stoop Policy Kernel

Status: implemented in `packages/policy` (see `design.md`). Remaining tasks are in `tasks.md`.

## Requirement 1: Address release (R2)

**User story:** As a seller, I want my address shown only to the buyer who paid, only around pickup time, so strangers and AI agents never learn where I live.

**Acceptance criteria:**
1. WHEN an address reveal is requested through any channel other than the pickup-pass page, THE SYSTEM SHALL deny it.
2. WHEN the deal's funds are not held, THE SYSTEM SHALL deny address release.
3. WHEN the requester is not the bound buyer, or the device isn't the device bound by one-time code, THE SYSTEM SHALL deny address release.
4. WHEN the time is earlier than 30 minutes before the window, or after the window end, THE SYSTEM SHALL deny address release.
5. THE SYSTEM SHALL record every change in reveal outcome as an auditable policy decision.

## Requirement 2: Capture only with proof (R3)

**User story:** As a buyer, I want my payment captured only after a verified pickup, so I never pay for something I didn't get.

**Acceptance criteria:**
1. WHEN the deal is in INSPECTION with verdict VERIFIED and the buyer confirms, THE SYSTEM SHALL allow capture.
2. WHEN the deal is in INSPECTION with verdict VERIFIED and 2 hours have elapsed since verification, THE SYSTEM SHALL allow capture.
3. WHEN both parties confirm a REVIEW/DEGRADED deal and the amount is at most $150, THE SYSTEM SHALL allow capture.
4. WHEN a dispute is resolved in the seller's favour, THE SYSTEM SHALL allow capture.
5. IN ALL OTHER CASES THE SYSTEM SHALL deny capture. (Property test: no event sequence reaches CAPTURED otherwise.)

## Requirement 3: Human approval for irreversible actions (R4)

**Acceptance criteria:**
1. THE SYSTEM SHALL mint capability tokens that expire in 5 minutes, are single-use, and are bound to action, deal, listing, amount and the SHA-256 of the RFC 8785 canonical terms shown.
2. WHEN any bound term differs at use time, THE SYSTEM SHALL reject the token without burning it.
3. WHEN an offer is below the seller's floor, THE SYSTEM SHALL deny acceptance even with a valid human token.

## Requirement 4: Floor secrecy (R5)

**Acceptance criteria:**
1. THE SYSTEM SHALL expose only `acceptable(offer)` and `suggestCounter(offer)` to negotiating agents.
2. Suggested counters SHALL be strictly above the floor, at most the ask, rounded to $5, and never higher than a previous counter.

## Requirement 5: Proof-of-Handoff verdicts

**Acceptance criteria:**
1. WHEN the after-frame shows the item absent, the buyer checked in, a Ring presence event occurred within ±3 minutes, and the before-frame showed the item, THE SYSTEM SHALL return VERIFIED.
2. WHEN the item is gone and no valid check-in exists, THE SYSTEM SHALL return PIRACY_SUSPECTED.
3. WHEN the buyer checked in but no Ring event has arrived, THE SYSTEM SHALL wait until the presence window has passed before returning REVIEW.
4. WHEN the camera is offline or end-to-end encrypted, THE SYSTEM SHALL return DEGRADED.

## Requirement 6: Alexa+ purchase policy (R13)

**Acceptance criteria:**
1. THE SYSTEM SHALL require the breakdown, the refund policy and an explicit yes before any purchase.
2. WHEN the total exceeds $100, THE SYSTEM SHALL also require a 4-digit voice code and on-screen confirmation.
3. WHEN the charged amount differs from the quote, or the payment method isn't pre-configured, THE SYSTEM SHALL deny the purchase.
