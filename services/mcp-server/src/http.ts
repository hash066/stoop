// Streamable HTTP transport for /mcp/seller and /mcp/buyer (MCP spec 2025-11-25).
//  - Clients that send `initialize` get a stateful session (MCP-Session-Id) so server->client requests
//    (elicitation) can ride the tool call's SSE stream and come back to the same process.
//  - Requests with no session id that aren't `initialize` are served statelessly: Amazon's Alexa+ client
//    example initializes with 2025-03-26 and sends no session id, so every tool works without one.
//  - Bearer auth (per household / per buyer). 401 carries the RFC 9728 resource_metadata challenge.
//  - Origin validation (403) against DNS rebinding.
import { Hono, type Context } from "hono";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { PendingActions } from "./approvals.ts";
import { createBuyerServer } from "./buyer.ts";
import type { BuyerActor, SellerActor, StoopContext } from "./context.ts";
import { createSellerServer } from "./seller.ts";

export interface McpHttpOptions {
  authSeller(token: string): Promise<SellerActor | undefined>;
  authBuyer(token: string): Promise<BuyerActor | undefined>;
  /** Exact origins allowed to call from browsers (the sims). Requests without Origin (servers, CLIs) pass. */
  allowedOrigins: string[];
  onRpc?(entry: { role: string; sessionId?: string; direction: "in"; body: unknown }): void;
}

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  role: "seller" | "buyer";
  actorKey: string;
  lastSeen: number;
}

const SESSION_IDLE_MS = 30 * 60 * 1000;

export function mcpRouter(ctx: StoopContext, opts: McpHttpOptions) {
  const app = new Hono();
  const sessions = new Map<string, Session>();
  const pendingByActor = new Map<string, PendingActions>();
  const pendingFor = (key: string) => {
    let p = pendingByActor.get(key);
    if (!p) pendingByActor.set(key, (p = new PendingActions()));
    return p;
  };

  setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastSeen > SESSION_IDLE_MS) void s.transport.close().finally(() => sessions.delete(id));
  }, 60_000).unref?.();

  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json({
      resource: `${ctx.publicBaseUrl}/mcp`,
      authorization_servers: [`${ctx.publicBaseUrl}/auth`],
      bearer_methods_supported: ["header"],
      scopes_supported: ["stoop.sell", "stoop.buy"],
      resource_documentation: `${ctx.publicBaseUrl}/docs/mcp`,
    }),
  );

  const unauthorized = (c: Context) => {
    c.header("WWW-Authenticate", `Bearer resource_metadata="${ctx.publicBaseUrl}/.well-known/oauth-protected-resource", scope="stoop.sell stoop.buy"`);
    return c.json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }, 401);
  };

  async function handle(c: Context, role: "seller" | "buyer") {
    const origin = c.req.header("Origin");
    if (origin && !opts.allowedOrigins.includes(origin)) return c.json({ jsonrpc: "2.0", error: { code: -32002, message: "Origin not allowed" }, id: null }, 403);

    const auth = c.req.header("Authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!token) return unauthorized(c);
    const actor = role === "seller" ? await opts.authSeller(token) : await opts.authBuyer(token);
    if (!actor) return unauthorized(c);
    const actorKey = actor.kind === "seller" ? `seller:${actor.householdId}` : `buyer:${actor.buyerId}`;
    const makeServer = () =>
      actor.kind === "seller" ? createSellerServer(ctx, actor, pendingFor(actorKey)) : createBuyerServer(ctx, actor, pendingFor(actorKey));

    const sessionId = c.req.header("mcp-session-id");
    const method = c.req.method;

    if (sessionId) {
      const sess = sessions.get(sessionId);
      if (!sess) return c.json({ jsonrpc: "2.0", error: { code: -32003, message: "Session not found" }, id: null }, 404);
      if (sess.actorKey !== actorKey || sess.role !== role) return c.json({ jsonrpc: "2.0", error: { code: -32004, message: "Session belongs to someone else" }, id: null }, 403);
      sess.lastSeen = Date.now();
      if (method === "POST") {
        const body = await c.req.raw.clone().json().catch(() => undefined);
        opts.onRpc?.({ role, sessionId, direction: "in", body });
        return sess.transport.handleRequest(c.req.raw, { parsedBody: body });
      }
      const res = await sess.transport.handleRequest(c.req.raw);
      if (method === "DELETE") sessions.delete(sessionId);
      return res;
    }

    if (method !== "POST") return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Missing MCP-Session-Id" }, id: null }, 400);
    const body = await c.req.raw.clone().json().catch(() => undefined);
    if (body === undefined) return c.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, 400);
    opts.onRpc?.({ role, direction: "in", body });

    const isInit = Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body);
    if (isInit) {
      const server = makeServer();
      const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, role, actorKey, lastSeen: Date.now() });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      await server.connect(transport);
      return transport.handleRequest(c.req.raw, { parsedBody: body });
    }

    // Stateless path (no session): a fresh server per request, JSON responses.
    const server = makeServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const res = await transport.handleRequest(c.req.raw, { parsedBody: body });
    const out = new Response(await res.text(), { status: res.status, headers: res.headers });
    void transport.close();
    return out;
  }

  app.all("/mcp/seller", (c) => handle(c, "seller"));
  app.all("/mcp/buyer", (c) => handle(c, "buyer"));
  return { app, sessions };
}
