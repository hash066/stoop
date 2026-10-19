// Talking to a shop's world (/s/<shop>/…): plain JSON routes for state, and the same MCP tools an
// Alexa+ device calls, through the official MCP TypeScript SDK client.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Form fields the server rejected, when it says. */
    readonly fields: string[] = [],
  ) {
    super(message);
  }
}

export const base = (shop: string) => `/s/${encodeURIComponent(shop)}`;

export async function api<T>(shop: string, path: string, o: { method?: string; body?: unknown; token?: string; device?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.device) headers["X-Stoop-Device"] = o.device;
  return request<T>(`${base(shop)}${path}`, { method: o.method ?? (o.body === undefined ? "GET" : "POST"), headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
}

export async function request<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response | undefined;
  // one retry on a transient network or proxy error (never on a real answer from the server)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(url, init);
      if (res.status !== 502 && res.status !== 503 && res.status !== 504) break;
    } catch (e) {
      if (attempt === 1) throw new ApiError(0, "network", "You seem to be offline. Check your connection and try again.");
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  const r = res!;
  const isJson = (r.headers.get("content-type") ?? "").includes("json");
  const body = isJson ? await r.json().catch(() => ({})) : {};
  if (!r.ok) {
    const b = body as { error?: string; message?: string; fields?: string[] };
    throw new ApiError(r.status, b.error ?? `http_${r.status}`, b.message ?? (b.fields?.length ? "Check the highlighted fields." : friendly(r.status, b.error)), b.fields ?? []);
  }
  return body as T;
}

function friendly(status: number, code?: string) {
  if (code === "sandbox_expired") return "This shop has closed.";
  if (status === 401 || status === 403) return "You don't have access to that.";
  if (status === 404) return "That doesn't exist anymore.";
  if (status === 429) return "That's a lot of requests. Wait a minute and try again.";
  return "Something went wrong on our side. Try again in a moment.";
}

// ---------- MCP tools

export interface ToolResult {
  text: string;
  data: Record<string, any>;
  isError: boolean;
}

// One MCP session per shop, role and token, through the official TypeScript SDK (spec 2025-11-25,
// Streamable HTTP). The app declares form and URL elicitation, so a tool that needs a person's yes
// asks for it in the middle of the call (elicitation/create) and the app answers with the person's tap.

export interface Approval {
  message: string;
  /** The purchase needs the buyer's 4-digit code (over $100, as on a voice assistant). */
  needsCode: boolean;
  /** What is being approved (e.g. the checkout breakdown), sent by the server in the request's _meta. */
  card?: Record<string, any>;
  mode: "form" | "url";
  url?: string;
}
export type ApprovalAnswer = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };
export type Approver = (a: Approval) => Promise<ApprovalAnswer>;

interface Session {
  client: Client;
  queue: Promise<unknown>;
  approver?: Approver;
}
const sessions = new Map<string, Promise<Session>>();

