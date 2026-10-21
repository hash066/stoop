// Stoop on a real Alexa: a custom skill built with the Alexa Skills Kit SDK, hosted by this server.
// Selling works by voice from the start: "what's my porch bench worth?", "do you still need it?",
// "no", a price, a lowest price, and Alexa opens the shop (address from the Alexa account, with the
// person's permission) and lists it; the porch camera takes the photo when they say "it's out".
// A shop opened on the website links by saying the 6-digit code from its page. Then:
//   "Alexa, ask stoop shop if I have any offers."  "Yes."  "Alexa, ask stoop shop how my sale is going."
// Every answer comes from the shop's own MCP tools, called the way an Alexa-style client calls them:
// no MCP session and no elicitation, so an action that needs the owner's yes comes back as
// approval_required, Alexa asks, and the next "yes" is sent as confirm_action.
import { randomInt } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as Alexa from "ask-sdk-core";
import type { RequestEnvelope, ResponseEnvelope } from "ask-sdk-model";
import { mcpCall, type ToolOut } from "./inproc.ts";
import { inSentence } from "@stoop/shared";

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
  /** Links an Alexa account to the shop it just opened by voice. */
  linkSeller(userId: string, link: { shop: string; token: string; name: string }) {
    this.users.set(userId, { kind: "seller", ...link });
    this.save();
  }
  unlink(userId: string) {
    this.users.delete(userId);
    this.save();
  }
  private save() {
    if (this.file) writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.users)), { mode: 0o600 });
  }
}

/** A price for something described out loud (before or after there's a shop to keep it in). */
export interface Quote {
  title: string;
  listMinor: number;
  floorSuggestionMinor: number;
  priceSource: "comps" | "ai-estimate" | "none";
  blocked: boolean;
  blockedReason?: string;
}

/** What selling by voice needs from the server when the person has no shop yet. */
export interface ShopMaker {
  quote(description: string): Promise<Quote | undefined>;
  /** Opens a shop; the address is encrypted on arrival and a buyer sees it only on their pickup pass. */
  open(input: { displayName: string; address: string; zip: string; porchInstructions: string }, who: string): Promise<{ shop: string; token: string; name: string } | { error: string }>;
  /** A one-time code (10 minutes) that turns an old phone into this shop's porch camera. */
  cameraCode(shop: string, token: string): Promise<{ code: string; url: string } | undefined>;
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

const SELLER_TOOLS = new Set(["my_items", "describe_item", "photograph_item", "list_items", "set_mandate", "review_offers", "respond_to_offer", "set_pickup_preferences", "handoff_status", "get_receipt", "confirm_pickup", "cancel_sale", "confirm_action"]);
const LINK_FIRST = "You don’t have a Stoop shop on this Alexa yet. Tell me something to sell, like: sell my porch bench, and I’ll set one up. Or, for a shop you opened on the Stoop website, tap Get a Code there and tell me the six digits.";
const ADDRESS_PERMISSION = "read::alexa:device:all:address";
const OUT_HINT = "When it’s on your porch, say: it’s out, and your porch camera will take its photo. No camera yet? Say: set up my camera.";
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
  // selling by voice, one step at a time
  sell?: {
    step: "offer" | "price" | "floor" | "name" | "address" | "zip" | "confirm_address" | "approve_list" | "approve_floor" | "out";
    description: string;
    title: string;
    listMinor: number;
    floorSuggestionMinor: number;
    priceSource: Quote["priceSource"];
    askMinor?: number;
    floorMinor?: number;
    itemId?: string;
    name?: string;
    address?: string;
    zip?: string;
  };
};

