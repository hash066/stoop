// Hosted mode: every visitor gets a private, disposable Stoop world (its own household, buyers,
// deals and event feed) under /s/<id>/, so testers never see each other's sales.
//
//   /                      landing page
//   POST /api/sandboxes    create a world -> { id, tour }
//   /s/<id>/               guided tour (seller + buyer devices, pickup pass, progress, feedback)
//   /s/<id>/device/        the Alexa+ simulator (?role=seller|buyer)
//   /s/<id>/m/p/<pass>     the pickup pass
//   /s/<id>/ops            mission control
//   /s/<id>/*              everything else is proxied to that world's stack (MCP, UCP, pass API, SSE)
//   /app/<name>/*          built app assets (shared by all worlds)
//   POST /api/feedback     tester feedback -> <dataDir>/feedback.jsonl
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { createStack, type Stack } from "./compose.ts";
import { landingHtml, tourHtml, expiredHtml } from "./site.ts";

export interface SandboxServerOptions {
  rootDir: string;
  /** Public origin (https://…). Default: from X-Forwarded-* or the request URL. */
  origin?: string;
  maxWorlds?: number;
  idleMs?: number;
  createsPerIpPerHour?: number;
  /** Where feedback.jsonl is written. */
  dataDir: string;
  /** Enables GET /api/feedback.jsonl?key=… */
  adminKey?: string;
  now?: () => number;
}

interface World {
  id: string;
  stack: Stack;
  createdAt: number;
  lastSeen: number;
}

/** Built app per URL segment, and its dist folder. */
const APPS = { device: "alexa-sim", m: "pass", ops: "ops" } as const;

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
};

const Feedback = z.object({
  world: z.string().max(40).optional(),
  rating: z.number().int().min(1).max(5),
  wouldUse: z.enum(["yes", "maybe", "no"]),
  sells: z.enum(["often", "sometimes", "never"]).optional(),
  comment: z.string().max(2000).optional(),
  email: z.string().email().max(200).optional(),
  consent: z.boolean().optional(),
  step: z.number().int().min(0).max(10).optional(),
});

export async function createSandboxServer(o: SandboxServerOptions) {
  const now = o.now ?? (() => Date.now());
  const maxWorlds = o.maxWorlds ?? 60;
  const idleMs = o.idleMs ?? 30 * 60 * 1000;
  const perIp = o.createsPerIpPerHour ?? 6;
  const worlds = new Map<string, World>();
  const creates = new Map<string, number[]>();
  mkdirSync(o.dataDir, { recursive: true });
  const feedbackFile = join(o.dataDir, "feedback.jsonl");

  const originOf = (c: Context) => {
    if (o.origin) return o.origin.replace(/\/$/, "");
    const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
    const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim() ?? c.req.header("host");
    return proto && host ? `${proto}://${host}` : new URL(c.req.url).origin;
  };
  const ipOf = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local";

  // Built apps: index.html per app, injected per world with that world's base path.
  const appHtml = new Map<string, string>();
  for (const name of Object.values(APPS)) {
    const p = join(o.rootDir, "apps", name, "dist", "index.html");
    if (existsSync(p)) appHtml.set(name, readFileSync(p, "utf8"));
  }
  const inject = (name: string, id: string) => {
    const html = appHtml.get(name);
    if (!html) return undefined;
    const cfg = JSON.stringify({ stack: `/s/${id}`, public: true });
    return html.replace("<head>", `<head><script>window.__STOOP__=${cfg}</script>`);
  };

  const stopWorld = (w: World) => {
    w.stack.stop();
    worlds.delete(w.id);
  };
  const sweep = () => {
    const t = now();
    for (const w of worlds.values()) if (t - w.lastSeen > idleMs) stopWorld(w);
  };
  const sweeper = setInterval(sweep, 60_000);
  sweeper.unref?.();

  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true, worlds: worlds.size, maxWorlds }));
  app.get("/", (c) => c.html(landingHtml()));

  app.post("/api/sandboxes", async (c) => {
    const ip = ipOf(c);
    const t = now();
    const recent = (creates.get(ip) ?? []).filter((x) => t - x < 60 * 60 * 1000);
    if (recent.length >= perIp) return c.json({ error: "rate_limited", message: "That's a lot of sandboxes. Try again in a few minutes." }, 429);
    sweep();
    if (worlds.size >= maxWorlds) {
      // make room by retiring the longest-idle world, but never one in use in the last 5 minutes
      const oldest = [...worlds.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (!oldest || t - oldest.lastSeen < 5 * 60 * 1000) return c.json({ error: "full", message: "All sandboxes are busy. Try again in a few minutes." }, 503);
      stopWorld(oldest);
    }
    const id = randomBytes(6).toString("base64url");
    const origin = originOf(c);
    const base = `${origin}/s/${id}`;
    const stack = await createStack({
      publicBaseUrl: base,
      passBaseUrl: `${base}/m`,
      allowedOrigins: [origin],
      rootDir: o.rootDir,
      seedDemo: true,
      autoTick: true,
      immediateWindow: true,
      frameDelayScale: 0.15,
    });
    worlds.set(id, { id, stack, createdAt: t, lastSeen: t });
    creates.set(ip, [...recent, t]);
    return c.json({ id, tour: `/s/${id}/` });
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

  // Shared, immutable app assets
  app.get("/app/:name/*", (c) => {
    const name = c.req.param("name");
    if (!Object.values(APPS).includes(name as never)) return c.notFound();
    const dist = join(o.rootDir, "apps", name, "dist");
    const rel = c.req.path.slice(`/app/${name}/`.length);
    const file = normalize(join(dist, rel));
    if (!file.startsWith(dist + sep) || !existsSync(file)) return c.notFound();
    return c.body(readFileSync(file), 200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    });
  });

  // Per-world routes
  app.all("/s/:id/*", async (c) => {
    const id = c.req.param("id");
    const w = worlds.get(id);
    const rest = c.req.path.slice(`/s/${id}`.length) || "/";
    if (!w) return c.req.method === "GET" && !rest.startsWith("/mcp") ? c.html(expiredHtml(), 404) : c.json({ error: "sandbox_expired" }, 404);
    w.lastSeen = now();

    if (c.req.method === "GET") {
      if (rest === "/") return c.html(tourHtml(id));
      // App pages only; /ops/state, /ops/events, /pass/<id>/… are the world's API and fall through
      const page = rest === "/device" || rest === "/device/" ? APPS.device : rest === "/ops" || rest === "/ops/" ? APPS.ops : rest.startsWith("/m/") ? APPS.m : undefined;
      if (page) {
        const html = inject(page, id);
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
    stop() {
      clearInterval(sweeper);
      for (const w of [...worlds.values()]) stopWorld(w);
    },
  };
}
