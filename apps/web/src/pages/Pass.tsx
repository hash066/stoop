import { useCallback, useState, type ReactNode } from "react";
import { api, ApiError, base, clock, deviceId, money, tokens, until } from "../api.ts";
import { Camera, Check, Clock, Lock, Phone, Pin, Receipt } from "../icons.tsx";
import { Closed, Loading, Nav, usePoll, useTitle } from "../ui.tsx";
import { Feedback } from "./Feedback.tsx";

interface PassView {
  passId: string;
  dealId: string;
  state: string;
  itemTitle: string;
  breakdown: { itemMinor: number; feeMinor: number; taxMinor: number; totalMinor: number };
  window?: { start: number; end: number };
  consented: boolean;
  checkedIn: boolean;
  address?: string;
  porchInstructions?: string;
  verdict?: string;
  inspectionEndsAt?: number;
  receiptIds: string[];
}

export function Pass({ shop, passId }: { shop: string; passId: string }) {
  useTitle("Pickup pass");
  const device = deviceId();
  const [view, setView] = useState<PassView>();
  const [problem, setProblem] = useState<"" | "unbound" | "closed" | "other">("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const buyerToken = tokens.get("buyer", shop);

  const load = useCallback(async () => {
    try {
      setView(await api<PassView>(shop, `/pass/${passId}`, { device }));
      setProblem("");
    } catch (e) {
      if (e instanceof ApiError && e.code === "sandbox_expired") setProblem("closed");
      else if (e instanceof ApiError && e.status === 403) setProblem("unbound");
      else setProblem("other");
    }
  }, [shop, passId, device]);
  usePoll(load, 3000, [load]);

  const doing = async (fn: () => Promise<unknown>) => {
    setErr("");
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That didn’t go through. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (problem === "closed") return <Closed />;
  if (problem === "unbound")
    return (
      <Frame>
        <div className="ticket">
          <div className="ticket-top stack-s">
            <span className="badge dark">
              <Phone /> One phone per pass
            </span>
            <h1 style={{ fontSize: "var(--t-xl)", color: "#fff" }}>Open your pass on this phone?</h1>
          </div>
          <div className="ticket-cut" />
          <div className="ticket-body stack">
            {buyerToken ? (
              <>
                <p className="muted">The pass works on one phone only: the one you’ll have with you at the pickup.</p>
                {err ? (
                  <p className="err" role="alert">
                    {err}
                  </p>
                ) : null}
                <button className="btn xl block" type="button" disabled={busy} onClick={() => doing(() => api(shop, `/web/pass/${passId}/claim`, { token: buyerToken, device, body: {} }))}>
                  Use This Phone
                </button>
              </>
            ) : (
              <p className="muted">This pass belongs to the phone or computer you paid with. Open it there, or scan the code it shows with this phone.</p>
            )}
          </div>
        </div>
      </Frame>
    );
  if (problem === "other" && !view)
    return (
      <Frame>
        <p className="note">We couldn’t load this pass. Check your connection; it retries on its own.</p>
      </Frame>
    );
  if (!view) return <Loading label="Loading your pass…" />;

  const now = Date.now();
  const inWindow = !!view.window && now >= view.window.start && now <= view.window.end;

  return (
    <Frame>
      <div className="ticket">
        <div className="ticket-top stack-s">
          <div className="spread">
            <span className="badge dark">Pickup pass</span>
            <span className="small num" style={{ color: "rgb(255 255 255 / 0.8)" }}>
              {money(view.breakdown.totalMinor)} held, not charged
            </span>
          </div>
          <h1 style={{ fontSize: "var(--t-xl)", color: "#fff" }}>{view.itemTitle}</h1>
          {view.window ? (
            <div className="row" style={{ gap: 12, paddingTop: 8 }}>
              <Clock style={{ width: 28, height: 28, color: "var(--sun)" }} />
              <div>
                <p className="countdown num">{now < view.window.start ? clock(view.window.start) : now <= view.window.end ? until(view.window.end, now) : "Ended"}</p>
                <p className="muted small">{now < view.window.start ? "your window opens" : now <= view.window.end ? `left to pick it up (until ${clock(view.window.end)})` : "your pickup window has ended"}</p>
              </div>
            </div>
          ) : null}
        </div>
        <div className="ticket-cut" />
        <div className="ticket-body stack" style={{ ["--gap" as string]: "20px" }}>
          {!view.consented ? (
            <>
              <h2 style={{ fontSize: "var(--t-l)" }}>Before you see the address</h2>
              <ul className="stack-s" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {[
                  [Check, "Stoop records when you tap “I’m here”."],
                  [Camera, "The seller’s porch camera photographs the porch before and after, and counts whether someone is at the door. It never identifies you."],
                  [Lock, "The address is for this pickup only. It disappears when your window ends."],
                ].map(([I, t], i) => {
                  const Icon = I as typeof Check;
                  return (
                    <li key={i} className="row" style={{ gap: 12, alignItems: "flex-start", flexWrap: "nowrap" }}>
                      <span className="step-n" style={{ width: 36, height: 36, borderRadius: 12 }}>
                        <Icon />
                      </span>
                      <span className="small">{t as string}</span>
                    </li>
                  );
                })}
              </ul>
              {err ? <p className="err">{err}</p> : null}
              <button className="btn xl block" type="button" disabled={busy} onClick={() => doing(() => api(shop, `/pass/${passId}/consent`, { device, body: {} }))}>
                Agree and Show Address
              </button>
            </>
          ) : (
            <>
              {view.address ? (
                <div className="row" style={{ gap: 14, alignItems: "flex-start", flexWrap: "nowrap" }}>
                  <span className="step-n">
                    <Pin />
                  </span>
                  <div className="stack-s" style={{ flex: 1 }}>
                    <h2 style={{ fontSize: "var(--t-l)" }}>{view.address}</h2>
                    {view.porchInstructions ? <p className="muted">{view.porchInstructions}</p> : null}
                    <div>
                      <a className="btn soft sm" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(view.address)}`} target="_blank" rel="noreferrer">
                        <Pin /> Open in Maps
                      </a>
                    </div>
                  </div>
                </div>
              ) : null}
              <Status view={view} inWindow={inWindow} busy={busy} err={err} doing={doing} shop={shop} passId={passId} device={device} />
            </>
          )}
        </div>
      </div>
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <>
      <Nav />
      <main id="main" className="page stack" style={{ maxWidth: 560, paddingBlock: "clamp(16px, 3vw, 40px) 64px" }}>
        {children}
      </main>
    </>
  );
}

function Status(p: { view: PassView; inWindow: boolean; busy: boolean; err: string; doing(fn: () => Promise<unknown>): void; shop: string; passId: string; device: string }) {
  const { view, shop, passId, device } = p;
  const s = view.state;
  const outcome = (o: "got_it" | "not_as_described") => p.doing(() => api(shop, `/pass/${passId}/outcome`, { device, body: { outcome: o } }));
  const err = p.err ? (
    <p className="err" role="alert">
      {p.err}
    </p>
  ) : null;

  if (["CAPTURED", "PAYOUT_RECORDED", "CLOSED"].includes(s))
    return (
      <div className="stack">
        <p className="note">
          <Check />
          <span>All done. It’s yours.</span>
        </p>
        {view.receiptIds.length ? (
          <a className="btn soft" href={`${base(shop)}/verify/${view.receiptIds.at(-1)}`} target="_blank" rel="noreferrer">
            <Receipt /> See the Signed Pickup Receipt
          </a>
        ) : null}
        <Feedback role="buyer" shop={shop} step={9} />
      </div>
    );
  if (["VOIDED", "NO_SHOW", "PIRACY_SUSPECTED", "SELLER_CANCELLED"].includes(s)) return <p className="note">This pickup didn’t happen, so your hold was released. You weren’t charged.</p>;
  if (s === "INSPECTION" || s === "VERIFIED")
    return (
      <div className="stack">
        <h2 style={{ fontSize: "var(--t-l)" }}>Pickup verified. Is everything as described?</h2>
        <p className="muted small">If you don’t answer, the payment goes through {view.inspectionEndsAt ? `at ${clock(view.inspectionEndsAt)}` : "in two hours"}.</p>
        {err}
        <div className="row">
          <button className="btn xl" type="button" disabled={p.busy} onClick={() => outcome("got_it")}>
            Got It
          </button>
          <button className="btn ghost lg" type="button" disabled={p.busy} onClick={() => outcome("not_as_described")}>
            Something’s Wrong
          </button>
        </div>
      </div>
    );
  if (s === "REVIEW" || s === "DEGRADED")
    return (
      <div className="stack">
        <p className="note warn">The porch camera couldn’t confirm this pickup, so you and the seller both confirm instead.</p>
        {err}
        <button className="btn xl block" type="button" disabled={p.busy} onClick={() => outcome("got_it")}>
          I Have It
        </button>
      </div>
    );
  if (s === "DISPUTE") return <p className="note">You reported a problem. Your payment stays held while it’s reviewed.</p>;
  if (view.checkedIn)
    return (
      <div className="stack">
        <p className="note">
          <Check />
          <span>You’re checked in. Take the item now.</span>
        </p>
        <p className="muted small">
          {s === "STILL_THERE"
            ? "The camera still sees the item on the porch. Once you’ve taken it, it checks again on its own."
            : "Walk away with it as normal. The porch camera checks the spot in about a minute, then your payment goes through."}
        </p>
      </div>
    );
  if (!p.inWindow) return <p className="note">Check-in opens during your pickup window.</p>;
  return (
    <div className="stack">
      <h2 style={{ fontSize: "var(--t-l)" }}>At the porch, tap this first. Then take the item.</h2>
      <p className="muted small">If the item leaves the porch before you tap, Stoop treats it as taken by someone else and cancels your payment.</p>
      {err}
      <button className="btn xl block" style={{ minHeight: 88, fontSize: "1.875rem" }} type="button" disabled={p.busy} onClick={() => p.doing(() => api(shop, `/pass/${passId}/checkin`, { device, body: {} }))}>
        I’m Here
      </button>
    </div>
  );
}
