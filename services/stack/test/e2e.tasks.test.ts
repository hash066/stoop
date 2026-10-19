// MCP Tasks (experimental, spec 2025-11-25): watch_handoff is task-only, reports one spoken line per
// step through tasks/get, finishes with the handoff-timeline card through tasks/result, and is
// invisible to every other actor.
import { CallToolResultSchema, CreateTaskResultSchema, GetTaskResultSchema, ListTasksResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Stack } from "../src/index.ts";
import { appFetch, BASE, bootStack, DANA, http, mcpClient, sc, SELLER, text, waitFor } from "./harness.ts";

type Client = Awaited<ReturnType<typeof mcpClient>>["client"];

const getTask = (c: Client, taskId: string) => c.request({ method: "tasks/get", params: { taskId } }, GetTaskResultSchema);

async function dealAtWindow(stack: Stack) {
  const seller = await mcpClient(stack, "seller", SELLER);
  const buyer = await mcpClient(stack, "buyer", DANA.token);
  await http(stack, "POST", "/sweep/demo", undefined, { Authorization: `Bearer ${SELLER}` });
  await seller.call("appraise_photos");
  await seller.call("list_items", { items: ["stroller"] });
  await seller.call("set_mandate", { item: "stroller", floorDollars: 90 });
  const listingId = sc<{ results: Array<{ listingId: string }> }>(await buyer.call("search_listings", { query: "stroller" })).results[0]!.listingId;
  await buyer.call("make_offer", { listingId, amountDollars: 95 });
  const dealId = sc<{ dealId: string }>(await seller.call("respond_to_offer", { decision: "accept" })).dealId;
  await buyer.call("checkout", {});
  await waitFor(async () => (await stack.settlement.getDeal(dealId)).passId, 3000, "pass", stack);
  await stack.tick();
  return { dealId, seller, buyer };
}

describe("MCP Tasks: watch_handoff", () => {
  it("is advertised as task-only and refuses a plain tools/call", async () => {
    const stack = await bootStack();
    const seller = await mcpClient(stack, "seller", SELLER);
    expect(seller.client.getServerCapabilities()?.tasks).toMatchObject({ requests: { tools: { call: {} } } });
    const tool = (await seller.client.listTools()).tools.find((t) => t.name === "watch_handoff");
    expect(tool?.execution).toMatchObject({ taskSupport: "required" });
    // Server side, from a stateless Alexa-style client that ignores the hint:
    const res = await appFetch(stack)(`${BASE}/mcp/seller`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${SELLER}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "watch_handoff", arguments: {} } }),
    });
    expect(JSON.stringify(await res.json())).toMatch(/requires task augmentation/);
  });

  it("follows a sale to CLOSED, one spoken line per step, and stays private to its owner", async () => {
    const stack = await bootStack();
    const { dealId, seller, buyer } = await dealAtWindow(stack);

    const created = await seller.client.request(
      { method: "tools/call", params: { name: "watch_handoff", arguments: { dealId }, task: { ttl: 60_000 } } },
      CreateTaskResultSchema,
    );
    const taskId = created.task.taskId;
    expect(created.task.status).toBe("working");
    await waitFor(async () => (await getTask(seller.client, taskId)).statusMessage, 3000, "first status", stack);
    expect((await getTask(seller.client, taskId)).statusMessage).toMatch(/pickup window is open/i);

    // Doorbell verifies the pickup: still working (inspection), with the new line.
    expect((await http(stack, "POST", "/sim/scenario/golden", { dealId })).json.state).toBe("INSPECTION");
    await waitFor(async () => /verified by your porch camera/i.test((await getTask(seller.client, taskId)).statusMessage ?? ""), 3000, "verified status", stack);
    expect((await getTask(seller.client, taskId)).status).toBe("working");

    // Another actor can't see or read it.
    await expect(getTask(buyer.client, taskId)).rejects.toThrow();
    expect((await buyer.client.request({ method: "tasks/list", params: {} }, ListTasksResultSchema)).tasks).toHaveLength(0);

    // Buyer taps "Got it" -> captured -> the task completes with the timeline card.
    const passId = (await stack.settlement.getDeal(dealId)).passId!;
    await stack.settlement.buyerOutcome(passId, "sim-device-0001", "got_it");
    await waitFor(async () => (await getTask(seller.client, taskId)).status === "completed", 3000, "task completed", stack);
    const final = await seller.client.request({ method: "tasks/result", params: { taskId } }, CallToolResultSchema);
    expect(text(final)).toMatch(/Sold\. \$\d+\.\d{2} is on its way to you/);
    expect(final._meta).toMatchObject({ ui: { resourceUri: expect.stringMatching(/^ui:\/\/stoop\/handoff-timeline@/) } });
    expect((await seller.client.request({ method: "tasks/list", params: {} }, ListTasksResultSchema)).tasks.map((t) => t.taskId)).toContain(taskId);
  });

  it("cancel stops the watcher; a task with no sale completes with a spoken error", async () => {
    const stack = await bootStack();
    const seller = await mcpClient(stack, "seller", SELLER);
    const empty = await seller.client.request({ method: "tools/call", params: { name: "watch_handoff", arguments: {}, task: {} } }, CreateTaskResultSchema);
    await waitFor(async () => (await getTask(seller.client, empty.task.taskId)).status === "completed", 3000, "empty task", stack);
    const r = await seller.client.request({ method: "tasks/result", params: { taskId: empty.task.taskId } }, CallToolResultSchema);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/no sale to watch/);

    const { dealId, seller: s2 } = await dealAtWindow(stack);
    const t = await s2.client.request({ method: "tools/call", params: { name: "watch_handoff", arguments: { dealId }, task: {} } }, CreateTaskResultSchema);
    await s2.client.request({ method: "tasks/cancel", params: { taskId: t.task.taskId } }, GetTaskResultSchema.passthrough());
    await http(stack, "POST", "/sim/scenario/no_show", { dealId });
    expect((await getTask(s2.client, t.task.taskId)).status).toBe("cancelled");
  });
});
