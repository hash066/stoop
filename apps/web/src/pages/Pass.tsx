import { useCallback, useState, type ReactNode } from "react";
import { api, ApiError, base, clock, deviceId, money, tokens, until } from "../api.ts";
import { Bar, Check, Closed, Spinner, usePoll, useTitle } from "../ui.tsx";
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
        <h1 style={{ fontSize: "var(--t-l)" }}>Open your pickup pass on this phone?</h1>
        {buyerToken ? (
          <>
            <p className="lede">The pass works on one phone only: the one you’ll have with you at the pickup.</p>
            {err ? (
              <p className="err" role="alert">
                {err}
              </p>
            ) : null}
            <button className="btn big wide" type="button" disabled={busy} onClick={() => doing(() => api(shop, `/web/pass/${passId}/claim`, { token: buyerToken, device, body: {} }))}>
              Use This Phone
            </button>
          </>
        ) : (
          <p className="lede">This pass belongs to the phone or computer you paid with. Open it there, or scan the code it shows with this phone.</p>
        )}
      </Frame>
    );
  if (problem === "other" && !view) return <Frame>{<p className="lede">We couldn’t load this pass. Check your connection; it retries on its own.</p>}</Frame>;
  if (!view) return <Spinner label="Loading your pass…" />;

  const now = Date.now();
  const inWindow = !!view.window && now >= view.window.start && now <= view.window.end;

  return (
    <Frame>
      <div className="stack-s">
        <h1 style={{ fontSize: "var(--t-l)" }}>{view.itemTitle}</h1>
        <p className="meta">Your pickup pass. {money(view.breakdown.totalMinor)} held, not charged.</p>
      </div>

      {!view.consented ? (
        <div className="stack">
          <p>Before you see the address:</p>
          <ul className="stack-s" style={{ paddingLeft: "1.2em", margin: 0 }}>
            <li>Stoop records when you tap “I’m here”.</li>
            <li>The seller’s porch camera takes a photo of the porch before and after you pick up, and counts whether someone is at the door. It never identifies you.</li>
            <li>The address is for this pickup only. It disappears when your window ends.</li>
          </ul>
          {err ? <p className="err">{err}</p> : null}
          <button className="btn big wide" type="button" disabled={busy} onClick={() => doing(() => api(shop, `/pass/${passId}/consent`, { device, body: {} }))}>
            Agree and Show Address
          </button>
        </div>
      ) : (
        <>
          {view.window ? (
            <p className="note num">
              {now < view.window.start
                ? `Your window opens at ${clock(view.window.start)}.`
                : now <= view.window.end
                  ? `Pick it up by ${clock(view.window.end)}. That’s ${until(view.window.end, now)} from now.`
                  : "Your pickup window has ended."}
            </p>
          ) : null}
          {view.address ? (
            <div className="stack-s">
              <h2 style={{ fontSize: "var(--t-m)" }}>{view.address}</h2>
              {view.porchInstructions ? <p>{view.porchInstructions}</p> : null}
              <p>
                <a className="btn quiet" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(view.address)}`} target="_blank" rel="noreferrer">
                  Open in Maps
                </a>
              </p>
            </div>
          ) : null}
          <Status view={view} inWindow={inWindow} busy={busy} err={err} doing={doing} shop={shop} passId={passId} device={device} />
        </>
      )}
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <>
      <Bar />
      <main id="main" className="page stack" style={{ maxWidth: 620, paddingBottom: 64 }}>
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
        <p className="lede">
          <Check /> All done. It’s yours.
        </p>
        {view.receiptIds.length ? (
          <p>
            <a href={`${base(shop)}/verify/${view.receiptIds.at(-1)}`} target="_blank" rel="noreferrer">
              See the signed pickup receipt
            </a>
          </p>
        ) : null}
        <Feedback role="buyer" shop={shop} step={9} />
      </div>
    );
  if (["VOIDED", "NO_SHOW", "PIRACY_SUSPECTED", "SELLER_CANCELLED"].includes(s))
    return <p className="note">This pickup didn’t happen, so your hold was released. You weren’t charged.</p>;
  if (s === "INSPECTION" || s === "VERIFIED")
    return (
      <div className="stack">
        <p className="lede">Pickup verified. Is everything as described?</p>
        <p className="meta">If you don’t answer, the payment goes through {view.inspectionEndsAt ? `at ${clock(view.inspectionEndsAt)}` : "in two hours"}.</p>
        {err}
        <div className="row">
          <button className="btn big" type="button" disabled={p.busy} onClick={() => outcome("got_it")}>
            Got It
          </button>
          <button className="btn big quiet" type="button" disabled={p.busy} onClick={() => outcome("not_as_described")}>
            Something’s Wrong
          </button>
        </div>
      </div>
    );
  if (s === "REVIEW" || s === "DEGRADED")
    return (
      <div className="stack">
        <p className="lede">The porch camera couldn’t confirm this pickup, so you and the seller both confirm instead.</p>
        {err}
        <button className="btn big wide" type="button" disabled={p.busy} onClick={() => outcome("got_it")}>
          I Have It
        </button>
      </div>
    );
  if (s === "DISPUTE") return <p className="note">You reported a problem. Your payment stays held while it’s reviewed.</p>;
  if (view.checkedIn)
    return (
      <div className="stack">
        <p className="lede">
          <Check /> You’re checked in. Take the item now.
        </p>
        <p className="meta">
          {s === "STILL_THERE"
            ? "The camera still sees the item on the porch. Once you’ve taken it, it checks again on its own."
            : "Walk away with it as normal. The porch camera checks the spot in about a minute, then your payment goes through."}
        </p>
      </div>
    );
  if (!p.inWindow) return <p className="note">Check-in opens during your pickup window.</p>;
  return (
    <div className="stack">
      <p className="lede">At the porch, tap this first. Then take the item.</p>
      <p className="meta">If the item leaves the porch before you tap, Stoop treats it as taken by someone else and cancels your payment.</p>
      {err}
      <button className="btn big wide" style={{ minHeight: 76 }} type="button" disabled={p.busy} onClick={() => p.doing(() => api(shop, `/pass/${passId}/checkin`, { device, body: {} }))}>
        I’m Here
      </button>
    </div>
  );
}

