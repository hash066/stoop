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
type Said = { speech: string; attrs: Record<string, unknown>; end?: boolean };
async function say(post: (p: string, b: unknown) => Promise<Response>, request: Record<string, unknown>, attrs: Record<string, unknown> = {}): Promise<Said> {
  const res = await post("/alexa", envelope(request, attrs));
  expect(res.status).toBe(200);
  const j = (await res.json()) as { response: { outputSpeech?: { ssml?: string }; shouldEndSession?: boolean }; sessionAttributes?: Record<string, unknown> };
  return { speech: (j.response.outputSpeech?.ssml ?? "").replace(/<\/?speak>/g, ""), attrs: j.sessionAttributes ?? {}, end: j.response.shouldEndSession };
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
    expect((await say(post, { type: "LaunchRequest" })).speech).toMatch(/six digit code/);
    expect((await say(post, intent("OffersIntent"))).speech).toMatch(/six digit code/);

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
