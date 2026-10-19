// Hosted mode. Two kinds of private, isolated Stoop worlds live under /s/<id>/:
//   shops  a real seller's shop: their own pickup address, photos, buyers who arrive by link, and a
//          phone or laptop as the porch camera. No demo data, no simulator.
//   demos  the guided Alexa+ device tour (seeded demo household, labelled simulator), for judges.
//
//   /                          the Stoop web app (landing, shop setup, shop, listing, pickup pass, camera)
//   /sell, /shop/<id>/…        web app pages (client-side routes)
//   POST /api/shops            open a shop -> { id, sellerToken, url }
//   /demo                      the Alexa+ device tour landing; POST /api/sandboxes creates a demo world
//   /s/<id>/*                  that world's API (MCP, UCP, pass, web), proxied to its stack
//   /app/<name>/*              built app assets (shared by all worlds)
//   POST /api/feedback         tester feedback -> <dataDir>/feedback.jsonl
//   GET /api/admin/shops, DELETE /api/admin/shops/:id   (?key=ADMIN_KEY) list shops, close a test shop
//   POST /alexa                the Stoop Alexa skill's endpoint (Alexa Skills Kit; signed requests only)
//   POST /api/alexa/pair       a 6-digit code that links a shop to someone's Alexa
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { Hono, type Context } from "hono";
import { modelCallsToday } from "@stoop/shared";
import type { RequestEnvelope } from "ask-sdk-model";
import { SkillRequestSignatureVerifier, TimestampVerifier } from "ask-sdk-express-adapter";
import { AlexaLinks, createStoopSkill } from "./alexa.ts";
import { marketListings, searchMarket, Street, streetRouter, type StreetWorld } from "./street.ts";
import { z } from "zod";
import { createStack, type Stack, type StackConfig, type WorldSecrets, type WorldState } from "./compose.ts";
import { landingHtml, tourHtml, expiredHtml } from "./site.ts";

export interface SandboxServerOptions {
  rootDir: string;
  /** Public origin (https://…). Default: from X-Forwarded-* or the request URL. */
  origin?: string;
  /** Scheme browsers use when no X-Forwarded-Proto arrives (behind CloudFront: "https"). */
  publicProto?: string;
  maxWorlds?: number;
  idleMs?: number;
  createsPerIpPerHour?: number;
  /** Real shops: how many at once, how long an untouched shop stays open, and how many one address may open per hour. */
  maxShops?: number;
  shopIdleMs?: number;
  shopsPerIpPerHour?: number;
  /** Link the Alexa+ device tour from the web app (the judges' site). */
  deviceDemo?: boolean;
  /** The Stoop Alexa skill's id: enables /alexa and the dashboard's Connect Alexa tile. */
  alexaSkillId?: string;
  /** Check Amazon's request signature and timestamp on /alexa (default on; tests turn it off). */
  alexaVerify?: boolean;
  /** How often buyer agents look at the street (default 20 s). */
  agentTickMs?: number;
  /** More origins every world accepts (local recordings that put each device on its own port). */
  extraOrigins?: string[];
  /** Stack overrides for every world (tests and local end-to-end runs, e.g. a stand-in vision model). */
  stackOverrides?: Partial<StackConfig>;
  /** Where feedback.jsonl is written (and, with persist, the shops). */
  dataDir: string;
  /** Save every shop to <dataDir>/worlds/ and bring them back on start, so a redeploy closes nothing. */
  persist?: boolean;
  /** Enables GET /api/feedback.jsonl?key=… */
  adminKey?: string;
  now?: () => number;
}

interface World {
  id: string;
  kind: "shop" | "demo";
  stack: Stack;
  createdAt: number;
  lastSeen: number;
  /** The origin it was opened from: its links (photos, pass) are built on it. */
  origin: string;
}

interface SavedWorld {
  meta: { id: string; origin: string; createdAt: number; lastSeen: number };
  secrets: WorldSecrets;
  state: WorldState;
}

/** Built app per URL segment of a demo world, and its dist folder. */
const APPS = { device: "alexa-sim", m: "pass", ops: "ops" } as const;
const ASSET_APPS = ["alexa-sim", "pass", "ops", "web"];

