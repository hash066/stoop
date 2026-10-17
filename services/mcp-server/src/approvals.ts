// Human approval for irreversible actions (rule R4).
// Path A (client declares `elicitation`): ask right now with MCP elicitation/create (form mode),
//         sent on the tool call's own stream via extra.sendRequest (relatedRequestId).
// Path B (Alexa-style client, no elicitation): return `approval_required` + a pending action id; the
//         assistant asks the user and calls confirm_action on the next turn.
// Either way the answer becomes a single-use capability token bound to the exact terms shown.
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitResultSchema, type CallToolResult, type ServerNotification, type ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CardName, CardRegistry } from "./cards.ts";
import { uiMeta } from "./cards.ts";

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export const ELICITATION_TIMEOUT_MS = 5 * 60 * 1000;

export function supportsFormElicitation(server: McpServer): boolean {
  const caps = server.server.getClientCapabilities()?.elicitation as Record<string, unknown> | undefined;
  if (!caps) return false;
  // Spec 2025-11-25: an empty elicitation object means form-only; explicit modes list form/url.
  return Object.keys(caps).length === 0 || "form" in caps;
}

export function supportsUrlElicitation(server: McpServer): boolean {
  const caps = server.server.getClientCapabilities()?.elicitation as Record<string, unknown> | undefined;
  return !!caps && "url" in caps;
}

export interface FormField {
  type: "string" | "boolean" | "number";
  title: string;
  description?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  default?: string | boolean | number;
}

export async function elicitConfirm(
  extra: Extra,
  message: string,
  extraFields: Record<string, FormField> = {},
): Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }> {
  const required = ["confirm", ...Object.keys(extraFields)];
  const res = await extra.sendRequest(
    {
      method: "elicitation/create",
      params: {
        mode: "form",
        message,
        requestedSchema: {
          type: "object",
          properties: { confirm: { type: "boolean", title: "Approve", default: true }, ...extraFields },
          required,
        },
      },
    } as ServerRequest,
    ElicitResultSchema,
    { timeout: ELICITATION_TIMEOUT_MS },
  );
  return { action: res.action, content: res.content as Record<string, unknown> | undefined };
}

export async function elicitUrl(extra: Extra, message: string, url: string): Promise<"accept" | "decline" | "cancel"> {
  const res = await extra.sendRequest(
    { method: "elicitation/create", params: { mode: "url", message, url, elicitationId: randomUUID() } } as ServerRequest,
    ElicitResultSchema,
    { timeout: ELICITATION_TIMEOUT_MS },
  );
  return res.action;
}

// ---------- pending actions (Path B) ----------

export interface PendingAction {
  id: string;
  actor: string;
  summary: string;
  /** Extra confirmation required (e.g. voice code over $100). */
  needsVoiceCode?: boolean;
  createdAt: number;
  execute(args: { voiceCode?: string }): Promise<CallToolResult>;
  decline(): Promise<CallToolResult>;
}

export class PendingActions {
  private map = new Map<string, PendingAction>();
  add(p: Omit<PendingAction, "id" | "createdAt">): PendingAction {
    const full = { ...p, id: `pa_${randomUUID().replace(/-/g, "").slice(0, 12)}`, createdAt: Date.now() };
    this.map.set(full.id, full);
    return full;
  }
  take(id: string, actor: string): PendingAction | undefined {
    const p = this.map.get(id);
    if (!p || p.actor !== actor) return undefined;
    if (Date.now() - p.createdAt > 15 * 60 * 1000) {
      this.map.delete(id);
      return undefined;
    }
    this.map.delete(id);
    return p;
  }
  latestFor(actor: string): PendingAction | undefined {
    return [...this.map.values()].filter((p) => p.actor === actor).sort((a, b) => b.createdAt - a.createdAt)[0];
  }
}

// ---------- result helpers ----------

/** Voice-safe text: no pipes / markdown (Alexa voice-only display mode). */
export const voice = (s: string) => s.replace(/[|*_#`]/g, "").replace(/\s+/g, " ").trim();

export function result(text: string, structured: Record<string, unknown>, cards?: CardRegistry, card?: CardName): CallToolResult {
  return {
    content: [{ type: "text", text: voice(text) }],
    structuredContent: structured,
    ...(cards && card ? { _meta: uiMeta(cards, card) } : {}),
  };
}

export function errorResult(text: string, code: string): CallToolResult {
  return { content: [{ type: "text", text: voice(text) }], structuredContent: { kind: "error", code, speech: voice(text) }, isError: true };
}

/**
 * Run an approval-gated action. `run(accepted, content)` executes after a human yes.
 * Returns either the action's result (Path A) or an approval_required result (Path B).
 */
export async function withApproval(opts: {
  server: McpServer;
  extra: Extra;
  pending: PendingActions;
  actor: string;
  summary: string;
  cards: CardRegistry;
  card: CardName;
  cardData: Record<string, unknown>;
  voiceCode?: boolean;
  onApprove(content: { voiceCode?: string }): Promise<CallToolResult>;
  onDecline(): Promise<CallToolResult>;
}): Promise<CallToolResult> {
  if (supportsFormElicitation(opts.server)) {
    const fields: Record<string, FormField> = opts.voiceCode
      ? { voiceCode: { type: "string", title: "Your 4-digit purchase code", pattern: "^[0-9]{4}$", minLength: 4, maxLength: 4 } }
      : {};
    let ans;
    try {
      ans = await elicitConfirm(opts.extra, opts.summary, fields);
    } catch {
      ans = undefined; // client errored or timed out -> fall back to Path B
    }
    if (ans) {
      if (ans.action === "accept" && ans.content?.confirm !== false) return opts.onApprove({ voiceCode: ans.content?.voiceCode as string | undefined });
      return opts.onDecline();
    }
  }
  const p = opts.pending.add({ actor: opts.actor, summary: opts.summary, needsVoiceCode: opts.voiceCode, execute: (a) => opts.onApprove(a), decline: () => opts.onDecline() });
  return result(
    `${opts.summary} Say yes to approve${opts.voiceCode ? " and tell me your 4-digit purchase code" : ""}, or no to cancel.`,
    { kind: "approval_required", pendingActionId: p.id, summary: opts.summary, needsVoiceCode: !!opts.voiceCode, card: opts.cardData },
    opts.cards,
    opts.card,
  );
}
