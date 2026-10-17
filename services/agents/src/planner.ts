// Host planner for the Alexa+ simulator: utterance -> MCP tool calls. On real Alexa+ this is Amazon's
// LLM; in our sim it's Bedrock (tool use over the MCP tools/list) or an offline intent parser.
// Speech is shaped by the tools' returned text (Alexa add-on design guide), so the planner only plans.
import { BedrockRuntimeClient, ConverseCommand, type Tool as BedrockTool } from "@aws-sdk/client-bedrock-runtime";
import { llmMode, modelIdFor } from "./llm.ts";
import { parseMoneyMinor } from "./negotiator.ts";

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface PlannerState {
  role: "seller" | "buyer";
  /** Last listing ids the buyer heard about (search results), most relevant first. */
  lastListingIds?: string[];
  activeNegotiationId?: string;
  activeListingId?: string;
  activeDealId?: string;
  /** Approval waiting for a spoken yes (clients without elicitation). */
  pendingApprovalId?: string;
}

export interface PlannedCall {
  name: string;
  args: Record<string, unknown>;
}

export interface Plan {
  calls: PlannedCall[];
  /** Spoken directly when no tool is needed (e.g. "Sorry, I didn't catch that"). */
  say?: string;
  planner: string;
}

const has = (tools: McpToolInfo[], name: string) => tools.some((t) => t.name === name);

