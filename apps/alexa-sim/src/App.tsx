import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { connectMcp, resultText, type ElicitPrompt, type Mcp, type RpcLog } from "./mcp.ts";
import { mountCard } from "./host.ts";
import { listenOnce, speak, speechSupported, stopSpeaking } from "./voice.ts";

// Hosted sandboxes inject window.__STOOP__ (the visitor's own stack under /s/<id>); local dev uses :8787
const RT = (window as unknown as { __STOOP__?: { stack?: string; public?: boolean } }).__STOOP__;
const STACK = RT?.stack ? new URL(RT.stack, location.origin).href.replace(/\/$/, "") : ((import.meta.env.VITE_STACK_URL as string | undefined) ?? "http://localhost:8787");
const params = new URLSearchParams(location.search);
const ROLE = (params.get("role") === "buyer" ? "buyer" : "seller") as "seller" | "buyer";
const BUYER_INDEX = Number(params.get("buyer") ?? 0);

type Mode = "idle" | "listening" | "thinking" | "speaking";

interface PlannerState {
  role: "seller" | "buyer";
  lastListingIds?: string[];
  activeListingId?: string;
  activeDealId?: string;
  pendingApprovalId?: string;
  pendingOfferApprovalId?: string;
}

interface Decision {
  id: string;
  outcome: string;
  action: string;
  ruleIds: string[];
  reasons: string[];
  at: number;
}

const HINTS = {
  seller: ["Price my things", "Sell the stroller and the bike. Don't go below $90 on the stroller.", "Pickups work in the evening", "What offers do I have?", "How's my sale going?"],
  buyer: ["Find me a jogging stroller under $100 nearby", "Would they take $70?", "Okay, how about $95?", "Check out", "Send my pickup pass"],
};

