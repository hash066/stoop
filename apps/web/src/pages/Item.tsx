import { useCallback, useState, type ReactNode } from "react";
import { act, api, ApiError, dollars, isPhone, money, tokens } from "../api.ts";
import { ApprovalPrompt, Composer, Thread, useConversation } from "../conversation.tsx";
import { Bar, Closed, Link, QR, Spinner, usePoll, useTitle } from "../ui.tsx";
import { Feedback } from "./Feedback.tsx";

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
  if (!listing) return <Spinner label="Loading…" />;

  return (
    <>
      <Bar right={<Link to={`/shop/${shop}`}>More from this seller</Link>} />
      <main id="main" className="page section split" style={{ paddingTop: 12 }}>
        <Photos listing={listing} />
        <div className="stack">
          <div className="stack-s">
            <h1 style={{ fontSize: "var(--t-l)" }}>{listing.title}</h1>
            <p className="price">{money(listing.askMinor)}</p>
            <p className="meta">Porch pickup in {listing.zip}</p>
          </div>
          {listing.description ? <p>{listing.description}</p> : null}
          {token ? (
            <Buying shop={shop} listing={listing} token={token} state={state} refresh={refresh} />
          ) : listing.state === "LIVE" ? (
            <Join shop={shop} onJoined={(t) => setToken(t)} ask={listing.askMinor} />
          ) : (
            <p className="note">Someone else is buying this right now. If it falls through, it comes back here.</p>
          )}
          <HowPickupWorks />
        </div>
      </main>
    </>
  );
}

