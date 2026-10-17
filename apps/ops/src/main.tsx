import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const STACK = (import.meta.env.VITE_STACK_URL as string | undefined) ?? "http://localhost:8787";

interface Ev {
  type: string;
  at: number;
  dealId?: string;
  [k: string]: any;
}

const $ = (m?: number) => (m === undefined ? "–" : `$${(m / 100).toFixed(m % 100 ? 2 : 0)}`);
const tm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const LABEL: Record<string, (e: Ev) => string> = {
  mcp_rpc: (e) => `MCP ${e.role} · ${e.method}${e.tool ? ` ${e.tool}` : ""}`,
  planner_turn: (e) => `planner (${e.planner}) → ${e.calls?.join(", ") || "speech"}`,
  appraisal_done: (e) => `appraised ${e.count} items · ${$(e.totalMinor)}`,
  listing_live: (e) => `listing live · ${e.title} ${$(e.askMinor)}`,
  offer_received: (e) => `offer ${$(e.amountMinor)}`,
  counter_sent: (e) => `counter ${$(e.amountMinor)}`,
  approval_requested: (e) => `approval requested · ${e.summary}`,
  deal_created: (e) => `deal · ${e.title} ${$(e.amountMinor)}`,
  deal_state: (e) => `deal ${e.from} → ${e.to}`,
  funds_held: (e) => `funds held ${$(e.amountMinor)} · ${e.psp}`,
  ucp_call: (e) => `UCP ${e.method} ${e.path} → ${e.status}`,
  pass_issued: () => `pickup pass issued (code sent by email)`,
  window_opened: () => `pickup window open`,
  frame_needed: (e) => `frame needed · ${e.kind}`,
  frame_assessed: (e) => `frame ${e.kind}: ${e.presence} · ${e.adapter} · ${e.origin}`,
  ring_webhook: (e) => `Ring webhook ${e.kind}${e.subType ? `/${e.subType}` : ""} · ${e.origin === "simulator" ? "simulator-signed" : "Ring-signed"}`,
  buyer_checked_in: () => `buyer tapped I'm here (P)`,
  handoff_evaluated: (e) => `truth table → ${e.verdict} · P:${b(e.signals?.P)} D:${b(e.signals?.D)} B:${b(e.signals?.B)} · ${e.reasons?.join(", ")}`,
  receipt_signed: (e) => `receipt signed (ES256) · ${e.receiptId}`,
  handoff_verified: () => `PICKUP VERIFIED`,
  sale_completed: (e) => `SOLD · payout ${$(e.payoutMinor)} (test ledger)`,
  piracy_alert: () => `PIRACY ALERT · no money moved`,
  hold_voided: (e) => `hold voided · ${e.reason}`,
  no_show: () => `no-show · relisted`,
  ring_webhook_bad_signature: () => `REJECTED webhook · bad signature`,
  ring_webhook_stale: () => `REJECTED webhook · stale timestamp`,
  sim_scenario: (e) => `scenario ${e.scenario} (simulator)`,
  sim_scene: (e) => `camera scene → ${e.scene} (simulator)`,
  email_outbox: (e) => `email → ${e.to}: ${e.subject}`,
};
const b = (x: boolean | undefined) => (x ? "✓" : "·");
const QUIET = new Set(["policy_decision", "negotiation_opened", "frame_recorded", "approval_resolved", "listing_drafted", "mandate_set", "pass_bound", "ring_event_matched"]);

