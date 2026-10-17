// my_items (plan §8 seller tools): the read-only "what am I selling?" inventory tool.
// Covers empty household, appraised items (with the blocked crib), the LIVE transition after
// listing, and an Alexa-style stateless call (2025-03-26, no session) that still gets the card.
import { describe, expect, it } from "vitest";
import type { Stack } from "../src/index.ts";
import { appFetch, BASE, bootStack, http, mcpClient, sc, SELLER, text } from "./harness.ts";

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

async function rpc(stack: Stack, body: unknown, headers: Record<string, string> = {}) {
  const res = await appFetch(stack)(`${BASE}/mcp/seller`, { method: "POST", headers: { ...MCP_HEADERS, ...headers }, body: JSON.stringify(body) });
  const raw = await res.text();
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    const data = raw.split("\n").find((l) => l.startsWith("data:"));
    json = data ? JSON.parse(data.slice(5)) : undefined;
  }
  return { status: res.status, json };
}

interface Inv {
  kind: string;
  totalListMinor: number;
  items: Array<{ itemId: string; title: string; listMinor: number; quickSaleMinor: number; blocked: boolean; listingState?: string }>;
}

describe("my_items: read-only household inventory", () => {
  it("empty -> appraised (crib blocked) -> LIVE after listing", async () => {
    const stack = await bootStack();
    const seller = await mcpClient(stack, "seller", SELLER);

    // 1. Nothing swept yet
    const empty = await seller.call("my_items");
    expect(text(empty)).toMatch(/Nothing appraised yet/i);
    const e = sc<Inv>(empty);
    expect(e.items).toHaveLength(0);
    expect(e.totalListMinor).toBe(0);
    // read-only tool still advertises the appraisal-grid card on its result
    expect(empty._meta).toMatchObject({ ui: { resourceUri: expect.stringMatching(/^ui:\/\/stoop\/appraisal-grid@/) } });
    expect(text(empty)).not.toMatch(/[|*#`]/); // voice-safe

    // 2. After the sweep + appraisal, items appear with prices; the crib is blocked, nothing listed yet
    expect((await http(stack, "POST", "/sweep/demo", undefined, { Authorization: `Bearer ${SELLER}` })).status).toBe(200);
    await seller.call("appraise_photos");
    const appraised = await seller.call("my_items");
    const inv = sc<Inv>(appraised);
    const stroller = inv.items.find((i) => /stroller/i.test(i.title));
    expect(stroller?.listMinor).toBe(120_00);
    expect(stroller?.listingState).toBeUndefined();
    expect(inv.items.find((i) => /crib/i.test(i.title))?.blocked).toBe(true);
    expect(inv.totalListMinor).toBeGreaterThan(0);
    expect(text(appraised)).toMatch(/You have \d+ thing/);
    expect(text(appraised)).not.toMatch(/listed now/); // read-only: it didn't publish anything

    // 3. After listing the stroller, my_items reflects LIVE without re-appraising
    await seller.call("list_items", { items: ["stroller"] }); // harness auto-approves the elicitation
    const listed = await seller.call("my_items");
    const after = sc<Inv>(listed);
    expect(after.items.find((i) => /stroller/i.test(i.title))?.listingState).toBe("LIVE");
    expect(text(listed)).toMatch(/1 listed now/);

    await seller.close();
  });

  it("X18: works for an Alexa-style stateless client (2025-03-26, no session)", async () => {
    const stack = await bootStack();
    const auth = { Authorization: `Bearer ${SELLER}` };
    const init = await rpc(stack, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Alexa+ MCP Client", version: "1" } } }, auth);
    expect(init.json.result.protocolVersion).toBe("2025-03-26");
    const call = (id: number, name: string) => rpc(stack, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } }, auth); // no session header

    // empty inventory, stateless
    const empty = await call(2, "my_items");
    expect(empty.status).toBe(200);
    expect(empty.json.result.content[0].text).toMatch(/Nothing appraised yet/i);
    expect(empty.json.result._meta.ui.resourceUri).toMatch(/^ui:\/\/stoop\/appraisal-grid@/); // in the RESULT, as Alexa expects

    // after a sweep + stateless appraisal, the inventory comes back with prices
    await http(stack, "POST", "/sweep/demo", undefined, auth);
    await call(3, "appraise_photos");
    const inv = await call(4, "my_items");
    const data = inv.json.result.structuredContent as Inv;
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items.find((i) => /stroller/i.test(i.title))?.listMinor).toBe(120_00);
    expect(inv.json.result.content[0].text).not.toMatch(/[|*#`]/); // voice-safe
  });
});
