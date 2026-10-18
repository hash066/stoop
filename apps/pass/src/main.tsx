import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// Hosted sandboxes inject window.__STOOP__ (the visitor's own stack under /s/<id>); local dev uses :8787
const RT = (window as unknown as { __STOOP__?: { stack?: string; public?: boolean } }).__STOOP__;
const STACK = RT?.stack ? new URL(RT.stack, location.origin).href.replace(/\/$/, "") : ((import.meta.env.VITE_STACK_URL as string | undefined) ?? "http://localhost:8787");
const passId = location.pathname.match(/\/p\/([A-Za-z0-9_]+)/)?.[1];

function deviceId(): string {
  try {
    let d = localStorage.getItem("stoop-device");
    if (!d) {
      d = `dev_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
      localStorage.setItem("stoop-device", d);
    }
    return d;
  } catch {
    return `dev_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  }
}
const DEV = deviceId();

interface View {
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

const $ = (m: number) => `$${(m / 100).toFixed(m % 100 ? 2 : 0)}`;
const t = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");

async function api(path: string, method = "GET", body?: unknown) {
  const r = await fetch(`${STACK}/pass/${passId}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Stoop-Device": DEV },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message ?? `Error ${r.status}`), { status: r.status, code: j.error });
  return j;
}

function Pass() {
  const [view, setView] = useState<View>();
  const [needsCode, setNeedsCode] = useState(false);
  const [otp, setOtp] = useState("");
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      setView(await api(""));
      setNeedsCode(false);
    } catch (e: any) {
      if (e.status === 403) setNeedsCode(true);
      else setErr(e.message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const i = setInterval(() => {
      setNow(Date.now());
      if (!needsCode) void refresh();
    }, 2000);
    return () => clearInterval(i);
  }, [refresh, needsCode]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(undefined);
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!passId) return <Shell><h1>Pickup pass</h1><p>Open the link from your email.</p></Shell>;

  if (needsCode)
    return (
      <Shell>
        <p className="eyebrow">Stoop pickup pass</p>
        <h1>Enter the code from your email</h1>
        <p className="muted">This pass works on one phone only. Nobody else can open it, even with the link.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api("/bind", "POST", { otp }));
          }}
        >
          <input className="otp num" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} aria-label="One-time code" />
          <button className="primary" disabled={otp.length !== 6 || busy}>Open my pass</button>
        </form>
        {err && <p className="err">{err}</p>}
      </Shell>
    );

  if (!view) return <Shell><p className="muted">Loading your pass…</p>{err && <p className="err">{err}</p>}</Shell>;

  const w = view.window;
  const inWindow = !!w && now >= w.start && now <= w.end;
  const before = !!w && now < w.start;
  const done = view.state === "CLOSED";

  return (
    <Shell>
      <p className="eyebrow">Stoop pickup pass</p>
      <h1>{view.itemTitle}</h1>

      <section className="block">
        <div className="row"><span>Item</span><span className="num">{$(view.breakdown.itemMinor)}</span></div>
        <div className="row"><span>Verified pickup</span><span className="num">{$(view.breakdown.feeMinor)}</span></div>
        <div className="row total"><span>Total</span><span className="num">{$(view.breakdown.totalMinor)}</span></div>
        <p className="held">{done ? "Paid. Enjoy it!" : "Held, not charged, until your pickup is verified."}</p>
      </section>

      {!view.consented && !done && (
        <section className="block">
          <h2>Before you go</h2>
          <p>The seller's doorbell camera confirms the pickup. It checks that the item left the porch; it never identifies you. Clips are kept for 30 days for disputes.</p>
          <button className="primary" disabled={busy} onClick={() => void act(() => api("/consent", "POST", {}))}>I understand</button>
        </section>
      )}

      {view.consented && !done && w && (
        <section className="block">
          <h2>Pickup window</h2>
          <p className="big num">{t(w.start)} – {t(w.end)}</p>
          <p className="muted">{before ? `Opens in ${Math.max(0, Math.ceil((w.start - now) / 60000))} min.` : inWindow ? `Closes in ${Math.max(0, Math.ceil((w.end - now) / 60000))} min.` : "This window has closed."}</p>
          {view.address ? (
            <div className="porch">
              <p className="eyebrow">Porch details · shown only now, only here</p>
              <p className="addr">{view.address}</p>
              <p>{view.porchInstructions}</p>
            </div>
          ) : (
            <p className="muted">Porch details appear here 30 minutes before your window.</p>
          )}
        </section>
      )}

      {view.consented && inWindow && ["WINDOW_OPEN", "STILL_THERE"].includes(view.state) && (
        <section className="block">
          {!view.checkedIn ? (
            <>
              <p>At the door? Tap below, then ring the doorbell and take the item.</p>
              <button className="primary big-btn" disabled={busy} onClick={() => void act(() => api("/checkin", "POST", {}))}>I'm here</button>
            </>
          ) : (
            <p className="status">{view.state === "STILL_THERE" ? "The camera still sees the item on the porch. Take it and we'll check again." : "Checked in. Verifying your pickup…"}</p>
          )}
        </section>
      )}

      {view.state === "INSPECTION" && (
        <section className="block verified">
          <div className="stamp">PICKUP VERIFIED</div>
          <p>Check the item. Your payment releases when you tap Got it, or automatically at {t(view.inspectionEndsAt)}.</p>
          <button className="primary" disabled={busy} onClick={() => void act(() => api("/outcome", "POST", { outcome: "got_it" }))}>Got it, looks good</button>
          <button className="secondary" disabled={busy} onClick={() => void act(() => api("/outcome", "POST", { outcome: "not_as_described" }))}>Not as described</button>
        </section>
      )}

      {["REVIEW", "DEGRADED"].includes(view.state) && (
        <section className="block">
          <p>The camera couldn't confirm the pickup. If you have the item, confirm below; the seller confirms too.</p>
          <button className="primary" disabled={busy} onClick={() => void act(() => api("/outcome", "POST", { outcome: "got_it" }))}>I have the item</button>
        </section>
      )}

      {view.state === "DISPUTE" && <section className="block"><p className="status">We're reviewing your report. No money moves until it's resolved.</p></section>}
      {view.state === "VOIDED" && <section className="block"><p className="status">This pickup didn't happen, so your payment hold was released.</p></section>}

      {view.receiptIds.length > 0 && (
        <section className="block">
          <a className="receipt" href={`${STACK}/verify/${view.receiptIds.at(-1)}`} target="_blank" rel="noreferrer">View the signed pickup receipt →</a>
        </section>
      )}
      {err && <p className="err">{err}</p>}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="pass">{children}</main>;
}

createRoot(document.getElementById("root")!).render(<Pass />);
