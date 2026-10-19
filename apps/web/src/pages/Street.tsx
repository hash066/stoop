import { useEffect, useState } from "react";
import { createProfile, dollars, money, postJson, profile, request } from "../api.ts";
import { Bot, Pin, Search, Shield, Star } from "../icons.tsx";
import { Link, navigate, Nav, Spinner, useTitle } from "../ui.tsx";

export interface MarketListing {
  shop: string;
  shopName: string;
  listingId: string;
  title: string;
  askMinor: number;
  zip: string;
  photoUrl?: string;
  rating: { avg: number | null; count: number; verified: number };
}

export function Rating({ r, light }: { r: MarketListing["rating"]; light?: boolean }) {
  if (!r.count) return <span className="tiny" style={light ? { color: "rgb(255 255 255 / 0.7)" } : undefined}>New seller</span>;
  return (
    <span className="row tiny" style={{ gap: 4, color: light ? "#fff" : "var(--ink-2)" }} aria-label={`Rated ${r.avg} out of 5 from ${r.count} pickups, ${r.verified} verified by camera`}>
      <Star width={14} height={14} style={{ color: "var(--sun)" }} />
      <strong>{r.avg}</strong> · {r.verified} verified pickup{r.verified === 1 ? "" : "s"}
    </span>
  );
}

