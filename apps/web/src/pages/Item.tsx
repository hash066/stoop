import { useCallback, useState, type ReactNode } from "react";
import { api, ApiError, createProfile, dollars, isPhone, joinShop, money, profile, tokens } from "../api.ts";
import { ApprovalPrompt, Composer, Thread, useConversation } from "../conversation.tsx";
import { Camera, Check, Clock, Lock, Pin, Shield, Wallet } from "../icons.tsx";
import { speak } from "../voice.ts";
import { Closed, Link, Loading, Nav, QR, usePoll, useTitle } from "../ui.tsx";
import { Feedback } from "./Feedback.tsx";
import { ReviewForm } from "./Review.tsx";

interface Listing {
  id: string;
  title: string;
  description: string;
  askMinor: number;
  state: string;
  zip: string;
  photoUrls: string[];
}
interface BuyerDeal {
  dealId: string;
  listingId: string;
  title: string;
  state: string;
  amountMinor: number;
  totalMinor: number;
  window: { start: number; end: number } | null;
  passId: string | null;
  active: boolean;
  reviewed?: boolean;
}
interface BuyerState {
  me: { displayName: string };
  negotiation: { state: string; offers: Array<{ by: string; amountMinor: number; at: number; message: string }>; lastCounterMinor?: number; pendingAmountMinor?: number } | null;
  deals: BuyerDeal[];
}

const PAID = ["FUNDS_HELD", "PASS_ISSUED", "WINDOW_OPEN", "STILL_THERE", "VERIFIED", "INSPECTION", "REVIEW", "DEGRADED", "DISPUTE", "DUAL_CONFIRMED", "HOLD_EXPIRING"];
const DONE_OK = ["CAPTURED", "PAYOUT_RECORDED", "CLOSED"];

export function Item({ shop, listingId }: { shop: string; listingId: string }) {
  const [listing, setListing] = useState<Listing>();
  const [gone, setGone] = useState<"" | "listing" | "shop">("");
  const [token, setToken] = useState(() => tokens.get("buyer", shop));
  const [state, setState] = useState<BuyerState>();
  useTitle(listing?.title ?? "");

  usePoll(
    async () => {
      try {
        setListing(await api<Listing>(shop, `/web/listing/${listingId}`));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) setGone(e.code === "sandbox_expired" ? "shop" : "listing");
      }
    },
    10_000,
    [shop, listingId],
  );
  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setState(await api<BuyerState>(shop, `/web/buyer/state?listing=${encodeURIComponent(listingId)}`, { token }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        tokens.clear("buyer", shop);
        setToken("");
      }
    }
  }, [shop, listingId, token]);
  usePoll(refresh, 3000, [refresh]);

  if (gone === "shop") return <Closed />;
  if (gone === "listing") return <Closed what="listing" />;
  if (!listing) return <Loading />;

  return (
    <>
      <Nav
        right={
          <Link to={`/shop/${shop}`} className="btn ghost sm">
            More From This Seller
          </Link>
        }
      />
      <main id="main" className="page grid-2" style={{ paddingBlock: "clamp(16px, 3vw, 40px) 80px", ["--cols" as string]: "minmax(0, 1.1fr) minmax(0, 1fr)" }}>
        <div className="sticky">
          <Photos listing={listing} />
        </div>
        <div className="stack" style={{ ["--gap" as string]: "16px" }}>
          <section className="card stack" style={{ ["--gap" as string]: "14px" }}>
            <div className="row" style={{ gap: 8 }}>
              <span className="badge">
                <Pin /> Porch pickup in {listing.zip}
              </span>
              <span className="badge sun">
                <Shield /> Paid only when verified
              </span>
            </div>
            <h1 style={{ fontSize: "var(--t-xl)" }}>{listing.title}</h1>
            <p className="price">{money(listing.askMinor)}</p>
            <div className="row" style={{ gap: 12, flexWrap: "nowrap" }}>
              <span className="avatar" aria-hidden="true">
                AI
              </span>
              <p className="small muted">The seller’s AI assistant answers questions and offers in seconds, within the owner’s rules.</p>
            </div>
          </section>
          {token ? (
            <Buying shop={shop} listing={listing} token={token} state={state} refresh={refresh} />
          ) : listing.state === "LIVE" ? (
            <Join shop={shop} onJoined={(t) => setToken(t)} ask={listing.askMinor} />
          ) : (
            <p className="note">Someone else is buying this right now. If it falls through, it comes back here.</p>
          )}
          <section className="card stack" aria-labelledby="about-h">
            <h2 id="about-h" style={{ fontSize: "var(--t-m)" }}>
              About this item
            </h2>
            {listing.description ? <p className="muted">{listing.description}</p> : null}
            <h3 style={{ fontSize: "var(--t-b)", paddingTop: 6 }}>How pickup works</h3>
            <ol className="stack-s" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {[
                [Wallet, "You pay first. The money is held, not charged."],
                [Clock, "Your pickup pass shows the address during a two-hour window."],
                [Check, "At the porch, tap “I’m here” before you take the item."],
                [Camera, "The seller’s camera checks it’s gone. Only then are you charged."],
              ].map(([I, t], i) => {
                const Icon = I as typeof Wallet;
                return (
                  <li key={i} className="row" style={{ gap: 12, flexWrap: "nowrap" }}>
                    <span className="step-n" style={{ width: 36, height: 36, borderRadius: 12 }}>
                      <Icon />
                    </span>
                    <span className="small">{t as string}</span>
                  </li>
                );
              })}
            </ol>
          </section>
        </div>
      </main>
    </>
  );
}

