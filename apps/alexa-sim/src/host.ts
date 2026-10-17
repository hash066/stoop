// MCP Apps host bridge (spec 2026-01-26) for one card instance.
// Renders through the sandbox proxy (different origin), answers ui/initialize, then sends
// tool-input and tool-result after `initialized`. Proxies tools/call (visibility-checked),
// resources/read, open-link, message and size-changed.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface CardHostOptions {
  proxyUrl: string;
  html: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: CallToolResult;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  visibility(name: string): string[];
  readResource(uri: string): Promise<unknown>;
  onMessage(text: string): void;
  onSize(height: number): void;
  log(line: string): void;
  width: number;
}

export function mountCard(container: HTMLElement, o: CardHostOptions) {
  const iframe = document.createElement("iframe");
  iframe.src = o.proxyUrl;
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
  iframe.setAttribute("title", `${o.toolName} card`);
  iframe.style.cssText = "border:0;width:100%;height:120px;display:block;background:transparent";
  container.replaceChildren(iframe);
  const proxyOrigin = new URL(o.proxyUrl).origin;
  let initialized = false;
  let latest = o.toolResult;

  const post = (m: unknown) => iframe.contentWindow?.postMessage(m, proxyOrigin);
  const reply = (id: unknown, result: unknown) => post({ jsonrpc: "2.0", id, result });
  const fail = (id: unknown, message: string) => post({ jsonrpc: "2.0", id, error: { code: -32000, message } });

  const onMsg = async (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow || e.origin !== proxyOrigin) return;
    const m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    switch (m.method) {
      case "ui/notifications/sandbox-proxy-ready":
        post({ jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready", params: { html: o.html, sandbox: "allow-scripts", csp: { connectDomains: [], resourceDomains: [] } } });
        return;
      case "ui/initialize":
        reply(m.id, {
          protocolVersion: m.params?.protocolVersion ?? "2026-01-26",
          hostInfo: { name: "stoop-alexa-sim", version: "0.1.0" },
          hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {}, logging: {}, sandbox: { csp: { connectDomains: [], resourceDomains: [] } } },
          hostContext: {
            theme: "light",
            displayMode: "inline",
            availableDisplayModes: ["inline"],
            containerDimensions: { maxHeight: 560, width: o.width },
            platform: "web",
            deviceCapabilities: { touch: true, hover: false },
            locale: navigator.language,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
            toolInfo: { tool: { name: o.toolName, inputSchema: { type: "object" } } },
            deviceClass: "hub-10in",
          },
        });
        return;
      case "ui/notifications/initialized":
        initialized = true;
        post({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: o.toolInput } });
        post({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: latest });
        return;
      case "ui/notifications/size-changed":
        if (typeof m.params?.height === "number") {
          iframe.style.height = `${Math.min(Math.ceil(m.params.height) + 2, 620)}px`;
          o.onSize(m.params.height);
        }
        return;
      case "notifications/message":
        o.log(`card log: ${JSON.stringify(m.params).slice(0, 160)}`);
        return;
      case "tools/call": {
        const name = m.params?.name as string;
        if (!o.visibility(name).includes("app")) return fail(m.id, `Tool ${name} is not callable from apps`);
        o.log(`card -> tools/call ${name}`);
        try {
          reply(m.id, await o.callTool(name, m.params?.arguments ?? {}));
        } catch (err) {
          fail(m.id, String(err));
        }
        return;
      }
      case "resources/read":
        try {
          reply(m.id, await o.readResource(m.params?.uri));
        } catch (err) {
          fail(m.id, String(err));
        }
        return;
      case "ui/open-link":
        window.open(String(m.params?.url ?? ""), "_blank", "noopener");
        reply(m.id, {});
        return;
      case "ui/message": {
        const text = m.params?.content?.text ?? m.params?.content?.[0]?.text;
        if (text) o.onMessage(String(text));
        reply(m.id, {});
        return;
      }
      case "ui/update-model-context":
        reply(m.id, {});
        return;
      case "ui/request-display-mode":
        reply(m.id, { mode: "inline" });
        return;
      case "ping":
        reply(m.id, {});
        return;
      default:
        if (m.id !== undefined && m.method) fail(m.id, `Unsupported: ${m.method}`);
    }
  };
  window.addEventListener("message", onMsg);
  return {
    update(result: CallToolResult) {
      latest = result;
      if (initialized) post({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
    },
    destroy() {
      window.removeEventListener("message", onMsg);
      if (initialized) post({ jsonrpc: "2.0", id: "teardown", method: "ui/resource-teardown", params: { reason: "replaced" } });
      iframe.remove();
    },
  };
}
