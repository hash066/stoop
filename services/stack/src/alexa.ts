// Stoop on a real Alexa: a custom skill built with the Alexa Skills Kit SDK, hosted by this server.
// A seller links their shop by saying a 6-digit code from their shop page, then talks to it:
//   "Alexa, ask stoop shop if I have any offers."  "Yes."  "Alexa, ask stoop shop how my sale is going."
// Every answer comes from the shop's own MCP tools, called the way an Alexa-style client calls them:
// no MCP session and no elicitation, so an action that needs the owner's yes comes back as
// approval_required, Alexa asks, and the next "yes" is sent as confirm_action.
import { randomInt } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as Alexa from "ask-sdk-core";
import type { RequestEnvelope, ResponseEnvelope } from "ask-sdk-model";
import { mcpCall, type ToolOut } from "./inproc.ts";

/** What the skill needs from a shop: its world's HTTP app, and whose shop a seller token opens. */
export interface ShopHandle {
  fetch(req: Request): Promise<Response>;
  shopName(token: string): Promise<string | undefined>;
}

/** A seller's shop, or a buyer's Stoop profile (voice shopping across the street). */
export type Link = { kind?: "seller"; shop: string; token: string; name: string } | { kind: "buyer"; profileId: string; name: string };

/** Pairing codes (10 minutes, single use) and which Alexa account is linked to which shop or buyer. */
export class AlexaLinks {
  private codes = new Map<string, Link & { exp: number }>();
  private users = new Map<string, Link>();
  constructor(
    private file?: string,
    private now: () => number = () => Date.now(),
  ) {
    if (file && existsSync(file)) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, Link>)) this.users.set(k, v);
      } catch {
        /* a damaged file only means people link again */
      }
    }
  }
  newCode(shop: string, token: string, name: string): string {
    return this.issue({ kind: "seller", shop, token, name });
  }
  newBuyerCode(profileId: string, name: string): string {
    return this.issue({ kind: "buyer", profileId, name });
  }
  private issue(link: Link): string {
    const t = this.now();
    for (const [c, v] of this.codes) if (v.exp < t || JSON.stringify({ ...v, exp: 0 }) === JSON.stringify({ ...link, exp: 0 })) this.codes.delete(c);
    let code: string;
    do code = String(randomInt(100000, 1000000));
    while (this.codes.has(code));
    this.codes.set(code, { ...link, exp: t + 10 * 60_000 });
    return code;
  }
  redeem(code: string, userId: string): Link | undefined {
    const c = this.codes.get(code);
    if (!c || c.exp < this.now()) return undefined;
    this.codes.delete(code);
    const { exp: _e, ...link } = c;
    this.users.set(userId, link as Link);
    this.save();
    return link as Link;
  }
  get(userId: string) {
    return this.users.get(userId);
  }
  unlink(userId: string) {
    this.users.delete(userId);
    this.save();
  }
  private save() {
    if (this.file) writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.users)), { mode: 0o600 });
  }
}

/** One stateless MCP call into the shop as its seller, like an Alexa+ client without a session. */
const callTool = (h: ShopHandle, token: string, name: string, args: Record<string, unknown> = {}) => mcpCall(h.fetch, "seller", token, name, args);

/** What the skill needs from Stoop Street to shop by voice. */
export interface StreetAccess {
  search(q: string, maxMinor?: number): Promise<Array<{ shop: string; shopName: string; listingId: string; title: string; askMinor: number; zip: string; rating: { avg: number | null; verified: number } }>>;
  buyerToken(profileId: string, shop: string): Promise<string | undefined>;
}

const NUM: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
/** "a hundred", "one hundred fifty", "eighty", "120" -> a number. */
export function spokenNumber(s: string): number | undefined {
  const d = /\d+(?:\.\d+)?/.exec(s.replace(/,/g, ""));
  if (d) return Number(d[0]);
  let total = 0;
  let cur = 0;
  let seen = false;
  for (const w of s.toLowerCase().split(/[\s-]+/)) {
    if (w === "a" && !seen) continue;
    if (w in NUM) {
      cur += NUM[w]!;
      seen = true;
    } else if (w === "hundred") {
      cur = (cur || 1) * 100;
      seen = true;
    } else if (w === "thousand") {
      total += (cur || 1) * 1000;
      cur = 0;
      seen = true;
    } else if (w !== "and" && seen) break;
  }
  return seen ? total + cur : undefined;
}
/** "a jogging stroller under a hundred dollars" -> { what: "a jogging stroller", maxMinor: 10000 } */
export function parseWant(q: string): { what: string; maxMinor?: number } {
  const m = /\b(?:under|below|less than|for less than|up to|at most|max(?:imum)?)\s+(.+?)(?:\s*dollars?|\s*bucks)?$/i.exec(q.trim());
  const max = m ? spokenNumber(m[1]!) : undefined;
  return { what: (m ? q.slice(0, m.index) : q).replace(/\b(for|me|a|an|some)\s*$/i, "").trim() || q, maxMinor: max ? Math.round(max * 100) : undefined };
}