function Photos({ listing }: { listing: Listing }) {
  const [i, setI] = useState(0);
  const urls = listing.photoUrls;
  if (!urls.length) return <div className="photo" role="img" aria-label="No photo" style={{ borderRadius: "var(--r-l)" }} />;
  return (
    <div className="stack-s">
      <img className="photo" src={urls[i]} alt={listing.title} width={1200} height={900} style={{ borderRadius: "var(--r-l)", boxShadow: "var(--shadow-up)" }} />
      {urls.length > 1 ? (
        <div className="row">
          {urls.map((u, n) => (
            <button key={u} type="button" className="link" onClick={() => setI(n)} aria-label={`Photo ${n + 1}`} aria-pressed={i === n}>
              <img className="thumb" src={u} alt="" width={72} height={72} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Join({ shop, onJoined, ask }: { shop: string; onJoined(t: string): void; ask: number }) {
  const p = profile.get();
  const [fresh, setFresh] = useState(!p.token);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!fresh)
    return (
      <div className="card attn stack">
        <div className="stack-s">
          <h2 style={{ fontSize: "var(--t-l)" }}>Want it?</h2>
          <p className="muted small">Make an offer or buy it at {money(ask)}. The seller’s AI assistant answers in seconds.</p>
        </div>
        {err ? (
          <p className="err" role="alert">
            {err}
          </p>
        ) : null}
        <button
          className="btn lg block"
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              onJoined(await joinShop(shop));
            } catch (e) {
              if (e instanceof ApiError && e.status === 401) {
                profile.clear();
                setFresh(true);
              } else setErr(e instanceof Error ? e.message : "Couldn’t continue. Try again.");
              setBusy(false);
            }
          }}
        >
          {busy ? "One Moment…" : `Continue as ${p.name}`}
        </button>
        <button type="button" className="link small" onClick={() => setFresh(true)}>
          Not {p.name}?
        </button>
      </div>
    );
  return (
    <form
      className="card attn stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return setErr("Add your first name.");
        if (!/^\d{4}$/.test(code)) return setErr("Choose a 4-digit purchase code.");
        setErr("");
        setBusy(true);
        try {
          // one profile for the whole street: this shop, the next one, your agents and voice shopping
          await createProfile(name.trim(), code);
          onJoined(await joinShop(shop));
        } catch (e2) {
          setErr(e2 instanceof Error ? e2.message : "Couldn’t continue. Try again.");
          setBusy(false);
        }
      }}
    >
      <div className="stack-s">
        <h2 style={{ fontSize: "var(--t-l)" }}>Want it?</h2>
        <p className="muted small">Make an offer or buy it at {money(ask)}. No account needed.</p>
      </div>
      <label className="field">
        <span className="label">Your first name</span>
        <input className="input" name="given-name" autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </label>
      <label className="field">
        <span className="label">Choose a 4-digit purchase code</span>
        <input className="input" name="purchase-code" inputMode="numeric" autoComplete="off" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} style={{ maxWidth: "12ch" }} />
        <span className="hint">You’ll type it to approve purchases over $100, like the code on a voice assistant.</span>
      </label>
      {err ? (
        <p className="err" role="alert">
          {err}
        </p>
      ) : null}
      <button className="btn lg block" type="submit" disabled={busy}>
        {busy ? "One Moment…" : "Continue"}
      </button>
    </form>
  );
}

