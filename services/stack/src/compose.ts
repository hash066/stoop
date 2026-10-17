// Wires every Stoop service into one Hono app for local development, the e2e tests and judge mode.
// AWS mapping (see docs/ARCHITECTURE.md): MCP host -> AgentCore Runtime / EC2; Settlement + UCP ->
// its own Lambda; Ring webhook -> Lambda + EventBridge; scheduler -> Step Functions; store -> DynamoDB.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { Appraiser, cpscChecker, llmMode, Negotiator, planTurn, rulesOnlyChecker, type RecallChecker } from "@stoop/agents";
import { loadCards, mcpRouter, type BuyerActor, type SellerActor, type StoopContext } from "@stoop/mcp-server";
import { localHmacProvider, memorySpentStore } from "@stoop/policy";
import { localSigner, verifyReceipt } from "@stoop/proof-of-handoff";
import { buildEnvelope, FootageSource, RingClient, RingSnapshotSource, ringWebhookRouter, signBody, type FrameSource, type Scene } from "@stoop/ring-bridge";
import {
  EventBus,
  localVault,
  MemoryStore,
  SandboxPSP,
  Settlement,
  SettlementError,
  systemClock,
  TickScheduler,
  ucpRouter,
  type Clock,
  type ScheduledJob,
} from "@stoop/settlement";
import { BedrockVision, LabelVision, Verifier } from "@stoop/verifier";
import { LocalPhotoStore, LocalPreferenceMemory } from "./memory.ts";
import { NotificationHub } from "./notifications.ts";
import { verifyPageHtml, refundPolicyHtml } from "./pages.ts";

export interface StackConfig {
  publicBaseUrl: string;
  passBaseUrl: string;
  allowedOrigins: string[];
  /** Repo root (fixtures/, packages/ui-cards/dist, skills/). */
  rootDir: string;
  clock?: Clock;
  ringHmacKey?: string;
  simulatorKey?: string;
  /** Multiply verifier delays (0 = immediate, for tests; 0.1 = fast demo). */
  frameDelayScale?: number;
  /** Demo: pickup windows start now instead of at the seller's next preferred slot. */
  immediateWindow?: boolean;
  autoTick?: boolean;
  recallChecker?: RecallChecker;
  ringToken?: string;
  frameSource?: "footage" | "ring";
  /** Persist the receipt signing key under .data/ so receipts stay verifiable across restarts. */
  persistKeys?: boolean;
  /** Seed the demo household, buyers and photos. */
  seedDemo?: boolean;
}

export const DEMO = {
  household: { id: "hh_okafor", displayName: "The Okafors", address: "1427 Maple Ridge Dr, Columbus, OH 43215", zip: "43215", porch: "Left of the front door, by the bench. Please close the gate behind you." },
  sellerToken: "seller-demo-okafor",
  buyers: [
    { id: "buyer_dana", displayName: "Dana", email: "dana@example.com", voiceCode: "4821", wallet: "tok_visa_4242", token: "buyer-demo-dana" },
    { id: "buyer_lee", displayName: "Lee", email: "lee@example.com", voiceCode: "1111", wallet: "tok_mc_5555", token: "buyer-demo-lee" },
  ],
  ringDeviceId: "ring_sim_doorbell_1",
};

