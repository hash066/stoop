import { describe, expect, it } from "vitest";
import type { RingEvent } from "@stoop/shared";
import { buildEnvelope, normalizeEnvelope, ringWebhookRouter, RingClient, RingApiError, signBody, verifySignature } from "../src/index.ts";

const KEY = "ring-hmac-key";
const SIM = "sim-key";
const NOW = Date.UTC(2026, 9, 20, 22, 0);

function setup() {
  const seen = new Set<string>();
  const events: RingEvent[] = [];
  const app = ringWebhookRouter({
    hmacKey: KEY,
    simulatorKey: SIM,
    markSeen: async (id) => (seen.has(id) ? false : (seen.add(id), true)),
    onEvent: async (e) => {
      events.push(e);
    },
    now: () => NOW,
  });
  const post = (body: string, sig: string) =>
    app.request("/ring/webhook", { method: "POST", headers: { "X-Signature": sig, "Content-Type": "application/json" }, body });
  return { app, post, events };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Ring webhook ingest", () => {
  it("accepts a Ring-signed motion event and labels origin", async () => {
    const { post, events } = setup();
    const body = JSON.stringify(buildEnvelope({ type: "motion_detected", deviceId: "dev1", at: NOW, subType: "human", requestId: "r1" }));
    const res = await post(body, signBody(body, KEY));
    expect(res.status).toBe(200);
    await flush();
    expect(events[0]).toMatchObject({ kind: "motion_detected", deviceId: "dev1", subType: "human", origin: "ring", requestId: "r1" });
  });

  it("labels simulator-signed events as simulator, never as Ring", async () => {
    const { post, events } = setup();
    const body = JSON.stringify(buildEnvelope({ type: "button_press", deviceId: "dev1", at: NOW, requestId: "r2" }));
    await post(body, signBody(body, SIM));
    await flush();
    expect(events[0]?.origin).toBe("simulator");
  });

  it("rejects bad signatures, stale timestamps, and dedupes replays (X10)", async () => {
    const { post, events } = setup();
    const body = JSON.stringify(buildEnvelope({ type: "motion_detected", deviceId: "dev1", at: NOW, requestId: "r3" }));
    expect((await post(body, "sha256=deadbeef")).status).toBe(401);
    expect((await post(body, signBody(body + " ", KEY))).status).toBe(401); // body altered after signing
    const stale = JSON.stringify(buildEnvelope({ type: "motion_detected", deviceId: "dev1", at: NOW - 10 * 60 * 1000, requestId: "r4" }));
    expect((await post(stale, signBody(stale, KEY))).status).toBe(401);
    expect((await post(body, signBody(body, KEY))).status).toBe(200);
    const dup = await post(body, signBody(body, KEY));
    expect(await dup.json()).toMatchObject({ duplicate: true });
    await flush();
    expect(events).toHaveLength(1);
  });

  it("normalizes unknown sub_types and lifecycle events", () => {
    const n = normalizeEnvelope(buildEnvelope({ type: "motion_detected", deviceId: "d", at: NOW, subType: "pet", requestId: "x" }), "ring");
    expect(n.kind === "event" && n.event.subType).toBe("pet");
    const l = normalizeEnvelope(buildEnvelope({ type: "device_offline", deviceId: "d", at: NOW, requestId: "y" }), "ring");
    expect(l).toMatchObject({ kind: "lifecycle", type: "device_offline" });
  });

  it("verifySignature is strict about format", () => {
    expect(verifySignature("{}", undefined, KEY)).toBe(false);
    expect(verifySignature("{}", "md5=abc", KEY)).toBe(false);
  });
});

describe("RingClient", () => {
  function fakeFetch(routes: Array<(url: string, init?: RequestInit) => Response | undefined>) {
    const calls: string[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      for (const r of routes) {
        const res = r(url, init);
        if (res) return res;
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    return { f, calls };
  }

  it("follows the snapshot 303 to the pre-signed URL without the bearer token", async () => {
    let presignedAuth: string | null = "unset";
    const { f } = fakeFetch([
      (u) =>
        u.endsWith("/media/image/download")
          ? new Response(null, { status: 303, headers: { Location: "https://s3.example/presigned.jpg", "X-Media-Timestamp": "123" } })
          : undefined,
      (u, init) => {
        if (u === "https://s3.example/presigned.jpg") {
          presignedAuth = new Headers(init?.headers).get("Authorization");
          return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg" } });
        }
        return undefined;
      },
    ]);
    const c = new RingClient({ getToken: async () => "tok", fetchImpl: f });
    const snap = await c.snapshot("dev1", { type: "at_timestamp", timestamp: 1 });
    expect(Array.from(snap.bytes)).toEqual([1, 2, 3]);
    expect(snap.mediaTimestamp).toBe(123);
    expect(presignedAuth).toBeNull();
  });

  it("retries clips on 425 then succeeds; 503 maps to offline", async () => {
    let n = 0;
    const { f } = fakeFetch([
      (u) => (u.endsWith("/media/video/download") ? (++n < 3 ? new Response(null, { status: 425 }) : new Response(new Uint8Array([9]))) : undefined),
    ]);
    const c = new RingClient({ getToken: async () => "tok", fetchImpl: f, sleep: async () => {} });
    expect(Array.from(await c.clip("dev1", 1, 10_000))).toEqual([9]);
    const off = new RingClient({
      getToken: async () => "tok",
      fetchImpl: (async () => new Response(JSON.stringify({ errors: [{ code: "DEVICE_OFFLINE" }] }), { status: 503 })) as typeof fetch,
    });
    await expect(off.listDevices()).rejects.toSatisfy((e: unknown) => e instanceof RingApiError && e.offline);
  });

  it("honours 429 Retry-After", async () => {
    let n = 0;
    const waits: number[] = [];
    const { f } = fakeFetch([
      (u) => (u.includes("/v1/devices") ? (++n === 1 ? new Response(null, { status: 429, headers: { "Retry-After": "2" } }) : Response.json({ data: [] })) : undefined),
    ]);
    const c = new RingClient({ getToken: async () => "tok", fetchImpl: f, sleep: async (ms) => void waits.push(ms) });
    expect(await c.listDevices()).toEqual([]);
    expect(waits).toEqual([2000]);
  });
});
