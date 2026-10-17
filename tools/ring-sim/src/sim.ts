// Builds and sends simulator-signed Ring webhooks. Payloads match the Ring Partner API v1.1 envelope;
// the HMAC uses our simulator key, so Stoop labels every event origin="simulator" (never "Ring-signed").
import { randomUUID } from "node:crypto";
import { buildEnvelope, signBody } from "@stoop/ring-bridge";

export type SimEventType = "motion_detected" | "button_press" | "device_offline" | "device_online";

export const DEFAULT_URL = "http://127.0.0.1:8787";
export const DEFAULT_DEVICE = "ring_sim_doorbell_1";
/** Matches the local stack's default; deployed stacks read RING_SIMULATOR_KEY. */
export const DEFAULT_SIM_KEY = "stoop-simulator-key-not-ring";

export interface SignedEvent {
  body: string;
  headers: Record<string, string>;
  requestId: string;
}

export function signedEvent(opts: {
  type: SimEventType;
  key: string;
  deviceId?: string;
  subType?: string;
  at?: number;
  requestId?: string;
  badSignature?: boolean;
}): SignedEvent {
  const requestId = opts.requestId ?? `sim_${randomUUID()}`;
  const body = JSON.stringify(
    buildEnvelope({ type: opts.type, deviceId: opts.deviceId ?? DEFAULT_DEVICE, at: opts.at ?? Date.now(), subType: opts.subType, requestId }),
  );
  const signature = opts.badSignature ? `sha256=${"0".repeat(64)}` : signBody(body, opts.key);
  return { body, requestId, headers: { "Content-Type": "application/json", "X-Signature": signature } };
}

export async function send(baseUrl: string, ev: SignedEvent, fetchImpl: typeof fetch = fetch) {
  const res = await fetchImpl(new URL("/ring/webhook", baseUrl), { method: "POST", headers: ev.headers, body: ev.body });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body };
}

/** X10 from the outside: signed -> accepted, replay -> deduped, forged -> 401, stale -> rejected. */
export async function replayAttack(baseUrl: string, key: string, deviceId?: string, fetchImpl: typeof fetch = fetch) {
  const first = signedEvent({ type: "motion_detected", subType: "human", key, deviceId });
  const forged = signedEvent({ type: "motion_detected", subType: "human", key, deviceId, badSignature: true });
  const stale = signedEvent({ type: "motion_detected", subType: "human", key, deviceId, at: Date.now() - 10 * 60_000 });
  return [
    { step: "signed event", ...(await send(baseUrl, first, fetchImpl)) },
    { step: "same event replayed", ...(await send(baseUrl, first, fetchImpl)) },
    { step: "bad signature", ...(await send(baseUrl, forged, fetchImpl)) },
    { step: "10 minutes stale", ...(await send(baseUrl, stale, fetchImpl)) },
  ];
}

/** Server-side scenarios (footage scene + events + time skips) exposed by the stack's /sim routes. */
export async function scenario(baseUrl: string, name: string, dealId?: string, fetchImpl: typeof fetch = fetch) {
  const res = await fetchImpl(new URL(`/sim/scenario/${encodeURIComponent(name)}`, baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dealId ? { dealId } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
