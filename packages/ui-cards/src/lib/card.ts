// Shared bootstrap for every card: official MCP Apps App class, tokens, safe DOM helpers.
// Cards get data only through ui/notifications/tool-result; they never fetch (default-deny CSP).
import { App } from "@modelcontextprotocol/ext-apps";
import "./style.css";

export type Render = (data: any, ctx: { app: App; root: HTMLElement }) => void;

/** Escape-by-construction element builder: text is always set via textContent (no innerHTML). */
export function h(tag: string, attrs: Record<string, string | undefined> = {}, ...children: Array<Node | string | null | undefined | false>): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, v);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

/** append() that skips null/false children (conditional rows). */
export function add(parent: HTMLElement, ...nodes: Array<Node | string | null | undefined | false>) {
  for (const n of nodes) if (n !== null && n !== undefined && n !== false) parent.append(n);
}

export const money = (minor: number | undefined) => (minor === undefined || minor === null ? "–" : `$${(minor / 100).toFixed(minor % 100 ? 2 : 0)}`);
export const clock = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "–");

export function mountCard(name: string, render: Render) {
  const root = document.getElementById("card")!;
  const app = new App({ name: `stoop-${name}`, version: "0.1.0" }, {}, { autoResize: true });
  app.ontoolresult = (result) => {
    root.replaceChildren();
    try {
      render(result.structuredContent ?? {}, { app, root });
    } catch (e) {
      root.append(h("p", { class: "muted" }, "This card couldn't render."));
      console.error(e);
    }
  };
  app.onhostcontextchanged = (ctx) => {
    if (ctx.theme) document.documentElement.dataset.theme = ctx.theme;
  };
  void app.connect();
  return app;
}
