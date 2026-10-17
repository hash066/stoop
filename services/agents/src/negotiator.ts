// The Negotiator: one turn per buyer message. Safety layering:
//   1) deterministic scam / injection / address screening (R7, R8, R2) before any model sees the text
//   2) a Strands agent that can ONLY act through three guarded tools
//   3) every outgoing message passes Settlement's leak guard (address + floor), else template fallback
// Numbers never come from the model: counters come from the Settlement oracle (floor never exposed).
import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";
import { AI_DISCLOSURE, scanBuyerText, STRIKE_SIGNALS, type ScamSignal } from "@stoop/policy";
import { createModel, type Script } from "./llm.ts";

export interface NegotiationPort {
  getNegotiation(id: string): Promise<{ id: string; listingId: string; buyerId: string; state: string; offers: Array<{ by: string; amountMinor: number }>; lastCounterMinor?: number }>;
  getListing(id: string): Promise<{ id: string; title: string; askMinor: number; description: string; state: string }>;
  oracle(negotiationId: string, offerMinor: number): Promise<{ acceptable: boolean; autoAcceptable: boolean; counterMinor: number | null; askMinor: number }>;
  recordOffer(negotiationId: string, by: "buyer" | "seller", amountMinor: number, message: string): Promise<unknown>;
  proposeAccept(
    negotiationId: string,
    amountMinor: number,
  ): Promise<{ decision: { outcome: string; reasons: string[] }; deal?: { id: string }; approval?: { id: string } }>;
  checkOutgoing(listingId: string, text: string): Promise<{ ok: boolean; violations: string[] }>;
  strike(negotiationId: string, signal: string): Promise<{ strikes: number; blocked: boolean }>;
  noteRefusal(negotiationId: string, signal: string): Promise<unknown>;
}

export type NegotiatorAction = "counter" | "awaiting_seller" | "accepted" | "declined" | "answered" | "refused" | "blocked";

export interface NegotiatorResult {
  action: NegotiatorAction;
  reply: string;
  buyerOfferMinor?: number;
  counterMinor?: number;
  approvalId?: string;
  dealId?: string;
  signals: ScamSignal[];
  usedFallback: boolean;
  guardBlocks: number;
}

export const MAX_AGENT_TURNS = 6;
export const AGENT_TIMEOUT_MS = 20_000;

export const dollars = (minor: number) => `$${(minor / 100).toFixed(minor % 100 === 0 ? 0 : 2)}`;

/** Extract a dollar amount from buyer text: "$85", "85 dollars", "would you take 85". */
export function parseMoneyMinor(text: string): number | undefined {
  const m =
    text.match(/\$\s?(\d{1,5}(?:\.\d{1,2})?)/) ??
    text.match(/\b(\d{1,5}(?:\.\d{1,2})?)\s*(?:dollars|bucks|usd)\b/i) ??
    text.match(/\b(?:take|do|offer|pay|give(?: you)?|for)\s+(\d{1,5}(?:\.\d{1,2})?)\b/i);
  if (!m?.[1]) return undefined;
  const v = Math.round(Number(m[1]) * 100);
  return v > 0 ? v : undefined;
}

const REFUSALS: Record<ScamSignal, string> = {
  off_platform_payment: "Payment only goes through Stoop, so your money is protected until pickup. I can't take Zelle, Venmo, wire or crypto.",
  gift_card: "Sorry, gift cards aren't accepted. Payment goes through Stoop and is held until your pickup is verified.",
  verification_code: "I'll never ask for or send verification codes. Payment and pickup both happen inside Stoop.",
  overpayment: "No overpayments or refunds of differences, sorry. You'll pay exactly the agreed price through Stoop.",
  shipping_or_courier: "This one is porch pickup only, by the buyer, verified at the door. No shipping or third-party couriers.",
  external_link: "I can't open outside links. Everything you need is in Stoop.",
  address_request: "Pickup details come with your pickup pass once your payment is held, and only during your pickup window.",
  instruction_injection: "I can only help with this item: questions, offers and pickup. What would you like to offer?",
};

