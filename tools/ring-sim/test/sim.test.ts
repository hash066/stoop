import { normalizeEnvelope, ringWebhookRouter, verifySignature } from "@stoop/ring-bridge";
import { describe, expect, it } from "vitest";
import { DEFAULT_SIM_KEY, replayAttack, send, signedEvent } from "../src/sim.ts";

const RING_KEY = "real-ring-key";

/** The real webhook router behind an in-memory fetch, as a deployed stack would run it. */
function target() {
  const events: Array<{ origin: string; kind: string }> = [];
  const seen = new Set<string>();
  const app = ringWebhookRouter({
    hmacKey: RING_KEY,
    simulatorKey: DEFAULT_SIM_KEY,
    markSeen: async (id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
    onEvent: async (e) => void events.push({ origin: e.origin, kind: e.kind }),
    now: () => Date.now(),
  });
  const fetchImpl = ((input: URL | RequestInfo, init?: RequestInit) => app.request(String(input), init)) as typeof fetch;
  return { events, fetchImpl };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("ring-sim", () => {
  it("signs v1.1 envelopes with the simulator key, never the Ring key", () => {
    const ev = signedEvent({ type: "motion_detected", subType: "human", key: DEFAULT_SIM_KEY });
    expect(verifySignature(ev.body, ev.headers["X-Signature"], DEFAULT_SIM_KEY)).toBe(true);
    expect(verifySignature(ev.body, ev.headers["X-Signature"], RING_KEY)).toBe(false);
    expect(normalizeEnvelope(JSON.parse(ev.body), "simulator").kind).toBe("event");
  });

  it("events land labelled as simulator", async () => {
    const t = target();
    const r = await send("http://stoop.test", signedEvent({ type: "button_press", key: DEFAULT_SIM_KEY }), t.fetchImpl);
    expect(r.status).toBe(200);
    await settle();
    expect(t.events).toEqual([{ origin: "simulator", kind: "button_press" }]);
  });

  it("replay attack: accepted once, then deduped; forged and stale rejected (X10)", async () => {
    const t = target();
    const steps = await replayAttack("http://stoop.test", DEFAULT_SIM_KEY, undefined, t.fetchImpl);
    expect(steps.map((s) => s.status)).toEqual([200, 200, 401, 401]);
    expect(steps[1]!.body).toMatchObject({ duplicate: true });
    await settle();
    expect(t.events).toHaveLength(1);
  });
});
