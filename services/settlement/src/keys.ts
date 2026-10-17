// Store key layout. Shared by Settlement and the address boundary (the Vault Lambda in AWS reads
// the same DynamoDB items), so it lives in one place.
export const K = {
  household: (id: string) => `household#${id}`,
  buyer: (id: string) => `buyer#${id}`,
  item: (id: string) => `item#${id}`,
  listing: (id: string) => `listing#${id}`,
  mandate: (listingId: string) => `mandate#${listingId}`,
  nego: (id: string) => `nego#${id}`,
  approval: (id: string) => `approval#${id}`,
  deal: (id: string) => `deal#${id}`,
  activeDeal: (listingId: string) => `activedeal#${listingId}`,
  pass: (id: string) => `pass#${id}`,
  evidence: (dealId: string) => `evidence#${dealId}`,
  receipt: (id: string) => `receipt#${id}`,
  decision: (at: number, id: string) => `decision#${String(at).padStart(15, "0")}#${id}`,
};
