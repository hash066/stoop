// Ring Partner API client (server-side only; browsers are CORS-blocked).
// Base: https://api.amazonvision.com (JSON:API). Auth: OAuth Bearer (Playground tokens last 30 min).
// Implements the documented quirks: snapshot = 303 + pre-signed Location; clips retry on 416/425;
// 429 honours Retry-After; 503 = device offline; E2EE devices are excluded.

export const RING_API_BASE = "https://api.amazonvision.com";

export class RingApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
  get offline() {
    return this.status === 503;
  }
  get tokenExpired() {
    return this.status === 401;
  }
}

export interface RingDevice {
  id: string;
  name?: string;
  kind?: string;
  online?: boolean;
  e2ee?: boolean;
  raw: unknown;
}

export interface SnapshotResult {
  bytes: Uint8Array;
  mime: string;
  mediaTimestamp?: number;
  mediaOrigin?: string;
}

export interface RingClientOptions {
  getToken(): Promise<string>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?(ms: number): Promise<void>;
}

export class RingClient {
  private base: string;
  private f: typeof fetch;
  private sleep: (ms: number) => Promise<void>;

  constructor(private o: RingClientOptions) {
    this.base = o.baseUrl ?? RING_API_BASE;
    this.f = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async req(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
    const res = await this.f(`${this.base}${path}`, {
      ...init,
      redirect: "manual",
      headers: { Authorization: `Bearer ${await this.o.getToken()}`, Accept: "application/vnd.api+json, application/json", ...(init.headers ?? {}) },
    });
    if (res.status === 429 && attempt < 3) {
      const wait = Number(res.headers.get("Retry-After") ?? "1") * 1000;
      await this.sleep(Math.min(wait, 10_000));
      return this.req(path, init, attempt + 1);
    }
    return res;
  }

  private async fail(res: Response): Promise<never> {
    let code = `http_${res.status}`;
    let detail = res.statusText;
    try {
      const j = (await res.json()) as { errors?: Array<{ code?: string; title?: string; detail?: string }> };
      code = j.errors?.[0]?.code ?? j.errors?.[0]?.title ?? code;
      detail = j.errors?.[0]?.detail ?? detail;
    } catch {
      /* non-JSON error */
    }
    throw new RingApiError(res.status, code, detail);
  }

  async listDevices(): Promise<RingDevice[]> {
    const res = await this.req("/v1/devices?include=status,capabilities,location,configurations");
    if (!res.ok) return this.fail(res);
    const j = (await res.json()) as {
      data?: Array<{ id: string; type?: string; attributes?: Record<string, unknown>; relationships?: unknown }>;
      included?: Array<{ id: string; type: string; attributes?: Record<string, unknown> }>;
    };
    return (j.data ?? []).map((d) => {
      const conf = j.included?.find((i) => i.type?.includes("configuration") && i.id.startsWith(d.id));
      const status = j.included?.find((i) => i.type?.includes("status") && i.id.startsWith(d.id));
      const e2ee = (conf?.attributes?.e2e_encryption as { enabled?: boolean } | undefined)?.enabled === true;
      return {
        id: d.id,
        name: (d.attributes?.name as string) ?? undefined,
        kind: (d.attributes?.kind as string) ?? d.type,
        online: (status?.attributes?.online as boolean | undefined) ?? undefined,
        e2ee,
        raw: d,
      };
    });
  }

  /** POST .../media/image/download -> 303 + pre-signed Location -> GET bytes. */
  async snapshot(
    deviceId: string,
    opts: { type: "at_timestamp"; timestamp: number } | { type: "latest_in_range"; startTimestamp: number; endTimestamp?: number },
  ): Promise<SnapshotResult> {
    const body =
      opts.type === "at_timestamp"
        ? { type: "at_timestamp", timestamp: opts.timestamp }
        : { type: "latest_in_range", start_timestamp: opts.startTimestamp, end_timestamp: opts.endTimestamp };
    const res = await this.req(`/v1/devices/${encodeURIComponent(deviceId)}/media/image/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, image_options: { format: "jpeg", resolution: { width: 1920, height: 1080 } } }),
    });
    if (res.status !== 303) return this.fail(res);
    const location = res.headers.get("Location");
    if (!location) throw new RingApiError(502, "missing_location", "Snapshot 303 without Location header");
    const img = await this.f(location); // pre-signed: no Authorization header
    if (!img.ok) throw new RingApiError(img.status, "snapshot_fetch_failed", img.statusText);
    const ts = res.headers.get("X-Media-Timestamp");
    return {
      bytes: new Uint8Array(await img.arrayBuffer()),
      mime: img.headers.get("Content-Type") ?? "image/jpeg",
      mediaTimestamp: ts ? Number(ts) : undefined,
      mediaOrigin: res.headers.get("X-Media-Origin") ?? undefined,
    };
  }

  /** POST .../media/video/download; retries 416 MEDIA_NOT_FOUND / 425 RECORDING_NOT_READY for ~2 min. */
  async clip(deviceId: string, timestamp: number, durationMs: number, opts: { maxWaitMs?: number } = {}): Promise<Uint8Array> {
    const deadline = Date.now() + (opts.maxWaitMs ?? 120_000);
    for (;;) {
      const res = await this.req(`/v1/devices/${encodeURIComponent(deviceId)}/media/video/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timestamp, duration: Math.min(durationMs, 900_000), video_options: { codec: "avc" } }),
      });
      if (res.status === 301 || res.status === 302) {
        const loc = res.headers.get("Location");
        if (loc) return new Uint8Array(await (await this.f(loc)).arrayBuffer());
      }
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      if ((res.status === 416 || res.status === 425) && Date.now() < deadline) {
        await this.sleep(10_000);
        continue;
      }
      return this.fail(res);
    }
  }

  /** WHEP offer -> answer SDP for the live tile (proxied; browsers can't call Ring directly). */
  async whep(deviceId: string, sdpOffer: string): Promise<{ answer: string; sessionUrl?: string }> {
    const res = await this.req(`/v1/devices/${encodeURIComponent(deviceId)}/media/streaming/whep/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: sdpOffer,
    });
    if (!res.ok && res.status !== 201) return this.fail(res);
    return { answer: await res.text(), sessionUrl: res.headers.get("Location") ?? undefined };
  }

  async history(deviceId: string, cursor?: string) {
    const q = cursor ? `?page[key]=${encodeURIComponent(cursor)}` : "";
    const res = await this.req(`/v1/history/devices/${encodeURIComponent(deviceId)}/events${q}`);
    if (!res.ok) return this.fail(res);
    return (await res.json()) as { data: unknown[]; links?: { next?: string } };
  }
}
