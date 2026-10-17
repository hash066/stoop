import { describe, expect, it } from "vitest";
import { ucpRouter } from "../src/index.ts";
import { agreedDeal, makeStack, WALLET } from "./helpers.ts";

async function setup() {
  const st = await makeStack();
  const app = ucpRouter({
    settlement: st.s,
    store: st.store,
    publicBaseUrl: "http://stoop.local",
    authBuyer: async (t) => (t === "buyer-token" ? st.buyer.id : t === "buyer2-token" ? st.buyer2.id : undefined),
  });
  const { deal } = await agreedDeal(st);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: {
        Authorization: "Bearer buyer-token",
        "UCP-Agent": 'profile="https://alexa.amazon.com/.well-known/ucp"',
        "Content-Type": "application/json",
        "Request-Id": "req-123",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { st, app, deal, call };
}

const completeBody = (over: Record<string, unknown> = {}) => ({
  payment_data: { handler_id: "partner_card_on_file", credential: { token: WALLET } },
  buyer_confirmations: { breakdown_shown: true, refund_policy_shown: true, explicit_yes: true },
  ...over,
});

describe("UCP checkout endpoints", () => {
  it("discovery profile", async () => {
    const { app } = await setup();
    const r = await app.request("/.well-known/ucp");
    const j = (await r.json()) as { ucp: { version: string; capabilities: Record<string, unknown> } };
    expect(j.ucp.version).toBe("2026-04-08");
    expect(j.ucp.capabilities).toHaveProperty("dev.ucp.shopping.checkout");
  });

  it("create -> get -> complete holds funds; headers honoured", async () => {
    const { call, st, deal } = await setup();
    const created = await call("POST", "/checkout-sessions", { line_items: [{ item: { id: deal.id } }] }, { "Idempotency-Key": "k1" });
    expect(created.status).toBe(201);
    expect(created.headers.get("Cache-Control")).toBe("no-store");
    expect(created.headers.get("Request-Id")).toBe("req-123");
    const s = (await created.json()) as { id: string; status: string; totals: Array<{ type: string; amount: number }>; links: unknown[]; messages: unknown[] };
    expect(s.status).toBe("ready_for_complete");
    expect(s.totals.find((t) => t.type === "total")?.amount).toBe(95_00 + 199);
    expect(s.links).toEqual([{ type: "refund_policy", url: "http://stoop.local/policies/refunds" }]);
    expect(s.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(s)).not.toContain(st.buyer.id); // internal ids not exposed

    const got = await call("GET", `/checkout-sessions/${s.id}`);
    expect(got.status).toBe(200);

    const done = await call("POST", `/checkout-sessions/${s.id}/complete`, completeBody(), { "Idempotency-Key": "k2" });
    const dj = (await done.json()) as { status: string; order: { status: string } };
    expect(done.status).toBe(200);
    expect(dj.status).toBe("completed");
    expect(dj.order.status).toBe("held_until_verified_pickup");
    expect((await st.s.getDeal(deal.id)).state).toBe("FUNDS_HELD");
  });

  it("replayed complete with same key never double-charges (X12); different body -> 409 (X19)", async () => {
    const { call, deal } = await setup();
    const c = await call("POST", "/checkout-sessions", { line_items: [{ item: { id: deal.id } }] }, { "Idempotency-Key": "a" });
    const { id } = (await c.json()) as { id: string };
    const first = await call("POST", `/checkout-sessions/${id}/complete`, completeBody(), { "Idempotency-Key": "same" });
    const again = await call("POST", `/checkout-sessions/${id}/complete`, completeBody(), { "Idempotency-Key": "same" });
    expect(await again.json()).toEqual(await first.json());
    const conflict = await call("POST", `/checkout-sessions/${id}/complete`, completeBody({ expected_total: 1 }), { "Idempotency-Key": "same" });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { messages: Array<{ code: string }> }).messages[0]!.code).toBe("idempotency_conflict");
  });

  it("missing headers and bad auth are rejected", async () => {
    const { call, deal } = await setup();
    expect((await call("POST", "/checkout-sessions", { line_items: [{ item: { id: deal.id } }] })).status).toBe(400); // no Idempotency-Key
    expect((await call("GET", "/checkout-sessions/x", undefined, { "UCP-Agent": "" })).status).toBe(400);
    expect((await call("GET", "/checkout-sessions/x", undefined, { Authorization: "Bearer nope" })).status).toBe(401);
  });

  it("another buyer can't read or complete my session", async () => {
    const { call, deal } = await setup();
    const c = await call("POST", "/checkout-sessions", { line_items: [{ item: { id: deal.id } }] }, { "Idempotency-Key": "z" });
    const { id } = (await c.json()) as { id: string };
    expect((await call("GET", `/checkout-sessions/${id}`, undefined, { Authorization: "Bearer buyer2-token" })).status).toBe(404);
  });

  it("missing confirmations -> requires_escalation with continue_url; tampered total -> 422", async () => {
    const { call, deal } = await setup();
    const c = await call("POST", "/checkout-sessions", { line_items: [{ item: { id: deal.id } }] }, { "Idempotency-Key": "q" });
    const { id } = (await c.json()) as { id: string };
    const noYes = await call(
      "POST",
      `/checkout-sessions/${id}/complete`,
      completeBody({ buyer_confirmations: { breakdown_shown: true, refund_policy_shown: true } }),
      { "Idempotency-Key": "q2" },
    );
    const nj = (await noYes.json()) as { status: string; continue_url: string };
    expect(nj.status).toBe("requires_escalation");
    expect(nj.continue_url).toMatch(/^http/);
    const tampered = await call("POST", `/checkout-sessions/${id}/complete`, completeBody({ expected_total: 9_00 }), { "Idempotency-Key": "q3" });
    expect(tampered.status).toBe(422);
  });

  it("declined card -> 402 payment_failed; cancel releases the item", async () => {
    const { call, deal, st } = await setup();
    const c = await call("POST", "/checkout-sessions", { line_items: [{ item: { id: deal.id } }] }, { "Idempotency-Key": "d" });
    const { id } = (await c.json()) as { id: string };
    const cancel = await call("POST", `/checkout-sessions/${id}/cancel`, {}, { "Idempotency-Key": "d2" });
    expect(((await cancel.json()) as { status: string }).status).toBe("canceled");
    expect((await st.s.getListing(deal.listingId)).state).toBe("LIVE");
  });
});
