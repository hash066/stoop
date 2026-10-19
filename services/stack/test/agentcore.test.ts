// The negotiating agent as it runs on Bedrock AgentCore Runtime: its handler talks to the shop only
// through the negotiation port, with a one-time grant for one negotiation.
import { describe, expect, it } from "vitest";
import { AgentCoreNegotiator, PortGrants } from "../src/agentcore.ts";
import { bootStack, http } from "./harness.ts";
import type { Stack } from "../src/index.ts";

process.env.STOOP_RUNTIME_NO_LISTEN = "1";
const { handle } = await import("../../negotiator-runtime/src/server.ts");

async function setup() {
  const stack = await bootStack({ seedDemo: false, frameSource: "porchcam" });
  const seller = (await http(stack, "POST", "/web/shop", { displayName: "Ana", address: "12 Elm St, Springfield, IL", zip: "62704", porchInstructions: "Bench" })).json.sellerToken as string;
  const call = async (role: string, token: string, name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const r = await http(stack, "POST", `/mcp/${role}`, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" });
    const d = r.json?.result?.structuredContent ?? {};
    return d.kind === "approval_required" ? call(role, token, "confirm_action", { approvalId: d.pendingActionId, decision: "accept" }) : d;
  };
  await http(stack, "POST", "/sweep", { photos: [{ name: "jogging-stroller.jpg", dataUrl: `data:image/jpeg;base64,${Buffer.from("x").toString("base64")}` }] }, { Authorization: `Bearer ${seller}` });
  await call("seller", seller, "appraise_photos");
  const listingId = (await call("seller", seller, "list_items", { items: ["stroller"] })).listings[0].listingId as string;
  await call("seller", seller, "set_mandate", { item: listingId, floorDollars: 90 });
  const buyer = (await http(stack, "POST", "/web/buyer", { displayName: "Ben", purchaseCode: "2580" })).json.buyerId as string;
  const n = await stack.settlement.openNegotiation(listingId, buyer);
  const portFetch = (async (url: string | URL | Request, init?: RequestInit) => stack.app.fetch(new Request(url, init))) as typeof fetch;
  return { stack, n, listingId, portFetch };
}
const port = (stack: Stack, token: string, method: string, args: unknown[]) => http(stack, "POST", "/agent-port", { method, args }, { Authorization: `Bearer ${token}` });

describe("negotiator on AgentCore Runtime", () => {
  it("negotiates through the one-time port and records the offer in the shop", async () => {
    const { stack, n, listingId, portFetch } = await setup();
    try {
      const token = stack.portGrants.issue(n.id, listingId);
      const out = await handle({ input: { negotiationId: n.id, buyerText: "Would you take $95?", offerMinor: 95_00 }, port: { url: "http://stoop.test/agent-port", token } }, portFetch);
      expect(out.action).toBe("awaiting_seller");
      expect(out.reply).toMatch(/\$95 could work/);
      const after = await stack.settlement.getNegotiation(n.id);
      expect(after.offers[0]).toMatchObject({ by: "buyer", amountMinor: 95_00 });
      expect(after.state).toBe("AGREED_PENDING_SELLER");
    } finally {
      stack.stop();
    }
  });

  it("the port opens one negotiation only, and only with a live grant", async () => {
    const { stack, n, listingId } = await setup();
    try {
      const token = stack.portGrants.issue(n.id, listingId);
      expect((await port(stack, "np_nope", "getNegotiation", [n.id])).status).toBe(401);
      expect((await port(stack, token, "getNegotiation", ["neg_someone_else"])).status).toBe(403);
      expect((await port(stack, token, "getListing", ["lst_other"])).status).toBe(403);
      expect((await port(stack, token, "deleteEverything", [n.id])).status).toBe(400);
      const listing = (await port(stack, token, "getListing", [listingId])).json.result;
      expect(JSON.stringify(listing)).not.toMatch(/Elm St/); // no address through the port
      const oracle = (await port(stack, token, "oracle", [n.id, 50_00])).json.result;
      expect(oracle).not.toHaveProperty("floorMinor"); // the owner's lowest price never crosses
      stack.portGrants.revoke(token);
      expect((await port(stack, token, "getNegotiation", [n.id])).status).toBe(401);
      let t = 0;
      const short = new PortGrants(() => t);
      const tok = short.issue(n.id, listingId, 1000);
      t = 2000;
      expect(short.get(tok)).toBeUndefined();
    } finally {
      stack.stop();
    }
  });

  it("falls back to the shop's own agent if AgentCore is down, but never acts twice", async () => {
    const { stack, n, listingId } = await setup();
    try {
      const make = () =>
        new AgentCoreNegotiator({ runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/test", region: "us-east-1", portUrl: "http://stoop.test/agent-port", settlement: stack.settlement, grants: stack.portGrants, local: stack.localNegotiator, bus: stack.bus, now: () => Date.now(), budget: () => true });
      const down = make();
      (down as unknown as { client: unknown }).client = { send: async () => { throw new Error("unreachable"); } };
      const local = await down.turn({ negotiationId: n.id, buyerText: "Would you take $95?", offerMinor: 95_00 });
      expect(local.action).toBe("awaiting_seller"); // the local agent answered
      // the remote agent touched the port, then failed: no second answer, nothing done twice
      const half = make();
      (half as unknown as { client: unknown }).client = {
        send: async (cmd: { input: { payload: Uint8Array } }) => {
          const { port: p } = JSON.parse(new TextDecoder().decode(cmd.input.payload)) as { port: { token: string } };
          await port(stack, p.token, "getNegotiation", [n.id]);
          throw new Error("timeout");
        },
      };
      const safe = await half.turn({ negotiationId: n.id, buyerText: "Any chance of $92?", offerMinor: 92_00 });
      expect(safe).toMatchObject({ action: "answered", usedFallback: true });
      expect((await stack.settlement.getNegotiation(n.id)).offers).toHaveLength(1);
    } finally {
      stack.stop();
    }
  });
});
