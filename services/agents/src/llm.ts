// LLM plumbing for every agent. One switch: LLM_MODE=bedrock uses Amazon Bedrock (Strands BedrockModel);
// anything else uses ScriptedModel, a deterministic Strands Model that drives the SAME agents and tools
// offline. Model ids come from env (BEDROCK_MODEL_ID_<ROLE>); Nova 2 Lite is the guaranteed baseline.
import { BedrockModel, Model, type Message, type StreamOptions, type ToolSpec } from "@strands-agents/sdk";
import type { ModelStreamEvent } from "@strands-agents/sdk";
import { takeModelCalls } from "@stoop/shared";

export type AgentRole = "NEGOTIATOR" | "APPRAISER" | "BUYERBOT" | "PLANNER" | "VISION";

export const DEFAULT_MODEL_ID = "us.amazon.nova-2-lite-v1:0";

export function llmMode(): "bedrock" | "offline" {
  return process.env.LLM_MODE === "bedrock" ? "bedrock" : "offline";
}

export function modelIdFor(role: AgentRole): string {
  return process.env[`BEDROCK_MODEL_ID_${role}`] ?? DEFAULT_MODEL_ID;
}

/** What a scripted step produces: either a tool call or final text. */
export type ScriptStep = { tool: string; input: Record<string, unknown> } | { text: string };

export interface ScriptContext {
  messages: Message[];
  toolSpecs: ToolSpec[];
  /** Tool results so far in this invocation, parsed (JSON blocks / JSON text), keyed by tool name, latest last. */
  results: Array<{ tool: string; output: unknown; status: "success" | "error" }>;
  /** The latest user text in the conversation. */
  userText: string;
}

export type Script = (ctx: ScriptContext) => ScriptStep;

/**
 * A deterministic Strands Model. It lets the real Agent loop (tool dispatch, validation, hooks)
 * run without any network, so the offline demo exercises exactly the code paths Bedrock will.
 */
export class ScriptedModel extends Model<{ modelId?: string }> {
  private config: { modelId?: string } = { modelId: "scripted" };
  constructor(private script: Script) {
    super();
  }
  updateConfig(c: { modelId?: string }) {
    this.config = { ...this.config, ...c };
  }
  getConfig() {
    return this.config;
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const ctx = buildContext(messages, options?.toolSpecs ?? []);
    const step = this.script(ctx);
    yield { type: "modelMessageStartEvent", role: "assistant" };
    if ("tool" in step) {
      const toolUseId = `tu_${Math.random().toString(36).slice(2, 10)}`;
      yield { type: "modelContentBlockStartEvent", start: { type: "toolUseStart", name: step.tool, toolUseId } };
      yield { type: "modelContentBlockDeltaEvent", delta: { type: "toolUseInputDelta", input: JSON.stringify(step.input) } };
      yield { type: "modelContentBlockStopEvent" };
      yield { type: "modelMessageStopEvent", stopReason: "toolUse" };
    } else {
      yield { type: "modelContentBlockStartEvent" };
      yield { type: "modelContentBlockDeltaEvent", delta: { type: "textDelta", text: step.text } };
      yield { type: "modelContentBlockStopEvent" };
      yield { type: "modelMessageStopEvent", stopReason: "endTurn" };
    }
    yield { type: "modelMetadataEvent", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }
}

function parseResultContent(content: unknown[]): unknown {
  for (const c of content) {
    const block = c as { type?: string; json?: unknown; text?: string };
    if (block.json !== undefined) return block.json;
    if (typeof block.text === "string") {
      try {
        return JSON.parse(block.text);
      } catch {
        return block.text;
      }
    }
  }
  return undefined;
}

export function buildContext(messages: Message[], toolSpecs: ToolSpec[]): ScriptContext {
  const toolNames = new Map<string, string>();
  const results: ScriptContext["results"] = [];
  let userText = "";
  for (const m of messages) {
    for (const block of m.content as unknown as Array<Record<string, unknown>>) {
      if (block.type === "toolUseBlock") toolNames.set(String(block.toolUseId), String(block.name));
      if (block.type === "toolResultBlock") {
        results.push({
          tool: toolNames.get(String(block.toolUseId)) ?? "unknown",
          output: parseResultContent((block.content as unknown[]) ?? []),
          status: (block.status as "success" | "error") ?? "success",
        });
      }
      if (block.type === "textBlock" && m.role === "user") userText = String(block.text);
    }
  }
  // Results only count for the current turn: drop those before the last user text message.
  return { messages, toolSpecs, results: lastTurnResults(messages, toolNames), userText };
}

function lastTurnResults(messages: Message[], toolNames: Map<string, string>): ScriptContext["results"] {
  let start = 0;
  messages.forEach((m, i) => {
    const blocks = m.content as unknown as Array<Record<string, unknown>>;
    if (m.role === "user" && blocks.some((b) => b.type === "textBlock")) start = i;
  });
  const out: ScriptContext["results"] = [];
  for (const m of messages.slice(start)) {
    for (const block of m.content as unknown as Array<Record<string, unknown>>) {
      if (block.type === "toolResultBlock") {
        out.push({
          tool: toolNames.get(String(block.toolUseId)) ?? "unknown",
          output: parseResultContent((block.content as unknown[]) ?? []),
          status: (block.status as "success" | "error") ?? "success",
        });
      }
    }
  }
  return out;
}

/** Model for a role: Bedrock in LLM_MODE=bedrock, else the given offline script. */
export function createModel(role: AgentRole, offlineScript: Script): Model {
  // an agent turn makes about 3 model calls; over the daily cap the same agent runs offline
  if (llmMode() === "bedrock" && takeModelCalls(3)) {
    return new BedrockModel({
      region: process.env.AWS_REGION ?? "us-east-1",
      modelId: modelIdFor(role),
      maxTokens: 800,
      temperature: role === "BUYERBOT" ? 0.8 : 0.2,
    });
  }
  return new ScriptedModel(offlineScript);
}
