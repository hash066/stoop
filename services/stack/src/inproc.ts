// One MCP tools/call straight into a shop's world, the way an Alexa-style client calls: no session,
// no elicitation, so an action that needs a person's yes comes back as approval_required.
export interface ToolOut {
  text: string;
  data: Record<string, any>;
  isError: boolean;
}

export async function mcpCall(fetch: (r: Request) => Promise<Response>, role: "seller" | "buyer", token: string, name: string, args: Record<string, unknown> = {}): Promise<ToolOut> {
  const list = name === "tools/list";
  const res = await fetch(
    new Request(`http://stoop.internal/mcp/${role}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, "MCP-Protocol-Version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: list ? "tools/list" : "tools/call", params: list ? {} : { name, arguments: args } }),
    }),
  );
  const raw = await res.text();
  const json = raw.trimStart().startsWith("{") ? raw : (raw.split("\n").find((l) => l.startsWith("data:")) ?? "data:{}").slice(5);
  const msg = JSON.parse(json) as { result?: { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, any>; isError?: boolean; tools?: unknown[] }; error?: { message: string } };
  if (msg.error) throw new Error(msg.error.message);
  if (list) return { text: "", data: { tools: msg.result?.tools ?? [] }, isError: false };
  return {
    text: (msg.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join(" "),
    data: msg.result?.structuredContent ?? {},
    isError: !!msg.result?.isError,
  };
}