const SYSTEM_PROMPT = `You are the selling assistant for one household item on Stoop. You speak to buyers (people or their AI agents).
Rules you must follow:
- You are an AI; the owner approves every sale. Be brief, warm and concrete (1-3 sentences).
- You never know the owner's minimum price. To respond to an offer, call evaluate_offer first.
- If evaluate_offer says acceptable, call propose_acceptance with the buyer's exact offer.
- Otherwise reply with send_reply using the counter amount evaluate_offer gave you (or a higher one up to the ask).
- Never mention addresses, streets, or meeting places: pickup details come only with the pickup pass after payment.
- Never accept other payment methods, codes, links, shipping or couriers.
- Always finish by calling send_reply exactly once with the message to send.`;

export interface NegotiatorOptions {
  /** Override the offline script (tests use this to simulate a misbehaving model). */
  script?: (listing: { title: string; askMinor: number }, offerMinor: number | undefined) => Script;
}

export class Negotiator {
  constructor(
    private port: NegotiationPort,
    private opts: NegotiatorOptions = {},
  ) {}

  async turn(input: { negotiationId: string; buyerText: string; offerMinor?: number }): Promise<NegotiatorResult> {
    const n = await this.port.getNegotiation(input.negotiationId);
    const listing = await this.port.getListing(n.listingId);
    const first = n.offers.length === 0;
    const disclose = (s: string) => (first ? `${AI_DISCLOSURE} ${s}` : s);

    // 1) Deterministic screening.
    const signals = scanBuyerText(input.buyerText);
    const strikeSignal = signals.find((s) => STRIKE_SIGNALS.has(s));
    if (strikeSignal) {
      const { blocked } = await this.port.strike(n.id, strikeSignal);
      const reply = blocked
        ? "This conversation is closed because of repeated off-platform requests."
        : disclose(REFUSALS[strikeSignal]);
      return { action: blocked ? "blocked" : "refused", reply, signals, usedFallback: false, guardBlocks: 0 };
    }
    const refuse = signals.find((s) => s === "address_request" || s === "instruction_injection" || s === "external_link");
    if (refuse && parseMoneyMinor(input.buyerText) === undefined && input.offerMinor === undefined) {
      await this.port.noteRefusal(n.id, refuse);
      return { action: "refused", reply: disclose(REFUSALS[refuse]), signals, usedFallback: false, guardBlocks: 0 };
    }
    if (refuse) await this.port.noteRefusal(n.id, refuse); // refuse the bad part, still handle the offer

    // 2) Agent turn with guarded tools.
    const state: {
      buyerOfferMinor?: number;
      oracle?: Awaited<ReturnType<NegotiationPort["oracle"]>>;
      reply?: string;
      counterMinor?: number;
      approvalId?: string;
      dealId?: string;
      acceptOutcome?: string;
      guardBlocks: number;
    } = { guardBlocks: 0 };
    const offerFromText = input.offerMinor ?? parseMoneyMinor(input.buyerText);

    const evaluateOffer = tool({
      name: "evaluate_offer",
      description: "Check a buyer offer (in cents). Returns whether it is acceptable and a suggested counter. Never reveals the owner's minimum.",
      inputSchema: z.object({ amountMinor: z.number().int().positive() }),
      callback: async ({ amountMinor }) => {
        if (offerFromText !== undefined && amountMinor !== offerFromText)
          throw new Error(`The buyer offered ${dollars(offerFromText)}; evaluate that exact amount.`);
        if (state.buyerOfferMinor === undefined) {
          await this.port.recordOffer(n.id, "buyer", amountMinor, input.buyerText.slice(0, 500));
          state.buyerOfferMinor = amountMinor;
        }
        state.oracle = await this.port.oracle(n.id, amountMinor);
        return { acceptable: state.oracle.acceptable, suggestedCounterMinor: state.oracle.counterMinor, askMinor: state.oracle.askMinor };
      },
    });

    const proposeAcceptance = tool({
      name: "propose_acceptance",
      description: "Propose accepting the buyer's exact offer. The owner's rules decide; may require the owner's approval.",
      inputSchema: z.object({ amountMinor: z.number().int().positive() }),
      callback: async ({ amountMinor }) => {
        if (state.buyerOfferMinor === undefined || amountMinor !== state.buyerOfferMinor)
          throw new Error("You can only accept the buyer's actual, evaluated offer.");
        const res = await this.port.proposeAccept(n.id, amountMinor);
        state.acceptOutcome = res.deal ? "accepted" : res.approval ? "awaiting_seller" : "declined";
        state.dealId = res.deal?.id;
        state.approvalId = res.approval?.id;
        return { outcome: state.acceptOutcome };
      },
    });

    const sendReply = tool({
      name: "send_reply",
      description: "Send the final message to the buyer. Include counterMinor if the message makes a counter-offer.",
      inputSchema: z.object({ text: z.string().min(1).max(600), counterMinor: z.number().int().positive().optional() }),
      callback: async ({ text, counterMinor }) => {
        if (counterMinor !== undefined) {
          const floorish = state.oracle?.counterMinor;
          if (!state.oracle) throw new Error("Call evaluate_offer before countering.");
          if (floorish === null || floorish === undefined) throw new Error("No counter is appropriate here.");
          if (counterMinor < floorish || counterMinor > state.oracle.askMinor)
            throw new Error(`Counter must be between ${dollars(floorish)} and ${dollars(state.oracle.askMinor)}.`);
        }
        const finalText = disclose(text);
        const check = await this.port.checkOutgoing(listing.id, finalText);
        if (!check.ok) {
          state.guardBlocks += 1;
          throw new Error(`Message blocked by policy (${check.violations.join(", ")}). Rephrase without addresses or minimum prices.`);
        }
        if (counterMinor !== undefined) {
          await this.port.recordOffer(n.id, "seller", counterMinor, finalText);
          state.counterMinor = counterMinor;
        }
        state.reply = finalText;
        return { sent: true };
      },
    });

    const script = (this.opts.script ?? offlineNegotiatorScript)(listing, offerFromText);
    const agent = new Agent({
      model: createModel("NEGOTIATOR", script),
      systemPrompt: SYSTEM_PROMPT,
      tools: [evaluateOffer, proposeAcceptance, sendReply],
      printer: false,
      sandbox: false,
      name: "stoop-negotiator",
    });

    let usedFallback = false;
    try {
      const facts = [
        `Item: ${listing.title}. Asking ${dollars(listing.askMinor)}.`,
        offerFromText !== undefined ? `Buyer's offer: ${offerFromText} cents.` : "The buyer made no offer.",
        `Buyer says: """${input.buyerText.slice(0, 800)}"""`,
      ].join("\n");
      // Hard budget: a misbehaving model can't loop. Exceeding it falls through to the safe template.
      await agent.invoke(facts, { limits: { turns: MAX_AGENT_TURNS }, cancelSignal: AbortSignal.timeout(AGENT_TIMEOUT_MS) });
    } catch {
      usedFallback = true;
    }

    // 3) Deterministic fallback if the agent didn't produce a safe message.
    if (!state.reply) {
      usedFallback = true;
      if (offerFromText !== undefined && !state.oracle) {
        state.buyerOfferMinor = offerFromText;
        await this.port.recordOffer(n.id, "buyer", offerFromText, input.buyerText.slice(0, 500));
        state.oracle = await this.port.oracle(n.id, offerFromText);
        if (state.oracle.acceptable && !state.acceptOutcome) {
          const res = await this.port.proposeAccept(n.id, offerFromText);
          state.acceptOutcome = res.deal ? "accepted" : res.approval ? "awaiting_seller" : "declined";
          state.dealId = res.deal?.id;
          state.approvalId = res.approval?.id;
        }
      }
      const text = disclose(templateReply(listing, state));
      const check = await this.port.checkOutgoing(listing.id, text);
      state.reply = check.ok ? text : disclose("Thanks for your message. The owner will follow up shortly.");
      if (state.oracle?.counterMinor && !state.acceptOutcome && check.ok) {
        await this.port.recordOffer(n.id, "seller", state.oracle.counterMinor, state.reply);
        state.counterMinor = state.oracle.counterMinor;
      }
    }

    const action: NegotiatorAction =
      state.acceptOutcome === "accepted"
        ? "accepted"
        : state.acceptOutcome === "awaiting_seller"
          ? "awaiting_seller"
          : state.counterMinor !== undefined
            ? "counter"
            : state.buyerOfferMinor !== undefined
              ? "declined"
              : "answered";
    return {
      action,
      reply: state.reply!,
      buyerOfferMinor: state.buyerOfferMinor,
      counterMinor: state.counterMinor,
      approvalId: state.approvalId,
      dealId: state.dealId,
      signals,
      usedFallback,
      guardBlocks: state.guardBlocks,
    };
  }
}