export function createStoopSkill(o: { skillId?: string; links: AlexaLinks; shop(id: string): ShopHandle | undefined; street?: StreetAccess; maker?: ShopMaker; fetch?: typeof fetch }) {
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
    `${i === 0 ? (n === 1 ? "I found one" : `I found ${n}. The first`) : "Next"}: the ${inSentence(r.title)} for ${$(r.askMinor)}, porch pickup in ${zipSaid(r.zip)}, from ${r.shopName.replace("’", "'")}${r.rating.verified ? `, with ${r.rating.verified} verified pickup${r.rating.verified === 1 ? "" : "s"}` : ""}. Want to make an offer${i < n - 1 ? ", or hear the next one" : ""}?`;
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


  // ---------------------------------------------------------------- selling by voice, start to finish
  type Sell = NonNullable<Attrs["sell"]>;
  type Linked = { link: Extract<Link, { shop: string }>; handle: ShopHandle };
  const sellAt = (h: Input, ...steps: Sell["step"][]) => {
    const s = attrs(h).sell;
    return s && steps.includes(s.step) ? s : undefined;
  };
  const art = (name: string) => (/^[aeiou]/i.test(name) ? "an" : "a");
  // "Porch Bench" is title case from the model, not a brand: say it in lower case
  const spoken = (title: string) => (/^[A-Z][a-z]+(?: [A-Z][a-z]+)*$/.test(title) ? title.toLowerCase() : inSentence(title));
  const estimate = (q: Quote) => {
    const name = spoken(q.title);
    if (q.priceSource === "none") return `I don’t have prices for ${art(name)} ${name} yet.`;
    if (q.priceSource === "ai-estimate") return `I’d estimate ${art(name)} ${name} like yours sells for about ${$(q.listMinor)} secondhand. That’s an AI estimate.`;
    const lead = art(name);
    return `${lead.charAt(0).toUpperCase()}${lead.slice(1)} ${name} like yours goes for about ${$(q.listMinor)} secondhand.`;
  };
  /** The seller's shop when this Alexa has one (a closed shop is unlinked on the way). */
  const ownShop = (h: Input): Linked | undefined => {
    if (!o.links.get(userId(h))) return undefined;
    const l = linked(h);
    return "say" in l ? undefined : l;
  };
  const NEXT: Record<Sell["step"], string> = {
    offer: "Do you still need it?",
    price: "What price should I list it at?",
    floor: "What’s the lowest price you’d take?",
    name: "What’s your first name?",
    address: "Say: my address is, then your street and ZIP code. Or allow your address in the Alexa app and say continue.",
    zip: "What’s your ZIP code?",
    confirm_address: "Is that address right?",
    approve_list: ASK_YES,
    approve_floor: ASK_YES,
    out: OUT_HINT,
  };

  const voiceSell = async (h: Input, description: string | undefined, mode: "worth" | "sell") => {
    const a = attrs(h);
    if (buyer(h)) return speak(h, "This Alexa is set up for shopping, so I can’t sell from it yet.", true);
    if (!description) return speak(h, "What would you like to sell? Tell me what it is and what shape it’s in.", true, "What would you like to sell?");
    const shop = ownShop(h);
    let q: Quote | undefined;
    let itemId: string | undefined;
    if (shop) {
      const out = await callTool(shop.handle, shop.link.token, "describe_item", { description });
      if (out.isError) return speak(h, out.text, true);
      q = { title: out.data.title, listMinor: out.data.listMinor, floorSuggestionMinor: out.data.floorSuggestionMinor, priceSource: out.data.priceSource, blocked: out.data.blocked, blockedReason: out.data.blockedReason };
      itemId = out.data.itemId;
    } else if (o.maker) q = await o.maker.quote(description);
    else return speak(h, LINK_FIRST, true);
    if (!q) return speak(h, "Tell me what it is and what shape it’s in, like: my wooden porch bench, a few scratches.", true);
    if (q.blocked) {
      a.sell = undefined;
      return speak(h, q.blockedReason ?? `The ${inSentence(q.title)} can’t be resold.`, true);
    }
    const s: Sell = { step: "offer", description, title: q.title, listMinor: q.listMinor, floorSuggestionMinor: q.floorSuggestionMinor, priceSource: q.priceSource, itemId };
    a.sell = s;
    if (!q.listMinor) {
      s.step = "price";
      return speak(h, `${estimate(q)} What would you like to ask for it?`, true, NEXT.price);
    }
    if (mode === "worth") return speak(h, `${estimate(q)} Do you still need it?`, true, "Do you still need it, or should I sell it for you?");
    s.step = "price";
    return speak(h, `${estimate(q)} Should I list it at ${$(q.listMinor)}, or another price?`, true, `Should I list it at ${$(q.listMinor)}?`);
  };

  const askPrice = (h: Input, s: Sell) => {
    s.step = "price";
    return speak(h, `Okay, I can sell it for you. Should I list it at ${$(s.listMinor)}, or another price?`, true, `Should I list it at ${$(s.listMinor)}?`);
  };
  const setAsk = (h: Input, s: Sell, minor: number) => {
    s.askMinor = minor;
    s.step = "floor";
    const tip = s.floorSuggestionMinor > 0 && s.floorSuggestionMinor < minor ? s.floorSuggestionMinor : Math.max(100, Math.round((minor * 0.75) / 500) * 500);
    return speak(h, `${$(minor)} it is. What’s the lowest you’d take? I’ll never go below it without asking you. Many sellers pick about ${$(tip)}.`, true, NEXT.floor);
  };
  const listNow = async (h: Input, l: Linked, s: Sell, lead: string) => {
    const a = attrs(h);
    if (!s.itemId) {
      const d = await callTool(l.handle, l.link.token, "describe_item", { description: s.description });
      if (d.isError) return speak(h, d.text, true);
      s.itemId = d.data.itemId;
      s.title = d.data.title;
    }
    const out = await callTool(l.handle, l.link.token, "list_items", { items: [s.itemId], askDollars: (s.askMinor ?? s.listMinor) / 100 });
    if (out.data.kind === "approval_required" && out.data.pendingActionId) {
      a.pendingApprovalId = out.data.pendingActionId;
      s.step = "approve_list";
      return speak(h, `${lead}${out.text}`, true, ASK_YES);
    }
    return speak(h, `${lead}${out.text}`, true);
  };
  const setFloor = async (h: Input, s: Sell, minor: number | undefined) => {
    if (minor !== undefined && minor > (s.askMinor ?? s.listMinor)) return speak(h, `That’s more than your asking price of ${$(s.askMinor ?? s.listMinor)}. What’s the lowest you’d take?`, true, NEXT.floor);
    s.floorMinor = minor;
    const lead = minor === undefined ? "Okay, I’ll check every offer with you. " : "";
    const l = ownShop(h);
    if (l) return listNow(h, l, s, lead);
    if (!o.maker) return speak(h, LINK_FIRST, true);
    s.step = "name";
    return speak(h, `${lead}Last thing: let’s set up your Stoop shop. What’s your first name?`, true, NEXT.name);
  };

  /** The address on this Alexa device, if the person allowed Stoop to read it. */
  const deviceAddress = async (h: Input) => {
    const sys = h.requestEnvelope.context?.System;
    const access = sys?.apiAccessToken;
    const device = sys?.device?.deviceId;
    if (!access || !device || !sys?.apiEndpoint) return undefined;
    try {
      const r = await (o.fetch ?? fetch)(`${sys.apiEndpoint}/v1/devices/${encodeURIComponent(device)}/settings/address`, { headers: { Authorization: `Bearer ${access}`, Accept: "application/json" } });
      if (!r.ok) return undefined;
      const j = (await r.json()) as Record<string, string | null | undefined>;
      const zip = (j.postalCode ?? "").replace(/\D/g, "").slice(0, 5);
      if (!j.addressLine1 || zip.length !== 5) return undefined;
      return { address: [j.addressLine1, j.addressLine2, j.city, j.stateOrRegion].filter(Boolean).join(", "), zip };
    } catch {
      return undefined;
    }
  };
  const askAddress = async (h: Input, s: Sell, lead: string) => {
    const found = await deviceAddress(h);
    if (found) {
      s.address = found.address;
      s.zip = found.zip;
      s.step = "confirm_address";
      return speak(h, `${lead}I’ll use the address set on this Alexa, in ZIP ${zipSaid(found.zip)}. Buyers see it only on their pickup pass, during their pickup window. Is that right?`, true, NEXT.confirm_address);
    }
    s.step = "address";
    return h.responseBuilder
      .speak(`${lead}I need your address so buyers can find your porch. They see it only on their pickup pass, during their window. You can let Stoop use this Alexa’s address in your Alexa app, then say continue. Or tell me your street address and ZIP code.`)
      .reprompt(NEXT.address)
      .withAskForPermissionsConsentCard([ADDRESS_PERMISSION])
      .getResponse();
  };

  const sellHandlers: Alexa.RequestHandler[] = [
    { canHandle: (h) => intent(h, "WorthIntent"), handle: (h) => voiceSell(h, slot(h, "thing"), "worth") },
    { canHandle: (h) => intent(h, "SellIntent"), handle: (h) => voiceSell(h, slot(h, "thing"), "sell") },
    // "Do you still need it?"  "No, I don't need it."  -> sell it.  "Yes" / "keep it" -> keep it.
    { canHandle: (h) => intent(h, "AMAZON.NoIntent", "SellItIntent") && !!sellAt(h, "offer"), handle: (h) => askPrice(h, attrs(h).sell!) },
    {
      canHandle: (h) => intent(h, "AMAZON.YesIntent", "KeepIntent") && !!sellAt(h, "offer"),
      handle: (h) => {
        attrs(h).sell = undefined;
        return speak(h, "Okay, keep it. Tell me whenever there’s something you’d like to sell.", true);
      },
    },
    { canHandle: (h) => intent(h, "AMAZON.YesIntent", "SellItIntent") && !!sellAt(h, "price") && attrs(h).sell!.listMinor > 0, handle: (h) => setAsk(h, attrs(h).sell!, attrs(h).sell!.listMinor) },
    { canHandle: (h) => intent(h, "AMAZON.NoIntent") && !!sellAt(h, "price"), handle: (h) => speak(h, "What price would you like?", true, NEXT.price) },
    { canHandle: (h) => intent(h, "AMAZON.NoIntent") && !!sellAt(h, "floor"), handle: (h) => setFloor(h, attrs(h).sell!, undefined) },
    {
      // a number means whatever the last question asked for: the price, the lowest price, or the ZIP
      canHandle: (h) => intent(h, "PriceIntent", "LinkShopIntent", "OfferIntent") && !!sellAt(h, "price", "floor", "zip"),
      handle: async (h) => {
        const s = attrs(h).sell!;
        const said = slot(h, "price") ?? slot(h, "code") ?? "";
        const n = Number(said.replace(/[^\d.]/g, ""));
        if (!(n > 0)) return speak(h, NEXT[s.step], true);
        if (s.step === "price") return setAsk(h, s, Math.round(n * 100));
        if (s.step === "floor") return setFloor(h, s, Math.round(n * 100));
        const zip = said.replace(/\D/g, "").padStart(5, "0").slice(0, 5);
        s.zip = zip;
        s.step = "confirm_address";
        return speak(h, `I heard ${s.address}, ZIP ${zipSaid(zip)}. Is that right?`, true, NEXT.confirm_address);
      },
    },
    {
      canHandle: (h) => intent(h, "NameIntent") && !!sellAt(h, "name"),
      handle: (h) => {
        const s = attrs(h).sell!;
        const n = (slot(h, "name") ?? "").trim();
        if (!n) return speak(h, NEXT.name, true);
        s.name = n.charAt(0).toUpperCase() + n.slice(1);
        return askAddress(h, s, `Thanks, ${s.name}. `);
      },
    },
    { canHandle: (h) => intent(h, "ContinueIntent") && !!sellAt(h, "address"), handle: (h) => askAddress(h, attrs(h).sell!, "") },
    {
      canHandle: (h) => intent(h, "AddressIntent", "StreetAddressIntent") && !!sellAt(h, "address", "name", "confirm_address"),
      handle: (h) => {
        const s = attrs(h).sell!;
        if (s.step === "name") return speak(h, NEXT.name, true);
        const said = (slot(h, "address") ?? slot(h, "street") ?? "").trim();
        if (!said) return speak(h, NEXT.address, true);
        const zip = /\b(\d{5})(?:-\d{4})?\b/.exec(said)?.[1];
        s.address = said.replace(/\b\d{5}(?:-\d{4})?\b/, "").replace(/[\s,]+$/, "").trim();
        if (!zip) {
          s.step = "zip";
          return speak(h, "And your ZIP code?", true, NEXT.zip);
        }
        s.zip = zip;
        s.step = "confirm_address";
        return speak(h, `I heard ${s.address}, ZIP ${zipSaid(zip)}. Is that right?`, true, NEXT.confirm_address);
      },
    },
    {
      // while Alexa waits for an address, an address heard as another intent ("12 Elm Street... 62704" as a price) is asked again, never acted on
      canHandle: (h) => intent(h, "MandateIntent", "PriceIntent", "ListIntent", "CommandIntent", "FindIntent", "AMAZON.FallbackIntent") && !!sellAt(h, "address"),
      handle: (h) => speak(h, `I didn’t catch your address. ${NEXT.address}`, true, NEXT.address),
    },
    {
      canHandle: (h) => intent(h, "AMAZON.YesIntent") && !!sellAt(h, "confirm_address"),
      handle: async (h) => {
        const s = attrs(h).sell!;
        if (!o.maker || !s.address || !s.zip) return speak(h, LINK_FIRST, true);
        const r = await o.maker.open({ displayName: s.name ?? "My", address: s.address, zip: s.zip, porchInstructions: "On the porch, by the front door." }, userId(h));
        if ("error" in r) return speak(h, r.error === "rate_limited" ? "You’ve opened several shops in the last hour. Please try again later." : "I couldn’t open your shop just now. Please try again in a minute.", true);
        o.links.linkSeller(userId(h), r);
        const l = ownShop(h);
        if (!l) return speak(h, "I couldn’t open your shop just now. Please try again in a minute.", true);
        s.itemId = undefined;
        return listNow(h, l, s, "Your shop is open. ");
      },
    },
    {
      canHandle: (h) => intent(h, "AMAZON.NoIntent") && !!sellAt(h, "confirm_address"),
      handle: (h) => {
        attrs(h).sell!.step = "address";
        return speak(h, "Okay. Tell me your street address and ZIP code.", true, NEXT.address);
      },
    },
    {
      // the owner's yes to the listing, then to the lowest price, one after the other
      canHandle: (h) => intent(h, "AMAZON.YesIntent", "SellItIntent") && !!sellAt(h, "approve_list", "approve_floor") && !!attrs(h).pendingApprovalId,
      handle: async (h) => {
        const a = attrs(h);
        const s = a.sell!;
        const l = ownShop(h);
        if (!l) return speak(h, LINK_FIRST, true);
        const done = await callTool(l.handle, l.link.token, "confirm_action", { approvalId: a.pendingApprovalId, decision: "accept" });
        a.pendingApprovalId = undefined;
        if (done.isError) {
          a.sell = undefined;
          return speak(h, done.text, true);
        }
        if (s.step === "approve_list" && s.floorMinor) {
          const m = await callTool(l.handle, l.link.token, "set_mandate", { item: s.title, floorDollars: s.floorMinor / 100 });
          if (m.data.kind === "approval_required" && m.data.pendingActionId) {
            a.pendingApprovalId = m.data.pendingActionId;
            s.step = "approve_floor";
            return speak(h, `${done.text} ${m.text}`, true, ASK_YES);
          }
          s.step = "out";
          return speak(h, `${done.text} ${m.text} ${OUT_HINT}`, true);
        }
        s.step = "out";
        return speak(h, `${done.text} ${OUT_HINT}`, true);
      },
    },
    {
      canHandle: (h) => intent(h, "AMAZON.NoIntent") && !!sellAt(h, "approve_list", "approve_floor") && !!attrs(h).pendingApprovalId,
      handle: async (h) => {
        const a = attrs(h);
        const l = ownShop(h);
        if (!l) return speak(h, LINK_FIRST, true);
        const out = await callTool(l.handle, l.link.token, "confirm_action", { approvalId: a.pendingApprovalId, decision: "decline" });
        a.pendingApprovalId = undefined;
        a.sell = undefined;
        return speak(h, out.text || "Okay.", true);
      },
    },
    {
      canHandle: (h) => intent(h, "ItsOutIntent"),
      handle: async (h) => {
        const l = linked(h);
        if ("say" in l) return speak(h, l.say, true);
        const s = attrs(h).sell;
        const out = await callTool(l.handle, l.link.token, "photograph_item", s?.itemId ? { item: s.itemId } : {});
        return speak(h, out.text, true);
      },
    },
    {
      canHandle: (h) => intent(h, "CameraIntent"),
      handle: async (h) => {
        const l = linked(h);
        if ("say" in l) return speak(h, l.say, true);
        const c = o.maker ? await o.maker.cameraCode(l.link.shop, l.link.token) : undefined;
        if (!c) return speak(h, "Set up your porch camera from your shop page on the Stoop website.", true);
        const digits = `<say-as interpret-as="digits">${c.code}</say-as>`;
        return h.responseBuilder
          .speak(`On an old phone, open the Stoop website and tap Porch Camera, then enter ${digits}. Again: ${digits}. It works once, for ten minutes, and it’s in your Alexa app too.`)
          .withSimpleCard("Stoop porch camera", `On an old phone, open ${c.url.split("#")[0]} and enter ${c.code}. The code works once, for ten minutes.`)
          .reprompt("What else can I do for your shop?")
          .getResponse();
      },
    },
    { canHandle: (h) => intent(h, "AMAZON.FallbackIntent") && !!attrs(h).sell, handle: (h) => speak(h, `Sorry, I didn’t catch that. ${NEXT[attrs(h).sell!.step]}`, true, NEXT[attrs(h).sell!.step]) },
  ];

  const handlers: Alexa.RequestHandler[] = [
    ...sellHandlers,
    ...buyerHandlers,
    {
      canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === "LaunchRequest",
      handle: (h) => {
        const l = linked(h);
        if ("say" in l)
          return speak(
            h,
            o.links.get(userId(h)) ? `Welcome to Stoop. ${l.say}` : "Welcome to Stoop. I sell things from your porch for you. Tell me what you’d like to sell, like: sell my porch bench, or ask what something’s worth.",
            true,
            "What would you like to sell?",
          );
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
      handle: async (h) => {
        const item = slot(h, "item");
        const price = Number(slot(h, "price"));
        if (!item) return speak(h, "Which item should I put up for sale?", true);
        const l = linked(h);
        if ("say" in l) return voiceSell(h, item, "sell");
        const out = await callTool(l.handle, l.link.token, "list_items", { items: [item], ...(price > 0 ? { askDollars: price } : {}) });
        // not something they photographed: price it from their words instead
        if (out.isError && out.data.code === "item_not_found") return voiceSell(h, item, "sell");
        return answer(h, out);
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