function session(shop: string, role: "seller" | "buyer", token: string): Promise<Session> {
  const key = `${shop}|${role}|${token}`;
  let s = sessions.get(key);
  if (!s) {
    s = (async () => {
      const client = new Client({ name: "stoop-web", version: "1.0.0", title: "Stoop web app" }, { capabilities: { elicitation: { form: {}, url: {} } } });
      const out: Session = { client, queue: Promise.resolve() };
      client.setRequestHandler(ElicitRequestSchema, async (req) => {
        const p = req.params as { mode?: "form" | "url"; message: string; url?: string; requestedSchema?: { properties?: Record<string, unknown> }; _meta?: Record<string, any> };
        const ask: Approval = { message: p.message, needsCode: !!p.requestedSchema?.properties?.voiceCode, card: p._meta?.["io.stoop/card"], mode: p.mode ?? "form", url: p.url };
        // nobody is there to answer (e.g. a background call): say no rather than guess
        const a = out.approver ? await out.approver(ask) : { action: "decline" as const };
        return ask.mode === "url" ? { action: a.action } : a;
      });
      const transport = new StreamableHTTPClientTransport(new URL(`${location.origin}${base(shop)}/mcp/${role}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
      await client.connect(transport);
      return out;
    })();
    s.catch(() => sessions.delete(key));
    sessions.set(key, s);
  }
  return s;
}

function toResult(r: CallToolResult): ToolResult {
  const text = (r.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ");
  return { text, data: (r.structuredContent as Record<string, any>) ?? {}, isError: !!r.isError };
}

/** Call one MCP tool. `approver` answers any approval the tool asks for during the call. */
export async function tool(shop: string, role: "seller" | "buyer", token: string, name: string, args: Record<string, unknown> = {}, approver?: Approver): Promise<ToolResult> {
  for (let attempt = 0; ; attempt++) {
    let s: Session;
    try {
      s = await session(shop, role, token);
    } catch (e) {
      throw mcpError(e);
    }
    // one call at a time per session, so an approval prompt belongs to the call that asked for it
    const run = async () => {
      s.approver = approver;
      try {
        return toResult((await s.client.callTool({ name, arguments: args }, undefined, { timeout: 6 * 60_000 })) as CallToolResult);
      } finally {
        s.approver = undefined;
      }
    };
    const p = s.queue.then(run, run);
    s.queue = p.catch(() => undefined);
    try {
      return await p;
    } catch (e) {
      // the server forgot this session (restart): start a new one, once
      if (attempt === 0 && /session|404|not found/i.test(String(e))) {
        sessions.delete(`${shop}|${role}|${token}`);
        continue;
      }
      throw mcpError(e);
    }
  }
}

function mcpError(e: unknown) {
  const s = String(e instanceof Error ? e.message : e);
  if (/sandbox_expired/.test(s)) return new ApiError(404, "sandbox_expired", "This shop has closed.");
  if (/401|unauthorized/i.test(s)) return new ApiError(401, "unauthorized", "You don’t have access to that.");
  if (/fetch|network/i.test(s)) return new ApiError(0, "network", "You seem to be offline. Check your connection and try again.");
  return new ApiError(500, "mcp", "Something went wrong on our side. Try again in a moment.");
}

/**
 * Run a tool the person just asked for with a button that names the exact terms ("List It at $120").
 * That click is their yes, so the approval the tool asks for is answered with it (and with the
 * purchase code, when the purchase needs one).
 */
export function act(shop: string, role: "seller" | "buyer", token: string, name: string, args: Record<string, unknown> = {}, voiceCode?: string): Promise<ToolResult> {
  return tool(shop, role, token, name, args, async (a) => (a.needsCode && !voiceCode ? { action: "decline" } : { action: "accept", content: { confirm: true, ...(a.needsCode ? { voiceCode } : {}) } }));
}

export async function listTools(shop: string, role: "seller" | "buyer", token: string) {
  const s = await session(shop, role, token);
  const { tools } = await s.client.listTools();
  return tools.filter((t) => (((t._meta as any)?.ui?.visibility as string[]) ?? ["model", "app"]).includes("model")).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

// ---------- tokens and this device

const KEY = { seller: "stoop:seller:", buyer: "stoop:buyer:", cam: "stoop:cam:" } as const;

/** One buyer profile across every shop on Stoop Street (name, and a purchase code kept server-side as a hash). */
export const profile = {
  get: () => ({ token: localStorage.getItem("stoop:profile") ?? "", name: localStorage.getItem("stoop:profile-name") ?? "" }),
  set: (token: string, name: string) => {
    localStorage.setItem("stoop:profile", token);
    localStorage.setItem("stoop:profile-name", name);
  },
  clear: () => {
    localStorage.removeItem("stoop:profile");
    localStorage.removeItem("stoop:profile-name");
  },
};
const json = (body: unknown, token?: string) => ({ method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
export async function createProfile(name: string, purchaseCode: string) {
  const r = await request<{ token: string; name: string }>("/api/profile", json({ name, purchaseCode }));
  profile.set(r.token, r.name);
  return r;
}
/** This person's buyer token in one shop (made from their profile the first time). */
export async function joinShop(shop: string) {
  const r = await request<{ buyerToken: string }>("/api/profile/join", json({ shop }, profile.get().token));
  tokens.set("buyer", shop, r.buyerToken);
  return r.buyerToken;
}
export const postJson = json;
export const tokens = {
  get: (kind: keyof typeof KEY, shop: string) => localStorage.getItem(KEY[kind] + shop) ?? "",
  set: (kind: keyof typeof KEY, shop: string, t: string) => localStorage.setItem(KEY[kind] + shop, t),
  clear: (kind: keyof typeof KEY, shop: string) => localStorage.removeItem(KEY[kind] + shop),
};

/** A link can carry a token in its #fragment (never sent to any server); keep it on this device and drop it from the address bar. */
export function absorbFragment(shop: string) {
  const h = new URLSearchParams(location.hash.slice(1));
  let took = false;
  for (const [k, kind] of [["sk", "seller"], ["bk", "buyer"], ["ck", "cam"]] as const) {
    const v = h.get(k);
    if (v && /^[a-z]{2}_[A-Za-z0-9_-]{10,}$/.test(v)) {
      tokens.set(kind, shop, v);
      took = true;
    }
  }
  if (took) history.replaceState(history.state, "", location.pathname + location.search);
}

export function deviceId() {
  let d = localStorage.getItem("stoop:device");
  if (!d) {
    const b = crypto.getRandomValues(new Uint8Array(18));
    d = btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    localStorage.setItem("stoop:device", d);
  }
  return d;
}

// ---------- formatting

const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
export const money = (minor: number) => (minor % 100 ? usd2 : usd0).format(minor / 100);
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
export const clock = (ms: number) => timeFmt.format(new Date(ms));
export const dollars = (s: string) => {
  const n = Number(String(s).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined;
};
export function until(ms: number, now = Date.now()) {
  const m = Math.max(0, Math.round((ms - now) / 60_000));
  if (m < 1) return "less than a minute";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${h} hour${h === 1 ? "" : "s"}${r ? ` ${r} min` : ""}`;
}

// ---------- photos: downscale on the device before upload (also drops EXIF location)

export async function toJpeg(file: File, max = 1600, quality = 0.82): Promise<string> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions).catch(() => undefined);
  let src: CanvasImageSource;
  let w: number;
  let h: number;
  if (bmp) {
    src = bmp;
    w = bmp.width;
    h = bmp.height;
  } else {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    await img.decode();
    src = img;
    w = img.naturalWidth;
    h = img.naturalHeight;
    URL.revokeObjectURL(url);
  }
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}

export const isPhone = () => matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 700;
