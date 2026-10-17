import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { rulesOnlyChecker } from "@stoop/agents";
import { createStack, DEMO, type Stack } from "../src/index.ts";

export const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
export const BASE = "http://stoop.test";

export async function bootStack(over: Partial<Parameters<typeof createStack>[0]> = {}) {
  return createStack({
    publicBaseUrl: BASE,
    passBaseUrl: "http://pass.test",
    allowedOrigins: ["http://localhost:5180"],
    rootDir: ROOT,
    frameDelayScale: 0,
    immediateWindow: true,
    recallChecker: rulesOnlyChecker(),
    ...over,
  });
}

/** In-process fetch: requests go straight into the Hono app (same code path as the network). */
export const appFetch = (stack: Stack) => (async (url: string | URL | Request, init?: RequestInit) => stack.app.fetch(new Request(url, init))) as typeof fetch;

export interface Elicitation {
  mode: string;
  message: string;
  url?: string;
  schema?: unknown;
}

export async function mcpClient(
  stack: Stack,
  role: "seller" | "buyer",
  token: string,
  answer: (e: Elicitation) => { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> } = () => ({ action: "accept", content: { confirm: true } }),
  opts: { elicitation?: boolean } = {},
) {
  const elicitations: Elicitation[] = [];
  const client = new Client(
    { name: `test-${role}`, version: "1.0.0" },
    { capabilities: opts.elicitation === false ? {} : { elicitation: { form: {}, url: {} } } },
  );
  if (opts.elicitation !== false) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const p = req.params as { mode?: string; message: string; url?: string; requestedSchema?: unknown };
      const e = { mode: p.mode ?? "form", message: p.message, url: p.url, schema: p.requestedSchema };
      elicitations.push(e);
      const a = answer(e);
      return e.mode === "url" ? { action: a.action } : a;
    });
  }
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${role}`), {
    fetch: appFetch(stack),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, call, elicitations, close: () => client.close() };
}

export const text = (r: CallToolResult) => (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join(" ");
export const sc = <T = Record<string, unknown>>(r: CallToolResult) => r.structuredContent as T;

export async function http(stack: Stack, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await stack.app.fetch(
    new Request(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }),
  );
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, json: ct.includes("json") ? await res.json() : undefined, text: ct.includes("json") ? undefined : await res.text(), headers: res.headers };
}

export const SELLER = DEMO.sellerToken;
export const DANA = DEMO.buyers[0]!;
export const LEE = DEMO.buyers[1]!;

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 3000, label = "condition", stack?: Stack): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) {
      const tail = stack ? stack.bus.recent(25).map((e) => `${e.type}${e.to ? `:${e.to}` : ""}${e.error ? ` ${e.error}` : ""}${e.reasons ? ` ${JSON.stringify(e.reasons)}` : ""}`).join("\n  ") : "";
      throw new Error(`waitFor timed out: ${label}${tail ? `\n  recent events:\n  ${tail}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