function Buying({ shop, listing, token, state, refresh }: { shop: string; listing: Listing; token: string; state?: BuyerState; refresh(): void }) {
  const deal = state?.deals.find((d) => d.listingId === listing.id && d.active) ?? state?.deals.find((d) => d.listingId === listing.id);
  const conv = useConversation({ shop, role: "buyer", token, storeKey: `stoop:thread:${shop}:${listing.id}`, context: { activeListingId: listing.id, lastListingIds: [listing.id], activeDealId: deal?.dealId }, onChange: refresh });
  const [offer, setOffer] = useState(String(listing.askMinor / 100));
  const [codeError, setCodeError] = useState("");
  const counter = state?.negotiation?.state === "OPEN" ? state.negotiation.lastCounterMinor : undefined;
  const waiting = state?.negotiation?.state === "AGREED_PENDING_SELLER" ? state.negotiation.pendingAmountMinor : undefined;

  const guarded = async (fn: () => Promise<unknown>) => {
    conv.setBusy(true);
    try {
      await fn();
    } catch (e) {
      conv.add({ who: "stoop", text: e instanceof Error ? e.message : "That didn’t go through." });
    } finally {
      conv.setBusy(false);
    }
  };
  const send = (amount: number) =>
    guarded(async () => {
      conv.add({ who: "me", text: Math.round(amount * 100) === listing.askMinor ? `I’ll take it at ${money(listing.askMinor)}.` : `Would you take ${money(Math.round(amount * 100))}?` });
      await conv.run("make_offer", { listingId: listing.id, amountDollars: amount });
    });
  // Everything typed here goes to the seller's assistant: it answers from the listing and treats
  // "would you take $90?" as an offer, within the owner's rules.
  const message = (text: string, aloud: boolean) =>
    guarded(async () => {
      const t = text.trim();
      if (!t) return;
      conv.add({ who: "me", text: t });
      const { spoken } = await conv.run("ask_seller", { listingId: listing.id, message: t.slice(0, 800) });
      if (aloud) speak(spoken);
    });
  const pay = (dealId: string) =>
    guarded(async () => {
      setCodeError("");
      const { r } = await conv.run("checkout", { dealId });
      if (r.data.code === "voice_code_invalid") setCodeError("That code didn’t match. Nothing was charged; tap Review and Pay to try again.");
    });

  let panel: ReactNode = null;
  if (conv.pending) panel = <ApprovalPrompt a={conv.pending} codeError={codeError} onAnswer={(d, c) => conv.answer(d, c)} />;
  else if (deal && DONE_OK.includes(deal.state)) {
    panel = (
      <div className="card stack">
        <p className="note">
          <Check />
          <span>It’s yours. Thanks for buying on Stoop.</span>
        </p>
        {deal.reviewed ? null : <ReviewForm shop={shop} dealId={deal.dealId} token={token} />}
        <Feedback role="buyer" shop={shop} step={9} />
      </div>
    );
  } else if (deal && PAID.includes(deal.state)) {
    panel = <PassLink shop={shop} deal={deal} token={token} />;
  } else if (deal && (deal.state === "AGREED" || deal.state === "CHECKOUT_OPEN")) {
    panel = (
      <div className="card attn stack-s">
        <h2 style={{ fontSize: "var(--t-l)" }}>The seller said yes to {money(deal.amountMinor)}.</h2>
        <p className="muted small">Pay now to reserve it. Your money is held, not charged, until the pickup is verified.</p>
        {codeError ? (
          <p className="err" role="alert">
            {codeError}
          </p>
        ) : null}
        <div style={{ paddingTop: 6 }}>
          <button className="btn lg" type="button" disabled={conv.busy} onClick={() => void pay(deal.dealId)}>
            <Lock /> Review and Pay
          </button>
        </div>
      </div>
    );
  } else if (listing.state !== "LIVE") {
    panel = <p className="note">Someone else is buying this right now. If it falls through, it comes back here.</p>;
  } else if (waiting) {
    panel = (
      <p className="note warn">
        <Clock />
        <span>You offered {money(waiting)}. Waiting for the owner to say yes. You can close this page and come back with the same link.</span>
      </p>
    );
  } else {
    const d = dollars(offer);
    const full = d !== undefined && Math.round(d * 100) === listing.askMinor;
    panel = (
      <form
        className="card stack-s"
        onSubmit={(e) => {
          e.preventDefault();
          if (d) void send(d);
        }}
      >
        <label className="label" htmlFor="offer">
          Your offer
        </label>
        <div className="row">
          <span className="money" style={{ flex: "1 1 140px", maxWidth: 200 }}>
            <input id="offer" className="input" inputMode="decimal" autoComplete="off" value={offer} onChange={(e) => setOffer(e.target.value)} />
          </span>
          <button className="btn lg" type="submit" disabled={conv.busy || !d}>
            {full ? `Buy for ${money(listing.askMinor)}` : "Send Offer"}
          </button>
          {counter ? (
            <button className="btn dark lg" type="button" disabled={conv.busy} onClick={() => void send(counter / 100)}>
              Accept {money(counter)}
            </button>
          ) : null}
        </div>
      </form>
    );
  }

  const chatting = !deal || !PAID.includes(deal.state);
  return (
    <>
      {conv.lines.length || conv.busy ? (
        <section className="card" aria-label="Your conversation with the seller’s assistant" style={{ background: "var(--mint-2)", boxShadow: "none" }}>
          <Thread lines={conv.lines} typing={conv.busy && !conv.pending} />
        </section>
      ) : null}
      {panel}
      {chatting && !conv.pending ? <Composer onSay={(t, aloud) => void message(t, aloud)} busy={conv.busy} label="Message the seller’s assistant" placeholder="Ask a question or make an offer…" /> : null}
    </>
  );
}

