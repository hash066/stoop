// The Stoop skill on a real Alexa, driven with Alexa Skills Kit request envelopes: link a shop with a
// code, hear the offer, say yes (twice: the offer, then the exact terms), follow the sale.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rulesOnlyChecker } from "@stoop/agents";
import { createSandboxServer } from "../src/sandboxes.ts";
import { ROOT } from "./harness.ts";

const ORIGIN = "http://stoop.test";
const SKILL = "amzn1.ask.skill.00000000-test";
const USER = "amzn1.ask.account.TESTUSER";
let stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops) s();
  stops = [];
});

async function server(over: Partial<Parameters<typeof createSandboxServer>[0]> = {}) {
  const s = await createSandboxServer({ rootDir: ROOT, origin: ORIGIN, dataDir: mkdtempSync(join(tmpdir(), "stoop-alexa-")), alexaSkillId: SKILL, alexaVerify: false, stackOverrides: { recallChecker: rulesOnlyChecker(), frameDelayScale: 0 }, ...over });
  stops.push(s.stop);
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => s.app.fetch(new Request(ORIGIN + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }));
  return { s, post };
}

let n = 0;
const envelope = (request: Record<string, unknown>, attributes: Record<string, unknown> = {}, applicationId = SKILL) => ({
  version: "1.0",
  session: { new: false, sessionId: "amzn1.echo-api.session.test", application: { applicationId }, user: { userId: USER }, attributes },
  context: { System: { application: { applicationId }, user: { userId: USER }, device: { deviceId: "amzn1.ask.device.test", supportedInterfaces: {} }, apiEndpoint: "https://api.amazonalexa.com" } },
  request: { requestId: `amzn1.echo-api.request.${++n}`, timestamp: new Date().toISOString(), locale: "en-US", ...request },
});
const intent = (name: string, slots: Record<string, string> = {}) => ({
  type: "IntentRequest",
  intent: { name, confirmationStatus: "NONE", slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, { name: k, value: v, confirmationStatus: "NONE" }])) },
});
type Said = { speech: string; attrs: Record<string, any>; end?: boolean; card?: string };
async function say(post: (p: string, b: unknown) => Promise<Response>, request: Record<string, unknown>, attrs: Record<string, unknown> = {}): Promise<Said> {
  const res = await post("/alexa", envelope(request, attrs));
  expect(res.status).toBe(200);
  const j = (await res.json()) as { response: { outputSpeech?: { ssml?: string }; shouldEndSession?: boolean; card?: { type: string } }; sessionAttributes?: Record<string, unknown> };
  return { speech: (j.response.outputSpeech?.ssml ?? "").replace(/<\/?speak>/g, ""), attrs: j.sessionAttributes ?? {}, end: j.response.shouldEndSession, card: j.response.card?.type };
}

