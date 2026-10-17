// A real MCP client in the browser (spec 2025-11-25, Streamable HTTP, sessions, elicitation).
// Every JSON-RPC message in and out is logged for the judges' "Developer view".
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";

export interface RpcLog {
  dir: "out" | "in";
  at: number;
  method?: string;
  id?: string | number;
  summary: string;
}

export interface ElicitField {
  name: string;
  title: string;
  type: string;
  pattern?: string;
}

export interface ElicitPrompt {
  mode: "form" | "url";
  message: string;
  url?: string;
  fields: ElicitField[];
  resolve(answer: { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }): void;
}

function summarize(m: any): RpcLog {
  const base = { at: Date.now(), id: m?.id } as RpcLog;
  if (m?.method) return { ...base, dir: "out", method: m.method, summary: m.method === "tools/call" ? `tools/call ${m.params?.name} ${JSON.stringify(m.params?.arguments ?? {})}` : m.method };
  if (m?.result) {
    const r = m.result;
    const txt = r.content?.[0]?.text as string | undefined;
    return { ...base, dir: "in", summary: txt ? `result: ${txt.slice(0, 140)}` : `result ${Object.keys(r).join(",")}` };
  }
  if (m?.error) return { ...base, dir: "in", summary: `error ${m.error.code}: ${m.error.message}` };
  return { ...base, dir: "in", summary: JSON.stringify(m).slice(0, 140) };
}

export async function connectMcp(opts: {
  base: string;
  role: "seller" | "buyer";
  token: string;
  onLog(l: RpcLog): void;
  onElicit(p: ElicitPrompt): void;
}) {
  const transport = new StreamableHTTPClientTransport(new URL(`${opts.base}/mcp/${opts.role}`), {
    requestInit: { headers: { Authorization: `Bearer ${opts.token}` } },
  });
  // Log outgoing.
  const send = transport.send.bind(transport);
  transport.send = async (message, o) => {
    opts.onLog({ ...summarize(message), dir: "out" });
    return send(message, o);
  };
  // Log incoming by intercepting the client's onmessage assignment.
  let handler: ((m: any, extra?: any) => void) | undefined;
  const wrapped = (m: any, extra?: any) => {
    opts.onLog(m?.method ? { ...summarize(m), dir: "in", summary: `server -> ${m.method}${m.params?.mode ? ` (${m.params.mode})` : ""}` } : summarize(m));
    handler?.(m, extra);
  };
  Object.defineProperty(transport, "onmessage", { configurable: true, get: () => (handler ? wrapped : undefined), set: (fn) => (handler = fn) });

  const client = new Client(
    { name: "stoop-alexa-sim", version: "0.1.0", title: "Simulated Alexa+ device" },
    {
      capabilities: {
        elicitation: { form: {}, url: {} },
        extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
      } as any,
    },
  );
  client.setRequestHandler(ElicitRequestSchema, (req) => {
    const p = req.params as any;
    const props = (p.requestedSchema?.properties ?? {}) as Record<string, { title?: string; type?: string; pattern?: string }>;
    const fields = Object.entries(props)
      .filter(([k]) => k !== "confirm")
      .map(([name, s]) => ({ name, title: s.title ?? name, type: s.type ?? "string", pattern: s.pattern }));
    return new Promise((resolve) => opts.onElicit({ mode: p.mode ?? "form", message: p.message, url: p.url, fields, resolve: resolve as never }));
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const cardCache = new Map<string, string>();
  return {
    client,
    tools,
    sessionId: () => transport.sessionId,
    async call(name: string, args: Record<string, unknown>) {
      return (await client.callTool({ name, arguments: args }, undefined, { timeout: 6 * 60 * 1000 })) as CallToolResult;
    },
    async cardHtml(uri: string) {
      if (!cardCache.has(uri)) {
        const r = await client.readResource({ uri });
        const c = r.contents[0] as { text?: string };
        cardCache.set(uri, c.text ?? "");
      }
      return cardCache.get(uri)!;
    },
    toolVisibility(name: string): string[] {
      const t = tools.find((x: Tool) => x.name === name);
      return ((t?._meta as any)?.ui?.visibility as string[]) ?? ["model", "app"];
    },
  };
}

export type Mcp = Awaited<ReturnType<typeof connectMcp>>;
export const resultText = (r: CallToolResult) => (r.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text).join(" ");