export async function createStack(cfg: StackConfig) {
  const clock = cfg.clock ?? systemClock;
  const store = new MemoryStore();
  const bus = new EventBus();
  const scheduler = new TickScheduler();
  const psp = new SandboxPSP();
  const dataDir = join(cfg.rootDir, ".data");
  const signer = localSigner({ kid: "stoop-local-1", privateKeyPem: cfg.persistKeys ? loadOrCreateKey(join(dataDir, "receipt-signing-key.pem")) : undefined });
  const ringHmacKey = cfg.ringHmacKey ?? randomBytes(16).toString("hex");
  const simulatorKey = cfg.simulatorKey ?? "stoop-simulator-key-not-ring";

  const settlement = new Settlement({
    store,
    psp,
    macp: localHmacProvider(process.env.LOCAL_TOKEN_MAC_KEY ?? randomBytes(32)),
    spent: memorySpentStore(),
    signer,
    vault: localVault(process.env.LOCAL_VAULT_KEY ?? randomBytes(32).toString("hex")),
    clock,
    bus,
    scheduler,
    passBaseUrl: cfg.passBaseUrl,
    issuer: "stoop-settlement-local",
  });
  scheduler.onFire((j) => settlement.onJob(j));

  // ---------- frames, vision, verifier
  const footage = new FootageSource(join(cfg.rootDir, "fixtures", "footage"), loadFootageIndex(join(cfg.rootDir, "fixtures", "footage")));
  let ringToken = cfg.ringToken ?? process.env.RING_ACCESS_TOKEN ?? "";
  const ringClient = new RingClient({ getToken: async () => ringToken });
  const frames: FrameSource = cfg.frameSource === "ring" ? new RingSnapshotSource(ringClient) : footage;
  const vision = llmMode() === "bedrock" ? new BedrockVision(process.env.BEDROCK_MODEL_ID_VISION ?? "us.amazon.nova-2-lite-v1:0", process.env.AWS_REGION ?? "us-east-1") : new LabelVision();
  const lastFrames = new Map<string, { kind: string; sha256: string; presence: string; adapter: string; origin: string; mime: string; bytes: Uint8Array; at: number }>();
  const scale = cfg.frameDelayScale ?? 1;
  const verifier = new Verifier({
    sink: {
      recordFrame: (d, k, o) => settlement.recordFrame(d, k, o),
      setCameraStatus: (d, c) => settlement.setCameraStatus(d, c),
      dealInfo: async (dealId) => {
        const deal = await settlement.getDeal(dealId);
        const hh = await settlement.householdPublic(deal.householdId);
        return { itemTitle: deal.itemTitle, placement: hh.porchInstructions, deviceId: hh.ringDeviceId, state: deal.state };
      },
    },
    frames,
    vision,
    now: () => clock.now(),
    delay: (ms, fn) => {
      if (scale === 0) void fn();
      else setTimeout(() => void fn(), Math.round(ms * scale));
    },
    onFrame: ({ dealId, kind, frame, verdict, sha256 }) => {
      lastFrames.set(`${dealId}:${kind}`, { kind, sha256, presence: verdict.presence, adapter: verdict.adapter, origin: frame.origin, mime: frame.mime, bytes: frame.bytes, at: frame.at });
      bus.emit({ type: "frame_assessed", at: clock.now(), dealId, kind, presence: verdict.presence, adapter: verdict.adapter, origin: frame.origin, source: frame.sourceName });
    },
  });
  bus.on((e) => {
    if (e.type === "frame_needed") verifier.request({ dealId: String(e.dealId), kind: e.kind as "before" | "after", notBefore: e.notBefore as number | undefined, deviceId: e.deviceId as string | undefined });
  });

  // ---------- agents, memory, photos, cards
  const appraiser = Appraiser.forMode(cfg.recallChecker ?? cpscChecker());
  const negotiator = new Negotiator(settlement);
  const photos = new LocalPhotoStore(cfg.publicBaseUrl);
  const prefs = new LocalPreferenceMemory(() => [DEMO.household.address]);
  const cards = loadCards(join(cfg.rootDir, "packages", "ui-cards", "dist"));
  const skill = readSkill(cfg.rootDir);

  // ---------- auth (demo tokens; Cognito / account linking in AWS)
  const sellers = new Map<string, SellerActor>();
  const buyers = new Map<string, BuyerActor>();

  // ---------- Marshal: when funds are held, issue the pass for the seller's preferred window
  const otps = new Map<string, string>(); // passId -> otp (demo "email outbox" only)
  bus.on((e) => {
    if (e.type === "pass_issued") otps.set(String(e.passId), String(e.otpForEmail));
    if (e.type !== "funds_held") return;
    void (async () => {
      const deal = await settlement.getDeal(String(e.dealId));
      const p = await prefs.get(deal.householdId);
      const now = clock.now();
      let start: number;
      if (cfg.immediateWindow) start = now;
      else {
        const d = new Date(now);
        const hour = p?.fromHour ?? 18;
        d.setHours(hour, 0, 0, 0);
        start = d.getTime() <= now ? now : d.getTime();
      }
      const len = ((p?.toHour ?? 20) - (p?.fromHour ?? 18)) * 3600_000 || 2 * 3600_000;
      await settlement.issuePass(deal.id, { start, end: start + Math.min(len, 2 * 3600_000) }, "agent:marshal");
      await scheduler.runDue(clock.now());
    })().catch((err) => bus.emit({ type: "marshal_error", at: clock.now(), dealId: e.dealId, error: String(err) }));
  });

  // ---------- HTTP
  const app = new Hono();
  app.use("*", cors({ origin: cfg.allowedOrigins, allowHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id", "MCP-Protocol-Version", "Last-Event-ID", "X-Stoop-Device", "UCP-Agent", "Idempotency-Key", "Request-Id"], exposeHeaders: ["Mcp-Session-Id", "Request-Id"] }));
  app.onError((err, c) => {
    if (err instanceof SettlementError) return c.json({ error: err.code, message: err.humanMessage }, err.status as 400);
    bus.emit({ type: "server_error", at: clock.now(), error: String(err) });
    return c.json({ error: "internal", message: String(err) }, 500);
  });

  const ucpApp = ucpRouter({
    settlement,
    store,
    publicBaseUrl: cfg.publicBaseUrl,
    authBuyer: async (t) => buyers.get(t)?.buyerId,
  });
  app.route("/ucp", ucpApp);
  app.get("/.well-known/ucp", (c) => ucpApp.request("/.well-known/ucp"));

  const ctx: StoopContext = {
    settlement,
    appraiser,
    negotiator,
    photos,
    prefs,
    cards,
    ucp: {
      async request(method, path, token, body, idem) {
        const res = await ucpApp.request(path, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "UCP-Agent": 'profile="https://stoop.local/.well-known/agent"',
            "Content-Type": "application/json",
            ...(idem ? { "Idempotency-Key": idem } : {}),
            "Request-Id": `mcp-${Date.now()}`,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        bus.emit({ type: "ucp_call", at: clock.now(), method, path, status: res.status });
        return { status: res.status, json: await res.json().catch(() => ({})) };
      },
    },
    bus,
    publicBaseUrl: cfg.publicBaseUrl,
    passBaseUrl: cfg.passBaseUrl,
    now: () => clock.now(),
  };

  const mcp = mcpRouter(ctx, {
    authSeller: async (t) => sellers.get(t),
    authBuyer: async (t) => buyers.get(t),
    allowedOrigins: cfg.allowedOrigins,
    onRpc: ({ role, body }) => {
      const m = body as { method?: string; params?: { name?: string } } | undefined;
      if (m?.method) bus.emit({ type: "mcp_rpc", at: clock.now(), role, method: m.method, tool: m.params?.name });
    },
  });
  app.route("/", mcp.app);

  // Ring webhook (real Ring key + our simulator key, labelled by origin)
  app.route(
    "/",
    ringWebhookRouter({
      hmacKey: ringHmacKey,
      simulatorKey,
      markSeen: (id) => store.put(`ringreq#${id}`, { id, version: 1 }, { ifAbsent: true }),
      onEvent: async (evt) => {
        bus.emit({ type: "ring_webhook", at: clock.now(), kind: evt.kind, subType: evt.subType, origin: evt.origin, deviceId: evt.deviceId });
        await settlement.ingestRingEvent(evt);
      },
      onLifecycle: async (type, deviceId) => {
        bus.emit({ type: "ring_lifecycle", at: clock.now(), lifecycle: type, deviceId });
      },
      now: () => clock.now(),
      log: (msg, data) => bus.emit({ type: msg, at: clock.now(), ...(data ?? {}) }),
    }),
  );

  // Photos (EXIF stripped) and sweep upload
  app.get("/photos/:file", (c) => {
    const p = photos.get(c.req.param("file").split(".")[0]!);
    if (!p?.bytes) return c.notFound();
    return new Response(Buffer.from(p.bytes), { headers: { "Content-Type": p.mime, "Cache-Control": "public, max-age=3600" } });
  });
  app.post("/sweep", async (c) => {
    const actor = sellers.get(bearer(c.req.header("Authorization")) ?? "");
    if (!actor) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json()) as { photos: Array<{ name: string; dataUrl: string; hint?: string }>; append?: boolean };
    const decoded = (body.photos ?? []).slice(0, 8).map((p) => {
      const m = p.dataUrl.match(/^data:([^;]+);base64,(.*)$/);
      if (!m) throw new SettlementError("bad_photo", "Photos must be data URLs");
      return { name: p.name, mime: m[1]!, bytes: new Uint8Array(Buffer.from(m[2]!, "base64")), hint: p.hint };
    });
    const stored = photos.add(actor.householdId, decoded, !body.append);
    bus.emit({ type: "sweep_uploaded", at: clock.now(), count: stored.length });
    return c.json({ photos: stored.map((p) => ({ id: p.id, name: p.name, url: p.url })) });
  });
  app.post("/sweep/demo", async (c) => {
    const actor = sellers.get(bearer(c.req.header("Authorization")) ?? "");
    if (!actor) return c.json({ error: "unauthorized" }, 401);
    const stored = photos.add(actor.householdId, loadDemoPhotos(cfg.rootDir));
    return c.json({ photos: stored.map((p) => ({ id: p.id, name: p.name, url: p.url })) });
  });

  // Planner (the Alexa sim's "brain"; Bedrock in AWS)
  app.post("/planner/turn", async (c) => {
    const body = (await c.req.json()) as { utterance: string; state: Parameters<typeof planTurn>[1]; tools: Parameters<typeof planTurn>[2] };
    const plan = await planTurn(body.utterance ?? "", body.state, body.tools ?? [], skill);
    bus.emit({ type: "planner_turn", at: clock.now(), role: body.state?.role, planner: plan.planner, calls: plan.calls.map((x) => x.name) });
    return c.json(plan);
  });

  // Pickup pass API (device-bound)
  const device = (h: string | undefined) => (h && /^[A-Za-z0-9_-]{8,64}$/.test(h) ? h : "");
  app.post("/pass/:id/bind", async (c) => {
    const { otp } = (await c.req.json()) as { otp: string };
    return c.json(await settlement.bindPass(c.req.param("id"), String(otp ?? ""), device(c.req.header("X-Stoop-Device"))));
  });
  app.post("/pass/:id/consent", async (c) => {
    await settlement.consentPass(c.req.param("id"), device(c.req.header("X-Stoop-Device")));
    return c.json({ ok: true });
  });
  app.get("/pass/:id", async (c) => c.json(await settlement.passView(c.req.param("id"), device(c.req.header("X-Stoop-Device")))));
  app.post("/pass/:id/checkin", async (c) => {
    const d = await settlement.checkIn(c.req.param("id"), device(c.req.header("X-Stoop-Device")));
    await scheduler.runDue(clock.now());
    return c.json({ state: d.state });
  });
  app.post("/pass/:id/outcome", async (c) => {
    const { outcome, note } = (await c.req.json()) as { outcome: "got_it" | "not_as_described" | "not_received"; note?: string };
    const d = await settlement.buyerOutcome(c.req.param("id"), device(c.req.header("X-Stoop-Device")), outcome, note);
    return c.json({ state: d.state });
  });

  // Receipts: public verification
  app.get("/.well-known/jwks.json", async (c) => c.json(await settlement.jwks()));
  app.get("/receipts/:id", async (c) => {
    const r = await settlement.getReceipt(c.req.param("id").replace(/\.jws$/, ""));
    return c.text(r.jws, 200, { "Content-Type": "application/jose" });
  });
  app.get("/verify/:id", async (c) => {
    const r = await settlement.getReceipt(c.req.param("id"));
    const out = await verifyReceipt(r.jws, await settlement.jwks());
    return c.html(verifyPageHtml(r, out, cfg.publicBaseUrl));
  });
  app.get("/policies/refunds", (c) => c.html(refundPolicyHtml()));

  // Frames for the Ops console (hash-addressed; porch zone only, never sent to buyers)
  app.get("/ops/frame/:dealId/:kind", (c) => {
    const f = lastFrames.get(`${c.req.param("dealId")}:${c.req.param("kind")}`);
    if (!f) return c.notFound();
    return new Response(Buffer.from(f.bytes), { headers: { "Content-Type": f.mime, "X-Frame-Sha256": f.sha256, "X-Frame-Origin": f.origin } });
  });

  // Ops: event stream + snapshot
  app.get("/ops/events", (c) =>
    streamSSE(c, async (stream) => {
      for (const e of bus.recent(100)) await stream.writeSSE({ event: "stoop", data: JSON.stringify(e) });
      const off = bus.on((e) => void stream.writeSSE({ event: "stoop", data: JSON.stringify(e) }));
      stream.onAbort(() => off());
      while (!stream.aborted) await stream.sleep(15_000).then(() => stream.writeSSE({ event: "ping", data: "{}" }));
    }),
  );
  app.get("/ops/state", async (c) => {
    const listings = await store.list<Record<string, unknown>>("listing#");
    const deals = await store.list<Record<string, unknown>>("deal#");
    const evidence = await store.list<Record<string, unknown>>("evidence#");
    return c.json({
      now: clock.now(),
      llmMode: llmMode(),
      vision: vision.name,
      appraiser: appraiser.identifierName,
      psp: psp.label,
      frameSource: frames.name,
      ringConfigured: !!ringToken,
      listings,
      deals,
      evidence,
      decisions: await settlement.decisions(80),
      jobs: scheduler.pending(),
      receipts: await store.list("receipt#"),
      outbox: [...otps.entries()].map(([passId, otp]) => ({ passId, otp, note: "Demo email outbox (SES in AWS)" })),
    });
  });

  // Notifications for the sims
  const hub = new NotificationHub(settlement, bus, prefs);
  app.get("/notify/stream", (c) => {
    const t = c.req.query("token") ?? "";
    const who = sellers.has(t) ? `seller:${sellers.get(t)!.householdId}` : buyers.has(t) ? `buyer:${buyers.get(t)!.buyerId}` : undefined;
    if (!who) return c.json({ error: "unauthorized" }, 401);
    return streamSSE(c, async (stream) => {
      const off = hub.on((n) => {
        if (n.to === who) void stream.writeSSE({ event: "notification", data: JSON.stringify(n) });
      });
      stream.onAbort(() => {
        off();
      });
      while (!stream.aborted) await stream.sleep(15_000).then(() => stream.writeSSE({ event: "ping", data: "{}" }));
    });
  });

  // Ring live view + devices (proxied; Playground token pasted at runtime)
  app.post("/ring/token", async (c) => {
    const { token } = (await c.req.json()) as { token: string };
    ringToken = String(token ?? "");
    bus.emit({ type: "ring_token_set", at: clock.now() });
    return c.json({ ok: true });
  });
  app.get("/ring/devices", async (c) => {
    if (!ringToken) return c.json({ error: "no_ring_token", message: "Paste a Ring Developer Playground token in Ops" }, 409);
    try {
      return c.json({ devices: await ringClient.listDevices() });
    } catch (e) {
      bus.emit({ type: "ring_api_error", at: clock.now(), error: String(e) });
      return c.json({ error: "ring_api_error", message: String(e) }, 502);
    }
  });
  app.post("/ring/whep/:deviceId", async (c) => {
    if (!ringToken) return c.json({ error: "no_ring_token" }, 409);
    const { answer } = await ringClient.whep(c.req.param("deviceId"), await c.req.text());
    return c.text(answer, 201, { "Content-Type": "application/sdp" });
  });

  // ---------- simulator (local only, every event labelled "simulator")
  const sim = new Hono();
  let reqN = 0;
  const postRing = async (type: "motion_detected" | "button_press", subType?: string, opts: { badSignature?: boolean; staleMs?: number; requestId?: string } = {}) => {
    const at = clock.now() - (opts.staleMs ?? 0);
    const body = JSON.stringify(buildEnvelope({ type, deviceId: DEMO.ringDeviceId, at, subType, requestId: opts.requestId ?? `sim_${Date.now()}_${++reqN}` }));
    const res = await app.request("/ring/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature": opts.badSignature ? "sha256=0000" : signBody(body, simulatorKey) },
      body,
    });
    await new Promise((r) => setTimeout(r, 5)); // let the async ack-then-process run
    return { status: res.status, body: await res.json() };
  };
  sim.post("/scene", async (c) => {
    const { scene } = (await c.req.json()) as { scene: Scene };
    footage.setScene(DEMO.ringDeviceId, scene);
    bus.emit({ type: "sim_scene", at: clock.now(), scene, label: "simulator" });
    return c.json({ ok: true, scene });
  });
  sim.post("/ring-event", async (c) => {
    const { type, subType } = (await c.req.json()) as { type: "motion_detected" | "button_press"; subType?: string };
    return c.json(await postRing(type, subType));
  });
  sim.post("/run-jobs", async (c) => {
    const { dealId, kind } = (await c.req.json()) as { dealId: string; kind: ScheduledJob["kind"] };
    bus.emit({ type: "sim_time_skip", at: clock.now(), dealId, kind });
    await settlement.onJob({ id: "sim", at: clock.now(), dealId, kind });
    return c.json({ state: (await settlement.getDeal(dealId)).state });
  });
  sim.post("/scenario/:name", async (c) => {
    const { dealId } = (await c.req.json().catch(() => ({}))) as { dealId?: string };
    const log: string[] = [];
    const name = c.req.param("name");
    const deals = (await store.list<{ id: string; state: string; updatedAt: number }>("deal#")).sort((a, b) => b.updatedAt - a.updatedAt);
    const deal = dealId ? await settlement.getDeal(dealId) : deals.find((d) => ["WINDOW_OPEN", "PASS_ISSUED", "STILL_THERE"].includes(d.state));
    if (name === "replay_attack") {
      const rid = `replay_${Date.now()}`;
      log.push(`signed event -> ${(await postRing("motion_detected", "human", { requestId: rid })).status}`);
      log.push(`same event replayed -> ${JSON.stringify((await postRing("motion_detected", "human", { requestId: rid })).body)}`);
      log.push(`bad signature -> ${(await postRing("motion_detected", "human", { badSignature: true })).status}`);
      log.push(`10 minutes stale -> ${(await postRing("motion_detected", "human", { staleMs: 10 * 60_000 })).status}`);
      return c.json({ scenario: name, log });
    }
    if (!deal) return c.json({ error: "no_active_deal", message: "Get a deal to the pickup window first" }, 409);
    await scheduler.runDue(clock.now());
    const fresh = await settlement.getDeal(deal.id);
    const passId = fresh.passId!;
    const dev = "sim-device-0001";
    const ensurePass = async () => {
      try {
        await settlement.bindPass(passId, otps.get(passId) ?? "", dev);
      } catch (e) {
        log.push(`bind: ${String(e)}`);
      }
      await settlement.consentPass(passId, dev).catch(() => undefined);
    };
    const capture = (kind: "before" | "after") => verifier.capture({ dealId: deal.id, kind });
    switch (name) {
      case "golden":
        await ensurePass();
        footage.setScene(DEMO.ringDeviceId, "item_present");
        await capture("before");
        log.push("before frame: item present");
        await settlement.checkIn(passId, dev);
        log.push("buyer tapped I'm here");
        log.push(`doorbell press -> ${(await postRing("button_press")).status}`);
        footage.setScene(DEMO.ringDeviceId, "item_absent");
        await capture("after");
        log.push(`after frame: item gone -> ${(await settlement.getDeal(deal.id)).state}`);
        break;
      case "piracy":
        footage.setScene(DEMO.ringDeviceId, "item_present");
        await capture("before");
        log.push(`stranger at the door -> ${(await postRing("motion_detected", "human")).status}`);
        footage.setScene(DEMO.ringDeviceId, "item_absent");
        await capture("after");
        log.push(`item gone without a pass -> ${(await settlement.getDeal(deal.id)).state}`);
        break;
      case "still_there":
        await ensurePass();
        footage.setScene(DEMO.ringDeviceId, "item_present");
        await capture("before");
        await settlement.checkIn(passId, dev);
        await postRing("motion_detected", "human");
        await capture("after");
        log.push(`buyer came, item still there -> ${(await settlement.getDeal(deal.id)).state}`);
        break;
      case "no_show":
        await settlement.onJob({ id: "sim", at: clock.now(), dealId: deal.id, kind: "close_window" });
        log.push(`window closed without check-in (time skip) -> ${(await settlement.getDeal(deal.id)).state}`);
        break;
      case "camera_offline":
        await ensurePass();
        footage.setScene(DEMO.ringDeviceId, "offline");
        await settlement.checkIn(passId, dev);
        await capture("after");
        log.push(`camera offline -> ${(await settlement.getDeal(deal.id)).state}`);
        break;
      default:
        return c.json({ error: "unknown_scenario" }, 404);
    }
    bus.emit({ type: "sim_scenario", at: clock.now(), scenario: name, dealId: deal.id, label: "simulator" });
    return c.json({ scenario: name, dealId: deal.id, log, state: (await settlement.getDeal(deal.id)).state });
  });
  app.route("/sim", sim);

  app.get("/api/config", (c) =>
    c.json({
      demo: true,
      sellerToken: DEMO.sellerToken,
      buyerTokens: DEMO.buyers.map((b) => ({ name: b.displayName, token: b.token })),
      ringDeviceId: DEMO.ringDeviceId,
      llmMode: llmMode(),
      passBaseUrl: cfg.passBaseUrl,
      publicBaseUrl: cfg.publicBaseUrl,
    }),
  );
  app.get("/health", (c) => c.json({ ok: true, now: clock.now() }));

  // ---------- seed
  if (cfg.seedDemo !== false) {
    const h = DEMO.household;
    await settlement.createHousehold({ id: h.id, displayName: h.displayName, address: h.address, zip: h.zip, porchInstructions: h.porch, ringDeviceId: DEMO.ringDeviceId });
    sellers.set(DEMO.sellerToken, { kind: "seller", householdId: h.id, displayName: h.displayName });
    for (const b of DEMO.buyers) {
      await settlement.createBuyer({ id: b.id, displayName: b.displayName, email: b.email, voiceCode: b.voiceCode, walletToken: b.wallet });
      buyers.set(b.token, { kind: "buyer", buyerId: b.id, displayName: b.displayName, token: b.token, walletToken: b.wallet });
    }
  }

  let timer: NodeJS.Timeout | undefined;
  if (cfg.autoTick) timer = setInterval(() => void scheduler.runDue(clock.now()), 1000);

  return {
    app,
    settlement,
    bus,
    store,
    scheduler,
    clock,
    footage,
    verifier,
    psp,
    otps,
    sellers,
    buyers,
    simulatorKey,
    ringHmacKey,
    tick: () => scheduler.runDue(clock.now()),
    stop: () => timer && clearInterval(timer),
  };
}

export type Stack = Awaited<ReturnType<typeof createStack>>;

// ---------- helpers

const bearer = (h?: string) => (h?.startsWith("Bearer ") ? h.slice(7) : undefined);

function loadOrCreateKey(path: string): string {
  if (existsSync(path)) return readFileSync(path, "utf8");
  const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, pem, { mode: 0o600 });
  return pem;
}

function readSkill(root: string) {
  const p = join(root, "skills", "stoop", "SKILL.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "You help people sell and buy secondhand items with Stoop.";
}

function loadFootageIndex(dir: string) {
  const empty = { item_present: [], item_absent: [], unclear: [] };
  const idx = join(dir, "index.json");
  if (!existsSync(idx)) return empty;
  try {
    return { ...empty, ...JSON.parse(readFileSync(idx, "utf8")) };
  } catch {
    return empty;
  }
}

function loadDemoPhotos(root: string) {
  const dir = join(root, "fixtures", "photos");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|svg)$/i.test(f))
    .sort()
    .map((f) => ({
      name: f,
      bytes: new Uint8Array(readFileSync(join(dir, f))),
      mime: f.endsWith(".svg") ? "image/svg+xml" : f.endsWith(".png") ? "image/png" : "image/jpeg",
    }));
}
