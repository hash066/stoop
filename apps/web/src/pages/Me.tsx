import { useCallback, useState } from "react";
import { ApiError, clock, createProfile, joinShop, money, postJson, profile, request } from "../api.ts";
import { Bot, Check, Voice, Wallet } from "../icons.tsx";
import { initials, Link, navigate, Nav, Spinner, usePoll, useTitle } from "../ui.tsx";
import { SendAgent } from "./Street.tsx";

interface Want {
  id: string;
  query: string;
  maxMinor: number;
  zip?: string;
  status: "hunting" | "found" | "bought" | "stopped";
  log: Array<{ at: number; text: string }>;
  tries: Record<string, { state: string; shop: string; listingId: string; title: string; lastOfferMinor?: number; agreedMinor?: number }>;
}
interface Purchase {
  shop: string;
  shopName: string;
  dealId: string;
  listingId: string;
  title: string;
  state: string;
  totalMinor: number;
  passId: string | null;
}

const cfg = (window as { __STOOP__?: { alexaSkill?: boolean } }).__STOOP__ ?? {};
const PAID = ["FUNDS_HELD", "PASS_ISSUED", "WINDOW_OPEN", "STILL_THERE", "VERIFIED", "INSPECTION", "REVIEW", "DEGRADED", "DUAL_CONFIRMED"];
const stateWord = (s: string) =>
  PAID.includes(s) ? "Paid · pickup next" : ["CAPTURED", "PAYOUT_RECORDED", "CLOSED"].includes(s) ? "Picked up" : s === "AGREED" || s === "CHECKOUT_OPEN" ? "Agreed · pay to reserve" : "Didn’t happen";

export function Me() {
  useTitle("Your Stoop");
  const [p, setP] = useState(profile.get());
  const [data, setData] = useState<{ name: string; wants: Want[]; purchases: Purchase[] }>();
  const load = useCallback(async () => {
    if (!p.token) return;
    try {
      setData(await request("/api/profile", { headers: { Authorization: `Bearer ${p.token}` } }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        profile.clear();
        setP(profile.get());
      }
    }
  }, [p.token]);
  usePoll(load, 4000, [load]);

  return (
    <>
      <Nav
        right={
          <Link to="/street" className="btn sm">
            Browse the Street
          </Link>
        }
      />
      <main id="main" className="page" style={{ paddingBottom: 80 }}>
        {!p.token ? (
          <NewProfile onDone={() => setP(profile.get())} />
        ) : !data ? (
          <div className="section">
            <Spinner label="Loading…" />
          </div>
        ) : (
          <>
            <header className="app-head row" style={{ gap: 16, flexWrap: "nowrap" }}>
              <span className="avatar lg sun" aria-hidden="true">
                {initials(data.name)}
              </span>
              <div>
                <h1 style={{ fontSize: "var(--t-xl)" }}>Your Stoop</h1>
                <p className="muted small">{data.name} · your agents, your purchases, every shop on the street</p>
              </div>
            </header>
            <div className="grid-2">
              <div className="stack" style={{ ["--gap" as string]: "20px" }}>
                <section className="stack" aria-labelledby="agents-h">
                  <h2 id="agents-h" style={{ fontSize: "var(--t-l)" }}>
                    Your agents
                  </h2>
                  {data.wants.length ? (
                    data.wants.map((w) => <WantCard key={w.id} w={w} token={p.token} onChange={load} />)
                  ) : (
                    <p className="muted">No agents out yet. Send one with the form on this page: it watches the street and haggles for you.</p>
                  )}
                </section>
                <section className="stack" aria-labelledby="buys-h">
                  <h2 id="buys-h" style={{ fontSize: "var(--t-l)" }}>
                    Your purchases
                  </h2>
                  {data.purchases.length ? (
                    data.purchases.map((b) => <PurchaseRow key={b.dealId} b={b} />)
                  ) : (
                    <p className="muted">
                      Nothing yet. <Link to="/street">Browse the street</Link>.
                    </p>
                  )}
                </section>
              </div>
              <aside className="stack" style={{ ["--gap" as string]: "16px" }}>
                <SendAgent query="" zip={localStorage.getItem("stoop:zip") ?? ""} />
                {cfg.alexaSkill ? <VoiceShopping token={p.token} /> : null}
              </aside>
            </div>
          </>
        )}
      </main>
    </>
  );
}

function NewProfile({ onDone }: { onDone(): void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  return (
    <div className="section grid-2" style={{ ["--cols" as string]: "minmax(0, 1fr) minmax(0, 1fr)" }}>
      <div className="stack">
        <h1 style={{ fontSize: "var(--t-xl)" }}>Your Stoop</h1>
        <p className="lede">One place for every shop on the street: the agents you send out to haggle, your purchases and your pickup passes.</p>
      </div>
      <form
        className="card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim() || !/^\d{4}$/.test(code)) return setErr("Add your first name and choose a 4-digit purchase code.");
          try {
            await createProfile(name.trim(), code);
            onDone();
          } catch (e2) {
            setErr(e2 instanceof Error ? e2.message : "Couldn’t set that up. Try again.");
          }
        }}
      >
        <label className="field">
          <span className="label">Your first name</span>
          <input className="input" autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </label>
        <label className="field">
          <span className="label">Choose a 4-digit purchase code</span>
          <input className="input" inputMode="numeric" maxLength={4} autoComplete="off" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} style={{ maxWidth: "12ch" }} />
          <span className="hint">You’ll say or type it to approve purchases over $100. Stoop keeps only a scrambled copy.</span>
        </label>
        {err ? (
          <p className="err" role="alert">
            {err}
          </p>
        ) : null}
        <button className="btn lg" type="submit">
          Continue
        </button>
      </form>
    </div>
  );
}