function templateReply(
  listing: { title: string; askMinor: number },
  s: { buyerOfferMinor?: number; oracle?: { counterMinor: number | null; acceptable: boolean }; acceptOutcome?: string },
): string {
  if (s.acceptOutcome === "accepted") return `Deal at ${dollars(s.buyerOfferMinor!)}. You'll get a checkout link; your payment is held until your pickup is verified.`;
  if (s.acceptOutcome === "awaiting_seller") return `${dollars(s.buyerOfferMinor!)} could work. I'm checking with the owner now and will confirm shortly.`;
  if (s.oracle?.counterMinor) return `Thanks for the offer of ${dollars(s.buyerOfferMinor!)}. The best I can do is ${dollars(s.oracle.counterMinor)}. It's in good shape and pickup is contactless from the porch.`;
  if (s.buyerOfferMinor !== undefined) return `I can't go that low, sorry. The asking price is ${dollars(listing.askMinor)}.`;
  return `It's the ${listing.title}, asking ${dollars(listing.askMinor)}. Pickup is contactless from the porch, and your payment is held until the doorbell verifies it. Want to make an offer?`;
}

/** Offline policy for ScriptedModel: same tool sequence a well-behaved LLM should follow. */
export function offlineNegotiatorScript(listing: { title: string; askMinor: number }, offerMinor: number | undefined): Script {
  return (ctx) => {
    const done = (name: string) => ctx.results.filter((r) => r.tool === name && r.status === "success");
    const evaluated = done("evaluate_offer").at(-1)?.output as { acceptable: boolean; suggestedCounterMinor: number | null } | undefined;
    const accepted = done("propose_acceptance").at(-1)?.output as { outcome: string } | undefined;
    if (done("send_reply").length) return { text: "sent" };
    if (ctx.results.filter((r) => r.status === "error").length >= 2) return { text: "unable to produce a safe reply" };
    if (offerMinor !== undefined && !evaluated) return { tool: "evaluate_offer", input: { amountMinor: offerMinor } };
    if (evaluated?.acceptable && !accepted) return { tool: "propose_acceptance", input: { amountMinor: offerMinor! } };
    const s = {
      buyerOfferMinor: offerMinor,
      oracle: evaluated ? { counterMinor: evaluated.suggestedCounterMinor, acceptable: evaluated.acceptable } : undefined,
      acceptOutcome: accepted?.outcome,
    };
    const counter = !accepted && evaluated?.suggestedCounterMinor ? evaluated.suggestedCounterMinor : undefined;
    return { tool: "send_reply", input: { text: templateReply(listing, s), ...(counter ? { counterMinor: counter } : {}) } };
  };
}
