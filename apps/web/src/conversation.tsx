// The assistant conversation: what you type or say goes to the same planner and MCP tools an
// Alexa+ device uses. Approvals the tools ask for show up here and need your tap (and your purchase
// code when a purchase needs one).
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, base, listTools, money, request, tool, type ToolResult } from "./api.ts";
import { Mic, Send } from "./ui.tsx";
import { listenOnce, speak, speechSupported, stopSpeaking } from "./voice.ts";

export interface Line {
  who: "me" | "seller" | "stoop";
  text: string;
  at: number;
}
export interface Approval {
  id: string;
  summary: string;
  needsCode: boolean;
  card?: Record<string, any>;
}
export interface PlannerContext {
  activeListingId?: string;
  lastListingIds?: string[];
  activeDealId?: string;
}

/** Tools the assistant may use on a page (the pass and photos have their own buttons). */
const ALLOW = {
  buyer: new Set(["get_listing", "make_offer", "ask_seller", "checkout", "confirm_action", "order_status"]),
  seller: new Set(["my_items", "list_items", "set_mandate", "review_offers", "respond_to_offer", "set_pickup_preferences", "handoff_status", "get_receipt", "confirm_pickup", "cancel_sale", "confirm_action"]),
};

export function useConversation(o: { shop: string; role: "seller" | "buyer"; token: string; storeKey: string; context: PlannerContext; onChange?(): void }) {
  const [lines, setLines] = useState<Line[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(o.storeKey) ?? "[]") as Line[];
    } catch {
      return [];
    }
  });
  const [approval, setApproval] = useState<Approval>();
  const [busy, setBusy] = useState(false);
  const tools = useRef<Awaited<ReturnType<typeof listTools>>>(undefined);
  const ctx = useRef(o.context);
  ctx.current = { ...ctx.current, ...o.context };
  const pendingOffer = useRef<string>(undefined);

  useEffect(() => {
    localStorage.setItem(o.storeKey, JSON.stringify(lines.slice(-60)));
  }, [lines, o.storeKey]);

  const add = useCallback((l: Omit<Line, "at">) => setLines((x) => [...x, { ...l, at: Date.now() }]), []);

  /** Show a tool result in the conversation; returns the spoken text. */
  const absorb = useCallback(
    (name: string, r: ToolResult) => {
      const d = r.data;
      if (d.kind === "approval_required" && d.pendingActionId) {
        setApproval({ id: d.pendingActionId, summary: d.summary ?? r.text, needsCode: !!d.needsVoiceCode, card: d.card });
        return r.text;
      }
      if (d.kind === "negotiation") {
        ctx.current.activeListingId = d.listingId;
        if (d.dealId) ctx.current.activeDealId = d.dealId;
        add({ who: "seller", text: d.reply ?? r.text });
        if (d.action === "awaiting_seller") add({ who: "stoop", text: "The owner has to approve this price. You’ll see their answer here; you can close the page and come back with the same link." });
        if (d.action === "accepted") add({ who: "stoop", text: `Accepted at ${money(ladderLast(d))}. Pay below to reserve it.` });
        return d.reply ?? r.text;
      }
      if (d.kind === "offers" && d.offers?.length) pendingOffer.current = d.offers[0].approvalId;
      if (d.kind === "deal" && d.dealId) ctx.current.activeDealId = d.dealId;
      // on the web the pass is a button on this page, not an email
      if (o.role === "buyer" && d.kind === "deal" && d.state === "FUNDS_HELD" && d.totalMinor) {
        const t = `Paid. ${money(d.totalMinor)} is held, not charged, until your pickup is verified. Your pickup pass is ready.`;
        add({ who: "stoop", text: t });
        return t;
      }
      add({ who: "stoop", text: r.text || (r.isError ? "That didn’t work." : "Done.") });
      return r.text;
    },
    [add, o.role],
  );

  const run = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      const r = await tool(o.shop, o.role, o.token, name, args);
      const spoken = absorb(name, r);
      o.onChange?.();
      return { r, spoken };
    },
    [absorb, o],
  );

  /** One turn from free text (typed or spoken). */
  const say = useCallback(
    async (utterance: string, aloud = false) => {
      const u = utterance.trim();
      if (!u || busy) return;
      add({ who: "me", text: u });
      setBusy(true);
      const spoken: string[] = [];
      try {
        if (!tools.current) tools.current = (await listTools(o.shop, o.role, o.token)).filter((t) => ALLOW[o.role].has(t.name));
        const plan = await request<{ calls?: Array<{ name: string; args?: Record<string, unknown> }>; say?: string }>(`${base(o.shop)}/planner/turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ utterance: u, state: { role: o.role, ...ctx.current, pendingApprovalId: approval?.id, pendingOfferApprovalId: pendingOffer.current }, tools: tools.current }),
        });
        const calls = (plan.calls ?? []).filter((c) => ALLOW[o.role].has(c.name));
        if (!calls.length) {
          const t = plan.say ?? "I can help with offers, questions about the item and paying for it.";
          add({ who: "stoop", text: t });
          spoken.push(t);
        }
        for (const c of calls) {
          if (c.name === "confirm_action") setApproval(undefined);
          const { r, spoken: s } = await run(c.name, c.args ?? {});
          spoken.push(s);
          if (r.data.kind === "approval_required" || r.isError) break;
        }
      } catch (e) {
        add({ who: "stoop", text: e instanceof ApiError ? e.message : "Sorry, that didn’t go through. Try again." });
      } finally {
        setBusy(false);
      }
      if (aloud) speak(spoken.join(" "));
    },
    [add, approval, busy, o.role, o.shop, o.token, run],
  );

  const answer = useCallback(
    async (decision: "accept" | "decline", code?: string) => {
      if (!approval) return;
      setBusy(true);
      try {
        const r = await tool(o.shop, o.role, o.token, "confirm_action", { approvalId: approval.id, decision, ...(code ? { voiceCode: code } : {}) });
        setApproval(undefined);
        absorb("confirm_action", r);
        o.onChange?.();
        return r;
      } catch (e) {
        add({ who: "stoop", text: e instanceof ApiError ? e.message : "That didn’t go through. Try again." });
      } finally {
        setBusy(false);
      }
    },
    [absorb, add, approval, o],
  );

  return { lines, add, say, run, approval, setApproval, answer, busy, setBusy };
}

const ladderLast = (d: Record<string, any>) => (d.ladder?.length ? d.ladder[d.ladder.length - 1].amountMinor : d.askMinor);

export function Thread({ lines, sellerName = "Seller’s assistant" }: { lines: Line[]; sellerName?: string }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [lines.length]);
  if (!lines.length) return null;
  return (
    <div className="thread" role="log" aria-live="polite" aria-label="Conversation">
      {lines.map((l, i) => (
        <div key={i} className={`msg${l.who === "me" ? " me" : ""}`}>
          {l.text}
          {l.who !== "me" ? <div className="meta">{l.who === "seller" ? sellerName : "Stoop"}</div> : null}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

export function Composer({ onSay, busy, placeholder, label }: { onSay(t: string, aloud: boolean): void; busy: boolean; placeholder: string; label: string }) {
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const stop = useRef<() => void>(undefined);
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        onSay(text, false);
        setText("");
      }}
    >
      <label className="sr-only" htmlFor="composer">
        {label}
      </label>
      <input id="composer" className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} autoComplete="off" enterKeyHint="send" disabled={busy} />
      {speechSupported() ? (
        <button
          type="button"
          className="icon-btn"
          aria-label={listening ? "Stop listening" : "Speak instead"}
          aria-pressed={listening}
          onClick={() => {
            if (listening) {
              stop.current?.();
              return;
            }
            stopSpeaking();
            setListening(true);
            stop.current = listenOnce(
              (t) => onSay(t, true),
              () => setListening(false),
            );
          }}
        >
          <Mic />
        </button>
      ) : null}
      <button type="submit" className="icon-btn" aria-label="Send" disabled={busy || !text.trim()}>
        <Send />
      </button>
    </form>
  );
}

/** An approval the assistant is waiting on. */
export function ApprovalPrompt({ a, busy, onAnswer, codeError }: { a: Approval; busy: boolean; onAnswer(d: "accept" | "decline", code?: string): void; codeError?: string }) {
  const [code, setCode] = useState("");
  const total = a.card?.totalMinor as number | undefined;
  return (
    <form
      className="note warn stack-s"
      onSubmit={(e) => {
        e.preventDefault();
        onAnswer("accept", a.needsCode ? code : undefined);
      }}
    >
      {a.card?.kind === "checkout" ? (
        <dl className="stack-s num" style={{ margin: 0 }}>
          <div className="spread">
            <dt>{a.card.title}</dt>
            <dd style={{ margin: 0 }}>{money(a.card.itemMinor)}</dd>
          </div>
          <div className="spread">
            <dt>Verified pickup</dt>
            <dd style={{ margin: 0 }}>{money(a.card.feeMinor)}</dd>
          </div>
          <div className="spread">
            <dt>Tax</dt>
            <dd style={{ margin: 0 }}>{money(a.card.taxMinor ?? 0)}</dd>
          </div>
          <div className="spread" style={{ fontWeight: 800 }}>
            <dt>Total</dt>
            <dd style={{ margin: 0 }}>{money(a.card.totalMinor)}</dd>
          </div>
          <p className="meta">
            Held, not charged, until your pickup is verified. If it isn’t, you’re never charged.{" "}
            {a.card.refundPolicyUrl ? (
              <a href={a.card.refundPolicyUrl} target="_blank" rel="noreferrer">
                Refund policy
              </a>
            ) : null}
          </p>
        </dl>
      ) : (
        <p style={{ fontWeight: 600 }}>{a.summary}</p>
      )}
      {a.needsCode ? (
        <label className="field">
          <span>Your 4-digit purchase code</span>
          <input className="input" inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} style={{ maxWidth: "10ch" }} required />
          <small>Purchases over $100 need it, like on a voice assistant.</small>
        </label>
      ) : null}
      {codeError ? (
        <p className="err" role="alert">
          {codeError}
        </p>
      ) : null}
      <div className="row">
        <button className="btn" type="submit" disabled={busy || (a.needsCode && code.length !== 4)}>
          {total ? `Pay ${money(total)}` : "Approve"}
        </button>
        <button className="btn quiet" type="button" disabled={busy} onClick={() => onAnswer("decline")}>
          Cancel
        </button>
      </div>
    </form>
  );
}
