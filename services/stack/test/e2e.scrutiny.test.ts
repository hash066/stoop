// Scrutiny path, end to end (plan §12.2): protocol hardening, Alexa-style clients, policy limits,
// and the handoff failure scenarios through the same endpoints the Ops scenario buttons use.
import { describe, expect, it } from "vitest";
import { DEMO, type Stack } from "../src/index.ts";
import { appFetch, BASE, bootStack, DANA, http, LEE, mcpClient, sc, SELLER, text, waitFor } from "./harness.ts";

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

async function rpc(stack: Stack, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await appFetch(stack)(`${BASE}${path}`, { method: "POST", headers: { ...MCP_HEADERS, ...headers }, body: JSON.stringify(body) });
  const raw = await res.text();
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    const data = raw.split("\n").find((l) => l.startsWith("data:"));
    json = data ? JSON.parse(data.slice(5)) : undefined;
  }
  return { status: res.status, headers: res.headers, json };
}

/** Seller lists the stroller (floor $90), Dana offers, seller approves, Dana pays; returns the deal at window open. */
async function dealAtWindow(stack: Stack, offerDollars = 95) {
  const seller = await mcpClient(stack, "seller", SELLER);
  const buyer = await mcpClient(stack, "buyer", DANA.token);
  await http(stack, "POST", "/sweep/demo", undefined, { Authorization: `Bearer ${SELLER}` });
  await seller.call("appraise_photos");
  await seller.call("list_items", { items: ["stroller"] });
  await seller.call("set_mandate", { item: "stroller", floorDollars: 90 });
  const listingId = sc<{ results: Array<{ listingId: string }> }>(await buyer.call("search_listings", { query: "stroller" })).results[0]!.listingId;
  await buyer.call("make_offer", { listingId, amountDollars: offerDollars });
  const dealId = sc<{ dealId: string }>(await seller.call("respond_to_offer", { decision: "accept" })).dealId;
  await buyer.call("checkout", {});
  await waitFor(async () => (await stack.settlement.getDeal(dealId)).passId, 3000, "pass", stack);
  await stack.tick();
  return { dealId, listingId, seller, buyer };
}

describe("MCP protocol hardening", () => {
  it("401 with RFC 9728 challenge, 403 bad Origin, 404 unknown session, negotiated 2025-11-25", async () => {
    const stack = await bootStack();
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
    const noAuth = await rpc(stack, "/mcp/seller", init);
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get("WWW-Authenticate")).toMatch(/resource_metadata=".*\/\.well-known\/oauth-protected-resource"/);
    expect((await http(stack, "GET", "/.well-known/oauth-protected-resource")).json.resource).toMatch(/\/mcp$/);
    expect((await rpc(stack, "/mcp/seller", init, { Authorization: `Bearer ${SELLER}`, Origin: "https://evil.example" })).status).toBe(403);
    expect((await rpc(stack, "/mcp/seller", init, { Authorization: `Bearer ${SELLER}`, "Mcp-Session-Id": "nope" })).status).toBe(404);
    const ok = await rpc(stack, "/mcp/seller", init, { Authorization: `Bearer ${SELLER}`, Origin: "http://localhost:5180" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("mcp-session-id")).toBeTruthy();
    expect(ok.json.result.protocolVersion).toBe("2025-11-25");
    // a buyer token can't use the seller endpoint
    expect((await rpc(stack, "/mcp/seller", init, { Authorization: `Bearer ${DANA.token}` })).status).toBe(401);
  });

  it("tools advertise MCP Apps cards and resources are served as text/html;profile=mcp-app", async () => {
    const stack = await bootStack();
    const seller = await mcpClient(stack, "seller", SELLER);
    const tools = await seller.client.listTools();
    const appraise = tools.tools.find((t) => t.name === "appraise_photos")!;
    const uri = (appraise._meta as { ui: { resourceUri: string } }).ui.resourceUri;
    expect(uri).toMatch(/^ui:\/\/stoop\/appraisal-grid@[0-9a-f]{10}$/);
    expect(appraise.outputSchema).toBeDefined();
    const res = await seller.client.readResource({ uri });
    expect(res.contents[0]).toMatchObject({ mimeType: "text/html;profile=mcp-app" });
    await seller.close();
  });
});

