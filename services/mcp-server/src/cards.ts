// MCP Apps card resources (extension io.modelcontextprotocol/ui, spec 2026-01-26).
// Each card is a single-file HTML bundle served as ui://stoop/<card>@<hash> with
// mimeType text/html;profile=mcp-app. Tools point at it via _meta.ui.resourceUri (on the tool
// definition AND in the tool result, as Alexa+'s client expects).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MCP_APP_MIME = "text/html;profile=mcp-app";
export const CARD_NAMES = ["appraisal-grid", "listing-card", "negotiation-live", "deal-approval", "handoff-timeline", "receipt"] as const;
export type CardName = (typeof CARD_NAMES)[number];

export interface Card {
  name: CardName;
  uri: string;
  html: string;
}

export interface CardRegistry {
  get(name: CardName): Card;
  all(): Card[];
  uri(name: CardName): string;
}

/** Minimal fallback so tools still work before `pnpm --filter @stoop/ui-cards build` has run. */
function fallbackHtml(name: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body style="font-family:system-ui;padding:12px">
<div id="out">Loading ${name}…</div>
<script>
window.addEventListener('message', (e) => {
  const m = e.data; if (!m || m.jsonrpc !== '2.0') return;
  if (m.method === 'ui/notifications/tool-result') {
    document.getElementById('out').textContent = (m.params?.content?.[0]?.text) || JSON.stringify(m.params?.structuredContent);
  }
});
const id = 1; parent.postMessage({ jsonrpc: '2.0', id, method: 'ui/initialize', params: { protocolVersion: '2026-01-26', appCapabilities: {}, clientInfo: { name: '${name}', version: '0' } } }, '*');
window.addEventListener('message', (e) => { if (e.data?.id === id && e.data.result) parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, '*'); });
</script></body></html>`;
}

export function loadCards(distDir: string): CardRegistry {
  const cards = new Map<CardName, Card>();
  for (const name of CARD_NAMES) {
    const file = join(distDir, `${name}.html`);
    const html = existsSync(file) ? readFileSync(file, "utf8") : fallbackHtml(name);
    const hash = createHash("sha256").update(html).digest("hex").slice(0, 10);
    cards.set(name, { name, uri: `ui://stoop/${name}@${hash}`, html });
  }
  return {
    get: (n) => cards.get(n)!,
    all: () => [...cards.values()],
    uri: (n) => cards.get(n)!.uri,
  };
}

/** _meta for a tool definition / result that renders a card. */
export const uiMeta = (cards: CardRegistry, name: CardName) => ({ ui: { resourceUri: cards.uri(name) } });

/** Resource-level _meta: the cards need no network (data arrives via tool-result), so CSP stays default-deny. */
export const RESOURCE_UI_META = { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } };
