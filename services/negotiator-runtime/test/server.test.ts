// AgentCore's contract: GET /ping says Healthy, POST /invocations answers JSON (an error for a bad call).
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";

process.env.STOOP_RUNTIME_NO_LISTEN = "1";
const { server, handle } = await import("../src/server.ts");
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(() => server.close());

describe("negotiator runtime", () => {
  it("answers AgentCore's health check", async () => {
    const r = await fetch(`${base}/ping`);
    expect(await r.json()).toMatchObject({ status: "Healthy" });
  });
  it("rejects an invocation without a negotiation or a port grant", async () => {
    await expect(handle({} as never)).rejects.toThrow(/bad_invocation/);
    const r = await fetch(`${base}/invocations`, { method: "POST", body: JSON.stringify({ input: { negotiationId: "n", buyerText: "hi" } }) });
    expect(r.status).toBe(500);
    expect((await r.json()).error).toMatch(/bad_invocation/);
  });
  it("only ever reaches the shop through the port it was given", async () => {
    const seen: string[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${String(url)} ${JSON.parse(String(init?.body)).method}`);
      return new Response(JSON.stringify({ error: "no_grant" }), { status: 401 });
    }) as typeof fetch;
    await expect(handle({ input: { negotiationId: "neg_1", buyerText: "hi" }, port: { url: "https://shop.example/agent-port", token: "np_x" } }, fake)).rejects.toThrow(/no_grant/);
    expect(seen.every((s) => s.startsWith("https://shop.example/agent-port "))).toBe(true);
  });
});
