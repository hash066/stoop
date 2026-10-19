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

const SELLER_TOOLS = new Set(["my_items", "list_items", "set_mandate", "review_offers", "respond_to_offer", "set_pickup_preferences", "handoff_status", "get_receipt", "confirm_pickup", "cancel_sale", "confirm_action"]);
const LINK_FIRST = "To connect your shop, open it on the Stoop website, tap Connect Alexa, and tell me the six digit code.";
const ASK_YES = "Say yes to approve, or no to cancel.";

export function createStoopSkill(o: { skillId?: string; links: AlexaLinks; shop(id: string): ShopHandle | undefined }) {
  type Input = Alexa.HandlerInput;
  const attrs = (h: Input) => h.attributesManager.getSessionAttributes() as { pendingApprovalId?: string; pendingOfferApprovalId?: string };
  const userId = (h: Input) => Alexa.getUserId(h.requestEnvelope);
  const intent = (h: Input, ...names: string[]) => Alexa.getRequestType(h.requestEnvelope) === "IntentRequest" && names.includes(Alexa.getIntentName(h.requestEnvelope));
  const slot = (h: Input, name: string) => Alexa.getSlotValue(h.requestEnvelope, name) ?? undefined;
  const speak = (h: Input, text: string, keepOpen: boolean, reprompt?: string) => {
    const b = h.responseBuilder.speak(text).withSimpleCard("Stoop", text);
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

  const handlers: Alexa.RequestHandler[] = [
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
