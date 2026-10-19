// The Stoop negotiating agent on Amazon Bedrock AgentCore Runtime.
//
// AgentCore runs this file (Node 22) and calls POST /invocations once per buyer message. The agent
// holds none of Stoop's data. Everything it needs (the listing, the owner's rules as an
// "acceptable? counter?" oracle, recording an offer, proposing a deal) it asks the shop for through
// a negotiation port: an HTTPS endpoint on the shop, opened with a one-time grant that works only
// for this one conversation and expires within minutes. The owner's address and lowest price never
// reach it, exactly as when the agent runs inside the shop.
import { createServer, type IncomingMessage } from "node:http";
import { Negotiator, type NegotiationPort, type NegotiatorResult } from "@stoop/agents";

export interface Invocation {
  input: { negotiationId: string; buyerText: string; offerMinor?: number };
  port: { url: string; token: string };
}

/** The shop's side of the negotiation, reached over HTTPS with the one-time grant. */
export function remotePort(url: string, token: string, fetchImpl: typeof fetch = fetch): NegotiationPort {
  const call = async (method: string, ...args: unknown[]) => {
    const r = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ method, args }),
    });
    const j = (await r.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!r.ok || j.error) throw new Error(`negotiation port ${method}: ${j.error ?? r.status}`);
    return j.result as never;
  };
  return {
    getNegotiation: (id) => call("getNegotiation", id),
    getListing: (id) => call("getListing", id),
    oracle: (id, offerMinor) => call("oracle", id, offerMinor),
    recordOffer: (id, by, amountMinor, message) => call("recordOffer", id, by, amountMinor, message),
    proposeAccept: (id, amountMinor) => call("proposeAccept", id, amountMinor),
    checkOutgoing: (listingId, text) => call("checkOutgoing", listingId, text),
    strike: (id, signal) => call("strike", id, signal),
    noteRefusal: (id, signal) => call("noteRefusal", id, signal),
    offerAllowed: (id) => call("offerAllowed", id),
    markDisclosed: (id) => call("markDisclosed", id),
  };
}

export async function handle(body: Invocation, fetchImpl?: typeof fetch): Promise<NegotiatorResult> {
  if (!body?.input?.negotiationId || !body?.port?.url || !body?.port?.token) throw new Error("bad_invocation");
  return new Negotiator(remotePort(body.port.url, body.port.token, fetchImpl)).turn(body.input);
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });

export const server = createServer(async (req, res) => {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/ping") return json(200, { status: "Healthy", time_of_last_update: Math.floor(Date.now() / 1000) });
  if (req.method === "POST" && req.url?.startsWith("/invocations")) {
    const t0 = Date.now();
    let body: Invocation | undefined;
    try {
      body = JSON.parse(await readBody(req)) as Invocation;
      const out = await handle(body);
      // one structured line per turn: AgentCore sends it to CloudWatch (no message text, no prices)
      console.log(JSON.stringify({ event: "negotiator_turn", negotiationId: body.input.negotiationId, action: out.action, usedFallback: out.usedFallback, guardBlocks: out.guardBlocks, ms: Date.now() - t0 }));
      return json(200, out);
    } catch (e) {
      console.log(JSON.stringify({ event: "negotiator_error", negotiationId: body?.input?.negotiationId, error: String(e).slice(0, 200), ms: Date.now() - t0 }));
      return json(500, { error: String(e).slice(0, 200) });
    }
  }
  json(404, { error: "not_found" });
});

if (process.env.STOOP_RUNTIME_NO_LISTEN !== "1") {
  server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => console.log(JSON.stringify({ event: "negotiator_ready", port: Number(process.env.PORT ?? 8080) })));
}
