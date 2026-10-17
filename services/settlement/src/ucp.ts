// UCP checkout endpoints, shaped to the Alexa+ add-on checkout contract (UCP 2026-04-08):
//   POST /checkout-sessions, GET/PUT /checkout-sessions/{id}, POST .../complete, POST .../cancel
// Required headers: Authorization: Bearer, UCP-Agent, Idempotency-Key (state-changing), Request-Id (echoed).
// Responses carry Cache-Control: no-store. Amazon defines no escrow; our hold-then-release is our own layer.
import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { canonicalize } from "proof-of-handoff";
import { newId, type Store } from "./infra.ts";
import { Settlement, SettlementError } from "./settlement.ts";

export const UCP_VERSION = "2026-04-08";
export const PAYMENT_HANDLER = { id: "partner_card_on_file", name: "com.amazon.payments.stored_payment_method" } as const;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export type UcpStatus = "incomplete" | "requires_escalation" | "ready_for_complete" | "complete_in_progress" | "completed" | "canceled";

export interface UcpTotal {
  type: "subtotal" | "fees" | "tax" | "total";
  amount: number;
  display_text?: string;
}

export interface UcpSession {
  id: string;
  dealId: string;
  buyerId: string;
  status: UcpStatus;
  currency: "USD";
  line_items: Array<{
    id: string;
    item: { id: string; title: string; price: number };
    quantity: 1;
    totals: UcpTotal[];
  }>;
  totals: UcpTotal[];
  messages: Array<{ type: "info" | "warning" | "error"; code?: string; content: string }>;
  links: Array<{ type: "refund_policy" | "terms_of_service"; url: string }>;
  ucp: { version: string; capabilities: Array<{ name: string; version: string }>; payment_handlers: Array<{ id: string; name: string }> };
  continue_url?: string;
  expires_at: string;
  order?: { id: string; status: "held_until_verified_pickup" };
}

interface IdemRecord {
  bodyHash: string;
  status: number;
  response: unknown;
  expiresAt: number;
}

export interface UcpOptions {
  settlement: Settlement;
  store: Store;
  publicBaseUrl: string;
  /** Map a bearer token to a buyer id (Cognito / account linking in prod). */
  authBuyer(token: string): Promise<string | undefined>;
}

const hashBody = (b: unknown) => createHash("sha256").update(canonicalize(b ?? null)).digest("hex");

export function buildSession(s: Settlement, deal: Awaited<ReturnType<Settlement["getDeal"]>>, id: string, base: string, status: UcpStatus): UcpSession {
  const total = s.buyerTotalMinor(deal);
  return {
    id,
    dealId: deal.id,
    buyerId: deal.buyerId,
    status,
    currency: "USD",
    line_items: [
      {
        id: "li_1",
        item: { id: deal.id, title: deal.itemTitle, price: deal.amountMinor },
        quantity: 1,
        totals: [{ type: "subtotal", amount: deal.amountMinor }],
      },
    ],
    totals: [
      { type: "subtotal", amount: deal.amountMinor },
      { type: "fees", amount: deal.buyerFeeMinor, display_text: "Verified porch pickup" },
      { type: "tax", amount: 0, display_text: "No sales tax on this private sale" },
      { type: "total", amount: total },
    ],
    messages: [
      {
        type: "info",
        content: "Your payment is held, not charged, until your doorbell-verified pickup. No-show or item missing: the hold is released.",
      },
    ],
    links: [{ type: "refund_policy", url: `${base}/policies/refunds` }],
    ucp: {
      version: UCP_VERSION,
      capabilities: [{ name: "dev.ucp.shopping.checkout", version: UCP_VERSION }],
      payment_handlers: [PAYMENT_HANDLER],
    },
    expires_at: new Date(deal.createdAt + 15 * 60 * 1000).toISOString(),
  };
}