/** Inside a real shop these demo and operator routes don't exist. */
const SHOP_BLOCKED = /^\/(ops|sim|ring|sweep\/demo|api\/config|sandbox|web\/shop)(\/|$)/;

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".map": "application/json",
  ".mp4": "video/mp4",
  ".vtt": "text/vtt; charset=utf-8",
};

const Feedback = z.object({
  world: z.string().max(40).optional(),
  role: z.enum(["seller", "buyer", "visitor"]).optional(),
  rating: z.number().int().min(1).max(5),
  wouldUse: z.enum(["yes", "maybe", "no"]),
  sells: z.enum(["often", "sometimes", "never"]).optional(),
  comment: z.string().max(2000).optional(),
  email: z.string().email().max(200).optional(),
  consent: z.boolean().optional(),
  step: z.number().int().min(0).max(10).optional(),
});

function loadOrCreateKey(path: string): string {
  if (existsSync(path)) return readFileSync(path, "utf8");
  const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, pem, { mode: 0o600 });
  return pem;
}

export async function createSandboxServer(o: SandboxServerOptions) {
  const now = o.now ?? (() => Date.now());
  const maxWorlds = o.maxWorlds ?? 60;
  const idleMs = o.idleMs ?? 30 * 60 * 1000;
  const perIp = o.createsPerIpPerHour ?? 6;
  const maxShops = o.maxShops ?? 150;
  const shopIdleMs = o.shopIdleMs ?? 72 * 60 * 60 * 1000;
  const shopsPerIp = o.shopsPerIpPerHour ?? 5;
  const worlds = new Map<string, World>();
  const creates = new Map<string, number[]>();
  mkdirSync(o.dataDir, { recursive: true });
  const feedbackFile = join(o.dataDir, "feedback.jsonl");

  const originOf = (c: Context) => {
    if (o.origin) return o.origin.replace(/\/$/, "");
    const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() ?? o.publicProto;
    const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim() ?? c.req.header("host");
    return proto && host ? `${proto}://${host}` : new URL(c.req.url).origin;
  };
  const ipOf = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local";
  // creations per address in the last hour (only successful ones count)
  const recentOf = (key: string) => (creates.get(key) ?? []).filter((x) => now() - x < 60 * 60 * 1000);
  const under = (key: string, limit: number) => recentOf(key).length < limit;
  const record = (key: string) => creates.set(key, [...recentOf(key), now()]);

  // Built apps: index.html per app, injected with the world's base path (demo apps) or site config (web app)
  const appHtml = new Map<string, string>();
  for (const name of [...Object.values(APPS), "web"]) {
    const p = join(o.rootDir, "apps", name, "dist", "index.html");
    if (existsSync(p)) appHtml.set(name, readFileSync(p, "utf8"));
  }
  const inject = (name: string, cfg: Record<string, unknown>) => {
    const html = appHtml.get(name);
    if (!html) return undefined;
    return html.replace("<head>", `<head><script>window.__STOOP__=${JSON.stringify(cfg)}</script>`);
  };
  const hasVideo = existsSync(join(o.rootDir, "apps", "web", "dist", "demo.mp4"));
  const webApp = async (c: Context) => {
    let html = inject("web", { deviceDemo: !!o.deviceDemo, video: hasVideo, alexaSkill: !!o.alexaSkillId });
    if (!html) return c.text("Web app not built. Run pnpm build:web.", 503);
    // a shared listing link previews as the item (photo, title, price) in chats and social apps
    const m = /^\/shop\/([A-Za-z0-9_-]+)\/item\/([A-Za-z0-9_-]+)\/?$/.exec(c.req.path);
    const w = m ? worlds.get(m[1]!) : undefined;
    if (m && w?.kind === "shop") {
      const l = await w.stack.settlement.getListing(m[2]!).catch(() => undefined);
      if (l && ["LIVE", "RESERVED"].includes(l.state)) {
        const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
        const price = `$${(l.askMinor / 100).toFixed(l.askMinor % 100 ? 2 : 0)}`;
        const title = esc(`${l.title} · ${price}`);
        const desc = esc(`Porch pickup in ${l.zip}. Pay on Stoop; you’re only charged once the pickup is verified.`);
        const tags = [
          `<meta property="og:type" content="product">`,
          `<meta property="og:site_name" content="Stoop">`,
          `<meta property="og:title" content="${title}">`,
          `<meta property="og:description" content="${desc}">`,
          `<meta property="og:url" content="${esc(originOf(c) + c.req.path)}">`,
          ...(l.photoUrls[0] ? [`<meta property="og:image" content="${esc(l.photoUrls[0])}">`, `<meta name="twitter:card" content="summary_large_image">`] : []),
          `<meta property="product:price:amount" content="${(l.askMinor / 100).toFixed(2)}">`,
          `<meta property="product:price:currency" content="USD">`,
        ].join("");
        html = html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`).replace("</head>", `${tags}</head>`);
      }
    }
    return c.html(html);
  };

  // ---------- shops survive restarts: a snapshot per shop under <dataDir>/worlds/<id>/
  const worldsDir = join(o.dataDir, "worlds");
  const signingKeyPem = o.persist ? loadOrCreateKey(join(o.dataDir, "receipt-signing-key.pem")) : undefined;
  const lastSaved = new Map<string, string>();
  const savedPhotos = new Map<string, Set<string>>();
  const shopStack = (id: string, origin: string, extra: Partial<StackConfig> = {}) =>
    createStack({
      publicBaseUrl: `${origin}/s/${id}`,
      passBaseUrl: `${origin}/shop/${id}`,
      allowedOrigins: [origin, ...(o.extraOrigins ?? [])],
      rootDir: o.rootDir,
      seedDemo: false,
      frameSource: "porchcam",
      autoTick: true,
      immediateWindow: true,
      frameDelayScale: 1,
      signingKeyPem,
      ...o.stackOverrides,
      ...extra,
    });
  const saveWorld = (w: World) => {
    if (!o.persist || w.kind !== "shop") return;
    const dir = join(worldsDir, w.id);
    mkdirSync(join(dir, "photos"), { recursive: true });
    const known = savedPhotos.get(w.id) ?? new Set(readdirSync(join(dir, "photos")));
    for (const p of w.stack.photos.all()) {
      if (!p.bytes || known.has(p.id)) continue;
      writeFileSync(join(dir, "photos", p.id), Buffer.from(p.bytes));
      known.add(p.id);
    }
    savedPhotos.set(w.id, known);
    const saved: SavedWorld = { meta: { id: w.id, origin: w.origin, createdAt: w.createdAt, lastSeen: w.lastSeen }, secrets: w.stack.secrets, state: w.stack.snapshot() };
    const json = JSON.stringify(saved);
    if (lastSaved.get(w.id) === json) return;
    writeFileSync(join(dir, "state.json.tmp"), json, { mode: 0o600 });
    renameSync(join(dir, "state.json.tmp"), join(dir, "state.json"));
    lastSaved.set(w.id, json);
  };
  const saveAll = () => {
    for (const w of worlds.values()) {
      try {
        saveWorld(w);
      } catch (e) {
        console.error(`could not save shop ${w.id}: ${String(e)}`);
      }
    }
  };
  const forget = (id: string) => {
    rmSync(join(worldsDir, id), { recursive: true, force: true });
    lastSaved.delete(id);
    savedPhotos.delete(id);
  };
  if (o.persist && existsSync(worldsDir)) {
    for (const id of readdirSync(worldsDir)) {
      try {
        const s = JSON.parse(readFileSync(join(worldsDir, id, "state.json"), "utf8")) as SavedWorld;
        if (now() - s.meta.lastSeen > shopIdleMs) {
          forget(id);
          continue;
        }
        const photos = s.state.photos.map((p) => {
          const f = join(worldsDir, id, "photos", p.id);
          return existsSync(f) ? { ...p, bytes: new Uint8Array(readFileSync(f)) } : p;
        });
        const stack = await shopStack(id, s.meta.origin, { secrets: s.secrets, restore: { ...s.state, photos } });
        worlds.set(id, { id, kind: "shop", stack, createdAt: s.meta.createdAt, lastSeen: s.meta.lastSeen, origin: s.meta.origin });
        await stack.resume();
      } catch (e) {
        console.error(`could not restore shop ${id}: ${String(e)}`);
      }
    }
  }
  // ---------- Stoop Street: the marketplace across shops, buyer profiles and buyer agents
  const links = new AlexaLinks(join(o.dataDir, "alexa-links.json"), now);
  const street = new Street({
    worlds: worlds as unknown as Map<string, StreetWorld>,
    now,
    file: o.persist ? join(o.dataDir, "street.json") : undefined,
    pairAlexa: o.alexaSkillId ? (id, name) => links.newBuyerCode(id, name) : undefined,
  });
  const agents = setInterval(() => void street.tick().catch(() => undefined), o.agentTickMs ?? 20_000);
  agents.unref?.();

  const saver = setInterval(() => {
    saveAll();
    if (o.persist) street.save();
  }, 15_000);
  saver.unref?.();

  const stopWorld = (w: World, closing = false) => {
    w.stack.stop();
    worlds.delete(w.id);
    if (closing && w.kind === "shop") forget(w.id);
  };
  const sweep = () => {
    const t = now();
    for (const w of worlds.values()) if (t - w.lastSeen > (w.kind === "shop" ? shopIdleMs : idleMs)) stopWorld(w, true);
  };
  const sweeper = setInterval(sweep, 60_000);
  sweeper.unref?.();
  const count = (kind: World["kind"]) => [...worlds.values()].filter((w) => w.kind === kind).length;

  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true, worlds: worlds.size, shops: count("shop"), demos: count("demo"), maxWorlds, maxShops, modelCalls: modelCallsToday() }));

  // ---------- the web app (client-side routes)
  app.get("/", webApp);
  app.get("/sell", webApp);
  app.get("/street", webApp);
  app.get("/me", webApp);
  app.get("/shop/:id", webApp);
  app.get("/shop/:id/*", webApp);

  // ---------- real shops
  app.post("/api/shops", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const key = `shop:${ipOf(c)}`;
    if (!under(key, shopsPerIp)) return c.json({ error: "rate_limited", message: "You've opened several shops in the last hour. Try again later." }, 429);
    sweep();
    if (count("shop") >= maxShops) return c.json({ error: "full", message: "Stoop is at capacity for this test. Try again tomorrow." }, 503);
    const id = randomBytes(6).toString("base64url");
    const origin = originOf(c);
    const stack = await shopStack(id, origin);
    const res = await stack.app.fetch(new Request(`${origin}/web/shop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }));
    const out = (await res.json()) as { sellerToken?: string; fields?: string[] };
    if (!res.ok || !out.sellerToken) {
      stack.stop();
      return c.json({ error: "invalid", fields: out.fields ?? [] }, 400);
    }
    const t = now();
    const w: World = { id, kind: "shop", stack, createdAt: t, lastSeen: t, origin };
    worlds.set(id, w);
    record(key);
    try {
      saveWorld(w);
    } catch {
      /* the next save round retries */
    }
    return c.json({ id, sellerToken: out.sellerToken, url: `/shop/${id}` });
  });

  // ---------- the Alexa+ device tour (demo worlds)
  app.get("/demo", (c) => c.html(landingHtml()));
  app.post("/api/sandboxes", async (c) => {
    const key = `demo:${ipOf(c)}`;
    if (!under(key, perIp)) return c.json({ error: "rate_limited", message: "That's a lot of sandboxes. Try again in a few minutes." }, 429);
    sweep();
    if (count("demo") >= maxWorlds) {
      // make room by retiring the longest-idle demo, but never one in use in the last 5 minutes
      const oldest = [...worlds.values()].filter((w) => w.kind === "demo").sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (!oldest || now() - oldest.lastSeen < 5 * 60 * 1000) return c.json({ error: "full", message: "All sandboxes are busy. Try again in a few minutes." }, 503);
      stopWorld(oldest);
    }
    const id = randomBytes(6).toString("base64url");
    const origin = originOf(c);
    const base = `${origin}/s/${id}`;
    const stack = await createStack({
      publicBaseUrl: base,
      passBaseUrl: `${base}/m`,
      allowedOrigins: [origin, ...(o.extraOrigins ?? [])],
      rootDir: o.rootDir,
      seedDemo: true,
      autoTick: true,
      immediateWindow: true,
      frameDelayScale: 0.15,
      ...o.stackOverrides,
    });
    const t = now();
    worlds.set(id, { id, kind: "demo", stack, createdAt: t, lastSeen: t, origin });
    record(key);
    return c.json({ id, tour: `/s/${id}/` });
  });

  app.route(
    "/api",
    streetRouter(street, {
      worlds: worlds as unknown as Map<string, StreetWorld>,
      allow: (k, l) => {
        if (!under(k, l)) return false;
        record(k);
        return true;
      },
      ipOf,
    }),
  );

  // ---------- the Stoop skill on a real Alexa
  const skill = createStoopSkill({
    skillId: o.alexaSkillId,
    links,
    street: {
      search: async (q, maxMinor) => searchMarket(await marketListings(worlds.values() as Iterable<StreetWorld>), { query: q, maxMinor }),
      buyerToken: async (profileId, shop) => {
        const p = street.profile(profileId);
        return p ? street.buyerIn(p, shop) : undefined;
      },
    },
    shop: (id) => {
      const w = worlds.get(id);
      if (!w || w.kind !== "shop") return undefined;
      w.lastSeen = now();
      return {
        fetch: async (r) => w.stack.app.fetch(r),
        shopName: async (token) => {
          const s = w.stack.sellers.get(token);
          return s ? `${(await w.stack.settlement.householdPublic(s.householdId)).displayName}’s shop` : undefined;
        },
      };
    },
  });
  const signature = new SkillRequestSignatureVerifier();
  const timestamp = new TimestampVerifier();
  app.post("/alexa", async (c) => {
    if (!o.alexaSkillId) return c.json({ error: "not_found" }, 404);
    const raw = await c.req.text();
    if (o.alexaVerify !== false) {
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      try {
        await signature.verify(raw, headers);
        await timestamp.verify(raw);
      } catch {
        return c.json({ error: "bad_request_signature" }, 400);
      }
    }
    try {
      return c.json(await skill.invoke(JSON.parse(raw) as RequestEnvelope));
    } catch {
      return c.json({ error: "skill_error" }, 400);
    }
  });
  app.post("/api/alexa/pair", async (c) => {
    if (!o.alexaSkillId) return c.json({ error: "not_found" }, 404);
    const { shop, token } = (await c.req.json().catch(() => ({}))) as { shop?: string; token?: string };
    const handle = shop ? worlds.get(shop) : undefined;
    const name = handle && handle.kind === "shop" && token ? await (async () => {
      const s = handle.stack.sellers.get(token);
      return s ? `${(await handle.stack.settlement.householdPublic(s.householdId)).displayName}’s shop` : undefined;
    })() : undefined;
    if (!name) return c.json({ error: "unauthorized" }, 401);
    return c.json({ code: links.newCode(shop!, token!, name), invocation: "stoop shop", expiresInMinutes: 10 });
  });

  app.post("/api/feedback", async (c) => {
    const parsed = Feedback.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues.map((i) => i.path.join(".")) }, 400);
    const f = parsed.data;
    // an email is kept only with consent to be contacted about this feedback
    const rec = { at: new Date(now()).toISOString(), ...f, email: f.consent ? f.email : undefined };
    appendFileSync(feedbackFile, JSON.stringify(rec) + "\n");
    return c.json({ ok: true });
  });
  app.get("/api/feedback.jsonl", (c) => {
    if (!o.adminKey || c.req.query("key") !== o.adminKey) return c.json({ error: "forbidden" }, 403);
    return c.body(existsSync(feedbackFile) ? readFileSync(feedbackFile, "utf8") : "", 200, { "Content-Type": "application/x-ndjson" });
  });

  // ---------- admin (ADMIN_KEY): see the shops, close a test shop for good (it leaves Stoop Street)
  const isAdmin = (c: Context) => !!o.adminKey && c.req.query("key") === o.adminKey;
  app.get("/api/admin/shops", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "forbidden" }, 403);
    const shops = [];
    for (const w of worlds.values()) {
      if (w.kind !== "shop") continue;
      const households = [...new Set([...w.stack.sellers.values()].map((s) => s.householdId))];
      const names = await Promise.all(households.map(async (h) => (await w.stack.settlement.householdPublic(h)).displayName));
      const live = (await Promise.all(households.map((h) => w.stack.settlement.listingsForHousehold(h)))).flat().filter((l) => l.state === "LIVE");
      shops.push({ id: w.id, names, live: live.map((l) => l.title), createdAt: new Date(w.createdAt).toISOString(), lastSeen: new Date(w.lastSeen).toISOString() });
    }
    return c.json({ shops });
  });
  app.delete("/api/admin/shops/:id", (c) => {
    if (!isAdmin(c)) return c.json({ error: "forbidden" }, 403);
    const w = worlds.get(c.req.param("id"));
    if (!w || w.kind !== "shop") return c.json({ error: "not_found" }, 404);
    stopWorld(w, true);
    return c.json({ ok: true, closed: w.id });
  });

  // Shared, immutable app assets
  app.get("/app/:name/*", (c) => {
    const name = c.req.param("name");
    if (!ASSET_APPS.includes(name)) return c.notFound();
    const dist = join(o.rootDir, "apps", name, "dist");
    const rel = c.req.path.slice(`/app/${name}/`.length);
    const file = normalize(join(dist, rel));
    if (!file.startsWith(dist + sep) || !existsSync(file)) return c.notFound();
    const body = readFileSync(file);
    const headers: Record<string, string> = {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : extname(file) === ".mp4" ? "public, max-age=3600" : "no-cache",
      "Accept-Ranges": "bytes",
    };
    // byte ranges, so video seeks (and plays at all on iOS Safari)
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
    if (range && (range[1] || range[2])) {
      const size = body.length;
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) return c.body(null, 416, { "Content-Range": `bytes */${size}` });
      return c.body(body.subarray(start, end + 1), 206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}` });
    }
    return c.body(body, 200, headers);
  });

  // Per-world routes
  app.all("/s/:id/*", async (c) => {
    const id = c.req.param("id");
    const w = worlds.get(id);
    const rest = c.req.path.slice(`/s/${id}`.length) || "/";
    if (!w) return c.req.method === "GET" && rest === "/" ? c.html(expiredHtml(), 404) : c.json({ error: "sandbox_expired", message: "This shop has closed." }, 404);
    w.lastSeen = now();

    if (w.kind === "shop") {
      if (SHOP_BLOCKED.test(rest)) return c.json({ error: "not_found" }, 404);
      if (c.req.method === "GET" && rest === "/") return c.redirect(`/shop/${id}`);
    } else if (c.req.method === "GET") {
      if (rest === "/") return c.html(tourHtml(id));
      // App pages only; /ops/state, /ops/events, /pass/<id>/… are the world's API and fall through
      const page = rest === "/device" || rest === "/device/" ? APPS.device : rest === "/ops" || rest === "/ops/" ? APPS.ops : rest.startsWith("/m/") ? APPS.m : undefined;
      if (page) {
        const html = inject(page, { stack: `/s/${id}`, public: true });
        return html ? c.html(html) : c.text("App not built. Run pnpm build:web.", 503);
      }
    }
    const src = new URL(c.req.url);
    const url = new URL(rest + src.search, src.origin);
    const init: RequestInit = { method: c.req.method, headers: c.req.raw.headers };
    if (c.req.method !== "GET" && c.req.method !== "HEAD") init.body = await c.req.raw.arrayBuffer();
    return w.stack.app.fetch(new Request(url, init));
  });
  app.get("/s/:id", (c) => c.redirect(`/s/${c.req.param("id")}/`));

  return {
    app,
    worlds,
    sweep,
    /** Save every shop now (also runs every 15 s and on stop). */
    save: saveAll,
    street,
    stop() {
      clearInterval(sweeper);
      clearInterval(saver);
      clearInterval(agents);
      saveAll();
      if (o.persist) street.save();
      for (const w of [...worlds.values()]) stopWorld(w);
    },
  };
}
