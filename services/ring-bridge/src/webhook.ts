// Ring webhook ingest (Ring Partner API docs):
//  - header `X-Signature: sha256=<hex>` = HMAC-SHA256(raw body, onboarding HMAC key); compare in constant time
//  - v1.1 envelope { meta{version,time,request_id,account_id}, data{id,type,attributes,relationships} }
//  - dedupe on meta.request_id; reply 2xx within 5 s and process asynchronously (Ring retries 1s..1h)
import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { RingWebhookEnvelope, type RingEvent } from "@stoop/shared";

export const MAX_SKEW_MS = 5 * 60 * 1000;

export function signBody(raw: string | Uint8Array, key: string): string {
  return `sha256=${createHmac("sha256", key).update(raw).digest("hex")}`;
}

export function verifySignature(raw: string | Uint8Array, header: string | undefined, key: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const want = Buffer.from(signBody(raw, key), "utf8");
  const got = Buffer.from(header, "utf8");
  return want.length === got.length && timingSafeEqual(want, got);
}

export type NormalizedWebhook =
  | { kind: "event"; event: RingEvent; requestId: string }
  | { kind: "lifecycle"; type: string; deviceId?: string; requestId: string }
  | { kind: "ignored"; type: string; requestId: string };

/** Parse + normalize a verified envelope. `origin` labels whether Ring or our simulator produced it. */
export function normalizeEnvelope(json: unknown, origin: RingEvent["origin"]): NormalizedWebhook {
  const env = RingWebhookEnvelope.parse(json);
  const a = env.data.attributes;
  const requestId = env.meta.request_id;
  const deviceId = a.source ?? "";
  const at = a.timestamp ?? Date.parse(env.meta.time);
  switch (env.data.type) {
    case "motion_detected":
      return {
        kind: "event",
        requestId,
        event: { kind: "motion_detected", deviceId, at, subType: a.sub_type, componentIds: a.component_ids, origin, requestId },
      };
    case "button_press":
      return { kind: "event", requestId, event: { kind: "button_press", deviceId, at, origin, requestId } };
    case "device_online":
    case "device_offline":
    case "device_added":
    case "device_removed":
    case "app_integration_added":
    case "app_integration_removed":
    case "subscription_activated":
    case "subscription_deactivated":
      return { kind: "lifecycle", type: env.data.type, deviceId: deviceId || undefined, requestId };
    default:
      return { kind: "ignored", type: env.data.type, requestId };
  }
}

export interface WebhookDeps {
  /** HMAC key: Ring's onboarding key in production. */
  hmacKey: string;
  /** Optional second key accepted for our simulator; events verified with it are labelled origin=simulator. */
  simulatorKey?: string;
  /** Returns false if this request id was already seen (DynamoDB conditional put + TTL in AWS). */
  markSeen(requestId: string): Promise<boolean>;
  onEvent(e: RingEvent): Promise<void>;
  onLifecycle?(type: string, deviceId: string | undefined): Promise<void>;
  now(): number;
  log?(msg: string, data?: Record<string, unknown>): void;
}

export function ringWebhookRouter(deps: WebhookDeps) {
  const app = new Hono();
  app.post("/ring/webhook", async (c) => {
    // Raw bytes: the HMAC is over the exact body. Never JSON.parse before verifying.
    const raw = new Uint8Array(await c.req.arrayBuffer());
    const sig = c.req.header("X-Signature");
    let origin: RingEvent["origin"] | undefined;
    if (verifySignature(raw, sig, deps.hmacKey)) origin = "ring";
    else if (deps.simulatorKey && verifySignature(raw, sig, deps.simulatorKey)) origin = "simulator";
    if (!origin) {
      deps.log?.("ring_webhook_bad_signature");
      return c.json({ error: "invalid_signature" }, 401);
    }
    let parsed: NormalizedWebhook;
    let metaTime: number;
    try {
      const json = JSON.parse(new TextDecoder().decode(raw));
      metaTime = Date.parse(json?.meta?.time);
      parsed = normalizeEnvelope(json, origin);
    } catch {
      return c.json({ error: "invalid_payload" }, 400); // 4xx: Ring will not retry
    }
    if (!Number.isFinite(metaTime) || Math.abs(deps.now() - metaTime) > MAX_SKEW_MS) {
      deps.log?.("ring_webhook_stale", { requestId: parsed.requestId });
      return c.json({ error: "stale_or_future_timestamp" }, 401);
    }
    if (!(await deps.markSeen(parsed.requestId))) return c.json({ ok: true, duplicate: true }, 200);
    // Ack immediately; process after the response (EventBridge/SQS in AWS).
    queueMicrotask(() => {
      const work =
        parsed.kind === "event"
          ? deps.onEvent(parsed.event)
          : parsed.kind === "lifecycle"
            ? (deps.onLifecycle?.(parsed.type, parsed.deviceId) ?? Promise.resolve())
            : Promise.resolve();
      work.catch((e) => deps.log?.("ring_webhook_processing_failed", { error: String(e) }));
    });
    return c.json({ ok: true, origin }, 200);
  });
  return app;
}

/** Build a Ring-shaped v1.1 envelope (used by the simulator and tests). */
export function buildEnvelope(input: {
  type: "motion_detected" | "button_press" | "device_offline" | "device_online";
  deviceId: string;
  at: number;
  subType?: string;
  requestId: string;
  accountId?: string;
}) {
  const attributes: Record<string, unknown> = { source: input.deviceId, source_type: "devices", timestamp: input.at };
  if (input.type === "motion_detected") {
    attributes.timestamp_readable = new Date(input.at).toISOString().replace("Z", "");
    attributes.sub_type = input.subType ?? "motion";
  }
  return {
    meta: { version: "1.1", time: new Date(input.at).toISOString(), request_id: input.requestId, account_id: input.accountId ?? "acct_sim" },
    data: { id: `evt_${input.requestId}`, type: input.type, attributes, relationships: {} },
  };
}