const SELLER_TOOLS = new Set(["my_items", "list_items", "set_mandate", "review_offers", "respond_to_offer", "set_pickup_preferences", "handoff_status", "get_receipt", "confirm_pickup", "cancel_sale", "confirm_action"]);
const LINK_FIRST = "To connect your shop, open it on the Stoop website, tap Connect Alexa, and tell me the six digit code.";
const ASK_YES = "Say yes to approve, or no to cancel.";

type Found = { shop: string; shopName: string; listingId: string; title: string; askMinor: number; zip: string; rating: { avg: number | null; verified: number } };
type Attrs = {
  pendingApprovalId?: string;
  pendingOfferApprovalId?: string;
  // shopping by voice
  results?: Found[];
  idx?: number;
  needsCode?: boolean;
  awaitingCode?: boolean;
};

export function createStoopSkill(o: { skillId?: string; links: AlexaLinks; shop(id: string): ShopHandle | undefined; street?: StreetAccess }) {
  type Input = Alexa.HandlerInput;
  const attrs = (h: Input) => h.attributesManager.getSessionAttributes() as Attrs;
  const userId = (h: Input) => Alexa.getUserId(h.requestEnvelope);
  const intent = (h: Input, ...names: string[]) => Alexa.getRequestType(h.requestEnvelope) === "IntentRequest" && names.includes(Alexa.getIntentName(h.requestEnvelope));
  const slot = (h: Input, name: string) => Alexa.getSlotValue(h.requestEnvelope, name) ?? undefined;
  const speak = (h: Input, text: string, keepOpen: boolean, reprompt?: string) => {
    const b = h.responseBuilder.speak(text).withSimpleCard("Stoop", text.replace(/<[^>]+>/g, ""));
    if (keepOpen) b.reprompt(reprompt ?? "What else can I do for your shop?");
    else b.withShouldEndSession(true);
    return b.getResponse();
  };

  /** The linked shop, or a spoken explanation of what to do instead. */
  const linked = (h: Input): { link: Extract<Link, { shop: string }>; handle: ShopHandle } | { say: string } => {
    const link = o.links.get(userId(h));
    if (!link) return { say: LINK_FIRST };
    if (link.kind === "buyer") return { say: "This Alexa is set up for shopping. Try: find me a jogging stroller under a hundred dollars." };
    const handle = o.shop(link.shop);
    if (!handle) {
      o.links.unlink(userId(h));
      return { say: "Your Stoop shop has closed. Open a new one on the Stoop website, then connect it again." };
    }
    return { link, handle };
  };

  /** Run one tool and say what it said; an approval it needs is remembered for the next yes. */
  const run = async (h: Input, name: string, args: Record<string, unknown> = {}) => {
    const l = linked(h);
    if ("say" in l) return speak(h, l.say, true, LINK_FIRST);
    const out = await callTool(l.handle, l.link.token, name, args);
    return answer(h, out);
  };
  const answer = (h: Input, out: ToolOut) => {
    const a = attrs(h);
    if (out.data.kind === "approval_required" && out.data.pendingActionId) {
      a.pendingApprovalId = out.data.pendingActionId;
      a.pendingOfferApprovalId = undefined;
      return speak(h, out.text, true, ASK_YES);
    }
    a.pendingApprovalId = undefined;
    if (out.data.kind === "offers" && out.data.offers?.length) {
      a.pendingOfferApprovalId = out.data.offers[0].approvalId;
      return speak(h, out.text, true, "Do you want to accept it?");
    }
    if (out.data.kind === "deal" || out.data.kind === "offer_declined") a.pendingOfferApprovalId = undefined;
    return speak(h, out.text || "Done.", true);
  };

  // ---------------------------------------------------------------- shopping by voice (a linked buyer)
  const buyer = (h: Input) => {
    const l = o.links.get(userId(h));
    return l?.kind === "buyer" ? l : undefined;
  };
  const SHOP_FIRST = "To shop by voice, open Your Stoop on the Stoop website, tap Get a Code under Shop by voice, and tell me the six digits.";
  const zipSaid = (z: string) => `<say-as interpret-as="digits">${z}</say-as>`;
  const describe = (r: Found, i: number, n: number) =>
    `${i === 0 ? (n === 1 ? "I found one" : `I found ${n}. The first`) : "Next"}: the ${r.title} for ${$(r.askMinor)}, porch pickup in ${zipSaid(r.zip)}, from ${r.shopName.replace("’", "'")}${r.rating.verified ? `, with ${r.rating.verified} verified pickup${r.rating.verified === 1 ? "" : "s"}` : ""}. Want to make an offer${i < n - 1 ? ", or hear the next one" : ""}?`;
  const current = (h: Input) => {
    const a = attrs(h);
    return a.results?.[a.idx ?? 0];
  };
  const buyerCall = async (h: Input, name: string, args: Record<string, unknown> = {}) => {
    const l = buyer(h)!;
    const r = current(h)!;
    const token = await o.street!.buyerToken(l.profileId, r.shop);
    const handle = o.shop(r.shop);
    if (!token || !handle) throw new Error("shop closed");
    return mcpCall(handle.fetch, "buyer", token, name, args);
  };
  /** Say what a buyer-side tool said; an approval it needs (checkout) waits for "yes" and, over $100, the code. */
  const buyerAnswer = (h: Input, out: ToolOut) => {
    const a = attrs(h);
    if (out.data.kind === "approval_required" && out.data.pendingActionId) {
      a.pendingApprovalId = out.data.pendingActionId;
      a.needsCode = !!out.data.needsVoiceCode;
      return speak(h, out.text, true, a.needsCode ? "Say yes, then your four digit purchase code. Or say no to cancel." : ASK_YES);
    }
    a.pendingApprovalId = undefined;
    a.needsCode = a.awaitingCode = false;
    if (out.data.kind === "deal" && out.data.state === "FUNDS_HELD")
      return speak(h, `Done. ${$(out.data.totalMinor)} is held, not charged, until your pickup is verified. Your pickup pass is in Your Stoop on your phone.`, true);
    return speak(h, out.text || "Done.", true);
  };
  const $ = (minor: number) => `$${(minor / 100).toFixed(minor % 100 ? 2 : 0)}`;

  const buyerHandlers: Alexa.RequestHandler[] = [
    {
      canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === "LaunchRequest" && !!buyer(h),
      handle: (h) => speak(h, `Welcome back, ${buyer(h)!.name}. Tell me what you’re looking for, like: find a jogging stroller under a hundred dollars.`, true),
    },
    {
      canHandle: (h) => intent(h, "FindIntent"),
      handle: async (h) => {
        if (!buyer(h) || !o.street) return speak(h, SHOP_FIRST, true);
        const { what, maxMinor } = parseWant(slot(h, "query") ?? "");
        const results = (await o.street.search(what, maxMinor)).slice(0, 5);
        const a = attrs(h);
        a.results = results;
        a.idx = 0;
        a.pendingApprovalId = undefined;
        if (!results.length) return speak(h, `I didn’t find ${what}${maxMinor ? ` under ${$(maxMinor)}` : ""} on Stoop Street right now. You can send an agent from Your Stoop to watch for one.`, true);
        return speak(h, describe(results[0]!, 0, results.length), true, "Say: offer, and a price. Or: next.");
      },
    },
    {
      canHandle: (h) => intent(h, "AMAZON.NextIntent") && !!buyer(h),
      handle: (h) => {
        const a = attrs(h);
        if (!a.results?.length) return speak(h, "Tell me what you’re looking for first.", true);
        if ((a.idx ?? 0) + 1 >= a.results.length) return speak(h, "That was the last one I found.", true);
        a.idx = (a.idx ?? 0) + 1;
        return speak(h, describe(a.results[a.idx]!, a.idx, a.results.length), true);
      },
    },
    {
      canHandle: (h) => intent(h, "OfferIntent"),
      handle: async (h) => {
        if (!buyer(h)) return speak(h, SHOP_FIRST, true);
        const r = current(h);
        const price = Number(slot(h, "price"));
        if (!r) return speak(h, "Tell me what you’re looking for first, like: find a jogging stroller.", true);
        if (!(price > 0)) return speak(h, "How much do you want to offer?", true);
        return buyerAnswer(h, await buyerCall(h, "make_offer", { listingId: r.listingId, amountDollars: price }));
      },
    },
    {
      canHandle: (h) => intent(h, "BuyIntent"),
      handle: async (h) => {
        if (!buyer(h)) return speak(h, SHOP_FIRST, true);
        const r = current(h);
        if (!r) return speak(h, "Tell me what you’re looking for first.", true);
        let out = await buyerCall(h, "checkout");
        if (out.isError && out.data.code === "no_deal") {
          // no agreed price yet: offer the asking price, then pay if the seller's rules accept it
          const offer = await buyerCall(h, "make_offer", { listingId: r.listingId, amountDollars: r.askMinor / 100 });
          if (offer.data.action !== "accepted") return buyerAnswer(h, offer);
          out = await buyerCall(h, "checkout");
        }
        return buyerAnswer(h, out);
      },
    },
    {
      canHandle: (h) => intent(h, "AMAZON.YesIntent") && !!buyer(h) && !!attrs(h).pendingApprovalId,
      handle: async (h) => {
        const a = attrs(h);
        if (a.needsCode) {
          a.awaitingCode = true;
          return speak(h, "What’s your four digit purchase code?", true, "Say your four digit purchase code.");
        }
        return buyerAnswer(h, await buyerCall(h, "confirm_action", { approvalId: a.pendingApprovalId, decision: "accept" }));
      },
    },
    {
      // the purchase code, digit by digit ("two five eight zero") or as a number
      canHandle: (h) => intent(h, "LinkShopIntent") && !!buyer(h) && !!attrs(h).awaitingCode && (slot(h, "code") ?? "").replace(/\D/g, "").length === 4,
      handle: async (h) => {
        const a = attrs(h);
        const voiceCode = (slot(h, "code") ?? "").replace(/\D/g, "");
        return buyerAnswer(h, await buyerCall(h, "confirm_action", { approvalId: a.pendingApprovalId, decision: "accept", voiceCode }));
      },
    },
    {
      canHandle: (h) => intent(h, "AMAZON.NoIntent") && !!buyer(h) && !!attrs(h).pendingApprovalId,
      handle: async (h) => buyerAnswer(h, await buyerCall(h, "confirm_action", { approvalId: attrs(h).pendingApprovalId, decision: "decline" })),
    },
    {
      canHandle: (h) => intent(h, "StatusIntent") && !!buyer(h),
      handle: async (h) => {
        if (!current(h)) return speak(h, "Your purchases and pickup passes are in Your Stoop on the Stoop website.", true);
        return buyerAnswer(h, await buyerCall(h, "order_status"));
      },
    },
  ];

  const handlers: Alexa.RequestHandler[] = [
    ...buyerHandlers,
    {
      canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === "LaunchRequest",
      handle: (h) => {
        const l = linked(h);
        if ("say" in l) return speak(h, `Welcome to Stoop. ${l.say}`, true, LINK_FIRST);
        return speak(h, `Welcome back to ${l.link.name}. You can ask if you have any offers, how your sale is going, or what you’re selling.`, true);
      },
    },
    {
      canHandle: (h) => intent(h, "LinkShopIntent"),
      handle: (h) => {
        const code = (slot(h, "code") ?? "").replace(/\D/g, "");
        const link = code.length === 6 ? o.links.redeem(code, userId(h)) : undefined;
        if (!link) return speak(h, "That code didn’t work. Codes last ten minutes; get a new one on your shop page, then tell me the six digits.", true, LINK_FIRST);
        if (link.kind === "buyer") return speak(h, `You’re set up to shop, ${link.name}. Tell me what you’re looking for, like: find a jogging stroller under a hundred dollars.`, true);
        return speak(h, `You’re connected to ${link.name}. Ask me if you have any offers, or how your sale is going.`, true);
      },
    },
    { canHandle: (h) => intent(h, "OffersIntent"), handle: (h) => run(h, "review_offers") },
    { canHandle: (h) => intent(h, "StatusIntent"), handle: (h) => run(h, "handoff_status") },
    { canHandle: (h) => intent(h, "ItemsIntent"), handle: (h) => run(h, "my_items") },
    {
      canHandle: (h) => intent(h, "MandateIntent"),
      handle: (h) => {
        const price = Number(slot(h, "price"));
        const item = slot(h, "item");
        if (!item || !(price > 0)) return speak(h, "Tell me the item and the lowest price, like: don’t go below ninety dollars on the stroller.", true);
        return run(h, "set_mandate", { item, floorDollars: price });
      },
    },
    {
      canHandle: (h) => intent(h, "ListIntent"),
      handle: (h) => {
        const item = slot(h, "item");
        const price = Number(slot(h, "price"));
        if (!item) return speak(h, "Which item should I put up for sale?", true);
        return run(h, "list_items", { items: [item], ...(price > 0 ? { askDollars: price } : {}) });
      },
    },
    {
      canHandle: (h) => intent(h, "AMAZON.YesIntent"),
      handle: (h) => {
        const a = attrs(h);
        if (a.pendingApprovalId) return run(h, "confirm_action", { approvalId: a.pendingApprovalId, decision: "accept" });
        if (a.pendingOfferApprovalId) return run(h, "respond_to_offer", { decision: "accept", approvalId: a.pendingOfferApprovalId });
        return speak(h, "There’s nothing waiting for a yes right now.", true);
      },
    },
    {
      canHandle: (h) => intent(h, "AMAZON.NoIntent"),
      handle: (h) => {
        const a = attrs(h);
        if (a.pendingApprovalId) return run(h, "confirm_action", { approvalId: a.pendingApprovalId, decision: "decline" });
        if (a.pendingOfferApprovalId) return run(h, "respond_to_offer", { decision: "decline", approvalId: a.pendingOfferApprovalId });
        return speak(h, "Okay.", false);
      },
    },
    {
      // anything else, in the seller's own words, goes to the same planner the Alexa+ device uses
      canHandle: (h) => intent(h, "CommandIntent"),
      handle: async (h) => {
        const l = linked(h);
        if ("say" in l) return speak(h, l.say, true, LINK_FIRST);
        const utterance = slot(h, "query") ?? "";
        const tools = ((await callTool(l.handle, l.link.token, "tools/list")).data.tools as Array<{ name: string; description?: string; inputSchema?: unknown }>).filter((t) => SELLER_TOOLS.has(t.name));
        const a = attrs(h);
        const res = await l.handle.fetch(
          new Request("http://stoop.internal/planner/turn", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ utterance, state: { role: "seller", pendingApprovalId: a.pendingApprovalId, pendingOfferApprovalId: a.pendingOfferApprovalId }, tools }),
          }),
        );
        const plan = (await res.json()) as { calls?: Array<{ name: string; args?: Record<string, unknown> }>; say?: string };
        const calls = (plan.calls ?? []).filter((c) => SELLER_TOOLS.has(c.name));
        if (!calls.length) return speak(h, plan.say ?? "I can check offers, list things, set your lowest price and follow a sale.", true);
        let last: ToolOut | undefined;
        const said: string[] = [];
        for (const c of calls) {
          last = await callTool(l.handle, l.link.token, c.name, c.args ?? {});
          said.push(last.text);
          if (last.isError || last.data.kind === "approval_required") break;
        }
        return answer(h, { ...last!, text: said.join(" ") });
      },
    },
    {
      canHandle: (h) => intent(h, "AMAZON.HelpIntent"),
      handle: (h) => {
        const l = linked(h);
        return speak(h, "say" in l ? l.say : "You can ask if you have any offers, how your sale is going, what you’re selling, or say something like: don’t go below ninety dollars on the stroller.", true);
      },
    },
    { canHandle: (h) => intent(h, "AMAZON.CancelIntent", "AMAZON.StopIntent"), handle: (h) => speak(h, "Okay. Your shop keeps selling.", false) },
    { canHandle: (h) => intent(h, "AMAZON.FallbackIntent", "AMAZON.NavigateHomeIntent"), handle: (h) => speak(h, "I didn’t catch that. You can ask if you have any offers, or how your sale is going.", true) },
    { canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === "SessionEndedRequest", handle: (h) => h.responseBuilder.getResponse() },
  ];

  const b = Alexa.SkillBuilders.custom()
    .addRequestHandlers(...handlers)
    .addErrorHandlers({
      canHandle: () => true,
      handle: (h) => h.responseBuilder.speak("Sorry, something went wrong. Please try again.").reprompt("What can I do for your shop?").getResponse(),
    })
    .withCustomUserAgent("stoop-skill/1.0");
  if (o.skillId) b.withSkillId(o.skillId);
  const skill = b.create();
  return { invoke: (env: RequestEnvelope): Promise<ResponseEnvelope> => skill.invoke(env) };
}