export function ucpRouter(opts: UcpOptions) {
  const { settlement: s, store } = opts;
  const app = new Hono<{ Variables: { buyerId: string } }>();
  const K = (id: string) => `checkout#${id}`;

  const json = (c: Context, body: unknown, status = 200) => {
    c.header("Cache-Control", "no-store");
    const rid = c.req.header("Request-Id");
    if (rid) c.header("Request-Id", rid);
    return c.json(body as object, status as 200);
  };
  const err = (c: Context, status: number, code: string, content: string) =>
    json(c, { messages: [{ type: "error", code, content }] }, status);

  app.get("/.well-known/ucp", (c) =>
    json(c, {
      ucp: {
        version: UCP_VERSION,
        capabilities: { "dev.ucp.shopping.checkout": { version: UCP_VERSION } },
        services: { "dev.ucp.shopping": { transport: "rest", endpoint: `${opts.publicBaseUrl}/ucp` } },
        payment_handlers: [PAYMENT_HANDLER],
        signing_keys: [],
      },
    }),
  );

  app.use("/checkout-sessions/*", async (c, next) => {
    const auth = c.req.header("Authorization");
    const buyerId = auth?.startsWith("Bearer ") ? await opts.authBuyer(auth.slice(7)) : undefined;
    if (!buyerId) {
      c.header("WWW-Authenticate", 'Bearer realm="stoop"');
      return err(c, 401, "unauthorized", "Missing or expired token");
    }
    if (!c.req.header("UCP-Agent")) return err(c, 400, "missing_ucp_agent", "UCP-Agent header is required");
    if ((c.req.method === "POST" || c.req.method === "PUT") && !c.req.header("Idempotency-Key"))
      return err(c, 400, "missing_idempotency_key", "Idempotency-Key header is required");
    c.set("buyerId", buyerId);
    await next();
  });
  app.use("/checkout-sessions", async (c, next) => {
    const auth = c.req.header("Authorization");
    const buyerId = auth?.startsWith("Bearer ") ? await opts.authBuyer(auth.slice(7)) : undefined;
    if (!buyerId) return err(c, 401, "unauthorized", "Missing or expired token");
    if (!c.req.header("UCP-Agent")) return err(c, 400, "missing_ucp_agent", "UCP-Agent header is required");
    if (!c.req.header("Idempotency-Key")) return err(c, 400, "missing_idempotency_key", "Idempotency-Key header is required");
    c.set("buyerId", buyerId);
    await next();
  });

  /** Replay-or-execute wrapper implementing the 24h idempotency contract. */
  async function idempotent(c: Context, body: unknown, run: () => Promise<{ status: number; body: unknown }>) {
    const key = `idem#${c.get("buyerId")}#${c.req.method}#${c.req.path}#${c.req.header("Idempotency-Key")}`;
    const bh = hashBody(body);
    const prior = await store.get<IdemRecord>(key);
    if (prior && prior.expiresAt > Date.now()) {
      if (prior.bodyHash !== bh) return err(c, 409, "idempotency_conflict", "Idempotency-Key reused with a different body");
      return json(c, prior.response, prior.status);
    }
    const out = await run();
    await store.put(key, { bodyHash: bh, status: out.status, response: out.body, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS } satisfies IdemRecord);
    return json(c, out.body, out.status);
  }

  const publicSession = (sess: UcpSession) => {
    const { dealId: _d, buyerId: _b, ...rest } = sess;
    return rest;
  };

  app.post("/checkout-sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { line_items?: Array<{ item?: { id?: string } }> };
    return idempotent(c, body, async () => {
      const dealId = body.line_items?.[0]?.item?.id;
      if (!dealId) return { status: 400, body: { messages: [{ type: "error", code: "item_unavailable", content: "line_items[0].item.id must be a reserved deal id" }] } };
      try {
        const id = newId("cs");
        const deal = await s.openCheckout(dealId, c.get("buyerId"), id);
        const sess = buildSession(s, deal, deal.checkoutId ?? id, opts.publicBaseUrl, "ready_for_complete");
        await store.put(K(sess.id), sess);
        return { status: 201, body: publicSession(sess) };
      } catch (e) {
        return mapError(e);
      }
    });
  });

  app.get("/checkout-sessions/:id", async (c) => {
    const sess = await store.get<UcpSession>(K(c.req.param("id")));
    if (!sess || sess.buyerId !== c.get("buyerId")) return err(c, 404, "not_found", "No such checkout session");
    return json(c, publicSession(sess));
  });

  app.put("/checkout-sessions/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { line_items?: Array<{ item?: { id?: string } }> };
    return idempotent(c, body, async () => {
      const sess = await store.get<UcpSession>(K(c.req.param("id")));
      if (!sess || sess.buyerId !== c.get("buyerId")) return { status: 404, body: { messages: [{ type: "error", code: "not_found", content: "No such checkout session" }] } };
      if (sess.status === "completed" || sess.status === "canceled")
        return { status: 409, body: { ...publicSession(sess), messages: [{ type: "error", code: "eligibility_invalid", content: `Session is ${sess.status}` }] } };
      const requested = body.line_items?.[0]?.item?.id;
      if (requested && requested !== sess.dealId)
        return { status: 400, body: { ...publicSession(sess), messages: [{ type: "error", code: "item_unavailable", content: "Line items are fixed for a reserved deal" }] } };
      // Full replace of buyer-editable fields; prices are server-authoritative and recomputed.
      const deal = await s.getDeal(sess.dealId);
      const next = buildSession(s, deal, sess.id, opts.publicBaseUrl, "ready_for_complete");
      await store.put(K(sess.id), next);
      return { status: 200, body: publicSession(next) };
    });
  });

  app.post("/checkout-sessions/:id/complete", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      payment_data?: { handler_id?: string; credential?: { token?: string } };
      expected_total?: number;
      buyer_confirmations?: {
        breakdown_shown?: boolean;
        refund_policy_shown?: boolean;
        explicit_yes?: boolean;
        voice_code?: string;
        on_screen_confirmed?: boolean;
      };
    };
    return idempotent(c, body, async () => {
      const sess = await store.get<UcpSession>(K(c.req.param("id")));
      if (!sess || sess.buyerId !== c.get("buyerId")) return { status: 404, body: { messages: [{ type: "error", code: "not_found", content: "No such checkout session" }] } };
      if (sess.status === "completed") return { status: 200, body: publicSession(sess) };
      if (sess.status !== "ready_for_complete")
        return { status: 409, body: { ...publicSession(sess), messages: [{ type: "error", code: "eligibility_invalid", content: `Session is ${sess.status}` }] } };
      const quoted = sess.totals.find((t) => t.type === "total")!.amount;
      const conf = body.buyer_confirmations ?? {};
      const result = await s.completeCheckout({
        dealId: sess.dealId,
        buyerId: sess.buyerId,
        quotedTotalMinor: quoted,
        expectedTotalMinor: body.expected_total ?? quoted,
        credential: { handler: body.payment_data?.handler_id ?? "", token: body.payment_data?.credential?.token ?? "" },
        confirmations: {
          breakdownShown: conf.breakdown_shown === true,
          refundPolicyShown: conf.refund_policy_shown === true,
          explicitYes: conf.explicit_yes === true,
          voiceCode: conf.voice_code,
          onScreenConfirmed: conf.on_screen_confirmed === true,
        },
        idempotencyKey: c.req.header("Idempotency-Key")!,
      });
      if (result.paymentError) {
        return { status: 402, body: { ...publicSession(sess), messages: [{ type: "error", code: "payment_failed", content: result.paymentError }] } };
      }
      if (result.decision.outcome !== "allow") {
        const needs = result.decision.outcome === "needs_approval";
        const updated: UcpSession = {
          ...sess,
          status: needs ? "requires_escalation" : sess.status,
          continue_url: needs ? `${opts.publicBaseUrl}/confirm/${sess.id}` : undefined,
          messages: [{ type: "error", code: needs ? "eligibility_invalid" : "payment_failed", content: result.decision.reasons.join(", ") }],
        };
        if (needs) await store.put(K(sess.id), { ...updated, status: "ready_for_complete" });
        return { status: needs ? 200 : 422, body: publicSession(updated) };
      }
      const done: UcpSession = {
        ...sess,
        status: "completed",
        order: { id: sess.dealId, status: "held_until_verified_pickup" },
        messages: [{ type: "info", content: "Funds held. Release happens only after your doorbell-verified pickup and a short inspection window." }],
      };
      await store.put(K(sess.id), done);
      return { status: 200, body: publicSession(done) };
    });
  });

  app.post("/checkout-sessions/:id/cancel", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return idempotent(c, body, async () => {
      const sess = await store.get<UcpSession>(K(c.req.param("id")));
      if (!sess || sess.buyerId !== c.get("buyerId")) return { status: 404, body: { messages: [{ type: "error", code: "not_found", content: "No such checkout session" }] } };
      if (sess.status === "completed") return { status: 409, body: { ...publicSession(sess), messages: [{ type: "error", code: "eligibility_invalid", content: "Already completed" }] } };
      await s.abandonCheckout(sess.dealId);
      const canceled: UcpSession = { ...sess, status: "canceled", messages: [{ type: "info", content: "Checkout canceled. The item is available again." }] };
      await store.put(K(sess.id), canceled);
      return { status: 200, body: publicSession(canceled) };
    });
  });

  return app;
}

function mapError(e: unknown): { status: number; body: unknown } {
  if (e instanceof SettlementError) {
    const code = e.code === "already_accepted" || e.code === "not_live" ? "item_unavailable" : "eligibility_invalid";
    return { status: e.status, body: { messages: [{ type: "error", code, content: e.message }] } };
  }
  throw e;
}