function WantCard({ w, token, onChange }: { w: Want; token: string; onChange(): void }) {
  const deal = Object.values(w.tries).find((t) => t.state === "deal");
  const [busy, setBusy] = useState(false);
  const badge =
    w.status === "hunting" ? (
      <span className="badge sun">
        <span className="dot live" /> Hunting
      </span>
    ) : w.status === "found" ? (
      <span className="badge">Found a deal</span>
    ) : w.status === "bought" ? (
      <span className="badge">
        <Check /> Bought
      </span>
    ) : (
      <span className="badge gray">Stopped</span>
    );
  return (
    <article className={`card stack ${w.status === "found" ? "attn" : ""}`} aria-label={`Agent looking for ${w.query}`}>
      <div className="spread" style={{ alignItems: "flex-start" }}>
        <div className="row" style={{ gap: 12, flexWrap: "nowrap" }}>
          <span className="step-n">
            <Bot />
          </span>
          <div>
            <h3>{w.query}</h3>
            <p className="tiny">
              Up to {money(w.maxMinor)}
              {w.zip ? ` · near ${w.zip}` : ""}
            </p>
          </div>
        </div>
        {badge}
      </div>
      <ol className="stack-s" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="What your agent did">
        {w.log.slice(-5).map((l, i) => (
          <li key={i} className="row small" style={{ gap: 10, alignItems: "flex-start", flexWrap: "nowrap" }}>
            <span className="tiny num" style={{ flex: "none", minWidth: 62 }}>
              {clock(l.at)}
            </span>
            <span>{l.text}</span>
          </li>
        ))}
      </ol>
      <div className="row">
        {w.status === "found" && deal ? (
          <button
            className="btn lg"
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await joinShop(deal.shop);
                navigate(`/shop/${deal.shop}/item/${deal.listingId}`);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Wallet /> Pay {deal.agreedMinor ? money(deal.agreedMinor) : ""}
          </button>
        ) : null}
        {w.status === "hunting" || w.status === "found" ? (
          <button
            className="btn ghost"
            type="button"
            onClick={async () => {
              await request(`/api/wants/${w.id}/stop`, postJson({}, token)).catch(() => undefined);
              onChange();
            }}
          >
            Stop Agent
          </button>
        ) : null}
      </div>
    </article>
  );
}

function PurchaseRow({ b }: { b: Purchase }) {
  const [busy, setBusy] = useState(false);
  const open = async (to: string) => {
    setBusy(true);
    try {
      await joinShop(b.shop);
      navigate(to);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="card row" style={{ gap: 14, flexWrap: "nowrap" }}>
      <div style={{ flex: 1 }}>
        <h3 style={{ fontSize: "var(--t-b)" }}>{b.title}</h3>
        <p className="tiny">
          {b.shopName} · {money(b.totalMinor)} · {stateWord(b.state)}
        </p>
      </div>
      {b.passId && PAID.includes(b.state) ? (
        <button className="btn" type="button" disabled={busy} onClick={() => void open(`/shop/${b.shop}/p/${b.passId}`)}>
          Pickup Pass
        </button>
      ) : (
        <button className="btn ghost" type="button" disabled={busy} onClick={() => void open(`/shop/${b.shop}/item/${b.listingId}`)}>
          Open
        </button>
      )}
    </article>
  );
}

function VoiceShopping({ token }: { token: string }) {
  const [code, setCode] = useState<string>();
  const [err, setErr] = useState("");
  return (
    <section className="card stack-s" aria-labelledby="voice-h">
      <div className="row" style={{ gap: 10 }}>
        <span className="step-n" style={{ background: "var(--sun)", color: "var(--ink)" }}>
          <Voice />
        </span>
        <h2 id="voice-h" style={{ fontSize: "var(--t-m)" }}>
          Shop by voice
        </h2>
      </div>
      {code ? (
        <>
          <p className="small">Say “Alexa, open stoop shop”, then this code:</p>
          <p className="countdown num" style={{ letterSpacing: "0.08em" }}>
            {code.slice(0, 3)} {code.slice(3)}
          </p>
          <p className="tiny">Then try: “Alexa, ask stoop shop to find a jogging stroller under a hundred dollars.”</p>
        </>
      ) : (
        <>
          <p className="small muted">Find things, make offers and pay with your purchase code, from any Echo or the Alexa app.</p>
          <div>
            <button
              className="btn dark"
              type="button"
              onClick={async () => {
                try {
                  setCode((await request<{ code: string }>("/api/profile/alexa", postJson({}, token))).code);
                } catch (e) {
                  setErr(e instanceof Error ? e.message : "Couldn’t get a code.");
                }
              }}
            >
              Get a Code
            </button>
          </div>
        </>
      )}
      {err ? <p className="err">{err}</p> : null}
    </section>
  );
}