describe("X18 Alexa-style client: protocol 2025-03-26, no session id, no elicitation", () => {
  it("every tool works stateless; approvals go approval_required -> confirm_action", async () => {
    const stack = await bootStack();
    const auth = { Authorization: `Bearer ${SELLER}` };
    const init = await rpc(stack, "/mcp/seller", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Alexa+ MCP Client", version: "1" } } }, auth);
    expect(init.json.result.protocolVersion).toBe("2025-03-26");
    await http(stack, "POST", "/sweep/demo", undefined, auth);
    const call = (id: number, name: string, args: Record<string, unknown> = {}) =>
      rpc(stack, "/mcp/seller", { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, auth); // no session header
    const a = await call(2, "appraise_photos");
    expect(a.status).toBe(200);
    expect(a.json.result._meta.ui.resourceUri).toMatch(/^ui:\/\/stoop\/appraisal-grid@/); // in the RESULT, as Alexa expects
    const listed = await call(3, "list_items", { items: ["stroller"] });
    expect(listed.json.result.structuredContent.kind).toBe("approval_required");
    expect(listed.json.result.content[0].text).toMatch(/Say yes to approve/);
    const confirmed = await call(4, "confirm_action", { approvalId: listed.json.result.structuredContent.pendingActionId, decision: "accept" });
    expect(confirmed.json.result.content[0].text).toMatch(/is live at \$120/);
    expect(confirmed.json.result.content[0].text).not.toMatch(/[|*#`]/); // voice-safe
  });
});

describe("policy limits through MCP", () => {
  it("X17: over $100 needs the 4-digit purchase code; a wrong code charges nothing", async () => {
    let code = "0000";
    const stack = await bootStack();
    const seller = await mcpClient(stack, "seller", SELLER);
    const buyer = await mcpClient(stack, "buyer", DANA.token, (e) => ({ action: "accept", content: { confirm: true, ...(e.mode === "form" && /\$1[0-9]{2}/.test(e.message) ? { voiceCode: code } : {}) } }));
    await http(stack, "POST", "/sweep/demo", undefined, { Authorization: `Bearer ${SELLER}` });
    await seller.call("appraise_photos");
    await seller.call("list_items", { items: ["bike"] });
    const listingId = sc<{ results: Array<{ listingId: string }> }>(await buyer.call("search_listings", { query: "hybrid bike" })).results[0]!.listingId;
    expect(sc<{ action: string }>(await buyer.call("make_offer", { listingId, amountDollars: 180 })).action).toBe("awaiting_seller");
    const dealId = sc<{ dealId: string }>(await seller.call("respond_to_offer", { decision: "accept" })).dealId;
    const wrong = await buyer.call("checkout", {});
    expect(JSON.stringify(buyer.elicitations.at(-1)?.schema)).toMatch(/voiceCode/);
    expect(text(wrong)).toMatch(/purchase code didn't match/);
    expect((await stack.settlement.getDeal(dealId)).state).toBe("CHECKOUT_OPEN");
    code = "4821";
    expect(text(await buyer.call("checkout", {}))).toMatch(/held, not charged/);
    expect((await stack.settlement.getDeal(dealId)).holdId).toBeTruthy();
  });

  it("X3: scams are refused, two strikes block the buyer", async () => {
    const stack = await bootStack();
    const seller = await mcpClient(stack, "seller", SELLER);
    const buyer = await mcpClient(stack, "buyer", LEE.token);
    await http(stack, "POST", "/sweep/demo", undefined, { Authorization: `Bearer ${SELLER}` });
    await seller.call("appraise_photos");
    await seller.call("list_items", { items: ["mixer"] });
    const listingId = sc<{ results: Array<{ listingId: string }> }>(await buyer.call("search_listings", { query: "mixer" })).results[0]!.listingId;
    expect(sc<{ action: string }>(await buyer.call("ask_seller", { listingId, message: "Can I pay with Zelle?" })).action).toBe("refused");
    expect(sc<{ action: string }>(await buyer.call("ask_seller", { listingId, message: "I'll send an Apple gift card" })).action).toBe("blocked");
    const after = await buyer.call("make_offer", { listingId, amountDollars: 100 });
    expect(after.isError).toBe(true);
    expect(text(after)).toMatch(/blocked/i);
  });

  it("X5: two buyers above auto-accept at the same moment -> exactly one deal", async () => {
    const stack = await bootStack();
    const seller = await mcpClient(stack, "seller", SELLER);
    const dana = await mcpClient(stack, "buyer", DANA.token);
    const lee = await mcpClient(stack, "buyer", LEE.token);
    await http(stack, "POST", "/sweep/demo", undefined, { Authorization: `Bearer ${SELLER}` });
    await seller.call("appraise_photos");
    await seller.call("list_items", { items: ["stroller"] });
    await seller.call("set_mandate", { item: "stroller", floorDollars: 90, autoAcceptAboveDollars: 110 });
    const listingId = sc<{ results: Array<{ listingId: string }> }>(await dana.call("search_listings", { query: "stroller" })).results[0]!.listingId;
    const [a, b] = await Promise.all([dana.call("make_offer", { listingId, amountDollars: 115 }), lee.call("make_offer", { listingId, amountDollars: 118 })]);
    const accepted = [a, b].filter((r) => sc<{ action?: string }>(r)?.action === "accepted");
    expect(accepted).toHaveLength(1);
    expect((await stack.settlement.getListing(listingId)).state).toBe("RESERVED");
  });
});

describe("handoff scenarios (Ops buttons)", () => {
  it("golden scenario via the simulator -> INSPECTION", async () => {
    const stack = await bootStack();
    const { dealId } = await dealAtWindow(stack);
    const r = await http(stack, "POST", "/sim/scenario/golden", { dealId });
    expect(r.json.state).toBe("INSPECTION");
    expect(r.json.log.join(" ")).toMatch(/doorbell press -> 200/);
  });

  it("a bound Ring device: simulator events and scenes follow it, golden still verifies", async () => {
    const stack = await bootStack();
    const deviceId = "ava1.ring.device.TEST0001";
    const bound = await http(stack, "POST", "/ring/bind", { deviceId });
    expect(bound.json).toMatchObject({ ok: true, deviceId, frameSource: "our_footage" });
    expect((await stack.settlement.householdPublic(DEMO.household.id)).ringDeviceId).toBe(deviceId);
    const { dealId } = await dealAtWindow(stack);
    const r = await http(stack, "POST", "/sim/scenario/golden", { dealId });
    expect(r.json.state).toBe("INSPECTION");
    expect(r.json.log.join(" ")).toMatch(/doorbell press -> 200/);
  });

  it("Ring routes refuse without a token or a device id", async () => {
    const stack = await bootStack();
    expect((await http(stack, "GET", "/ring/snapshot/ava1.ring.device.X")).status).toBe(409);
    expect((await http(stack, "POST", "/ring/bind", {})).status).toBe(400);
  });

  it("X7 piracy: stranger takes it, no pass -> hold voided, never captured", async () => {
    const stack = await bootStack();
    const { dealId } = await dealAtWindow(stack);
    const r = await http(stack, "POST", "/sim/scenario/piracy", { dealId });
    expect(r.json.state).toBe("VOIDED");
    const d = await stack.settlement.getDeal(dealId);
    expect(d.verdict).toBe("PIRACY_SUSPECTED");
    expect((await stack.psp.get(d.holdId!))?.status).toBe("canceled");
  });

  it("X6 no-show: window closes -> voided and relisted", async () => {
    const stack = await bootStack();
    const { dealId, listingId } = await dealAtWindow(stack);
    expect((await http(stack, "POST", "/sim/scenario/no_show", { dealId })).json.state).toBe("VOIDED");
    expect((await stack.settlement.getListing(listingId)).state).toBe("LIVE");
  });

  it("X8 still there, X11 camera offline", async () => {
    const s1 = await bootStack();
    const d1 = await dealAtWindow(s1);
    expect((await http(s1, "POST", "/sim/scenario/still_there", { dealId: d1.dealId })).json.state).toBe("STILL_THERE");
    const s2 = await bootStack();
    const d2 = await dealAtWindow(s2);
    expect((await http(s2, "POST", "/sim/scenario/camera_offline", { dealId: d2.dealId })).json.state).toBe("DEGRADED");
  });

  it("X10 webhook replay / forgery / stale timestamps are rejected", async () => {
    const stack = await bootStack();
    const r = await http(stack, "POST", "/sim/scenario/replay_attack", {});
    const log = r.json.log.join("\n");
    expect(log).toMatch(/signed event -> 200/);
    expect(log).toMatch(/replayed -> .*duplicate/);
    expect(log).toMatch(/bad signature -> 401/);
    expect(log).toMatch(/stale -> 401/);
  });
});
