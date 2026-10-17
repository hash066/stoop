// Seller-side MCP server (the household's assistant, e.g. Alexa+). One tool per customer intent.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inSentence } from "@stoop/shared";
import { SettlementError, type Deal, type Item, type Listing } from "@stoop/settlement";
import { errorResult, result, withApproval, type PendingActions } from "./approvals.ts";
import { MCP_APP_MIME, RESOURCE_UI_META, uiMeta } from "./cards.ts";
import type { SellerActor, StoopContext } from "./context.ts";
import { registerWatchHandoff, TASKS_CAPABILITY } from "./tasks.ts";
import type { TaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";

const $ = (minor: number) => `$${(minor / 100).toFixed(minor % 100 ? 2 : 0)}`;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

export function matchByName<T extends { title: string }>(items: T[], name: string, extra: (t: T) => string = () => ""): T | undefined {
  const n = norm(name);
  if (!n) return undefined;
  const words = n.split(" ").filter((w) => w.length > 2);
  let best: { t: T; score: number } | undefined;
  for (const t of items) {
    const hay = norm(`${t.title} ${extra(t)}`);
    const score = hay.includes(n) ? 100 : words.filter((w) => hay.includes(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { t, score };
  }
  return best?.t;
}

export function registerCardResources(server: McpServer, ctx: StoopContext) {
  for (const card of ctx.cards.all()) {
    server.registerResource(
      card.name,
      card.uri,
      { title: `Stoop ${card.name}`, mimeType: MCP_APP_MIME, _meta: RESOURCE_UI_META },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: MCP_APP_MIME, text: card.html, _meta: RESOURCE_UI_META }] }),
    );
  }
}

const STATE_SPEECH: Record<string, string> = {
  AGREED: "The buyer agreed and is checking out.",
  CHECKOUT_OPEN: "The buyer is checking out.",
  FUNDS_HELD: "The buyer's payment is held. I'm sending their pickup pass.",
  PASS_ISSUED: "Payment is held and the buyer has their pickup pass.",
  WINDOW_OPEN: "The pickup window is open. I'm watching the porch.",
  STILL_THERE: "The buyer checked in, but the item still looks like it's on the porch.",
  INSPECTION: "Pickup verified by your doorbell. The buyer has a short inspection window, then the money is released.",
  CLOSED: "Sold and paid.",
  VOIDED: "That sale didn't happen, so the buyer's hold was released.",
  REVIEW: "I couldn't fully verify the pickup. If the buyer has it, say confirm pickup.",
  DEGRADED: "Your camera wasn't available, so I need you and the buyer to confirm the pickup.",
  DISPUTE: "The buyer reported a problem. I've saved the evidence for review.",
  NO_SHOW: "The buyer didn't show up, so their hold was released and your item is listed again.",
};

