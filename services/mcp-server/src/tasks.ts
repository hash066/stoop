// MCP Tasks (experimental, spec 2025-11-25): `watch_handoff` follows one sale from payment to payout.
// The tool call returns a task at once; the requestor polls tasks/get (statusMessage = one spoken line
// per step) and fetches the final card with tasks/result. Status notifications are best effort: we
// don't keep a standalone GET stream open (see http.ts), so polling is the contract.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestTaskStore } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";
import type { Deal } from "@stoop/settlement";
import { errorResult } from "./approvals.ts";
import { uiMeta } from "./cards.ts";
import type { StoopContext } from "./context.ts";

/** States where watching ends: the sale is over, or a person has to act. */
export const WATCH_DONE = new Set(["CLOSED", "VOIDED", "NO_SHOW", "PIRACY_SUSPECTED", "REVIEW", "DEGRADED", "DISPUTE", "SELLER_CANCELLED", "CHECKOUT_ABANDONED"]);
export const WATCH_TTL_MS = 6 * 60 * 60 * 1000;
export const WATCH_POLL_MS = 1000;

/** Server capability block for task-augmented tools/call plus tasks/list and tasks/cancel. */
export const TASKS_CAPABILITY = { list: {}, cancel: {}, requests: { tools: { call: {} } } };

export function registerWatchHandoff(
  server: McpServer,
  ctx: StoopContext,
  opts: {
    resolveDeal(dealId?: string): Promise<Deal | undefined>;
    speech(deal: Deal): string;
    snapshot(deal: Deal): Promise<CallToolResult>;
  },
) {
  server.experimental.tasks.registerToolTask(
    "watch_handoff",
    {
      title: "Watch my sale until it's done",
      description:
        "Long-running task: follows the current sale (payment hold, pickup window, doorbell verification, payout) and finishes when it closes or needs a person. Poll tasks/get for progress.",
      inputSchema: { dealId: z.string().optional() },
      annotations: { readOnlyHint: true },
      execution: { taskSupport: "required" },
      _meta: uiMeta(ctx.cards, "handoff-timeline"),
    },
    {
      createTask: async ({ dealId }, extra) => {
        const task = await extra.taskStore.createTask({ ttl: Math.min(extra.taskRequestedTtl ?? WATCH_TTL_MS, WATCH_TTL_MS), pollInterval: WATCH_POLL_MS });
        const deal = await opts.resolveDeal(dealId);
        // Start after the CreateTaskResult is on the wire, so the first poll never races creation.
        setTimeout(() => void watch(ctx, extra.taskStore, task.taskId, deal, opts), 0);
        return { task };
      },
      getTask: async (_args, extra) => extra.taskStore.getTask(extra.taskId),
      getTaskResult: async (_args, extra) => (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult,
    },
  );
}

/** Store writes notify the session; after a stateless request ends there is no transport, so ignore that. */
async function quietly(fn: () => Promise<void>) {
  try {
    await fn();
  } catch {
    /* notification delivery is best effort; the store write already happened */
  }
}

async function watch(
  ctx: StoopContext,
  store: RequestTaskStore,
  taskId: string,
  initial: Deal | undefined,
  opts: { speech(deal: Deal): string; snapshot(deal: Deal): Promise<CallToolResult> },
) {
  if (!initial) {
    await quietly(() => store.storeTaskResult(taskId, "completed", errorResult("There's no sale to watch yet.", "no_deal")));
    return;
  }
  let lastState = "";
  let finished = false;
  const stop = () => {
    finished = true;
    off();
    clearTimeout(expiry);
  };
  const step = async () => {
    if (finished) return;
    const current = await store.getTask(taskId).catch(() => undefined);
    if (!current || current.status === "cancelled") return stop();
    const deal = await ctx.settlement.getDeal(initial.id);
    if (finished) return; // another event finished the task while we were reading
    if (WATCH_DONE.has(deal.state)) {
      stop();
      const snap = await opts.snapshot(deal);
      await quietly(() => store.storeTaskResult(taskId, "completed", snap));
      return;
    }
    if (deal.state === lastState) return;
    lastState = deal.state;
    await quietly(() => store.updateTaskStatus(taskId, "working", opts.speech(deal)));
  };
  const off = ctx.bus.on((e) => {
    if (e.dealId === initial.id) void step();
  });
  const expiry = setTimeout(() => {
    stop();
    void quietly(() => store.updateTaskStatus(taskId, "failed", "Stopped watching after six hours. Ask how the sale is going for the latest."));
  }, WATCH_TTL_MS);
  expiry.unref?.();
  await step();
}
