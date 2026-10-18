# Ring certification notes (draft answers for the Privacy & Legal questionnaire)

**App:** Stoop Verified Pickup. It verifies contactless porch pickups so buyers' held payments are released only when the item actually leaves the porch.

## Data processing

- **Ring data used:**
  - `motion_detected` (`sub_type`) and `button_press` webhooks for the linked doorbell
  - two existing images per pickup: the latest before the pickup window and the latest from the visit. Stoop never asks the camera to record; Ring's image download only returns images already captured (a press, motion or live view). If there is none, Stoop treats the camera as unavailable and the sale needs both people's confirmation, so a missing image is never evidence
  - optional short evidence clips
- **Purpose:** decide whether a scheduled pickup happened (item present before, absent after, buyer checked in, doorbell saw a visitor). Nothing else.
- **Identity:**
  - **No facial recognition, no license plates, no identity inference.** Vision answers one categorical question about the item's presence in a seller-drawn porch zone (present / absent / unsure).
  - Person counting is optional and never stored with identities.
- **Retention:** frames and clips for 30 days (dispute window), then deleted. Receipts contain hashes and timestamps only.
- **Sharing:** frames are never shown to buyers. Receipts are public but contain no images, addresses or identities.
- **Consent:**
  - The seller links Ring and chooses the porch zone.
  - The buyer consents to doorbell verification on the pickup pass before pickup details appear.

## AI governance

- Models never authorize payments. A deterministic Policy Kernel decides. Model output is evidence (present/absent/unsure) and wording.
- Every decision is audit-logged with rule ids.
- A red-team benchmark (300 adversarial conversations) shows zero address or floor leaks.

## Data protection

- Addresses are encrypted under a key only the Settlement service can use (KMS in production).
- Webhooks: HMAC verified over the raw body, deduped by `meta.request_id`, timestamp skew ≤ 5 minutes.
- E2EE / TAKE devices are detected (`e2e_encryption.enabled`) and fall back to dual confirmation; no attempt is made to read encrypted video.

## Third parties

- Payment processor (test mode during the hackathon).
- Amazon Bedrock (vision and language), in the same AWS account.

## Reviewer notes (20–4000 characters each)

1. **Test account:** use the Developer Playground device. Pickup verification can be exercised with the Ops console's "golden" and "piracy" scenarios (simulator-labelled events) because Playground doesn't deliver webhooks.
2. **Expected behaviour:**
   - A held payment is captured only after VERIFIED plus buyer confirmation, or after 2 h.
   - No-shows release the hold.
   - Pickups without a pass never release money.
3. **Contact:** **(team email).**