export function createSellerServer(ctx: StoopContext, actor: SellerActor, pending: PendingActions, taskStore?: TaskStore): McpServer {
  const server = new McpServer(
    { name: "stoop-seller", version: "0.1.0", title: "Stoop for sellers" },
    { capabilities: { logging: {}, ...(taskStore ? { tasks: TASKS_CAPABILITY } : {}) }, taskStore },
  );
  const s = ctx.settlement;
  const who = `seller:${actor.householdId}`;
  registerCardResources(server, ctx);

  const items = () => s.itemsForHousehold(actor.householdId);
  const listings = () => s.listingsForHousehold(actor.householdId);
  async function latestDeal(dealId?: string): Promise<Deal | undefined> {
    if (dealId) return s.getDeal(dealId);
    const ds = (await s.dealsForHousehold(actor.householdId)).sort((a, b) => b.updatedAt - a.updatedAt);
    return ds.find((d) => !["CLOSED", "VOIDED", "CHECKOUT_ABANDONED"].includes(d.state)) ?? ds[0];
  }

  // ------------------------------------------------------------ appraise_photos
  server.registerTool(
    "appraise_photos",
    {
      title: "Price my things",
      description: "Identify and price the items in the household's latest photo sweep. Checks recalls and banned items.",
      inputSchema: z.object({ useLastSweep: z.boolean().optional().describe("Use the most recent photo sweep (default true)") }),
      outputSchema: z.object({
        kind: z.literal("appraisal"),
        totalListMinor: z.number(),
        items: z.array(
          z.object({
            itemId: z.string(),
            title: z.string(),
            condition: z.string(),
            listMinor: z.number(),
            quickSaleMinor: z.number(),
            comps: z.number(),
            confidence: z.string(),
            blocked: z.boolean(),
            blockedReason: z.string().optional(),
            alternative: z.string().optional(),
            photoUrl: z.string().optional(),
          }),
        ),
        unidentified: z.array(z.string()),
        compsSource: z.string(),
        identifier: z.string(),
      }),
      annotations: { readOnlyHint: false, idempotentHint: false },
      _meta: uiMeta(ctx.cards, "appraisal-grid"),
    },
    async () => {
      const photos = await ctx.photos.lastSweep(actor.householdId);
      if (!photos.length) return errorResult("I don't see any photos yet. Take a few pictures of what you want to sell.", "no_photos");
      const { items: appraised, unidentified } = await ctx.appraiser.appraise(photos.map((p) => ({ name: p.name, bytes: p.bytes, mime: p.mime, hint: p.hint })));
      const out = [];
      let compsSource = "none";
      for (const a of appraised) {
        compsSource = a.compsSource;
        const photo = photos.find((p) => p.name === a.photoName);
        const item = await s.createItem({
          householdId: actor.householdId,
          title: a.identification.title,
          category: a.identification.category,
          condition: a.identification.condition,
          photoHashes: [a.photoHash],
          photoUrls: photo ? [photo.url] : [],
          priceBand: a.priceBand,
          comps: a.comps,
          compsConfidence: a.compsConfidence,
          recall: a.recall,
        });
        out.push({
          itemId: item.id,
          title: item.title,
          condition: item.condition,
          listMinor: a.priceBand.listMinor,
          quickSaleMinor: a.priceBand.quickSaleMinor,
          comps: a.comps.length,
          confidence: a.compsConfidence,
          blocked: a.recall.blocked,
          blockedReason: a.recall.reason,
          alternative: a.recall.alternative,
          photoUrl: photo?.url,
        });
      }
      const sellable = out.filter((i) => !i.blocked);
      const total = sellable.reduce((t, i) => t + i.listMinor, 0);
      const blocked = out.find((i) => i.blocked);
      // Say "can't be sold" once: skip our lead-in when the recall reason already says it
      const reasonSaysIt = /can.?t be (re)?sold/i.test(blocked?.blockedReason ?? "");
      const speech = (
        `I found ${sellable.length} thing${sellable.length === 1 ? "" : "s"} you can sell, worth about ${$(total)} together.` +
        (blocked ? ` ${reasonSaysIt ? "" : `The ${inSentence(blocked.title)} can't be sold. `}${blocked.blockedReason ?? ""} ${blocked.alternative ?? ""}` : "")
      ).trim();
      ctx.bus.emit({ type: "appraisal_done", at: ctx.now(), householdId: actor.householdId, totalMinor: total, count: out.length });
      return result(speech, { kind: "appraisal", totalListMinor: total, items: out, unidentified, compsSource, identifier: ctx.appraiser.identifierName }, ctx.cards, "appraisal-grid");
    },
  );

  // ------------------------------------------------------------ my_items
  server.registerTool(
    "my_items",
    {
      title: "What am I selling",
      description: "The household's appraised items with prices and whether each is listed, reserved or sold. Read-only; doesn't re-appraise.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      _meta: uiMeta(ctx.cards, "appraisal-grid"),
    },
    async () => {
      const [all, ls] = await Promise.all([items(), listings()]);
      if (!all.length) return result("Nothing appraised yet. Take a few photos of what you want to sell.", { kind: "appraisal", totalListMinor: 0, items: [], unidentified: [] }, ctx.cards, "appraisal-grid");
      const out = all.map((it) => {
        const l = ls.filter((x) => x.itemId === it.id).sort((a, b) => b.updatedAt - a.updatedAt)[0];
        return {
          itemId: it.id,
          title: it.title,
          condition: it.condition,
          listMinor: l?.askMinor ?? it.priceBand.listMinor,
          quickSaleMinor: it.priceBand.quickSaleMinor,
          comps: it.comps.length,
          confidence: it.compsConfidence,
          blocked: it.recall.blocked,
          blockedReason: it.recall.reason,
          alternative: it.recall.alternative,
          photoUrl: it.photoUrls[0],
          listingState: l?.state,
        };
      });
      const sellable = out.filter((i) => !i.blocked);
      const total = sellable.reduce((t, i) => t + i.listMinor, 0);
      const live = out.filter((i) => i.listingState === "LIVE").length;
      const speech = `You have ${sellable.length} thing${sellable.length === 1 ? "" : "s"} worth about ${$(total)}${live ? `, ${live} listed now` : ""}.`;
      return result(speech, { kind: "appraisal", totalListMinor: total, items: out, unidentified: [] }, ctx.cards, "appraisal-grid");
    },
  );

  // ------------------------------------------------------------ list_items
  server.registerTool(
    "list_items",
    {
      title: "Sell items",
      description: "Put one or more appraised items up for sale by name (e.g. ['stroller','bike']). Asks the owner to approve before publishing.",
      inputSchema: z.object({
        items: z.array(z.string().min(1)).min(1).max(5).describe("Item names or ids from the latest appraisal"),
        askDollars: z.number().positive().optional().describe("Override asking price (only when listing a single item)"),
      }),
      _meta: uiMeta(ctx.cards, "listing-card"),
    },
    async ({ items: names, askDollars }, extra) => {
      const all = await items();
      const resolved: Item[] = [];
      const missing: string[] = [];
      const blocked: Item[] = [];
      for (const n of names) {
        const it = all.find((i) => i.id === n) ?? matchByName([...all].reverse(), n, (i) => i.category);
        if (!it) missing.push(n);
        else if (it.recall.blocked) blocked.push(it);
        else if (!resolved.some((r) => r.id === it.id)) resolved.push(it);
      }
      if (!resolved.length) {
        const why = blocked.length ? `${blocked[0]!.recall.reason} ${blocked[0]!.recall.alternative ?? ""}` : `I couldn't find ${missing.join(" or ")} in your photos.`;
        return errorResult(why, blocked.length ? "blocked_recall" : "item_not_found");
      }
      const existing = await listings();
      const drafts: Listing[] = [];
      for (const it of resolved) {
        const reuse = existing.find((l) => l.itemId === it.id && (l.state === "AWAITING_SELLER_OK" || l.state === "RELISTED"));
        const live = existing.find((l) => l.itemId === it.id && l.state === "LIVE");
        if (live) continue;
        drafts.push(reuse ?? (await s.draftListing(it.id, resolved.length === 1 && askDollars ? { askMinor: Math.round(askDollars * 100) } : {})));
      }
      if (!drafts.length) return result("Those are already for sale.", { kind: "listings", listings: [] }, ctx.cards, "listing-card");
      const approvals = await Promise.all(drafts.map((d) => s.requestApproval(s.publishTerms(d), who, `Publish ${d.title} at ${$(d.askMinor)}`)));
      const summary = `List ${drafts.map((d) => `the ${d.title} at ${$(d.askMinor)}`).join(" and ")}? Pickup is contactless from your porch, verified by your doorbell.`;
      const cardData = { kind: "listings", listings: drafts.map((d) => ({ listingId: d.id, title: d.title, askMinor: d.askMinor, photoUrl: d.photoUrls[0], state: "AWAITING_SELLER_OK" })) };
      return withApproval({
        server,
        extra,
        pending,
        actor: who,
        summary,
        cards: ctx.cards,
        card: "listing-card",
        cardData,
        onApprove: async () => {
          const live: Listing[] = [];
          for (let i = 0; i < drafts.length; i++) {
            const { token } = await s.resolveApproval(approvals[i]!.id, true, who);
            live.push(await s.publishListing(drafts[i]!.id, token!, who));
          }
          const speech = `Done. ${live.map((l) => `Your ${inSentence(l.title)} is live at ${$(l.askMinor)}`).join(". ")}. I'll tell you when offers come in.${blocked.length ? ` I skipped the ${inSentence(blocked[0]!.title)} because it can't be resold.` : ""}`;
          return result(speech, { kind: "listings", listings: live.map((l) => ({ listingId: l.id, title: l.title, askMinor: l.askMinor, photoUrl: l.photoUrls[0], state: l.state })) }, ctx.cards, "listing-card");
        },
        onDecline: async () => {
          for (const a of approvals) await s.resolveApproval(a.id, false, who).catch(() => undefined);
          return result("Okay, nothing was listed.", { kind: "listings", listings: [] });
        },
      });
    },
  );

  // ------------------------------------------------------------ set_mandate
  server.registerTool(
    "set_mandate",
    {
      title: "Set my lowest price",
      description: "Set the lowest price the selling assistant may accept for an item (kept secret from buyers), and optionally a price above which it may accept without asking.",
      inputSchema: z.object({
        item: z.string().min(1).describe("Item name or listing id"),
        floorDollars: z.number().positive(),
        autoAcceptAboveDollars: z.number().positive().optional(),
        days: z.number().int().min(1).max(30).optional(),
      }),
    },
    async ({ item, floorDollars, autoAcceptAboveDollars, days }, extra) => {
      const ls = (await listings()).filter((l) => ["LIVE", "AWAITING_SELLER_OK", "RELISTED"].includes(l.state));
      const l = ls.find((x) => x.id === item) ?? matchByName(ls, item);
      if (!l) return errorResult(`I couldn't find a listing for ${item}.`, "listing_not_found");
      const floorMinor = Math.round(floorDollars * 100);
      if (floorMinor > l.askMinor) return errorResult(`Your lowest price is above the asking price of ${$(l.askMinor)}.`, "floor_above_ask");
      const mandate = {
        listingId: l.id,
        floorMinor,
        autoAcceptAboveMinor: autoAcceptAboveDollars ? Math.round(autoAcceptAboveDollars * 100) : undefined,
        expiresAt: ctx.now() + (days ?? 7) * 86_400_000,
      };
      const summary = `Never sell the ${inSentence(l.title)} below ${$(floorMinor)}. ${mandate.autoAcceptAboveMinor ? `I may accept ${$(mandate.autoAcceptAboveMinor)} or more without asking.` : "I'll always ask you before accepting."} Buyers never see this number.`;
      const approval = await s.requestApproval(s.mandateTerms(mandate), who, summary);
      return withApproval({
        server,
        extra,
        pending,
        actor: who,
        summary,
        cards: ctx.cards,
        card: "listing-card",
        cardData: { kind: "mandate", listingId: l.id, title: l.title, askMinor: l.askMinor },
        onApprove: async () => {
          const { token } = await s.resolveApproval(approval.id, true, who);
          await s.setMandate(mandate, token!, who);
          return result(`Got it. I won't go below ${$(floorMinor)} on the ${inSentence(l.title)}, and buyers will never know that number.`, {
            kind: "mandate",
            listingId: l.id,
            title: l.title,
            askMinor: l.askMinor,
          });
        },
        onDecline: async () => {
          await s.resolveApproval(approval.id, false, who).catch(() => undefined);
          return result("Okay, no lowest price set. I'll ask you about every offer.", { kind: "mandate", listingId: l.id, title: l.title, askMinor: l.askMinor });
        },
      });
    },
  );

  // ------------------------------------------------------------ review_offers
  server.registerTool(
    "review_offers",
    {
      title: "What offers do I have",
      description: "List offers waiting for the owner's decision (at most five).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      _meta: uiMeta(ctx.cards, "deal-approval"),
    },
    async () => {
      const ls = await listings();
      const offers = [];
      for (const l of ls) {
        for (const n of await s.negotiationsFor(l.id)) {
          if (n.state !== "AGREED_PENDING_SELLER" || !n.pendingApprovalId) continue;
          const appr = await s.getApproval(n.pendingApprovalId);
          if (appr.status !== "pending") continue;
          const buyer = await s.buyerPublic(n.buyerId);
          offers.push({ approvalId: appr.id, listingId: l.id, title: l.title, amountMinor: n.pendingAmountMinor!, askMinor: l.askMinor, buyer: buyer.label, at: appr.createdAt });
        }
      }
      offers.sort((a, b) => b.at - a.at);
      const top = offers.slice(0, 5);
      if (!top.length) return result("No offers waiting right now. I'll let you know.", { kind: "offers", offers: [] }, ctx.cards, "deal-approval");
      const prefs = await ctx.prefs.get(actor.householdId);
      const first = top[0]!;
      const speech =
        top.length === 1
          ? `${first.buyer} offers ${$(first.amountMinor)} for the ${inSentence(first.title)}${prefs ? `, pickup ${prefs.label} like last time` : ""}. Accept?`
          : `You have ${top.length} offers. The newest: ${first.buyer} offers ${$(first.amountMinor)} for the ${inSentence(first.title)}. Accept that one?`;
      return result(speech, { kind: "offers", offers: top, pickup: prefs?.label }, ctx.cards, "deal-approval");
    },
  );

  // ------------------------------------------------------------ respond_to_offer
  server.registerTool(
    "respond_to_offer",
    {
      title: "Accept or decline an offer",
      description: "Accept or decline a buyer's offer. With no approvalId, acts on the newest waiting offer.",
      inputSchema: z.object({ decision: z.enum(["accept", "decline"]), approvalId: z.string().optional() }),
      _meta: uiMeta(ctx.cards, "deal-approval"),
    },
    async ({ decision, approvalId }, extra) => {
      let id = approvalId;
      if (!id) {
        const ls = await listings();
        const candidates = [];
        for (const l of ls) for (const n of await s.negotiationsFor(l.id)) if (n.state === "AGREED_PENDING_SELLER" && n.pendingApprovalId) candidates.push(n);
        id = candidates.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.pendingApprovalId;
      }
      if (!id) return errorResult("There's no offer waiting for you.", "no_offer");
      const appr = await s.getApproval(id);
      if (appr.approver !== who) return errorResult("That offer isn't for your items.", "not_yours");
      const negotiationId = String(appr.terms.details?.negotiationId ?? "");
      const amount = appr.terms.amountMinor!;
      if (decision === "decline") {
        await s.resolveApproval(id, false, who);
        await s.declineOffer(negotiationId, who);
        return result("Declined. Your item stays listed.", { kind: "offer_declined", approvalId: id });
      }
      const fee = Math.round(amount * 0.05);
      const prefs = await ctx.prefs.get(actor.householdId);
      const listing = await s.getListing(appr.terms.listingId!);
      const summary = `Sell the ${inSentence(listing.title)} to ${appr.terms.buyerPseudonym} for ${$(amount)}? You get ${$(amount - fee)} after Stoop's 5% fee, released only after your doorbell verifies the pickup.${prefs ? ` Pickup ${prefs.label}.` : ""}`;
      const approve = async () => {
        try {
          const { token } = await s.resolveApproval(id!, true, who);
          const deal = await s.acceptWithToken(negotiationId, amount, token!, who);
          return result(`Accepted at ${$(amount)}. The buyer is paying now; the money is held until pickup.`, { kind: "deal", dealId: deal.id, state: deal.state, amountMinor: amount }, ctx.cards, "handoff-timeline");
        } catch (e) {
          if (e instanceof SettlementError) return errorResult(e.humanMessage, e.code);
          throw e;
        }
      };
      return withApproval({
        server,
        extra,
        pending,
        actor: who,
        summary,
        cards: ctx.cards,
        card: "deal-approval",
        cardData: { kind: "offer", approvalId: id, title: listing.title, amountMinor: amount, feeMinor: fee, buyer: appr.terms.buyerPseudonym, pickup: prefs?.label },
        onApprove: approve,
        onDecline: async () => {
          await s.resolveApproval(id!, false, who).catch(() => undefined);
          await s.declineOffer(negotiationId, who);
          return result("Declined. Your item stays listed.", { kind: "offer_declined", approvalId: id });
        },
      });
    },
  );

  // ------------------------------------------------------------ set_pickup_preferences
  server.registerTool(
    "set_pickup_preferences",
    {
      title: "Set pickup times",
      description: "Set when buyers may pick up from the porch. Remembered across sessions.",
      inputSchema: z.object({
        preset: z.enum(["mornings", "afternoons", "evenings"]).optional(),
        fromHour: z.number().int().min(6).max(22).optional(),
        toHour: z.number().int().min(7).max(23).optional(),
      }),
    },
    async ({ preset, fromHour, toHour }) => {
      const presets = { mornings: [8, 10], afternoons: [13, 15], evenings: [18, 20] } as const;
      const [f, t] = fromHour !== undefined && toHour !== undefined ? [fromHour, toHour] : presets[preset ?? "evenings"];
      if (t <= f || t - f > 2) return errorResult("Pickup windows can be up to two hours long.", "window_invalid");
      const fmt = (h: number) => `${h % 12 || 12}${h < 12 ? " am" : " pm"}`;
      const label = `${fmt(f)} to ${fmt(t)}`;
      await ctx.prefs.set(actor.householdId, { fromHour: f, toHour: t, label, updatedAt: ctx.now() });
      return result(`Got it: pickups ${label}. I'll remember that for every sale.`, { kind: "pickup_prefs", fromHour: f, toHour: t, label });
    },
  );

  // ------------------------------------------------------------ handoff_status
  server.registerTool(
    "handoff_status",
    {
      title: "How is my sale going",
      description: "Status of the current sale: payment, pickup window, doorbell verification, payout.",
      inputSchema: z.object({ dealId: z.string().optional() }),
      annotations: { readOnlyHint: true },
      _meta: uiMeta(ctx.cards, "handoff-timeline"),
    },
    async ({ dealId }) => {
      const deal = await latestDeal(dealId);
      if (!deal) return result("No sales in progress yet.", { kind: "status", deal: null }, ctx.cards, "handoff-timeline");
      return statusResult(deal);
    },
  );
  const stateSpeech = (deal: Deal) => STATE_SPEECH[deal.state] ?? `The sale is ${deal.state.toLowerCase().replace(/_/g, " ")}.`;
  const statusResult = async (deal: Deal) => result(stateSpeech(deal), await timeline(ctx, deal), ctx.cards, "handoff-timeline");
  if (taskStore) registerWatchHandoff(server, ctx, { resolveDeal: latestDeal, speech: stateSpeech, snapshot: statusResult });

  // ------------------------------------------------------------ get_receipt
  server.registerTool(
    "get_receipt",
    {
      title: "Show my receipt",
      description: "The signed proof-of-handoff receipt for a sale, verifiable by anyone.",
      inputSchema: z.object({ dealId: z.string().optional() }),
      annotations: { readOnlyHint: true },
      _meta: uiMeta(ctx.cards, "receipt"),
    },
    async ({ dealId }) => {
      const deal = await latestDeal(dealId);
      const rid = deal?.receiptIds.at(-1);
      if (!deal || !rid) return errorResult("There's no verified pickup receipt yet.", "no_receipt");
      const r = await s.getReceipt(rid);
      const verifyUrl = `${ctx.publicBaseUrl}/verify/${rid}`;
      return result(`Here's the signed receipt for the ${inSentence(deal.itemTitle)}. Anyone can verify it.`, {
        kind: "receipt",
        receiptId: rid,
        dealId: deal.id,
        title: deal.itemTitle,
        amountMinor: deal.amountMinor,
        verdict: deal.verdict,
        jwsPreview: `${r.jws.slice(0, 32)}…`,
        verifyUrl,
        hash: r.hash,
      }, ctx.cards, "receipt");
    },
  );

  // ------------------------------------------------------------ confirm_pickup (dual confirm when camera can't verify)
  server.registerTool(
    "confirm_pickup",
    {
      title: "Confirm the buyer picked it up",
      description: "When the doorbell couldn't verify a pickup, the owner confirms it (both sides must confirm; capped at $150).",
      inputSchema: z.object({ dealId: z.string().optional() }),
    },
    async ({ dealId }) => {
      const deal = await latestDeal(dealId);
      if (!deal || (deal.state !== "REVIEW" && deal.state !== "DEGRADED")) return errorResult("There's nothing to confirm right now.", "nothing_to_confirm");
      const d = await s.dualConfirm(deal.id, "seller");
      return result(d.state === "CLOSED" ? "Thanks. Both of you confirmed, so the payment was released." : "Thanks. Waiting for the buyer to confirm too.", await timeline(ctx, d), ctx.cards, "handoff-timeline");
    },
  );

  // ------------------------------------------------------------ cancel_sale
  server.registerTool(
    "cancel_sale",
    {
      title: "Cancel a sale",
      description: "Cancel the current sale. The buyer's held payment is released.",
      inputSchema: z.object({ dealId: z.string().optional() }),
      annotations: { destructiveHint: true },
    },
    async ({ dealId }, extra) => {
      const deal = await latestDeal(dealId);
      if (!deal || ["CLOSED", "VOIDED", "INSPECTION", "CAPTURED"].includes(deal.state)) return errorResult("There's no sale I can cancel.", "nothing_to_cancel");
      const summary = `Cancel the sale of the ${inSentence(deal.itemTitle)}? The buyer's payment hold is released and the listing is withdrawn.`;
      const approval = await s.requestApproval(s.cancelTerms(deal), who, summary);
      return withApproval({
        server,
        extra,
        pending,
        actor: who,
        summary,
        cards: ctx.cards,
        card: "handoff-timeline",
        cardData: await timeline(ctx, deal),
        onApprove: async () => {
          const { token } = await s.resolveApproval(approval.id, true, who);
          const d = await s.sellerCancel(deal.id, token!, who);
          return result("Cancelled. The buyer's hold was released.", await timeline(ctx, d), ctx.cards, "handoff-timeline");
        },
        onDecline: async () => {
          await s.resolveApproval(approval.id, false, who).catch(() => undefined);
          return result("Okay, the sale continues.", { kind: "status" });
        },
      });
    },
  );

  // ------------------------------------------------------------ confirm_action (Path B approvals)
  registerConfirmAction(server, pending, who);
  return server;
}

export function registerConfirmAction(server: McpServer, pending: PendingActions, who: string) {
  server.registerTool(
    "confirm_action",
    {
      title: "Confirm or decline",
      description: "Answer a pending approval after asking the user (for assistants that can't show approval prompts).",
      inputSchema: z.object({
        approvalId: z.string().optional().describe("pendingActionId from an approval_required result; defaults to the latest"),
        decision: z.enum(["accept", "decline"]),
        voiceCode: z.string().regex(/^\d{4}$/).optional(),
      }),
    },
    async ({ approvalId, decision, voiceCode }) => {
      const p = approvalId ? pending.take(approvalId, who) : (() => {
        const latest = pending.latestFor(who);
        return latest ? pending.take(latest.id, who) : undefined;
      })();
      if (!p) return errorResult("That approval expired or doesn't exist.", "approval_not_found");
      return decision === "accept" ? p.execute({ voiceCode }) : p.decline();
    },
  );
}

export async function timeline(ctx: StoopContext, deal: Deal) {
  const ev = await ctx.settlement.getEvidence(deal.id);
  const checkInAt = await ctx.settlement.checkInAt(deal.id);
  return {
    kind: "status",
    deal: {
      dealId: deal.id,
      title: deal.itemTitle,
      state: deal.state,
      amountMinor: deal.amountMinor,
      window: deal.window,
      verdict: deal.verdict,
      receiptId: deal.receiptIds.at(-1),
      history: deal.history.slice(-12).map((h) => ({ state: h.state, at: h.at })),
      evidence: {
        checkInAt: checkInAt ?? null,
        ringEvents: ev.ringEvents.map((e) => ({ kind: e.kind, subType: e.subType, at: e.at, origin: e.origin })),
        before: ev.before ? { presence: ev.before.presence, origin: ev.before.origin, at: ev.before.at } : null,
        after: ev.after ? { presence: ev.after.presence, origin: ev.after.origin, at: ev.after.at } : null,
        camera: ev.camera,
      },
    },
  };
}