export function App() {
  const [mcp, setMcp] = useState<Mcp>();
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState<Mode>("idle");
  const [reply, setReply] = useState<string>(ROLE === "seller" ? "Hi. Show me what you'd like to sell, or say: price my things." : "Hi. What are you looking for?");
  const [you, setYou] = useState<string>("");
  const [typed, setTyped] = useState("");
  const [elicit, setElicit] = useState<ElicitPrompt>();
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<string>();
  const [devOpen, setDevOpen] = useState(params.get("dev") === "1");
  const [rpc, setRpc] = useState<RpcLog[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [task, setTask] = useState<{ id: string; status: string; lines: Array<{ at: number; text: string }> }>();
  const [count, setCount] = useState(0);
  const [hasCard, setHasCard] = useState(false);
  const [token, setToken] = useState<string>();
  const state = useRef<PlannerState>({ role: ROLE });
  const cardBox = useRef<HTMLDivElement>(null);
  const cardHandle = useRef<ReturnType<typeof mountCard> | undefined>(undefined);
  const elicitRef = useRef<ElicitPrompt | undefined>(undefined);
  elicitRef.current = elicit;

  // ---------- connect
  useEffect(() => {
    (async () => {
      try {
        const cfg = await (await fetch(`${STACK}/api/config`)).json();
        const tok = ROLE === "seller" ? cfg.sellerToken : cfg.buyerTokens[BUYER_INDEX]?.token;
        setToken(tok);
        const m = await connectMcp({
          base: STACK,
          role: ROLE,
          token: tok,
          onLog: (l) =>
            setRpc((x) => {
              const i = [x.length - 1, x.length - 2].find((k) => k >= 0 && x[k]!.dir === l.dir && x[k]!.summary === l.summary);
              if (i === undefined) return [...x.slice(-200), l];
              const y = [...x];
              y[i] = { ...y[i]!, at: l.at, repeat: (y[i]!.repeat ?? 1) + 1 };
              return y;
            }),
          onElicit: (p) => {
            setCode("");
            setElicit(p);
            speak(p.mode === "url" ? p.message : `${p.message} Say yes to approve${p.fields.some((f) => f.name === "voiceCode") ? ", and say your four digit code" : ""}.`);
          },
        });
        setMcp(m);
      } catch (e) {
        setError(`Can't reach the Stoop stack at ${STACK}. Start it with: pnpm demo`);
        console.error(e);
      }
    })();
  }, []);

  // ---------- notifications (proactive offers, deals, verified...)
  useEffect(() => {
    if (!token) return;
    const es = new EventSource(`${STACK}/notify/stream?token=${encodeURIComponent(token)}`);
    es.addEventListener("notification", (ev) => {
      const n = JSON.parse((ev as MessageEvent).data);
      if (n.kind === "offer") state.current.pendingOfferApprovalId = n.data.approvalId;
      if (n.kind === "deal" || n.kind === "pass") state.current.activeDealId = n.data.dealId;
      setNotice(n.text);
      setReply(n.text);
      setMode("speaking");
      speak(n.text, () => setMode("idle"));
    });
    return () => es.close();
  }, [token]);

  // ---------- policy decisions for the developer view (only while it's open: browsers allow
  // 6 connections per host, and every open SSE stream holds one)
  useEffect(() => {
    if (!devOpen) return;
    const es = new EventSource(`${STACK}/ops/events`);
    es.addEventListener("stoop", (ev) => {
      const e = JSON.parse((ev as MessageEvent).data);
      if (e.type === "policy_decision") setDecisions((x) => [...x.slice(-60), e.decision]);
    });
    return () => es.close();
  }, [devOpen]);

  const showCard = useCallback(
    async (toolName: string, args: Record<string, unknown>, res: CallToolResult) => {
      const uri = (res._meta as any)?.ui?.resourceUri as string | undefined;
      if (!uri || !mcp || !cardBox.current) return;
      const html = await mcp.cardHtml(uri);
      cardHandle.current?.destroy();
      cardHandle.current = mountCard(cardBox.current, {
        proxyUrl: `${STACK}/sandbox/proxy.html`,
        html,
        toolName,
        toolInput: args,
        toolResult: res,
        callTool: async (name, a) => {
          const r = await mcp.call(name, a);
          absorb(r);
          const t = resultText(r);
          setReply(t);
          speak(t);
          return r;
        },
        visibility: (n) => mcp.toolVisibility(n),
        readResource: (u) => mcp.client.readResource({ uri: u }),
        onMessage: (t) => void turn(t),
        onSize: () => {},
        log: (l) => setRpc((x) => [...x.slice(-200), { dir: "in", at: Date.now(), summary: l }]),
        width: cardBox.current.clientWidth,
      });
      setHasCard(true);
    },
    [mcp],
  );

  function absorb(r: CallToolResult) {
    const s = (r.structuredContent ?? {}) as any;
    const st = state.current;
    if (s.kind === "search_results" && s.results?.length) {
      st.lastListingIds = s.results.map((x: any) => x.listingId);
      st.activeListingId = s.results[0].listingId;
    }
    if (s.kind === "negotiation") {
      st.activeListingId = s.listingId;
      if (s.dealId) st.activeDealId = s.dealId;
    }
    if (s.kind === "deal" && s.dealId) st.activeDealId = s.dealId;
    if (s.kind === "approval_required") st.pendingApprovalId = s.pendingActionId;
    if (s.kind === "offers" && s.offers?.length) st.pendingOfferApprovalId = s.offers[0].approvalId;
    if (s.kind === "deal" || s.kind === "offer_declined") st.pendingOfferApprovalId = undefined;
  }

  // ---------- one conversational turn
  const turn = useCallback(
    async (utterance: string) => {
      const u = utterance.trim();
      if (!u) return;
      if (!mcp) {
        setReply("Still connecting to Stoop. One moment.");
        return;
      }
      // While an approval prompt is open, the voice answers it.
      const open = elicitRef.current;
      if (open) {
        const digits = u.replace(/\D/g, "").slice(0, 4);
        if (/^(yes|yeah|yep|approve|confirm|sure|ok|okay|do it)/i.test(u) || digits.length === 4) {
          answer(open, "accept", digits.length === 4 ? digits : undefined);
          return;
        }
        if (/^(no|nope|decline|cancel|stop)/i.test(u)) {
          answer(open, "decline");
          return;
        }
      }
      stopSpeaking();
      setNotice(undefined);
      setYou(u);
      setCount((c) => c + 1);
      setMode("thinking");
      try {
        const tools = mcp.tools.filter((t) => ((t._meta as any)?.ui?.visibility ?? ["model", "app"]).includes("model")).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
        // one retry on a transient proxy error (a CDN can answer with an HTML 502 page); never parse that as JSON
        const askPlanner = async () => {
          for (let attempt = 0; attempt < 2; attempt++) {
            const r = await fetch(`${STACK}/planner/turn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ utterance: u, state: state.current, tools }) });
            if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) return r.json();
            await new Promise((res) => setTimeout(res, 500));
          }
          throw new Error("planner unavailable");
        };
        const plan = await askPlanner();
        const spoken: string[] = [];
        if (plan.say && !plan.calls?.length) spoken.push(plan.say);
        for (const c of plan.calls ?? []) {
          const res = await mcp.call(c.name, c.args ?? {});
          if (c.name === "confirm_action") state.current.pendingApprovalId = undefined;
          absorb(res);
          spoken.push(resultText(res));
          await showCard(c.name, c.args ?? {}, res);
        }
        const text = spoken.join(" ") || "Done.";
        setReply(text);
        setMode("speaking");
        speak(text, () => setMode("idle"));
      } catch (e) {
        setReply("Sorry, something went wrong. Try again.");
        setMode("idle");
        console.error(e);
      }
    },
    [mcp, showCard],
  );

  function answer(p: ElicitPrompt, action: "accept" | "decline", voiceCode?: string) {
    const content: Record<string, unknown> = { confirm: action === "accept" };
    if (p.fields.some((f) => f.name === "voiceCode")) {
      const c = voiceCode ?? code;
      if (action === "accept" && !/^\d{4}$/.test(c)) {
        speak("I need your four digit purchase code.");
        return;
      }
      content.voiceCode = c;
    }
    if (p.mode === "url" && action === "accept") window.open(p.url, "_blank", "noopener,width=430,height=860");
    p.resolve(p.mode === "url" ? { action } : { action, content });
    setElicit(undefined);
  }

  const mic = () => {
    if (!speechSupported()) return;
    stopSpeaking();
    setMode("listening");
    listenOnce(
      (t) => void turn(t),
      () => setMode((m) => (m === "listening" ? "idle" : m)),
    );
  };

  const uploadPhotos = async (files: FileList | null) => {
    if (!files?.length || !token) return;
    const photos = await Promise.all(
      [...files].slice(0, 8).map(
        (f) =>
          new Promise<{ name: string; dataUrl: string }>((resolve) => {
            const r = new FileReader();
            r.onload = () => resolve({ name: f.name, dataUrl: String(r.result) });
            r.readAsDataURL(f);
          }),
      ),
    );
    await fetch(`${STACK}/sweep`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ photos }) });
    await turn("Price my things");
  };
  const demoPhotos = async () => {
    if (!token) return;
    await fetch(`${STACK}/sweep/demo`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    await turn("Price my things");
  };

  const clock = useClock();
  const roomLabel = ROLE === "seller" ? "Seller's kitchen" : "Buyer's living room";

  // ---------- MCP Tasks: watch_handoff runs as a task; the device polls tasks/get (no server push here)
  const watchSale = async () => {
    if (!mcp) return;
    try {
      const created = await mcp.startTask("watch_handoff", {});
      setTask({ id: created.taskId, status: created.status, lines: [] });
    } catch (e) {
      setTask({ id: "-", status: "failed", lines: [{ at: Date.now(), text: e instanceof Error ? e.message : String(e) }] });
    }
  };
  useEffect(() => {
    if (!mcp || !task || task.id === "-" || !["working", "input_required"].includes(task.status)) return;
    const id = task.id;
    const poll = setInterval(async () => {
      const t = await mcp.taskStatus(id).catch(() => undefined);
      if (!t) return;
      let final: string | undefined;
      if (t.status === "completed") final = resultText(await mcp.taskResult(id).catch(() => ({ content: [] }) as never)) || undefined;
      setTask((cur) => {
        if (!cur || cur.id !== id) return cur;
        const lines = [...cur.lines];
        if (t.statusMessage && lines.at(-1)?.text !== t.statusMessage) lines.push({ at: Date.now(), text: t.statusMessage });
        if (final) lines.push({ at: Date.now(), text: `tasks/result: ${final}` });
        return { ...cur, status: t.status, lines };
      });
    }, 2500);
    return () => clearInterval(poll);
  }, [mcp, task?.id, task?.status]);

  // The hosted guided tour (same-origin parent page) drives this device through the same path as typing
  useEffect(() => {
    (window as unknown as { stoop?: unknown }).stoop = { ready: !!mcp, say: (t: string) => turn(t), demoPhotos: () => demoPhotos() };
  });

  return (
    <div className="page">
      <div className={`device ${notice ? "notify" : ""}`}>
        <div className={`lightbar ${mode}`} aria-hidden="true" />
        <header className="topline">
          <span className="room">{roomLabel}</span>
          <span className="sim-label">Simulated Alexa+ device · hackathon rules</span>
          <span className="time num">{clock}</span>
        </header>

        <main className="stage">
          <section className="voice">
            <p className="eyebrow">{mode === "listening" ? "Listening" : mode === "thinking" ? "Thinking" : mode === "speaking" ? "Speaking" : "Stoop"}</p>
            <p className="reply" aria-live="polite">{reply}</p>
            {you && <p className="you">You said: “{you}”</p>}
            {error && <p className="err">{error}</p>}
            {!hasCard && (
              <ul className="hints">
                {HINTS[ROLE].map((hnt) => (
                  <li key={hnt}>
                    <button onClick={() => void turn(hnt)}>{hnt}</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="cards">
            <div ref={cardBox} className="cardbox" />
            {!hasCard && <div className="empty">Cards from Stoop appear here.</div>}
            {elicit && (
              <div className="approve" role="dialog" aria-label="Approval needed">
                <p className="eyebrow">{elicit.mode === "url" ? "Open on your phone" : "Approval needed"}</p>
                <p className="approve-msg">{elicit.message}</p>
                {elicit.fields.map((f) => (
                  <label key={f.name} className="code">
                    {f.title}
                    <input inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} aria-label={f.title} />
                  </label>
                ))}
                <div className="approve-actions">
                  <button className="yes" onClick={() => answer(elicit, "accept")}>
                    {elicit.mode === "url" ? "Open pass" : "Approve"}
                  </button>
                  <button className="no" onClick={() => answer(elicit, "decline")}>
                    {elicit.mode === "url" ? "Not now" : "Decline"}
                  </button>
                </div>
                <p className="muted small">Or just say “yes”. {elicit.mode === "form" ? "Sent as an MCP elicitation (form mode)." : "Sent as an MCP URL elicitation: the link never enters the transcript."}</p>
              </div>
            )}
          </section>
        </main>

        <footer className="controls">
          <button className={`micbtn ${mode}`} onClick={mic} disabled={!speechSupported() || !mcp} aria-label="Talk">
            <span />
          </button>
          <form
            className="typebox"
            onSubmit={(e) => {
              e.preventDefault();
              void turn(typed);
              setTyped("");
            }}
          >
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={speechSupported() ? "Talk, or type here" : "Type what you'd say"} aria-label="Say something" />
          </form>
          {ROLE === "seller" && (
            <>
              <label className="ghost">
                Add photos
                <input type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => void uploadPhotos(e.target.files)} />
              </label>
              <button className="ghost" onClick={() => void demoPhotos()}>
                Demo photos
              </button>
            </>
          )}
          <span className="counter num" title="Spoken sentences this session">
            {count} sentence{count === 1 ? "" : "s"}
          </span>
          <button className="ghost" onClick={() => setDevOpen((d) => !d)} aria-pressed={devOpen}>
            Developer view
          </button>
        </footer>
      </div>

      {devOpen && (
        <aside className="dev">
          <h2>Developer view</h2>
          <p className="muted small">
            MCP {ROLE} endpoint · session {mcp?.sessionId()?.slice(0, 8) ?? "–"} · protocol 2025-11-25 · judges only, never shown to customers
          </p>
          {ROLE === "seller" && (
            <>
              <h3>MCP Tasks</h3>
              {task ? (
                <div className="task">
                  <p className="num small">
                    watch_handoff · task {task.id.slice(0, 8)} · <span className={`tstatus ${task.status}`}>{task.status}</span>
                  </p>
                  <ol className="tasklines">
                    {task.lines.length === 0 && <li className="muted">waiting for the first status…</li>}
                    {task.lines.map((l, i) => (
                      <li key={i}>
                        <span className="num">{new Date(l.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</span> {l.text}
                      </li>
                    ))}
                  </ol>
                  {["working", "input_required"].includes(task.status) ? (
                    <button className="ghost small" onClick={() => void mcp?.cancelTask(task.id).then(() => setTask({ ...task, status: "cancelled" }))}>
                      Cancel task
                    </button>
                  ) : (
                    <button className="ghost small" onClick={() => setTask(undefined)}>
                      Clear
                    </button>
                  )}
                </div>
              ) : (
                <button className="ghost small" onClick={() => void watchSale()} disabled={!mcp}>
                  Watch my sale as a task
                </button>
              )}
            </>
          )}
          <h3>Policy Kernel</h3>
          <ol className="decisions">
            {[...decisions].reverse().slice(0, 14).map((d) => (
              <li key={d.id} className={d.outcome}>
                <span className="stamp">{d.outcome === "allow" ? "ALLOW" : d.outcome === "deny" ? "DENIED" : "ASK"}</span>
                <span className="num">{d.ruleIds.join(" ")}</span>
                <span>{d.action}</span>
                <span className="muted">{d.reasons.join(", ")}</span>
              </li>
            ))}
          </ol>
          <h3>JSON-RPC</h3>
          <ol className="rpc">
            {[...rpc].reverse().slice(0, 60).map((l, i) => (
              <li key={i} className={l.dir}>
                <span className="num">{l.dir === "out" ? "→" : "←"}</span> {l.summary}
                {l.repeat ? <span className="num muted"> ×{l.repeat}</span> : null}
              </li>
            ))}
          </ol>
        </aside>
      )}
    </div>
  );
}

function useClock() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => {
    const i = setInterval(() => setT(new Date()), 15_000);
    return () => clearInterval(i);
  }, []);
  return useMemo(() => t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), [t]);
}
