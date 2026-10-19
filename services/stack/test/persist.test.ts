// Hosted shops survive a restart: stop the server mid-sale, start a new one on the same data folder,
// and everything is still there (keys included, so the encrypted pickup address still opens).
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rulesOnlyChecker } from "@stoop/agents";
import type { VisionAdapter } from "@stoop/verifier";
import { createSandboxServer } from "../src/sandboxes.ts";
import { ROOT } from "./harness.ts";

const ORIGIN = "http://stoop.test";
const vision: VisionAdapter = { name: "test", async assess() { return { presence: "present", rationale: "t", personCount: 0, adapter: "test" }; } };
let stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops) s();
  stops = [];
});

async function boot(dataDir: string, now?: () => number) {
  const s = await createSandboxServer({ rootDir: ROOT, origin: ORIGIN, dataDir, persist: true, now, stackOverrides: { vision, recallChecker: rulesOnlyChecker(), frameDelayScale: 0 } });
  stops.push(s.stop);
  const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await s.app.fetch(new Request(ORIGIN + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));
    const text = await r.text();
    let json: any;
    try {
      json = JSON.parse(text.startsWith("{") || text.startsWith("[") ? text : (text.split("\n").find((l) => l.startsWith("data:")) ?? "data:null").slice(5));
    } catch {
      json = undefined;
    }
    return { status: r.status, json, text };
  };
  const tool = async (shop: string, role: string, token: string, name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const r = await req("POST", `/s/${shop}/mcp/${role}`, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" });
    const data = r.json?.result?.structuredContent ?? {};
    if (data.kind === "approval_required") return tool(shop, role, token, "confirm_action", { approvalId: data.pendingActionId, decision: "accept" });
    return data;
  };
  return { s, req, tool };
}

describe("hosted shops survive a restart", () => {
  it("brings back the shop, its sale, photos, camera link and the encrypted address", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "stoop-persist-"));
    const a = await boot(dataDir);
    const shop = (await a.req("POST", "/api/shops", { displayName: "Ana", address: "12 Elm St, Springfield, IL", zip: "62704", porchInstructions: "Bench" })).json as { id: string; sellerToken: string };
    const S = { Authorization: `Bearer ${shop.sellerToken}` };
    await a.req("POST", `/s/${shop.id}/sweep`, { photos: [{ name: "jogging-stroller.jpg", dataUrl: `data:image/jpeg;base64,${Buffer.from("stroller photo").toString("base64")}` }] }, S);
    await a.tool(shop.id, "seller", shop.sellerToken, "appraise_photos");
    const listingId = (await a.tool(shop.id, "seller", shop.sellerToken, "list_items", { items: ["stroller"] })).listings[0].listingId as string;
    await a.tool(shop.id, "seller", shop.sellerToken, "set_mandate", { item: listingId, floorDollars: 90 });
    const cam = (await a.req("POST", `/s/${shop.id}/web/cam/register`, {}, S)).json as { camToken: string };
    const buyer = (await a.req("POST", `/s/${shop.id}/web/buyer`, { displayName: "Ben", purchaseCode: "2580" })).json.buyerToken as string;
    await a.tool(shop.id, "buyer", buyer, "make_offer", { listingId, amountDollars: 95 });
    await a.tool(shop.id, "seller", shop.sellerToken, "respond_to_offer", { decision: "accept" });
    await a.tool(shop.id, "buyer", buyer, "checkout");
    const deal = (await a.req("GET", `/s/${shop.id}/web/buyer/state?listing=${listingId}`, undefined, { Authorization: `Bearer ${buyer}` })).json.deals[0];
    const dev = { "X-Stoop-Device": "ben-phone-000001" };
    await a.req("POST", `/s/${shop.id}/web/pass/${deal.passId}/claim`, {}, { Authorization: `Bearer ${buyer}`, ...dev });
    await a.req("POST", `/s/${shop.id}/pass/${deal.passId}/consent`, {}, dev);
    const photoUrl = (await a.req("GET", `/s/${shop.id}/web/listing/${listingId}`)).json.photoUrls[0] as string;
    a.s.stop(); // saves everything
    expect(readdirSync(join(dataDir, "worlds"))).toEqual([shop.id]);

    // a new server on the same data folder: the redeploy
    const b = await boot(dataDir);
    expect(b.s.worlds.has(shop.id)).toBe(true);
    const st = (await b.req("GET", `/s/${shop.id}/web/seller/state`, undefined, S)).json;
    expect(st.shop).toMatchObject({ displayName: "Ana", zip: "62704" });
    expect(st.items[0]).toMatchObject({ title: "BOB Revolution jogging stroller", listing: { id: listingId } });
    expect(st.sales[0]).toMatchObject({ state: "WINDOW_OPEN", amountMinor: 95_00 });
    // the address was encrypted with this shop's own key, which came back with it
    expect((await b.req("GET", `/s/${shop.id}/pass/${deal.passId}`, undefined, dev)).json.address).toBe("12 Elm St, Springfield, IL");
    // the photo, the camera link and the buyer's session all still work
    expect((await b.req("GET", photoUrl.replace(ORIGIN, ""))).text).toBe("stroller photo");
    expect((await b.req("GET", `/s/${shop.id}/web/cam/next`, undefined, { Authorization: `Bearer ${cam.camToken}` })).status).toBe(200);
    expect((await b.req("GET", `/s/${shop.id}/web/buyer/state?listing=${listingId}`, undefined, { Authorization: `Bearer ${buyer}` })).json.deals[0].passId).toBe(deal.passId);
    // and the sale goes on: the buyer checks in after the restart
    expect((await b.req("POST", `/s/${shop.id}/pass/${deal.passId}/checkin`, {}, dev)).status).toBe(200);
  }, 30_000);

  it("deletes a shop's files once it has been idle too long", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "stoop-persist-"));
    let t = Date.now();
    const a = await boot(dataDir, () => t);
    const shop = (await a.req("POST", "/api/shops", { displayName: "Ana", address: "12 Elm St, Springfield, IL", zip: "62704", porchInstructions: "Bench" })).json as { id: string };
    a.s.stop();
    t += 73 * 60 * 60 * 1000;
    const b = await boot(dataDir, () => t);
    expect(b.s.worlds.has(shop.id)).toBe(false);
    expect(existsSync(join(dataDir, "worlds", shop.id))).toBe(false);
  });
});
