// Stoop Street: one marketplace across shops, and a buyer's agent that haggles with sellers' agents.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rulesOnlyChecker } from "@stoop/agents";
import { createSandboxServer } from "../src/sandboxes.ts";
import { ROOT } from "./harness.ts";

const ORIGIN = "http://stoop.test";
let stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops) s();
  stops = [];
});

async function boot() {
  const s = await createSandboxServer({ rootDir: ROOT, origin: ORIGIN, dataDir: mkdtempSync(join(tmpdir(), "stoop-street-")), agentTickMs: 3_600_000, stackOverrides: { recallChecker: rulesOnlyChecker(), frameDelayScale: 0 } });
  stops.push(s.stop);
  const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await s.app.fetch(new Request(ORIGIN + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));
    const text = await r.text();
    const json = text ? JSON.parse(text.startsWith("{") || text.startsWith("[") ? text : (text.split("\n").find((l) => l.startsWith("data:")) ?? "data:null").slice(5)) : undefined;
    return { status: r.status, json };
  };
  const tool = async (shop: string, role: string, token: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; data: any }> => {
    const r = await req("POST", `/s/${shop}/mcp/${role}`, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" });
    const data = r.json?.result?.structuredContent ?? {};
    if (data.kind === "approval_required") return tool(shop, role, token, "confirm_action", { approvalId: data.pendingActionId, decision: "accept", ...(args.voiceCode ? { voiceCode: args.voiceCode } : {}) });
    return { text: (r.json?.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join(" "), data };
  };
  /** A shop selling one fixture item at its suggested price, never below `floor`. */
  const shop = async (name: string, zip: string, photo: string, floor: number) => {
    const sh = (await req("POST", "/api/shops", { displayName: name, address: `1 ${name} St, Springfield, IL`, zip, porchInstructions: "Bench" })).json as { id: string; sellerToken: string };
    await req("POST", `/s/${sh.id}/sweep`, { photos: [{ name: photo, dataUrl: `data:image/jpeg;base64,${Buffer.from(photo).toString("base64")}` }] }, { Authorization: `Bearer ${sh.sellerToken}` });
    await tool(sh.id, "seller", sh.sellerToken, "appraise_photos");
    const listingId = (await tool(sh.id, "seller", sh.sellerToken, "list_items", { items: [photo.split(".")[0]!.split("-").at(-1)!] })).data.listings[0].listingId as string;
    await tool(sh.id, "seller", sh.sellerToken, "set_mandate", { item: listingId, floorDollars: floor });
    return { ...sh, listingId };
  };
  return { s, req, tool, shop };
}

describe("Stoop Street", () => {
  it("searches every shop, nearest first, and keeps addresses out of it", async () => {
    const { s, req, shop } = await boot();
    const ana = await shop("Ana", "62704", "jogging-stroller.jpg", 90);
    const bo = await shop("Bo", "62711", "hybrid-bike.jpg", 200);
    await shop("Cy", "10001", "standing-desk.jpg", 150);
    const all = (await req("GET", "/api/market")).json as { results: Array<{ shop: string; title: string; zip: string }>; total: number };
    expect(all.total).toBe(3);
    const strollers = (await req("GET", "/api/market?q=stroller&zip=62704")).json.results;
    expect(strollers).toHaveLength(1);
    expect(strollers[0]).toMatchObject({ shop: ana.id, listingId: ana.listingId, shopName: "Ana’s porch", zip: "62704", rating: { count: 0 } });
    // near 62704: same ZIP first, then the same area (627xx), then the rest
    expect((await req("GET", "/api/market?zip=62704")).json.results.map((r: { zip: string }) => r.zip)).toEqual(["62704", "62711", "10001"]);
    expect((await req("GET", "/api/market?q=bike&max=100")).json.results).toHaveLength(0);
    expect(JSON.stringify(all)).not.toMatch(/St, Springfield/);
    expect(bo.listingId).toBeTruthy();
    // a shared listing link previews as the item in chats and social apps (when the app is built)
    const page = await s.app.fetch(new Request(`${ORIGIN}/shop/${ana.id}/item/${ana.listingId}`));
    if (page.status === 200) {
      const html = await page.text();
      expect(html).toContain('<meta property="og:title" content="Three-wheel jogging stroller · $120">');
      expect(html).toMatch(/og:image" content="http:\/\/stoop\.test\/s\/[^"]+\/photos\//);
      expect(html).not.toMatch(/St, Springfield/);
    }
  }, 30_000);

  it("sends a buyer's agent to haggle within budget; the buyer still approves and pays", async () => {
    const { s, req, tool, shop } = await boot();
    const ana = await shop("Ana", "62704", "jogging-stroller.jpg", 90);
    const me = (await req("POST", "/api/profile", { name: "Ben", purchaseCode: "2580" })).json as { token: string };
    const B = { Authorization: `Bearer ${me.token}` };
    expect((await req("POST", "/api/wants", { query: "x", maxDollars: 100 }, B)).status).toBe(400);
    const want = (await req("POST", "/api/wants", { query: "jogging stroller", maxDollars: 100, zip: "62704" }, B)).json as { id: string };
    await s.street.tick();
    let w = (await req("GET", "/api/profile", undefined, B)).json.wants[0];
    // the agent opened under the asking price ($120) and inside the budget; the owner has to say yes
    expect(w.status).toBe("hunting");
    expect(w.log.map((l: { text: string }) => l.text).join(" ")).toMatch(/Found .*stroller for \$120 at Ana’s porch \(62704\)/);
    expect(w.log.at(-1).text).toMatch(/could work .* Waiting for the owner/);
    const offer = Object.values(w.tries)[0] as { lastOfferMinor: number; state: string };
    expect(offer.state).toBe("waiting_owner");
    expect(offer.lastOfferMinor).toBeLessThanOrEqual(100_00);
    // the seller's offer list shows the agent's offer; the seller accepts
    expect((await tool(ana.id, "seller", ana.sellerToken, "review_offers")).text).toMatch(/offers \$100/);
    await tool(ana.id, "seller", ana.sellerToken, "respond_to_offer", { decision: "accept" });
    await s.street.tick();
    w = (await req("GET", "/api/profile", undefined, B)).json.wants[0];
    expect(w.status).toBe("found");
    expect(w.log.at(-1).text).toMatch(/owner said yes: .* for \$100\. Tap Pay/);
    // the agent can't pay; the buyer does, on the listing page, with their purchase code (over $100 with the fee)
    const { buyerToken } = (await req("POST", "/api/profile/join", { shop: ana.id }, B)).json as { buyerToken: string };
    expect((await tool(ana.id, "buyer", buyerToken, "checkout", { voiceCode: "1111" })).text).toMatch(/code didn’t match|didn't match/);
    expect((await tool(ana.id, "buyer", buyerToken, "checkout", { voiceCode: "2580" })).text).toMatch(/held, not charged/);
    await s.street.tick();
    const prof = (await req("GET", "/api/profile", undefined, B)).json;
    expect(prof.wants[0].status).toBe("bought");
    expect(prof.purchases[0]).toMatchObject({ shop: ana.id, shopName: "Ana’s porch", amountMinor: 100_00 });
    expect(prof.purchases[0].passId).toBeTruthy();
    expect((await req("POST", `/api/wants/${want.id}/stop`, {}, { Authorization: "Bearer pt_nope" })).status).toBe(404);
  }, 40_000);
});