/** Stateless MCP call into a shop, as the tests elsewhere do. */
async function tool(post: (p: string, b: unknown, h?: Record<string, string>) => Promise<Response>, shop: string, role: string, token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await post(`/s/${shop}/mcp/${role}`, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" });
  const raw = await res.text();
  const msg = JSON.parse(raw.startsWith("{") ? raw : (raw.split("\n").find((l) => l.startsWith("data:")) ?? "data:{}").slice(5));
  const data = msg.result?.structuredContent ?? {};
  if (data.kind === "approval_required") return tool(post, shop, role, token, "confirm_action", { approvalId: data.pendingActionId, decision: "accept" });
  return { text: (msg.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join(" "), data };
}

describe("the Stoop skill on Alexa", () => {
  it("sells by voice from nothing: worth, keep or sell, price, lowest, a shop at the Alexa address, then the porch photo", async () => {
    let allowed = false;
    const addressApi = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.amazonalexa.com/v1/devices/amzn1.ask.device.test/settings/address");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer alexa-api-token");
      if (!allowed) return new Response("{}", { status: 403 });
      return Response.json({ addressLine1: "12 Elm St", city: "Springfield", stateOrRegion: "IL", postalCode: "62704-1234", countryCode: "US" });
    }) as typeof fetch;
    const present = { name: "stub", assess: async () => ({ presence: "present" as const, rationale: "stub", adapter: "stub" }) };
    const { s, post } = await server({ alexaFetch: addressApi, stackOverrides: { recallChecker: rulesOnlyChecker(), frameDelayScale: 0, vision: present } });
    const ask = async (request: Record<string, unknown>, attrs: Record<string, unknown> = {}) => {
      const env = envelope(request, attrs);
      (env.context.System as Record<string, unknown>).apiAccessToken = "alexa-api-token";
      const res = await post("/alexa", env);
      const j = (await res.json()) as { response: { outputSpeech?: { ssml?: string }; card?: { type: string; content?: string } }; sessionAttributes?: Record<string, any> };
      return { speech: (j.response.outputSpeech?.ssml ?? "").replace(/<\/?speak>/g, ""), attrs: j.sessionAttributes ?? {}, card: j.response.card };
    };

    // "What's my jogging stroller worth?" ... "Do you still need it?" "Yes" keeps it
    let r = await ask(intent("WorthIntent", { thing: "my old jogging stroller, barely used" }));
    expect(r.speech).toMatch(/goes for about \$\d+ secondhand\. Do you still need it\?/);
    expect((await ask(intent("AMAZON.YesIntent"), r.attrs)).speech).toMatch(/keep it/);

    // ... "No, I don't need it" sells it
    r = await ask(intent("WorthIntent", { thing: "my old jogging stroller, barely used" }));
    r = await ask(intent("SellItIntent"), r.attrs);
    expect(r.speech).toMatch(/Should I list it at \$\d+, or another price\?/);
    r = await ask(intent("PriceIntent", { price: "120" }), r.attrs);
    expect(r.speech).toMatch(/\$120 it is\. What’s the lowest you’d take\?/);
    expect((await ask(intent("PriceIntent", { price: "150" }), r.attrs)).speech).toMatch(/more than your asking price/);
    r = await ask(intent("LinkShopIntent", { code: "90" }), r.attrs); // a bare number is the answer to the last question
    expect(r.speech).toMatch(/set up your Stoop shop\. What’s your first name\?/);

    // no address permission yet: Alexa asks for it (a card in the Alexa app) or a spoken address
    r = await ask(intent("NameIntent", { name: "ana" }), r.attrs);
    expect(r.speech).toMatch(/Thanks, Ana\. I need your address/);
    expect(r.card?.type).toBe("AskForPermissionsConsent");
    allowed = true;
    r = await ask(intent("ContinueIntent"), r.attrs);
    expect(r.speech).toMatch(/address set on this Alexa, in ZIP <say-as interpret-as="digits">62704<\/say-as>.*only on their pickup pass/);
    expect(r.speech).not.toMatch(/Elm/); // the street isn't read out loud

    // "Yes": the shop opens and the listing waits for the owner's yes, then the lowest price does
    r = await ask(intent("AMAZON.YesIntent"), r.attrs);
    expect(r.speech).toMatch(/^Your shop is open\. List the three-wheel jogging stroller at \$120\?.*Say yes to approve/);
    r = await ask(intent("AMAZON.YesIntent"), r.attrs);
    expect(r.speech).toMatch(/live at \$120.*Never sell the three-wheel jogging stroller below \$90/);
    r = await ask(intent("AMAZON.YesIntent"), r.attrs);
    expect(r.speech).toMatch(/say: it’s out/);
    const sellAttrs = r.attrs;

    // a real shop now: Ana's, at the Alexa address, with the listing live and no photo yet
    const shop = [...s.worlds.values()].find((w) => w.kind === "shop")!;
    const store = (await (await s.app.fetch(new Request(`${ORIGIN}/s/${shop.id}/web/storefront`))).json()) as { displayName: string; zip: string; listings: Array<{ title: string; askMinor: number; photoUrl?: string }> };
    expect(store).toMatchObject({ displayName: "Ana", zip: "62704", listings: [{ title: "Three-wheel jogging stroller", askMinor: 120_00 }] });
    expect(store.listings[0]!.photoUrl).toBeUndefined();
    expect((await ask(intent("OffersIntent"))).speech).not.toMatch(/six digits/); // this Alexa is linked to it

    // "It's out" before there's a camera; "set up my camera" gives a one-time code for an old phone
    expect((await ask(intent("ItsOutIntent"), sellAttrs)).speech).toMatch(/porch camera isn.t set up yet/);
    r = await ask(intent("CameraIntent"));
    const code = /interpret-as="digits">(\d{6})</.exec(r.speech)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    expect(r.card?.content).toContain(`${ORIGIN}/camera and enter ${code}`);
    expect((await post("/api/camera/pair", { code: "000000" })).status).toBe(404);
    const paired = (await (await post("/api/camera/pair", { code })).json()) as { shop: string; camToken: string };
    expect(paired).toMatchObject({ shop: shop.id, camToken: expect.stringMatching(/^ck_/) });
    expect((await post("/api/camera/pair", { code })).status).toBe(404); // works once

    // the camera phone sends what it sees; "It's out" puts that photo on the listing
    const jpeg = `data:image/jpeg;base64,${Buffer.from("porch with a stroller").toString("base64")}`;
    expect((await post(`/s/${shop.id}/web/cam/frame`, { dataUrl: jpeg }, { Authorization: `Bearer ${paired.camToken}` })).status).toBe(200);
    expect((await ask(intent("ItsOutIntent"), sellAttrs)).speech).toMatch(/has its photo now/);
    const after = (await (await s.app.fetch(new Request(`${ORIGIN}/s/${shop.id}/web/storefront`))).json()) as { listings: Array<{ photoUrl?: string }> };
    expect(after.listings[0]!.photoUrl).toMatch(new RegExp(`^${ORIGIN}/s/${shop.id}/photos/`));
  });

  it("prices things it has no comparables for by asking the owner, and takes a spoken address", async () => {
    const { post } = await server({ alexaFetch: (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch });
    let r = await say(post, intent("SellIntent", { thing: "the wooden bench on my porch" }));
    expect(r.speech).toMatch(/I don’t have prices for a wooden bench yet\. What would you like to ask for it\?/);
    r = await say(post, intent("PriceIntent", { price: "40" }), r.attrs);
    r = await say(post, intent("AMAZON.NoIntent"), r.attrs); // no lowest price: every offer comes to the owner
    expect(r.speech).toMatch(/check every offer with you.*first name/);
    r = await say(post, intent("NameIntent", { name: "bo" }), r.attrs);
    r = await say(post, intent("AddressIntent", { address: "40 Oak Ave Springfield Illinois" }), r.attrs);
    expect(r.speech).toMatch(/And your ZIP code\?/);
    r = await say(post, intent("LinkShopIntent", { code: "62711" }), r.attrs);
    expect(r.speech).toMatch(/I heard 40 Oak Ave Springfield Illinois, ZIP <say-as interpret-as="digits">62711<\/say-as>\. Is that right\?/);
    r = await say(post, intent("AMAZON.YesIntent"), r.attrs);
    expect(r.speech).toMatch(/Your shop is open\. List the wooden bench at \$40\?/);
  });

  it("links a shop by code, reads the offer, and accepts it with two spoken yeses", async () => {
    const { post } = await server();
    const shop = (await (await post("/api/shops", { displayName: "Ana", address: "12 Elm St, Springfield, IL", zip: "62704", porchInstructions: "Bench" })).json()) as { id: string; sellerToken: string };
    const seller = shop.sellerToken;
    await post(`/s/${shop.id}/sweep`, { photos: [{ name: "jogging-stroller.jpg", dataUrl: `data:image/jpeg;base64,${Buffer.from("stroller").toString("base64")}` }] }, { Authorization: `Bearer ${seller}` });
    await tool(post, shop.id, "seller", seller, "appraise_photos");
    await tool(post, shop.id, "seller", seller, "list_items", { items: ["stroller"] });
    await tool(post, shop.id, "seller", seller, "set_mandate", { item: "stroller", floorDollars: 90 });
    const buyer = ((await (await post(`/s/${shop.id}/web/buyer`, { displayName: "Ben", purchaseCode: "2580" })).json()) as { buyerToken: string }).buyerToken;
    const listingId = (await tool(post, shop.id, "buyer", buyer, "search_listings", { query: "stroller" })).data.results[0].listingId;
    await tool(post, shop.id, "buyer", buyer, "make_offer", { listingId, amountDollars: 95 });

    // not linked yet: Alexa explains how
    expect((await say(post, { type: "LaunchRequest" })).speech).toMatch(/sell my porch bench/);
    expect((await say(post, intent("OffersIntent"))).speech).toMatch(/six digits/);

    // the code from the shop page (only for that shop's own seller token)
    expect((await post("/api/alexa/pair", { shop: shop.id, token: "sk_wrong" })).status).toBe(401);
    const { code } = (await (await post("/api/alexa/pair", { shop: shop.id, token: seller })).json()) as { code: string };
    expect(code).toMatch(/^\d{6}$/);
    expect((await say(post, intent("LinkShopIntent", { code: "123" }))).speech).toMatch(/didn’t work/);
    expect((await say(post, intent("LinkShopIntent", { code }))).speech).toMatch(/connected to Ana’s shop/);
    expect((await say(post, intent("LinkShopIntent", { code }))).speech).toMatch(/didn’t work/); // single use

    // "Alexa, ask stoop shop if I have any offers"
    const offers = await say(post, intent("OffersIntent"));
    expect(offers.speech).toMatch(/offers \$95 for the .*stroller.*Accept\?/i);
    expect(offers.attrs.pendingOfferApprovalId).toBeTruthy();
    expect(offers.end).toBeFalsy();

    // "Yes": the exact terms come back for a second yes (fee and payout spelled out)
    const terms = await say(post, intent("AMAZON.YesIntent"), offers.attrs);
    expect(terms.speech).toMatch(/Sell the .* for \$95\? You get \$90\.25/);
    expect(terms.attrs.pendingApprovalId).toBeTruthy();
    const done = await say(post, intent("AMAZON.YesIntent"), terms.attrs);
    expect(done.speech).toMatch(/Accepted at \$95/);
    expect(done.attrs.pendingApprovalId).toBeFalsy();

    // "Alexa, ask stoop shop how my sale is going" / "what am I selling" / lowest price by voice
    expect((await say(post, intent("StatusIntent"))).speech).toMatch(/buyer|payment|pickup/i);
    expect((await say(post, intent("ItemsIntent"))).speech).toMatch(/You have 1 thing/);
    const linked = await say(post, { type: "LaunchRequest" });
    expect(linked.speech).toMatch(/Welcome back to Ana’s shop/);
  }, 30_000);

  it("shops by voice: find, offer, buy, and the purchase code over $100", async () => {
    const { post } = await server();
    const shop = (await (await post("/api/shops", { displayName: "Ana", address: "12 Elm St, Springfield, IL", zip: "62704", porchInstructions: "Bench" })).json()) as { id: string; sellerToken: string };
    const seller = shop.sellerToken;
    await post(`/s/${shop.id}/sweep`, { photos: [{ name: "jogging-stroller.jpg", dataUrl: `data:image/jpeg;base64,${Buffer.from("stroller").toString("base64")}` }] }, { Authorization: `Bearer ${seller}` });
    await tool(post, shop.id, "seller", seller, "appraise_photos");
    await tool(post, shop.id, "seller", seller, "list_items", { items: ["stroller"] });
    await tool(post, shop.id, "seller", seller, "set_mandate", { item: "stroller", floorDollars: 90 });

    // a buyer profile on the website, linked to this Alexa with a code
    const me = (await (await post("/api/profile", { name: "Ben", purchaseCode: "2580" })).json()) as { token: string };
    const { code } = (await (await post("/api/profile/alexa", {}, { Authorization: `Bearer ${me.token}` })).json()) as { code: string };
    expect((await say(post, intent("FindIntent", { query: "a stroller" }))).speech).toMatch(/Your Stoop/);
    expect((await say(post, intent("LinkShopIntent", { code }))).speech).toMatch(/set up to shop, Ben/);

    const found = await say(post, intent("FindIntent", { query: "a jogging stroller under a hundred and fifty dollars" }));
    expect(found.speech).toMatch(/I found one: the three-wheel jogging stroller for \$120, porch pickup in <say-as interpret-as="digits">62704<\/say-as>, from Ana's porch/);
    const offered = await say(post, intent("OfferIntent", { price: "110" }), found.attrs);
    expect(offered.speech).toMatch(/\$110 could work/);
    await tool(post, shop.id, "seller", seller, "respond_to_offer", { decision: "accept" });

    const terms = await say(post, intent("BuyIntent"), offered.attrs);
    expect(terms.speech).toMatch(/Pay \$1\d\d\.\d\d for the three-wheel jogging stroller\?.*purchase code/);
    const ask = await say(post, intent("AMAZON.YesIntent"), terms.attrs);
    expect(ask.speech).toMatch(/four digit purchase code/);
    const paid = await say(post, intent("LinkShopIntent", { code: "2580" }), ask.attrs);
    expect(paid.speech).toMatch(/held, not charged, until your pickup is verified/);
  }, 30_000);

  it("a wrong purchase code charges nothing", async () => {
    const { post } = await server();
    const shop = (await (await post("/api/shops", { displayName: "Ana", address: "12 Elm St, Springfield, IL", zip: "62704", porchInstructions: "Bench" })).json()) as { id: string; sellerToken: string };
    await post(`/s/${shop.id}/sweep`, { photos: [{ name: "hybrid-bike.jpg", dataUrl: `data:image/jpeg;base64,${Buffer.from("bike").toString("base64")}` }] }, { Authorization: `Bearer ${shop.sellerToken}` });
    await tool(post, shop.id, "seller", shop.sellerToken, "appraise_photos");
    await tool(post, shop.id, "seller", shop.sellerToken, "list_items", { items: ["bike"] });
    await tool(post, shop.id, "seller", shop.sellerToken, "set_mandate", { item: "bike", floorDollars: 150, autoAcceptAboveDollars: 150 });
    const me = (await (await post("/api/profile", { name: "Ben", purchaseCode: "2580" })).json()) as { token: string };
    const { code } = (await (await post("/api/profile/alexa", {}, { Authorization: `Bearer ${me.token}` })).json()) as { code: string };
    await say(post, intent("LinkShopIntent", { code }));
    const found = await say(post, intent("FindIntent", { query: "a bike" }));
    const terms = await say(post, intent("BuyIntent"), found.attrs); // full price, auto-accepted by the seller's rules
    expect(terms.speech).toMatch(/purchase code/);
    const ask = await say(post, intent("AMAZON.YesIntent"), terms.attrs);
    expect((await say(post, intent("LinkShopIntent", { code: "1111" }), ask.attrs)).speech).toMatch(/didn.t match, so nothing was charged/);
  }, 30_000);

  it("refuses requests for another skill, unsigned requests, and runs nothing when the skill is off", async () => {
    const { post } = await server();
    expect((await post("/alexa", envelope({ type: "LaunchRequest" }, {}, "amzn1.ask.skill.someone-else"))).status).toBe(400);

    const signed = await server({ alexaVerify: true });
    expect((await signed.post("/alexa", envelope({ type: "LaunchRequest" }))).status).toBe(400);

    const off = await server({ alexaSkillId: undefined });
    expect((await off.post("/alexa", envelope({ type: "LaunchRequest" }))).status).toBe(404);
    expect((await off.post("/api/alexa/pair", { shop: "x", token: "y" })).status).toBe(404);
  });
});