export function Street() {
  useTitle("Stoop Street");
  const params = new URLSearchParams(location.search);
  const [q, setQ] = useState(params.get("q") ?? "");
  const [zip, setZip] = useState(params.get("zip") ?? localStorage.getItem("stoop:zip") ?? "");
  const [max, setMax] = useState(params.get("max") ?? "");
  const [results, setResults] = useState<MarketListing[]>();
  const [total, setTotal] = useState(0);

  const search = async () => {
    const u = new URLSearchParams();
    if (q.trim()) u.set("q", q.trim());
    if (zip.trim()) {
      u.set("zip", zip.trim());
      localStorage.setItem("stoop:zip", zip.trim());
    }
    const m = dollars(max);
    if (m) u.set("max", String(m));
    history.replaceState(null, "", `/street${u.size ? `?${u}` : ""}`);
    const r = await request<{ results: MarketListing[]; total: number }>(`/api/market?${u}`, {});
    setResults(r.results);
    setTotal(r.total);
  };
  useEffect(() => {
    void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <Nav
        right={
          <>
            <Link to="/me" className="hide-s">
              Your Stoop
            </Link>
            <Link to="/sell" className="btn sm">
              Sell Something
            </Link>
          </>
        }
      />
      <main id="main">
        <section className="hero" aria-labelledby="street-h">
          <div className="page stack" style={{ paddingBlock: "clamp(40px, 6vw, 72px) clamp(64px, 8vw, 96px)", ["--gap" as string]: "18px" }}>
            <h1 id="street-h" style={{ fontSize: "var(--t-xl)", color: "#fff" }}>
              Stoop Street
            </h1>
            <p className="lede">Everything for sale on porches near you. Pay first, pick it up while they’re out, and you’re only charged once the pickup is verified.</p>
          </div>
        </section>
        <div className="page" style={{ marginTop: "clamp(-64px, -6vw, -44px)", position: "relative", zIndex: 2 }}>
          <form
            className="card row"
            style={{ gap: 12, alignItems: "flex-end" }}
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <label className="field" style={{ flex: "3 1 240px" }}>
              <span className="label">What are you looking for?</span>
              <input className="input" name="q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Stroller, bike, desk…" autoComplete="off" />
            </label>
            <label className="field" style={{ flex: "1 1 110px" }}>
              <span className="label">Near ZIP</span>
              <input className="input" name="zip" inputMode="numeric" autoComplete="postal-code" value={zip} onChange={(e) => setZip(e.target.value)} />
            </label>
            <label className="field" style={{ flex: "1 1 110px" }}>
              <span className="label">Max price</span>
              <span className="money">
                <input className="input" name="max" inputMode="decimal" autoComplete="off" value={max} onChange={(e) => setMax(e.target.value)} />
              </span>
            </label>
            <button className="btn lg" type="submit">
              <Search /> Search
            </button>
          </form>
        </div>

        <section className="page section grid-2" style={{ paddingTop: 32, ["--cols" as string]: "minmax(0, 2fr) minmax(0, 1fr)" }} aria-label="Results">
          <div className="stack">
            {!results ? (
              <Spinner label="Looking along the street…" />
            ) : results.length ? (
              <>
                <p className="muted small">
                  {results.length} of {total} thing{total === 1 ? "" : "s"} for sale{zip ? `, nearest ${zip} first` : ""}.
                </p>
                <div className="item-grid">
                  {results.map((l, i) => (
                    <Link key={`${l.shop}:${l.listingId}`} to={`/shop/${l.shop}/item/${l.listingId}`} className="item-card card in" style={{ ["--i" as string]: Math.min(i, 8), padding: 12 }}>
                      {l.photoUrl ? <img className="photo" src={l.photoUrl} alt="" width={400} height={300} loading="lazy" /> : <div className="photo" />}
                      <div className="spread" style={{ flexWrap: "nowrap", alignItems: "flex-start", padding: "0 4px" }}>
                        <h3 style={{ fontSize: "var(--t-b)" }}>{l.title}</h3>
                        <span className="price" style={{ fontSize: "1.375rem" }}>
                          {money(l.askMinor)}
                        </span>
                      </div>
                      <div className="stack-s" style={{ padding: "0 4px 4px" }}>
                        <span className="row tiny" style={{ gap: 6 }}>
                          <Pin width={14} height={14} /> {l.zip} · {l.shopName}
                        </span>
                        <Rating r={l.rating} />
                      </div>
                    </Link>
                  ))}
                </div>
              </>
            ) : (
              <div className="card stack-s" style={{ textAlign: "center", padding: 40 }}>
                <h2 style={{ fontSize: "var(--t-l)" }}>Nothing like that on the street yet.</h2>
                <p className="muted">Send your agent: it watches for one and haggles for you when it shows up.</p>
              </div>
            )}
          </div>
          <aside className="stack sticky">
            <SendAgent query={q} zip={zip} />
            <div className="card flat stack-s">
              <h3 className="row" style={{ gap: 8 }}>
                <Shield width={20} height={20} style={{ color: "var(--green)" }} /> Why it’s safe
              </h3>
              <p className="small muted">You pay first, but you’re not charged until the seller’s porch camera sees you take the item. Ratings come only from pickups that happened; each links to a signed receipt.</p>
            </div>
          </aside>
        </section>
      </main>
    </>
  );
}

/** "Can't find it? Send your agent": a standing search where an AI haggles inside your budget. */
export function SendAgent({ query, zip }: { query: string; zip: string }) {
  const p = profile.get();
  const [what, setWhat] = useState(query);
  const [max, setMax] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setWhat(query), [query]);
  return (
    <form
      className="card green stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const m = dollars(max);
        if (what.trim().length < 2) return setErr("Say what you’re looking for.");
        if (!m) return setErr("Set the most you’ll pay.");
        if (!p.token && (!name.trim() || !/^\d{4}$/.test(code))) return setErr("Add your first name and a 4-digit purchase code.");
        setErr("");
        setBusy(true);
        try {
          if (!p.token) await createProfile(name.trim(), code);
          await request("/api/wants", postJson({ query: what.trim(), maxDollars: m, ...(zip.trim() ? { zip: zip.trim() } : {}) }, profile.get().token));
          navigate("/me");
        } catch (e2) {
          setErr(e2 instanceof Error ? e2.message : "Couldn’t send your agent. Try again.");
          setBusy(false);
        }
      }}
    >
      <div className="row" style={{ gap: 10 }}>
        <span className="step-n">
          <Bot />
        </span>
        <h2 style={{ fontSize: "var(--t-m)", color: "#fff" }}>Send your agent</h2>
      </div>
      <p className="small muted">Tell it what you want and the most you’ll pay. It watches the street and haggles with sellers’ AI assistants for you. It can agree a price; only you can pay.</p>
      <label className="field">
        <span className="label">Looking for</span>
        <input className="input" value={what} onChange={(e) => setWhat(e.target.value)} placeholder="A jogging stroller" autoComplete="off" />
      </label>
      <label className="field">
        <span className="label">The most you’ll pay</span>
        <span className="money">
          <input className="input" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} autoComplete="off" />
        </span>
      </label>
      {!p.token ? (
        <div className="row" style={{ gap: 10 }}>
          <label className="field" style={{ flex: "2 1 120px" }}>
            <span className="label">Your first name</span>
            <input className="input" autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          </label>
          <label className="field" style={{ flex: "1 1 90px" }}>
            <span className="label">Purchase code</span>
            <input className="input" inputMode="numeric" maxLength={4} autoComplete="off" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          </label>
        </div>
      ) : (
        <p className="tiny">Sending as {p.name}.</p>
      )}
      {err ? (
        <p className="err" role="alert" style={{ color: "#ffb4a6" }}>
          {err}
        </p>
      ) : null}
      <button className="btn lg block" type="submit" disabled={busy}>
        {busy ? "Sending…" : "Send My Agent"}
      </button>
    </form>
  );
}
