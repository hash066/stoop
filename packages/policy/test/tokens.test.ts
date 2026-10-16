import { describe, expect, it } from "vitest";
import { canonicalize, termsHash } from "../src/terms.ts";
import { localHmacProvider, memorySpentStore, mintToken, TOKEN_TTL_MS, verifyAndSpend } from "../src/tokens.ts";

const T0 = Date.UTC(2026, 9, 20, 18, 0);
const macp = localHmacProvider("test-key-not-secret");

describe("JCS canonicalization", () => {
  it("sorts keys, drops undefined, no whitespace", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], c: undefined, d: { z: 1, y: 2 } })).toBe(
      '{"a":[true,null,"x"],"b":1,"d":{"y":2,"z":1}}',
    );
  });
  it("is order-independent for hashing", () => {
    expect(termsHash({ action: "accept_offer", amountMinor: 9500, listingId: "l1" })).toBe(
      termsHash({ listingId: "l1", amountMinor: 9500, action: "accept_offer" }),
    );
  });
  it("rejects non-finite numbers and unsupported types", () => {
    expect(() => canonicalize(Number.NaN)).toThrow();
    expect(() => canonicalize(() => 1)).toThrow();
  });
});

describe("capability tokens", () => {
  const terms = { action: "accept_offer" as const, dealId: "deal1", amountMinor: 95_00, buyerPseudonym: "Buyer 7" };
  const th = termsHash(terms);
  const mint = () =>
    mintToken({ action: "accept_offer", actor: "seller:h1", termsHash: th, dealId: "deal1", amountMinor: 95_00, now: T0 }, macp);
  const expect_ = { action: "accept_offer" as const, termsHash: th, dealId: "deal1", amountMinor: 95_00 };

  it("verifies once, then is spent (X28)", async () => {
    const store = memorySpentStore();
    const tok = await mint();
    expect((await verifyAndSpend(tok, expect_, T0 + 1000, macp, store)).ok).toBe(true);
    const again = await verifyAndSpend(tok, expect_, T0 + 2000, macp, store);
    expect(again).toEqual({ ok: false, reason: "already_used" });
  });

  it("rejects a token whose terms changed after approval", async () => {
    const tok = await mint();
    const changed = termsHash({ ...terms, amountMinor: 90_00 });
    expect(await verifyAndSpend(tok, { ...expect_, termsHash: changed }, T0, macp, memorySpentStore())).toEqual({
      ok: false,
      reason: "terms_mismatch",
    });
  });

  it("rejects replay on another deal or amount", async () => {
    const store = memorySpentStore();
    const tok = await mint();
    expect((await verifyAndSpend(tok, { ...expect_, dealId: "deal2" }, T0, macp, store)).ok).toBe(false);
    expect((await verifyAndSpend(tok, { ...expect_, amountMinor: 1 }, T0, macp, store)).ok).toBe(false);
    // binding failures don't burn the token, so the real one still works
    expect((await verifyAndSpend(tok, expect_, T0, macp, store)).ok).toBe(true);
  });

  it("rejects expired, forged and malformed tokens", async () => {
    const tok = await mint();
    expect(await verifyAndSpend(tok, expect_, T0 + TOKEN_TTL_MS + 1, macp, memorySpentStore())).toEqual({
      ok: false,
      reason: "expired",
    });
    const forged = await mintToken(
      { action: "accept_offer", actor: "attacker", termsHash: th, dealId: "deal1", amountMinor: 95_00, now: T0 },
      localHmacProvider("wrong-key"),
    );
    expect((await verifyAndSpend(forged, expect_, T0, macp, memorySpentStore())).ok).toBe(false);
    const [body] = tok.split(".");
    const tampered = `${Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), amountMinor: 1 }),
    ).toString("base64url")}.${tok.split(".")[1]}`;
    expect(await verifyAndSpend(tampered, expect_, T0, macp, memorySpentStore())).toEqual({ ok: false, reason: "bad_mac" });
    expect((await verifyAndSpend("nope", expect_, T0, macp, memorySpentStore())).ok).toBe(false);
  });

  it("rejects a correctly MAC'd body that isn't valid claims", async () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" })).toString("base64url");
    const sig = Buffer.from(await macp.mac(new TextEncoder().encode(body))).toString("base64url");
    expect(await verifyAndSpend(`${body}.${sig}`, expect_, T0, macp, memorySpentStore())).toEqual({
      ok: false,
      reason: "bad_claims",
    });
  });

  it("spent store tracks burned ids", async () => {
    const store = memorySpentStore();
    await verifyAndSpend(await mint(), expect_, T0, macp, store);
    expect(store.size()).toBe(1);
  });

  it("rejects a token minted for a different action", async () => {
    const tok = await mint();
    expect((await verifyAndSpend(tok, { ...expect_, action: "capture" }, T0, macp, memorySpentStore())).ok).toBe(false);
  });
});
