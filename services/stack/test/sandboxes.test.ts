// Hosted mode: isolation between visitors, limits, and feedback handling (no browser needed).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSandboxServer } from "../src/sandboxes.ts";
import { ROOT } from "./harness.ts";

const ORIGIN = "http://stoop.test";
let stopAll: Array<() => void> = [];
afterEach(() => {
  for (const s of stopAll) s();
  stopAll = [];
});

async function server(over: Partial<Parameters<typeof createSandboxServer>[0]> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "stoop-sbx-"));
  const s = await createSandboxServer({ rootDir: ROOT, origin: ORIGIN, dataDir, adminKey: "k", ...over });
  stopAll.push(s.stop);
  const call = (path: string, init: RequestInit & { ip?: string } = {}) =>
    s.app.fetch(new Request(ORIGIN + path, { ...init, headers: { "Content-Type": "application/json", "X-Forwarded-For": init.ip ?? "1.1.1.1", Origin: ORIGIN, ...(init.headers ?? {}) } }));
  const create = async (ip?: string) => (await (await call("/api/sandboxes", { method: "POST", ip })).json()) as { id: string; tour: string };
  return { s, call, create, dataDir };
}

const SELLER = { Authorization: "Bearer seller-demo-okafor", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" };
const tool = (name: string) => ({
  method: "POST",
  headers: SELLER,
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
});
/** Spoken text of a stateless MCP tool result (JSON or SSE framing). */
async function spoken(res: Response): Promise<string> {
  const raw = await res.text();
  const json = raw.startsWith("{") ? raw : (raw.split("\n").find((l) => l.startsWith("data:")) ?? "data:{}").slice(5);
  const msg = JSON.parse(json) as { result?: { content?: Array<{ text?: string }> } };
  return (msg.result?.content ?? []).map((c) => c.text ?? "").join(" ");
}

describe("hosted sandboxes", () => {
  it("gives each visitor a private world: one visitor's sale never shows up in another's", async () => {
    const { call, create } = await server();
    const a = await create("1.1.1.1");
    const b = await create("2.2.2.2");
    expect(a.id).not.toBe(b.id);
    expect(a.tour).toBe(`/s/${a.id}/`);
    await call(`/s/${a.id}/sweep/demo`, { method: "POST", headers: { Authorization: "Bearer seller-demo-okafor" } });
    expect(await spoken(await call(`/s/${a.id}/mcp/seller`, tool("appraise_photos")))).toMatch(/things you can sell/);
    // A's garage is appraised; B, with the same demo tokens, sees an empty household
    expect(await spoken(await call(`/s/${a.id}/mcp/seller`, tool("my_items")))).toMatch(/You have 4 things/);
    expect(await spoken(await call(`/s/${b.id}/mcp/seller`, tool("my_items")))).toMatch(/Nothing appraised yet/);
    const cfgA = (await (await call(`/s/${a.id}/api/config`)).json()) as { publicBaseUrl: string; passBaseUrl: string };
    expect(cfgA.publicBaseUrl).toBe(`${ORIGIN}/s/${a.id}`);
    expect(cfgA.passBaseUrl).toBe(`${ORIGIN}/s/${a.id}/m`);
  });

  it("answers an expired or unknown sandbox with a friendly page (and JSON for API calls)", async () => {
    const { call } = await server();
    const page = await call("/s/nope/");
    expect(page.status).toBe(404);
    expect(await page.text()).toMatch(/expired/);
    const api = await call("/s/nope/mcp/seller", { method: "POST", body: "{}" });
    expect(await api.json()).toMatchObject({ error: "sandbox_expired" });
  });

  it("limits sandboxes per IP and in total", async () => {
    const { call } = await server({ createsPerIpPerHour: 2, maxWorlds: 3 });
    const post = (ip: string) => call("/api/sandboxes", { method: "POST", ip });
    expect((await post("9.9.9.9")).status).toBe(200);
    expect((await post("9.9.9.9")).status).toBe(200);
    expect((await post("9.9.9.9")).status).toBe(429);
    expect((await post("8.8.8.8")).status).toBe(200);
    // full, and every world was used in the last 5 minutes: refuse rather than kick someone out
    expect((await post("7.7.7.7")).status).toBe(503);
  });

  it("stores feedback, keeps an email only with consent, and exports only with the admin key", async () => {
    const { call, dataDir } = await server();
    const send = (body: unknown) => call("/api/feedback", { method: "POST", body: JSON.stringify(body) });
    expect((await send({ rating: 9, wouldUse: "yes" })).status).toBe(400);
    expect((await send({ rating: 4, wouldUse: "maybe", email: "a@example.com" })).status).toBe(200);
    expect((await send({ rating: 5, wouldUse: "yes", email: "b@example.com", consent: true, comment: "love it" })).status).toBe(200);
    const rows = readFileSync(join(dataDir, "feedback.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows[0].email).toBeUndefined();
    expect(rows[1].email).toBe("b@example.com");
    expect((await call("/api/feedback.jsonl?key=wrong")).status).toBe(403);
    expect(await (await call("/api/feedback.jsonl?key=k")).text()).toContain("love it");
  });

  const SHOP = { displayName: "Ana", address: "12 Elm St, Springfield, IL", zip: "62704", porchInstructions: "On the bench" };

  it("opens a real shop: no demo data, the seller's own token, no demo or operator routes", async () => {
    const { call } = await server();
    const bad = await call("/api/shops", { method: "POST", body: JSON.stringify({ displayName: "Ana" }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { fields: string[] }).fields).toEqual(expect.arrayContaining(["address", "zip"]));
    const shop = (await (await call("/api/shops", { method: "POST", body: JSON.stringify(SHOP) })).json()) as { id: string; sellerToken: string; url: string };
    expect(shop.url).toBe(`/shop/${shop.id}`);
    expect(shop.sellerToken).toMatch(/^sk_/);
    const state = await (await call(`/s/${shop.id}/web/seller/state`, { headers: { Authorization: `Bearer ${shop.sellerToken}` } })).json();
    expect(state).toMatchObject({ shop: { displayName: "Ana", zip: "62704", camera: null }, items: [], offers: [], sales: [] });
    expect(JSON.stringify(state)).not.toMatch(/Elm St/);
    // the demo household and its tokens don't exist in a real shop
    expect(await spoken(await call(`/s/${shop.id}/mcp/seller`, tool("my_items")))).not.toMatch(/You have/);
    // nor do the simulator, the operator console (it shows pass codes) or the demo photos
    for (const path of ["/ops/state", "/ops/events", "/ops/frame/x/before", "/sim/scene", "/ring/devices", "/api/config", "/sweep/demo"])
      expect((await call(`/s/${shop.id}${path}`, { method: path.startsWith("/sim") || path.startsWith("/sweep") ? "POST" : "GET", body: path.startsWith("/sim") || path.startsWith("/sweep") ? "{}" : undefined })).status, path).toBe(404);
    // and nobody can set up a second household in it
    expect((await call(`/s/${shop.id}/web/shop`, { method: "POST", body: JSON.stringify(SHOP) })).status).toBe(404);
    expect(await (await call(`/s/${shop.id}/web/storefront`)).json()).toMatchObject({ displayName: "Ana", zip: "62704", listings: [] });
  });

  it("lets only the admin list shops and close a test shop for good", async () => {
    const { call } = await server();
    const shop = (await (await call("/api/shops", { method: "POST", body: JSON.stringify(SHOP) })).json()) as { id: string };
    expect((await call("/api/admin/shops")).status).toBe(403);
    expect((await call("/api/admin/shops?key=wrong")).status).toBe(403);
    expect(await (await call("/api/admin/shops?key=k")).json()).toMatchObject({ shops: [{ id: shop.id, names: ["Ana"], live: [] }] });
    expect((await call(`/api/admin/shops/${shop.id}?key=wrong`, { method: "DELETE" })).status).toBe(403);
    expect((await call(`/api/admin/shops/${shop.id}?key=k`, { method: "DELETE" })).status).toBe(200);
    expect(await (await call("/api/admin/shops?key=k")).json()).toEqual({ shops: [] });
    expect((await call(`/s/${shop.id}/web/storefront`)).status).not.toBe(200);
  });

  it("keeps shops for days, demos for minutes, and counts only shops actually opened per address", async () => {
    let t = 5_000_000;
    const { s, call } = await server({ now: () => t, idleMs: 60_000, shopIdleMs: 3 * 60_000, shopsPerIpPerHour: 2 });
    const open = (body: unknown) => call("/api/shops", { method: "POST", ip: "5.5.5.5", body: JSON.stringify(body) });
    expect((await open({ displayName: "x" })).status).toBe(400); // a typo doesn't use up the limit
    const a = (await (await open(SHOP)).json()) as { id: string };
    expect((await open(SHOP)).status).toBe(200);
    expect((await open(SHOP)).status).toBe(429);
    t += 61_000;
    s.sweep();
    expect(s.worlds.has(a.id)).toBe(true);
    t += 3 * 60_000;
    s.sweep();
    expect(s.worlds.has(a.id)).toBe(false);
    expect((await call(`/s/${a.id}/web/storefront`)).status).toBe(404);
  });

  it("answers the web app's own pages with the app, and other paths with 404", async () => {
    const { call } = await server();
    for (const path of ["/", "/sell", "/shop/abc", "/shop/abc/item/lst_1", "/shop/abc/p/pass_1", "/shop/abc/camera"]) {
      const r = await call(path);
      expect([200, 503], path).toContain(r.status); // 503 = app not built in this checkout
      expect(r.headers.get("content-type") ?? "").toMatch(/text\/(html|plain)/);
    }
    expect((await call("/nope")).status).toBe(404);
    expect((await call("/demo")).status).toBe(200);
  });

  it("retires worlds idle past the limit", async () => {
    let t = 1_000_000;
    const { s, create } = await server({ now: () => t, idleMs: 60_000 });
    const a = await create();
    expect(s.worlds.has(a.id)).toBe(true);
    t += 61_000;
    s.sweep();
    expect(s.worlds.has(a.id)).toBe(false);
  });
});
