// Talking to a shop's world (/s/<shop>/…): plain JSON routes, and the same MCP tools an Alexa+
// device calls (stateless JSON-RPC over Streamable HTTP).

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

let rpcId = 0;
export async function tool(shop: string, role: "seller" | "buyer", token: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const res = await fetch(`${base(shop)}/mcp/${role}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  if (!res.ok && res.status !== 200) {
    const b = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, b.error ?? `http_${res.status}`, b.message ?? friendly(res.status, b.error));
  }
  const raw = await res.text();
  const json = raw.trimStart().startsWith("{") ? raw : (raw.split("\n").find((l) => l.startsWith("data:")) ?? "data:{}").slice(5);
  const msg = JSON.parse(json) as { result?: { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, any>; isError?: boolean }; error?: { message: string } };
  if (msg.error) throw new ApiError(500, "rpc", msg.error.message);
  const text = (msg.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ");
  return { text, data: msg.result?.structuredContent ?? {}, isError: !!msg.result?.isError };
}

/**
 * Run a tool the person just asked for with a button that names the exact terms ("List It at $120").
 * That click is their yes, so an approval the tool asks for is answered with it, with the purchase
 * code when the purchase needs one.
 */
export async function act(shop: string, role: "seller" | "buyer", token: string, name: string, args: Record<string, unknown> = {}, voiceCode?: string): Promise<ToolResult> {
  const r = await tool(shop, role, token, name, args);
  if (r.data.kind === "approval_required" && r.data.pendingActionId) {
    return tool(shop, role, token, "confirm_action", { approvalId: r.data.pendingActionId, decision: "accept", ...(voiceCode ? { voiceCode } : {}) });
  }
  return r;
}

export async function listTools(shop: string, role: "seller" | "buyer", token: string) {
  const res = await fetch(`${base(shop)}/mcp/${role}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list", params: {} }),
  });
  const raw = await res.text();
  const json = raw.trimStart().startsWith("{") ? raw : (raw.split("\n").find((l) => l.startsWith("data:")) ?? "data:{}").slice(5);
  const msg = JSON.parse(json) as { result?: { tools?: Array<{ name: string; description?: string; inputSchema?: unknown; _meta?: any }> } };
  return (msg.result?.tools ?? []).filter((t) => (t._meta?.ui?.visibility ?? ["model", "app"]).includes("model")).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

// ---------- tokens and this device

const KEY = { seller: "stoop:seller:", buyer: "stoop:buyer:", cam: "stoop:cam:" } as const;
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