/** Offline intent parser covering the demo script and common phrasings. */
export function planOffline(utterance: string, state: PlannerState, tools: McpToolInfo[]): Plan {
  const u = utterance.trim().toLowerCase().replace(/[’']/g, "'");
  const calls: PlannedCall[] = [];
  const P = (name: string, args: Record<string, unknown> = {}) => has(tools, name) && calls.push({ name, args });
  const yes = /^(yes|yeah|yep|sure|ok(ay)?|do it|accept( it)?|approve( it)?|confirm|go ahead|sounds good)\b/.test(u);
  const no = /^(no|nope|decline|don't|do not|reject|cancel that)\b/.test(u);

  if ((yes || no) && state.pendingApprovalId && has(tools, "confirm_action")) {
    P("confirm_action", { approvalId: state.pendingApprovalId, decision: yes ? "accept" : "decline" });
    return { calls, planner: "offline" };
  }

  if (state.role === "seller") {
    const sell = u.match(/\bsell (?:my |the |our )?(.+?)(?:[.!?]|$|,\s*(?:don't|do not|but|and don't))/);
    const floor = u.match(/(?:don't|do not|never) go (?:below|under|lower than) \$?\s?(\d{1,5})(?: (?:on|for) (?:the |my )?([a-z ]+?))?(?:[.!?]|$)/);
    if (sell) {
      const names = sell[1]!
        .split(/,|\band\b/)
        .map((s) =>
          s
            .trim()
            .replace(/\b(in the garage|from the garage|in the basement)\b/g, "")
            .replace(/^((the|my|our|old)\s+)+/g, "")
            .trim(),
        )
        .filter(Boolean);
      P("list_items", { items: names });
    }
    if (floor) {
      P("set_mandate", { item: (floor[2] ?? sell?.[1]?.split(/,|\band\b/)[0] ?? "").replace(/^(the|my)\s+/, "").trim(), floorDollars: Number(floor[1]) });
    }
    if (calls.length) return { calls, planner: "offline" };
    if (/\b(what|any|show|read).*(offers?|bids?)\b|\bwho wants\b/.test(u)) P("review_offers");
    else if (/\b(status|how's|how is|where are we|did .* (pick|come)|picked up)\b/.test(u)) P("handoff_status");
    else if (/\breceipt|proof\b/.test(u)) P("get_receipt");
    else if (/\bcancel (the )?(sale|deal)\b/.test(u)) P("cancel_sale");
    else if (/\b(evening|morning|afternoon|pickup|pick-up|pick up)\b.*\b(work|between|after|before|from)\b|\bpickups?\b/.test(u)) {
      const hours = u.match(/(\d{1,2})\s*(?:am|pm)?\s*(?:to|-|until|and)\s*(\d{1,2})\s*(am|pm)?/);
      P("set_pickup_preferences", hours ? { fromHour: to24(Number(hours[1]), hours[3]), toHour: to24(Number(hours[2]), hours[3]) } : { preset: u.includes("morning") ? "mornings" : u.includes("afternoon") ? "afternoons" : "evenings" });
    } else if (/\b(price|appraise|worth|value)\b/.test(u)) P("appraise_photos", { useLastSweep: true });
    if (calls.length) return { calls, planner: "offline" };
    return { calls, say: "You can say things like: sell the stroller, don't go below 90 dollars. Or: what offers do I have?", planner: "offline" };
  }

  // buyer
  const find = u.match(/\b(?:find|look for|search for|is there|any|i need|i want|shop for)\b (?:me )?(?:a |an |some )?(.+?)(?: (?:under|below|for less than|less than|max(?:imum)?|up to) \$?\s?(\d{1,5}))?(?: (?:near(?:by| me)?|around here|in my area))?(?:[.!?]|$)/);
  const amount = parseMoneyMinor(u) ?? (u.match(/\b(\d{2,4})\b/) ? Number(u.match(/\b(\d{2,4})\b/)![1]) * 100 : undefined);
  if (find && !/\boffer\b/.test(u)) {
    P("search_listings", { query: find[1]!.replace(/\b(nearby|near me|please)\b/g, "").trim(), maxPriceDollars: find[2] ? Number(find[2]) : undefined });
    return { calls, planner: "offline" };
  }
  if (/\b(check ?out|buy it|pay|purchase|i'll take it|book it)\b/.test(u) && state.activeDealId) {
    const code = u.match(/\b(\d{4})\b/);
    P("checkout", { dealId: state.activeDealId, explicitYes: true, ...(code ? { voiceCode: code[1] } : {}) });
    return { calls, planner: "offline" };
  }
  if (/\b(pass|pickup details|where do i pick|pick-up details)\b/.test(u) && state.activeDealId) {
    P("get_pickup_pass", { dealId: state.activeDealId });
    return { calls, planner: "offline" };
  }
  const listingId = state.activeListingId ?? state.lastListingIds?.[0];
  if (amount && listingId && /\b(offer|take|do|counter|how about|would they|pay|\$)/.test(u)) {
    P("make_offer", { listingId, amountDollars: Math.round(amount / 100), message: utterance });
    return { calls, planner: "offline" };
  }
  if (listingId && u.length > 3) {
    P("ask_seller", { listingId, message: utterance });
    return { calls, planner: "offline" };
  }
  return { calls, say: "Try: find me a jogging stroller under 100 dollars nearby.", planner: "offline" };
}

function to24(h: number, ampm?: string) {
  if (ampm === "am") return h % 12;
  if (ampm === "pm" || h < 8) return (h % 12) + 12;
  return h;
}

/** Bedrock planner: Converse with the MCP tool list as Bedrock toolConfig. */
export async function planBedrock(utterance: string, state: PlannerState, tools: McpToolInfo[], skill: string): Promise<Plan> {
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  const toolSpecs: BedrockTool[] = tools.map((t) => ({
    toolSpec: {
      name: t.name,
      description: (t.description ?? t.name).slice(0, 500),
      inputSchema: { json: (t.inputSchema ?? { type: "object", properties: {} }) as never },
    },
  }));
  const out = await client.send(
    new ConverseCommand({
      modelId: modelIdFor("PLANNER"),
      system: [{ text: `${skill}\n\nCurrent state (JSON): ${JSON.stringify(state)}\nCall the tools needed for the user's request. Do not invent ids.` }],
      messages: [{ role: "user", content: [{ text: utterance }] }],
      toolConfig: { tools: toolSpecs },
      inferenceConfig: { maxTokens: 400, temperature: 0 },
    }),
  );
  const calls: PlannedCall[] = [];
  let say: string | undefined;
  for (const c of out.output?.message?.content ?? []) {
    if ("toolUse" in c && c.toolUse?.name) calls.push({ name: c.toolUse.name, args: (c.toolUse.input ?? {}) as Record<string, unknown> });
    else if ("text" in c && c.text) say = c.text;
  }
  return { calls, say: calls.length ? undefined : say, planner: `bedrock:${modelIdFor("PLANNER")}` };
}

export async function planTurn(utterance: string, state: PlannerState, tools: McpToolInfo[], skill: string): Promise<Plan> {
  if (llmMode() === "bedrock") {
    try {
      return await planBedrock(utterance, state, tools, skill);
    } catch {
      return { ...planOffline(utterance, state, tools), planner: "offline-fallback" };
    }
  }
  return planOffline(utterance, state, tools);
}