function PassLink({ shop, deal, token }: { shop: string; deal: BuyerDeal; token: string }) {
  const [here, setHere] = useState(isPhone());
  if (!deal.passId) return <p className="note">Issuing your pickup pass…</p>;
  const path = `/shop/${shop}/p/${deal.passId}`;
  return (
    <div className="ticket">
      <div className="ticket-top stack-s">
        <span className="badge dark">
          <Check /> Paid · {money(deal.totalMinor)} held, not charged
        </span>
        <h2 style={{ fontSize: "var(--t-l)", color: "#fff" }}>Your pickup pass is ready.</h2>
        {deal.window ? <p className="muted small">Pick it up by {new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(deal.window.end))}. The address is on the pass.</p> : null}
      </div>
      <div className="ticket-cut" />
      <div className="ticket-body">
        {here ? (
          <Link to={path} className="btn xl block">
            Open Pickup Pass
          </Link>
        ) : (
          <div className="row" style={{ alignItems: "flex-start", gap: 24 }}>
            <QR text={`${location.origin}${path}#bk=${token}`} label="QR code that opens your pickup pass on your phone" />
            <div className="stack-s" style={{ flex: "1 1 200px" }}>
              <h3>Scan it with your phone.</h3>
              <p className="muted small">Use the phone you’ll have at the pickup. The pass works on one phone only.</p>
              <button type="button" className="link small" onClick={() => setHere(true)}>
                Use this device instead
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
