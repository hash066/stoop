// The negotiating agent on Amazon Bedrock AgentCore Runtime, seen from the shop.
//
// Each buyer message becomes one InvokeAgentRuntime call (session = the negotiation). The runtime
// gets a one-time grant for this shop's negotiation port (/agent-port), valid for one negotiation
// and a few minutes; through it, and only it, the agent reads the listing, asks the owner's oracle
// and records offers. If AgentCore can't be reached before the agent touched anything, the same
// agent runs inside the shop instead, so a buyer never waits on infrastructure.
import { randomBytes } from "node:crypto";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { Hono } from "hono";
import type { NegotiatorResult } from "@stoop/agents";
import type { EventBus, Settlement } from "@stoop/settlement";

type Turn = { negotiationId: string; buyerText: string; offerMinor?: number };
interface Grant {
  negotiationId: string;
  listingId: string;
  exp: number;
  used: boolean;
}

/** One-time grants for the negotiation port. */
export class PortGrants {
  private grants = new Map<string, Grant>();
  constructor(private now: () => number) {}
  issue(negotiationId: string, listingId: string, ttlMs = 3 * 60_000) {
    const t = this.now();
    for (const [k, g] of this.grants) if (g.exp < t) this.grants.delete(k);
    const token = `np_${randomBytes(24).toString("base64url")}`;
    this.grants.set(token, { negotiationId, listingId, exp: t + ttlMs, used: false });
    return token;
  }
  get(token: string) {
    const g = this.grants.get(token);
    return g && g.exp >= this.now() ? g : undefined;
  }
  revoke(token: string) {
    this.grants.delete(token);
  }
}

/**
 * The negotiation port: the only door the remote agent has into the shop. Every call must carry a
 * live grant and name that grant's own negotiation (or its listing); nothing else is reachable.
 */
export function agentPortRouter(settlement: Settlement, grants: PortGrants) {
  const app = new Hono();
  app.post("/", async (c) => {
    const h = c.req.header("Authorization") ?? "";
    const g = grants.get(h.startsWith("Bearer ") ? h.slice(7) : "");
    if (!g) return c.json({ error: "no_grant" }, 401);
    const { method, args } = (await c.req.json().catch(() => ({}))) as { method?: string; args?: unknown[] };
    const a = Array.isArray(args) ? args : [];
    const own = (id: unknown, kind: "negotiation" | "listing") => (kind === "negotiation" ? id === g.negotiationId : id === g.listingId);
    const s = settlement;
    const methods: Record<string, { on: "negotiation" | "listing"; run(): Promise<unknown> }> = {
      getNegotiation: { on: "negotiation", run: () => s.getNegotiation(g.negotiationId) },
      getListing: { on: "listing", run: () => s.getListing(g.listingId) },
      oracle: { on: "negotiation", run: () => s.oracle(g.negotiationId, Number(a[1])) },
      recordOffer: { on: "negotiation", run: () => s.recordOffer(g.negotiationId, a[1] === "seller" ? "seller" : "buyer", Number(a[2]), String(a[3] ?? "").slice(0, 600)) },
      proposeAccept: { on: "negotiation", run: () => s.proposeAccept(g.negotiationId, Number(a[1])) },
      checkOutgoing: { on: "listing", run: () => s.checkOutgoing(g.listingId, String(a[1] ?? "")) },
      strike: { on: "negotiation", run: () => s.strike(g.negotiationId, String(a[1] ?? "")) },
      noteRefusal: { on: "negotiation", run: () => s.noteRefusal(g.negotiationId, String(a[1] ?? "")) },
      offerAllowed: { on: "negotiation", run: () => s.offerAllowed(g.negotiationId) },
      markDisclosed: { on: "negotiation", run: () => s.markDisclosed(g.negotiationId) },
    };
    const m = method ? methods[method] : undefined;
    if (!m) return c.json({ error: "unknown_method" }, 400);
    if (!own(a[0], m.on)) return c.json({ error: "not_this_negotiation" }, 403);
    g.used = true;
    try {
      return c.json({ result: (await m.run()) ?? null });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
    }
  });
  return app;
}

/** Runs each turn on AgentCore Runtime; the shop's own copy of the agent covers outages. */
export class AgentCoreNegotiator {
  private client: BedrockAgentCoreClient;
  constructor(
    private o: {
      runtimeArn: string;
      region: string;
      portUrl: string;
      settlement: Settlement;
      grants: PortGrants;
      local: { turn(input: Turn): Promise<NegotiatorResult> };
      bus: EventBus;
      now: () => number;
      /** Model budget: false when today's calls are used up (then the local, offline agent answers). */
      budget: () => boolean;
    },
  ) {
    this.client = new BedrockAgentCoreClient({ region: o.region });
  }

  async turn(input: Turn): Promise<NegotiatorResult> {
    if (!this.o.budget()) return this.o.local.turn(input);
    const n = await this.o.settlement.getNegotiation(input.negotiationId);
    const token = this.o.grants.issue(n.id, n.listingId);
    const t0 = this.o.now();
    try {
      const res = await this.client.send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: this.o.runtimeArn,
          runtimeSessionId: `stoop-negotiation-${n.id}`.padEnd(40, "-"),
          contentType: "application/json",
          accept: "application/json",
          payload: new TextEncoder().encode(JSON.stringify({ input, port: { url: this.o.portUrl, token } })),
        }),
      );
      const out = JSON.parse((await res.response?.transformToString()) ?? "{}") as NegotiatorResult & { error?: string };
      if (!out.reply) throw new Error(out.error ?? "empty reply");
      this.o.bus.emit({ type: "agentcore_turn", at: this.o.now(), negotiationId: n.id, action: out.action, ms: this.o.now() - t0 });
      return out;
    } catch (e) {
      const touched = this.o.grants.get(token)?.used ?? true;
      this.o.bus.emit({ type: "agentcore_fallback", at: this.o.now(), negotiationId: n.id, error: String(e).slice(0, 160), touched });
      // if the remote agent already acted (recorded an offer, proposed a deal), don't act twice
      if (touched) return { action: "answered", reply: "Thanks, I've passed that on. Check back in a moment for an answer.", signals: [], usedFallback: true, guardBlocks: 0 };
      return this.o.local.turn(input);
    } finally {
      this.o.grants.revoke(token);
    }
  }
}