function App() {
  const [events, setEvents] = useState<Ev[]>([]);
  const [state, setState] = useState<any>();
  const [selected, setSelected] = useState<string>();
  const [scenarioLog, setScenarioLog] = useState<string[]>([]);
  const [ringToken, setRingToken] = useState("");
  const [devices, setDevices] = useState<any[]>([]);
  const [ringMsg, setRingMsg] = useState<string>();
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const es = new EventSource(`${STACK}/ops/events`);
    es.addEventListener("stoop", (ev) => setEvents((x) => [...x.slice(-400), JSON.parse((ev as MessageEvent).data)]));
    return () => es.close();
  }, []);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await (await fetch(`${STACK}/ops/state`)).json();
        if (alive) setState(s);
      } catch {
        /* stack down */
      }
    };
    void load();
    const i = setInterval(load, 1500);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, []);

  const deals = useMemo(() => [...(state?.deals ?? [])].sort((a: any, b: any) => b.updatedAt - a.updatedAt), [state]);
  const deal = deals.find((d: any) => d.id === selected) ?? deals[0];
  const evidence = state?.evidence?.find((e: any) => e.dealId === deal?.id);
  const decisions = state?.decisions ?? [];

  const post = async (path: string, body: unknown = {}) => {
    const r = await fetch(`${STACK}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return r.json().catch(() => ({}));
  };
  const scenario = async (name: string) => {
    const r = await post(`/sim/scenario/${name}`, { dealId: deal?.id });
    setScenarioLog([`▶ ${name}${r.state ? ` → ${r.state}` : ""}`, ...(r.log ?? [r.message ?? JSON.stringify(r)])]);
  };

  const liveView = async (deviceId: string) => {
    setRingMsg("Starting live view…");
    try {
      const pc = new RTCPeerConnection();
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      pc.ontrack = (e) => {
        if (video.current) video.current.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      };
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => setTimeout(r, 800)); // gather candidates
      const res = await fetch(`${STACK}/ring/whep/${encodeURIComponent(deviceId)}`, { method: "POST", headers: { "Content-Type": "application/sdp" }, body: pc.localDescription!.sdp });
      if (!res.ok) throw new Error(`WHEP ${res.status}`);
      await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
      setRingMsg("Live: Ring Developer Playground stream");
    } catch (e) {
      setRingMsg(`Live view failed: ${String(e)} (logged in the friction log)`);
    }
  };

  return (
    <div className="ops">
      <header className="bar">
        <h1>Stoop · mission control</h1>
        <div className="chips">
          <Chip k="LLM" v={state?.llmMode ?? "–"} />
          <Chip k="vision" v={state?.vision ?? "–"} />
          <Chip k="appraiser" v={state?.appraiser ?? "–"} />
          <Chip k="payments" v={state?.psp ?? "–"} />
          <Chip k="camera" v={state?.frameSource === "our_footage" ? "our footage / simulator" : state?.frameSource ?? "–"} />
          <Chip k="Ring API" v={state?.ringConfigured ? "token set" : "no token"} />
        </div>
      </header>

      <div className="cols">
        <section className="col feed">
          <h2>Live events</h2>
          <ol>
            {[...events].reverse().filter((e) => !QUIET.has(e.type)).slice(0, 160).map((e, i) => (
              <li key={i} className={cls(e)}>
                <span className="t num">{tm(e.at)}</span>
                <span>{(LABEL[e.type] ?? ((x: Ev) => x.type.replace(/_/g, " ")))(e)}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="col center">
          <h2>Deal</h2>
          {deals.length > 1 && (
            <select value={deal?.id} onChange={(e) => setSelected(e.target.value)} aria-label="Select deal">
              {deals.map((d: any) => (
                <option key={d.id} value={d.id}>
                  {d.itemTitle} · {d.state}
                </option>
              ))}
            </select>
          )}
          {deal ? (
            <div className="deal">
              <div className="dealhead">
                <div>
                  <p className="eyebrow">{deal.id}</p>
                  <h3>{deal.itemTitle}</h3>
                </div>
                <div className={`state s-${deal.state}`}>{deal.state.replace(/_/g, " ")}</div>
              </div>
              <div className="kv">
                <span>Price</span>
                <span className="num">{$(deal.amountMinor)}</span>
                <span>Window</span>
                <span className="num">{deal.window ? `${tm(deal.window.start)} – ${tm(deal.window.end)}` : "–"}</span>
                <span>Verdict</span>
                <span className="num">{deal.verdict ?? "–"}</span>
                <span>Receipt</span>
                <span>{deal.receiptIds?.length ? <a href={`${STACK}/verify/${deal.receiptIds.at(-1)}`} target="_blank" rel="noreferrer">verify ↗</a> : "–"}</span>
              </div>
              <div className="frames">
                {(["before", "after"] as const).map((k) => (
                  <figure key={k}>
                    {/* only request a frame once its evidence exists; before that the route 404s */}
                    {evidence?.[k] && (
                      <img src={`${STACK}/ops/frame/${deal.id}/${k}?t=${evidence[k].at}`} alt={`${k} frame`} onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} onLoad={(e) => ((e.target as HTMLImageElement).style.visibility = "visible")} />
                    )}
                    <figcaption>
                      {k} · {evidence?.[k] ? `${evidence[k].presence} · ${evidence[k].origin === "our_footage" ? "our footage" : evidence[k].origin}` : "–"}
                    </figcaption>
                  </figure>
                ))}
              </div>
              <ol className="history">
                {deal.history.slice(-10).map((h: any, i: number) => (
                  <li key={i}>
                    <span className="num t">{tm(h.at)}</span> {h.state} <span className="muted">{h.event}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="muted">No deals yet. Use the two simulated Alexa+ devices to sell and buy something.</p>
          )}

          <h2>Scenarios <span className="muted small">simulator · labelled</span></h2>
          <div className="btns">
            {["golden", "piracy", "still_there", "no_show", "camera_offline", "replay_attack"].map((s) => (
              <button key={s} onClick={() => void scenario(s)}>
                {s.replace(/_/g, " ")}
              </button>
            ))}
          </div>
          <div className="btns small-btns">
            <span className="muted small">camera scene</span>
            {["item_present", "item_absent", "unclear", "offline"].map((s) => (
              <button key={s} onClick={() => void post("/sim/scene", { scene: s })}>
                {s.replace("item_", "")}
              </button>
            ))}
            <span className="muted small">ring event</span>
            <button onClick={() => void post("/sim/ring-event", { type: "button_press" })}>doorbell</button>
            <button onClick={() => void post("/sim/ring-event", { type: "motion_detected", subType: "human" })}>person</button>
            <button onClick={() => void post("/sim/ring-event", { type: "motion_detected", subType: "vehicle" })}>vehicle</button>
          </div>
          {scenarioLog.length > 0 && (
            <pre className="log">{scenarioLog.join("\n")}</pre>
          )}
        </section>

        <section className="col right">
          <h2>Policy Kernel</h2>
          <ol className="decisions">
            {decisions.slice(0, 40).map((d: any) => (
              <li key={d.id} className={d.outcome}>
                <span className="stamp">{d.outcome === "allow" ? "ALLOW" : d.outcome === "deny" ? "DENIED" : "ASK"}</span>
                <span className="num rules">{d.ruleIds.join(" ")}</span>
                <span className="act">{d.action.replace(/_/g, " ")}</span>
                <span className="muted why">{d.reasons.join(", ")}</span>
              </li>
            ))}
          </ol>

          <h2>Email outbox <span className="muted small">demo · SES in AWS</span></h2>
          <ul className="outbox">
            {(state?.outbox ?? []).map((o: any) => (
              <li key={o.passId}>
                Pickup pass code <span className="num code">{o.otp}</span> <span className="muted small">{o.passId}</span>
              </li>
            ))}
          </ul>

          <h2>Ring Developer Playground</h2>
          <form
            className="ring"
            onSubmit={async (e) => {
              e.preventDefault();
              await post("/ring/token", { token: ringToken });
              const r = await (await fetch(`${STACK}/ring/devices`)).json();
              setDevices(r.devices ?? []);
              setRingMsg(r.message ?? `${r.devices?.length ?? 0} device(s)`);
            }}
          >
            <input type="password" placeholder="Paste a Playground token (30-min)" value={ringToken} onChange={(e) => setRingToken(e.target.value)} aria-label="Ring Playground token" />
            <button>Connect</button>
          </form>
          {devices.map((d) => (
            <div key={d.id} className="device">
              <span>{d.name ?? d.id}</span>
              <button onClick={() => void liveView(d.id)}>Live view</button>
            </div>
          ))}
          {ringMsg && <p className="muted small">{ringMsg}</p>}
          <video ref={video} autoPlay muted playsInline className="live" />
        </section>
      </div>
    </div>
  );
}

function cls(e: Ev) {
  if (/verified|sale_completed/.test(e.type)) return "good";
  if (/piracy|REJECTED|bad_signature|stale|no_show|voided|error/.test(e.type)) return "bad";
  if (/ring_webhook|frame_assessed|handoff_evaluated/.test(e.type)) return "ring";
  return "";
}

function Chip({ k, v }: { k: string; v: string }) {
  return (
    <span className="chip">
      <span className="k">{k}</span> {v}
    </span>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