function Photos({ listing }: { listing: Listing }) {
  const [i, setI] = useState(0);
  const urls = listing.photoUrls.length ? listing.photoUrls : [];
  if (!urls.length) return <div className="photo" role="img" aria-label="No photo" />;
  return (
    <div className="stack-s">
      <img className="photo" src={urls[i]} alt={listing.title} width={1200} height={900} />
      {urls.length > 1 ? (
        <div className="row">
          {urls.map((u, n) => (
            <button key={u} type="button" className="link" onClick={() => setI(n)} aria-label={`Photo ${n + 1}`} aria-pressed={i === n}>
              <img className="thumb" src={u} alt="" width={96} height={96} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Join({ shop, onJoined, ask }: { shop: string; onJoined(t: string): void; ask: number }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="tone stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return setErr("Add your first name.");
        if (!/^\d{4}$/.test(code)) return setErr("Choose a 4-digit purchase code.");
        setErr("");
        setBusy(true);
        try {
          const r = await api<{ buyerToken: string }>(shop, "/web/buyer", { body: { displayName: name.trim(), purchaseCode: code } });
          tokens.set("buyer", shop, r.buyerToken);
          onJoined(r.buyerToken);
        } catch (e2) {
          setErr(e2 instanceof Error ? e2.message : "Couldn’t continue. Try again.");
          setBusy(false);
        }
      }}
    >
      <div className="stack-s">
        <h3>Want it?</h3>
        <p className="meta">Make an offer or buy it at {money(ask)}. The seller’s assistant answers right away.</p>
      </div>
      <label className="field">
        <span>Your first name</span>
        <input className="input" name="given-name" autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </label>
      <label className="field">
        <span>Choose a 4-digit purchase code</span>
        <input className="input" name="purchase-code" inputMode="numeric" autoComplete="off" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} style={{ maxWidth: "10ch" }} />
        <small>You’ll type it to approve purchases over $100, like the code on a voice assistant.</small>
      </label>
      {err ? (
        <p className="err" role="alert">
          {err}
        </p>
      ) : null}
      <button className="btn big wide" type="submit" disabled={busy}>
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

  const send = async (amount: number) => {
    conv.add({ who: "me", text: amount === listing.askMinor / 100 ? `I’ll take it at ${money(listing.askMinor)}.` : `Would you take ${money(Math.round(amount * 100))}?` });
    conv.setBusy(true);
    try {
      await conv.run("make_offer", { listingId: listing.id, amountDollars: amount });
    } catch (e) {
      conv.add({ who: "stoop", text: e instanceof Error ? e.message : "That didn’t go through." });
    } finally {
      conv.setBusy(false);
    }
  };

  let panel: ReactNode;
  if (deal && DONE_OK.includes(deal.state)) {
    panel = (
      <div className="stack">
        <p className="note">It’s yours. Thanks for buying on Stoop.</p>
        <Feedback role="buyer" shop={shop} step={9} />
      </div>
    );
  } else if (deal && PAID.includes(deal.state)) {
    panel = <PassLink shop={shop} deal={deal} token={token} />;
  } else if (deal && (deal.state === "AGREED" || deal.state === "CHECKOUT_OPEN")) {
    panel = conv.approval ? null : (
      <div className="note warn stack-s">
        <p style={{ fontWeight: 600 }}>The seller accepted {money(deal.amountMinor)}.</p>
        <p className="meta">Pay now to reserve it. Your money is held, not charged, until the pickup is verified.</p>
        <div>
          <button className="btn big" type="button" disabled={conv.busy} onClick={() => void conv.run("checkout", { dealId: deal.dealId }).catch(() => undefined)}>
            Review and Pay
          </button>
        </div>
      </div>
    );
  } else if (listing.state !== "LIVE") {
    panel = <p className="note">Someone else is buying this right now. If it falls through, it comes back here.</p>;
  } else if (waiting) {
    panel = <p className="note">You offered {money(waiting)}. Waiting for the owner to say yes. You can close this page and come back with the same link.</p>;
  } else {
    panel = (
      <form
        className="stack-s"
        onSubmit={(e) => {
          e.preventDefault();
          const d = dollars(offer);
          if (d) void send(d);
        }}
      >
        <label className="field" htmlFor="offer">
          <span>Your offer</span>
        </label>
        <div className="row">
          <div className="money" style={{ flex: "1 1 140px", maxWidth: 220 }}>
            <input id="offer" className="input" inputMode="decimal" autoComplete="off" value={offer} onChange={(e) => setOffer(e.target.value)} />
          </div>
          <button className="btn" type="submit" disabled={conv.busy || !dollars(offer)}>
            {dollars(offer) && Math.round(dollars(offer)! * 100) === listing.askMinor ? `Buy for ${money(listing.askMinor)}` : "Send Offer"}
          </button>
          {counter ? (
            <button className="btn quiet" type="button" disabled={conv.busy} onClick={() => void send(counter / 100)}>
              Accept {money(counter)}
            </button>
          ) : null}
        </div>
      </form>
    );
  }

  return (
    <section className="stack" aria-label="Talk to the seller’s assistant">
      <Thread lines={conv.lines} />
      {conv.approval ? (
        <ApprovalPrompt
          a={conv.approval}
          busy={conv.busy}
          codeError={codeError}
          onAnswer={async (d, code) => {
            setCodeError("");
            const r = await conv.answer(d, code);
            if (r?.data?.code === "voice_code_invalid") setCodeError("That code didn’t match. Nothing was charged; tap Review and Pay to try again.");
          }}
        />
      ) : null}
      {panel}
      {!deal || !PAID.includes(deal.state) ? (
        <Composer onSay={(t, aloud) => void conv.say(t, aloud)} busy={conv.busy} label="Message the seller’s assistant" placeholder="Ask a question or make an offer…" />
      ) : null}
      {conv.busy ? <Spinner label="The seller’s assistant is answering…" /> : null}
    </section>
  );
}

function PassLink({ shop, deal, token }: { shop: string; deal: BuyerDeal; token: string }) {
  const [here, setHere] = useState(isPhone());
  if (!deal.passId) return <Spinner label="Issuing your pickup pass…" />;
  const path = `/shop/${shop}/p/${deal.passId}`;
  return (
    <div className="tone stack">
      <div className="stack-s">
        <h3>Your pickup pass</h3>
        <p className="meta">
          {money(deal.totalMinor)} is held, not charged.
          {deal.window ? ` Pick it up by ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(deal.window.end))}.` : ""} The address is on the pass.
        </p>
      </div>
      {here ? (
        <Link to={path} className="btn big wide">
          Open Pickup Pass
        </Link>
      ) : (
        <div className="row" style={{ alignItems: "flex-start", gap: 24 }}>
          <QR text={`${location.origin}${path}#bk=${token}`} label="QR code that opens your pickup pass on your phone" />
          <div className="stack-s" style={{ flex: "1 1 220px" }}>
            <p>Scan this with the phone you’ll have at the pickup. The pass works on one phone only.</p>
            <button type="button" className="link" onClick={() => setHere(true)}>
              Use this device instead
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function HowPickupWorks() {
  return (
    <details className="stack-s">
      <summary className="sum small">How pickup works</summary>
      <p className="meta">
        You pay first; the money is held, not charged. Your pickup pass shows the address during a two-hour window. At the porch, tap “I’m here” before you take the item. The seller’s porch camera
        checks that it’s gone, and only then does the payment go through. If anything’s off, you’re not charged.
      </p>
    </details>
  );
}
