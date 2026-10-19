// The assistant conversation. What you type or say goes to the same planner and MCP tools an Alexa+
// device uses. When a tool needs your yes, the server asks mid-call (MCP elicitation) and the
// question shows up here; your tap (and purchase code, when a purchase needs one) is the answer.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, base, listTools, money, request, tool, type Approval, type ApprovalAnswer, type ToolResult } from "./api.ts";
import { Mic, Send, Spark } from "./icons.tsx";
import { listenOnce, speak, speechSupported, stopSpeaking } from "./voice.ts";

export interface Line {
  who: "me" | "seller" | "stoop";
  text: string;
  at: number;
}
export interface PlannerContext {
  activeListingId?: string;
  lastListingIds?: string[];
  activeDealId?: string;
}
interface Pending {
  ask: Approval;
  resolve(a: ApprovalAnswer): void;
}

/** Tools the assistant may use on a page (photos and the pickup pass have their own buttons). */
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
  const [pending, setPending] = useState<Pending>();
  const [busy, setBusy] = useState(false);
  const tools = useRef<Awaited<ReturnType<typeof listTools>>>(undefined);
  const ctx = useRef(o.context);
  ctx.current = { ...ctx.current, ...o.context };
  const pendingOffer = useRef<string>(undefined);
  const onChange = useRef(o.onChange);
  onChange.current = o.onChange;

  useEffect(() => {
    localStorage.setItem(o.storeKey, JSON.stringify(lines.slice(-60)));
  }, [lines, o.storeKey]);

  const add = useCallback((l: Omit<Line, "at">) => setLines((x) => [...x, { ...l, at: Date.now() }]), []);

  /** A tool asked for a person's yes: show it and wait for their tap. */
  const approver = useCallback((ask: Approval) => new Promise<ApprovalAnswer>((resolve) => setPending({ ask, resolve })), []);

  /** Show a tool result in the conversation; returns what was said. */
  const absorb = useCallback(
    (r: ToolResult) => {
      const d = r.data;
      if (d.kind === "negotiation") {
        ctx.current.activeListingId = d.listingId;
        if (d.dealId) ctx.current.activeDealId = d.dealId;
        add({ who: "seller", text: d.reply ?? r.text });
        if (d.action === "accepted") add({ who: "stoop", text: `Accepted at ${money(d.ladder?.at(-1)?.amountMinor ?? d.askMinor)}. Pay below to reserve it.` });
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

  /** Call one tool; any approval it asks for appears in this conversation. */
  const run = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      try {
        const r = await tool(o.shop, o.role, o.token, name, args, approver);
        const spoken = absorb(r);
        onChange.current?.();
        return { r, spoken };
      } finally {
        setPending(undefined);
      }
    },
    [absorb, approver, o.role, o.shop, o.token],
  );

  /** One turn from free text (typed or spoken), planned by the same planner an Alexa+ device uses. */
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
          body: JSON.stringify({ utterance: u, state: { role: o.role, ...ctx.current, pendingOfferApprovalId: pendingOffer.current }, tools: tools.current }),
        });
        const calls = (plan.calls ?? []).filter((c) => ALLOW[o.role].has(c.name));
        if (!calls.length) {
          const t = plan.say ?? "I can check offers, list things, set your lowest price and follow a sale.";
          add({ who: "stoop", text: t });
          spoken.push(t);
        }
        for (const c of calls) {
          const { r, spoken: s } = await run(c.name, c.args ?? {});
          spoken.push(s);
          if (r.isError) break;
        }
      } catch (e) {
        add({ who: "stoop", text: e instanceof ApiError ? e.message : "Sorry, that didn’t go through. Try again." });
      } finally {
        setBusy(false);
      }
      if (aloud) speak(spoken.join(" "));
    },
    [add, busy, o.role, o.shop, o.token, run],
  );

  const answer = useCallback(
    (decision: "accept" | "decline", code?: string) => {
      if (!pending) return;
      pending.resolve(decision === "accept" ? { action: "accept", content: { confirm: true, ...(code ? { voiceCode: code } : {}) } } : { action: "decline", content: { confirm: false } });
      setPending(undefined);
    },
    [pending],
  );

  return { lines, add, say, run, pending: pending?.ask, answer, busy, setBusy };
}

