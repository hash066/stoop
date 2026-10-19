// Buyer-side MCP server: any buyer's assistant (a second Alexa+, Claude, ChatGPT...) can discover,
// negotiate and pay. Checkout goes through Settlement's UCP endpoints (the Alexa+ checkout contract).
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SettlementError } from "@stoop/settlement";
import { elicitUrl, errorResult, result, supportsUrlElicitation, withApproval, type PendingActions } from "./approvals.ts";
import { uiMeta } from "./cards.ts";
import type { BuyerActor, StoopContext } from "./context.ts";
import { registerCardResources, registerConfirmAction, timeline } from "./seller.ts";
import { registerWatchHandoff, TASKS_CAPABILITY } from "./tasks.ts";
import type { TaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import type { Deal } from "@stoop/settlement";

const $ = (minor: number) => `$${(minor / 100).toFixed(minor % 100 ? 2 : 0)}`;

const ORDER_SPEECH: Record<string, string> = {
  AGREED: "The owner accepted. Say check out to pay.",
  CHECKOUT_OPEN: "Your checkout is open. Say yes to pay.",
  FUNDS_HELD: "Your payment is held. Your pickup pass is coming.",
  PASS_ISSUED: "Your payment is held and your pickup pass is ready.",
  WINDOW_OPEN: "Your pickup window is open. Tap I'm here on the pass when you arrive.",
  INSPECTION: "Pickup verified. Tap got it on your pass, or the payment releases automatically in two hours.",
  CLOSED: "All done. Enjoy it!",
  VOIDED: "This purchase was cancelled and your hold was released.",
};

export function createBuyerServer(ctx: StoopContext, actor: BuyerActor, pending: PendingActions, taskStore?: TaskStore): McpServer {
  const server = new McpServer(
    { name: "stoop-buyer", version: "0.1.0", title: "Stoop for buyers" },
    { capabilities: { logging: {}, ...(taskStore ? { tasks: TASKS_CAPABILITY } : {}) }, taskStore },
  );
  const s = ctx.settlement;
  const who = `buyer:${actor.buyerId}`;
  registerCardResources(server, ctx);

  async function myDeal(dealId?: string) {
    if (dealId) {
      const d = await s.getDeal(dealId);
      return d.buyerId === actor.buyerId ? d : undefined;
    }
    const ds = (await s.dealsForBuyer(actor.buyerId)).sort((a, b) => b.updatedAt - a.updatedAt);
    return ds.find((d) => !["CLOSED", "VOIDED", "CHECKOUT_ABANDONED"].includes(d.state)) ?? ds[0];
  }

  // ------------------------------------------------------------ search_listings
  server.registerTool(
    "search_listings",
    {
      title: "Find secondhand items nearby",
      description: "Search items for sale with contactless porch pickup. Location is ZIP-level only.",
      inputSchema: z.object({
        query: z.string().min(1),
        zip: z.string().optional(),
        radiusMiles: z.number().positive().max(50).optional(),
        maxPriceDollars: z.number().positive().optional(),
      }),
      outputSchema: z.object({
        kind: z.literal("search_results"),
        results: z.array(z.object({ listingId: z.string(), title: z.string(), askMinor: z.number(), zip: z.string(), photoUrl: z.string().optional() })),
      }),
      annotations: { readOnlyHint: true },
      _meta: uiMeta(ctx.cards, "listing-card"),
    },
    async ({ query, zip, maxPriceDollars }) => {
      const found = await s.searchListings({ query, zip, maxPriceMinor: maxPriceDollars ? Math.round(maxPriceDollars * 100) : undefined, limit: 5 });
      const results = found.map((l) => ({ listingId: l.listingId, title: l.title, askMinor: l.askMinor, zip: l.zip, photoUrl: l.photoUrls[0] }));
      if (!results.length) return result(`I didn't find any ${query} nearby right now.`, { kind: "search_results", results: [] }, ctx.cards, "listing-card");
      const top = results.slice(0, 3);
      const speech =
        results.length === 1
          ? `I found one: a ${top[0]!.title} for ${$(top[0]!.askMinor)}, porch pickup in ${top[0]!.zip}. Want to make an offer?`
          : `I found ${results.length}. ${top.map((r, i) => `${i === 0 ? "First" : i === 1 ? "Second" : "Third"}, a ${r.title} for ${$(r.askMinor)}`).join(". ")}. Want to make an offer on the first one?`;
      return result(speech, { kind: "search_results", results }, ctx.cards, "listing-card");
    },
  );

  // ------------------------------------------------------------ get_listing
  server.registerTool(
    "get_listing",
    {
      title: "Item details",
      description: "Details for one listing: description, asking price, pickup policy.",
      inputSchema: z.object({ listingId: z.string() }),
      annotations: { readOnlyHint: true },
      _meta: uiMeta(ctx.cards, "listing-card"),
    },
    async ({ listingId }) => {
      try {
        const l = s.publicListing(await s.getListing(listingId));
        return result(`${l.title}, asking ${$(l.askMinor)}. ${l.pickup}`, { kind: "search_results", results: [{ listingId: l.listingId, title: l.title, askMinor: l.askMinor, zip: l.zip, photoUrl: l.photoUrls[0] }] }, ctx.cards, "listing-card");
      } catch {
        return errorResult("That item isn't available.", "listing_not_found");
      }
    },
  );

  async function negotiate(listingId: string, text: string, offerMinor?: number) {
    let n;
    try {
      n = await s.openNegotiation(listingId, actor.buyerId);
    } catch (e) {
      if (e instanceof SettlementError) return errorResult(e.humanMessage, e.code);
      throw e;
    }
    const r = await ctx.negotiator.turn({ negotiationId: n.id, buyerText: text, offerMinor });
    const neg = await s.getNegotiation(n.id);
    const listing = await s.getListing(listingId);
    // A live model often already promises an update; don't say it twice
    const promisesUpdate = /\b(let you know|update you|get back to you|keep you posted)\b/i.test(r.reply);
    const tail =
      r.action === "awaiting_seller"
        ? promisesUpdate
          ? ""
          : " I'll let you know when the owner answers."
        : r.action === "accepted"
          ? " Say check out to pay. Your money is held until the pickup is verified."
          : "";
    return result(`The seller's assistant says: ${r.reply}${tail}`, {
      kind: "negotiation",
      negotiationId: n.id,
      listingId,
      title: listing.title,
      askMinor: listing.askMinor,
      action: r.action,
      counterMinor: r.counterMinor,
      dealId: r.dealId,
      reply: r.reply,
      ladder: neg.offers.map((o) => ({ by: o.by, amountMinor: o.amountMinor, at: o.at })),
      signals: r.signals,
    }, ctx.cards, "negotiation-live");
  }

  // ------------------------------------------------------------ make_offer
  server.registerTool(
    "make_offer",
    {
      title: "Make an offer",
      description: "Offer a price on a listing. The seller's AI assistant answers within the owner's rules.",
      inputSchema: z.object({ listingId: z.string(), amountDollars: z.number().positive(), message: z.string().max(500).optional() }),
      _meta: uiMeta(ctx.cards, "negotiation-live"),
    },
    async ({ listingId, amountDollars, message }) => negotiate(listingId, message ?? `I'd like to offer ${$(Math.round(amountDollars * 100))}.`, Math.round(amountDollars * 100)),
  );

  // ------------------------------------------------------------ ask_seller
  server.registerTool(
    "ask_seller",
    {
      title: "Ask the seller",
      description: "Send a question or message to the seller's AI assistant about a listing.",
      inputSchema: z.object({ listingId: z.string(), message: z.string().min(1).max(800) }),
      _meta: uiMeta(ctx.cards, "negotiation-live"),
    },
    async ({ listingId, message }) => negotiate(listingId, message),
  );

  // ------------------------------------------------------------ checkout (UCP)
  server.registerTool(
    "checkout",
    {
      title: "Pay for an accepted deal",
      description: "Pay for an accepted deal. Shows the full price breakdown and refund policy and asks for confirmation; over $100 also needs your 4-digit purchase code. Payment is held until the pickup is verified.",
      inputSchema: z.object({ dealId: z.string().optional() }),
      _meta: uiMeta(ctx.cards, "deal-approval"),
    },
    async ({ dealId }, extra) => {
      const deal = await myDeal(dealId);
      if (!deal || !["AGREED", "CHECKOUT_OPEN"].includes(deal.state)) return errorResult("There's no accepted deal waiting for payment.", "no_deal");
      const created = await ctx.ucp.request("POST", "/checkout-sessions", actor.token, { line_items: [{ item: { id: deal.id } }] }, `create-${deal.id}`);
      if (created.status !== 201 && created.status !== 200) return errorResult(created.json?.messages?.[0]?.content ?? "Checkout isn't available.", "checkout_failed");
      const session = created.json as { id: string; totals: Array<{ type: string; amount: number }>; links: Array<{ url: string }> };
      const total = session.totals.find((t) => t.type === "total")!.amount;
      const fee = session.totals.find((t) => t.type === "fees")?.amount ?? 0;
      const high = total > 100_00;
      const summary =
        `Pay ${$(total)} for the ${deal.itemTitle}? That's ${$(deal.amountMinor)} for the item plus ${$(fee)} for verified pickup, and no tax. ` +
        "Refund policy: your payment is held, not charged, until your pickup is verified; if it isn't verified you're never charged.";
      const complete = async (voiceCode?: string) => {
        const res = await ctx.ucp.request(
          "POST",
          `/checkout-sessions/${session.id}/complete`,
          actor.token,
          {
            payment_data: { handler_id: "partner_card_on_file", credential: { token: actor.walletToken } },
            expected_total: total,
            buyer_confirmations: { breakdown_shown: true, refund_policy_shown: true, explicit_yes: true, voice_code: voiceCode, on_screen_confirmed: true },
          },
          `complete-${session.id}-${voiceCode ?? "nocode"}`,
        );
        const status = res.json?.status;
        if (status === "completed") {
          return result(`Done. ${$(total)} is held, not charged. Your pickup pass is on its way.`, { kind: "deal", dealId: deal.id, state: "FUNDS_HELD", amountMinor: deal.amountMinor, totalMinor: total, ucpSessionId: session.id }, ctx.cards, "handoff-timeline");
        }
        const msg = res.json?.messages?.[0]?.content ?? "Payment didn't go through.";
        if (/voice_code/.test(msg)) return errorResult("That purchase code didn't match, so nothing was charged.", "voice_code_invalid");
        return errorResult(res.status === 402 ? "Your card was declined, so nothing was charged." : `Payment didn't go through: ${msg}`, "payment_failed");
      };
      return withApproval({
        server,
        extra,
        pending,
        actor: who,
        summary,
        voiceCode: high,
        cards: ctx.cards,
        card: "deal-approval",
        cardData: { kind: "checkout", dealId: deal.id, title: deal.itemTitle, itemMinor: deal.amountMinor, feeMinor: fee, taxMinor: 0, totalMinor: total, refundPolicyUrl: session.links[0]?.url, needsVoiceCode: high },
        onApprove: ({ voiceCode }) => complete(voiceCode),
        onDecline: async () => {
          await ctx.ucp.request("POST", `/checkout-sessions/${session.id}/cancel`, actor.token, {}, `cancel-${session.id}`);
          return result("Okay, I cancelled the checkout. The item is available again.", { kind: "checkout_cancelled", dealId: deal.id });
        },
      });
    },
  );

  // ------------------------------------------------------------ get_pickup_pass
  server.registerTool(
    "get_pickup_pass",
    {
      title: "Get my pickup pass",
      description: "Open the pickup pass on your phone. Pickup details appear on the pass only during your window.",
      inputSchema: z.object({ dealId: z.string().optional() }),
    },
    async ({ dealId }, extra) => {
      const deal = await myDeal(dealId);
      if (!deal) return errorResult("You don't have a purchase yet.", "no_deal");
      if (!deal.passId) return errorResult("Your pickup pass is issued once your payment is held.", "no_pass_yet");
      const url = `${ctx.passBaseUrl.replace(/\/$/, "")}/p/${deal.passId}`;
      if (supportsUrlElicitation(server)) {
        try {
          const action = await elicitUrl(extra, "Open your Stoop pickup pass on your phone. Your one-time code is in your email.", url);
          return result(
            action === "accept" ? "Your pickup pass is open. Pickup details appear there when your window starts." : "No problem. The pass is also in your email.",
            { kind: "pass", dealId: deal.id, delivered: action === "accept" ? "url_elicitation" : "email" },
          );
        } catch {
          /* fall through to email */
        }
      }
      // Never put the bearer pass link into the assistant's transcript.
      ctx.bus.emit({ type: "email_outbox", at: ctx.now(), to: "buyer", subject: "Your Stoop pickup pass", body: `Pass: ${url}`, dealId: deal.id });
      return result("I emailed your pickup pass. Pickup details appear on it when your window starts.", { kind: "pass", dealId: deal.id, delivered: "email" });
    },
  );

  // ------------------------------------------------------------ order_status
  server.registerTool(
    "order_status",
    {
      title: "Where's my order",
      description: "Status of your purchase: payment hold, pickup window, verification, inspection.",
      inputSchema: z.object({ dealId: z.string().optional() }),
      annotations: { readOnlyHint: true },
      _meta: uiMeta(ctx.cards, "handoff-timeline"),
    },
    async ({ dealId }) => {
      const deal = await myDeal(dealId);
      if (!deal) return result("You don't have any purchases yet.", { kind: "status", deal: null });
      return statusResult(deal);
    },
  );
  const stateSpeech = (deal: Deal) => ORDER_SPEECH[deal.state] ?? `Your purchase is ${deal.state.toLowerCase().replace(/_/g, " ")}.`;
  const statusResult = async (deal: Deal) => result(stateSpeech(deal), await timeline(ctx, deal), ctx.cards, "handoff-timeline");
  if (taskStore) registerWatchHandoff(server, ctx, { resolveDeal: myDeal, speech: stateSpeech, snapshot: statusResult });

  registerConfirmAction(server, pending, who);
  return server;
}

export const newIdempotencyKey = () => randomUUID();