export function Thread({ lines, typing, sellerName = "Seller’s assistant" }: { lines: Line[]; typing?: boolean; sellerName?: string }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [lines.length, typing]);
  if (!lines.length && !typing) return null;
  return (
    <div className="chat" role="log" aria-live="polite" aria-label="Conversation">
      {lines.map((l, i) => (
        <div key={i} className={`bubble-row${l.who === "me" ? " me" : ""}`}>
          {l.who !== "me" ? (
            <span className={`avatar${l.who === "stoop" ? " sun" : ""}`} aria-hidden="true">
              {l.who === "seller" ? "AI" : <Spark width={16} height={16} />}
            </span>
          ) : null}
          <div className="bubble">
            {l.text}
            {l.who !== "me" ? <span className="who">{l.who === "seller" ? sellerName : "Stoop"}</span> : null}
          </div>
        </div>
      ))}
      {typing ? (
        <div className="bubble-row">
          <span className="avatar" aria-hidden="true">
            AI
          </span>
          <span className="typing" aria-label="Typing">
            <i />
            <i />
            <i />
          </span>
        </div>
      ) : null}
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
      <input id="composer" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} autoComplete="off" enterKeyHint="send" disabled={busy} />
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
          <Mic width={22} height={22} />
        </button>
      ) : null}
      <button type="submit" className="icon-btn send" aria-label="Send" disabled={busy || !text.trim()}>
        <Send width={22} height={22} />
      </button>
    </form>
  );
}

/** A question a tool is waiting on (MCP elicitation): what's being approved, and the yes or no. */
export function ApprovalPrompt({ a, onAnswer, codeError }: { a: Approval; onAnswer(d: "accept" | "decline", code?: string): void; codeError?: string }) {
  const [code, setCode] = useState("");
  const card = a.card;
  const checkout = card?.kind === "checkout";
  return (
    <form
      className="card attn stack"
      onSubmit={(e) => {
        e.preventDefault();
        onAnswer("accept", a.needsCode ? code : undefined);
      }}
    >
      {checkout ? (
        <>
          <h3>Review and pay</h3>
          <dl className="stack-s num" style={{ margin: 0 }}>
            {[
              [card.title, money(card.itemMinor)],
              ["Verified pickup", money(card.feeMinor)],
              ["Tax", money(card.taxMinor ?? 0)],
            ].map(([k, v]) => (
              <div key={k} className="spread">
                <dt className="muted">{k}</dt>
                <dd style={{ margin: 0 }}>{v}</dd>
              </div>
            ))}
            <div className="spread" style={{ paddingTop: 10, borderTop: "1px solid var(--line)" }}>
              <dt style={{ fontWeight: 700 }}>Total</dt>
              <dd className="price" style={{ margin: 0, fontSize: "var(--t-l)" }}>
                {money(card.totalMinor)}
              </dd>
            </div>
          </dl>
          <p className="tiny">
            Held, not charged, until your pickup is verified. If it isn’t, you’re never charged.{" "}
            {card.refundPolicyUrl ? (
              <a href={card.refundPolicyUrl} target="_blank" rel="noreferrer">
                Refund policy
              </a>
            ) : null}
          </p>
        </>
      ) : (
        <p style={{ fontWeight: 600 }}>{a.message}</p>
      )}
      {a.needsCode ? (
        <label className="field">
          <span className="label">Your 4-digit purchase code</span>
          <input className="input" inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} style={{ maxWidth: "10ch" }} required />
          <span className="hint">Purchases over $100 need it, like on a voice assistant.</span>
        </label>
      ) : null}
      {codeError ? (
        <p className="err" role="alert">
          {codeError}
        </p>
      ) : null}
      <div className="row">
        <button className="btn lg" type="submit" disabled={a.needsCode && code.length !== 4}>
          {checkout ? `Pay ${money(card.totalMinor)}` : "Approve"}
        </button>
        <button className="btn ghost lg" type="button" onClick={() => onAnswer("decline")}>
          Cancel
        </button>
      </div>
    </form>
  );
}
