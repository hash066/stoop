import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { act, api, ApiError, base, clock, dollars, isPhone, money, tokens, toJpeg } from "../api.ts";
import { ApprovalPrompt, Composer, Thread, useConversation } from "../conversation.tsx";
import { Bar, Check, Closed, CopyButton, Link, navigate, QR, ShareButton, Spinner, usePoll, useTitle, useToast } from "../ui.tsx";
import { Feedback } from "./Feedback.tsx";

interface ShopItem {
  itemId: string;
  title: string;
  condition: "A" | "B" | "C" | "D";
  photoUrl?: string;
  listMinor: number;
  quickSaleMinor: number;
  floorSuggestionMinor: number;
  priceSource: "comps" | "ai-estimate" | "none";
  comps: number;
  blocked: boolean;
  blockedReason?: string;
  alternative?: string;
  listing: { id: string; state: string; askMinor: number } | null;
}
interface Offer {
  approvalId: string;
  listingId: string;
  title: string;
  amountMinor: number;
  askMinor: number;
  buyer: string;
  at: number;
}
interface Conversation {
  listingId: string;
  title: string;
  buyer: string;
  state: string;
  offers: Array<{ by: "buyer" | "seller"; amountMinor: number; at: number; message: string }>;
}
interface Sale {
  dealId: string;
  listingId: string;
  title: string;
  state: string;
  amountMinor: number;
  feeMinor: number;
  payoutMinor: number;
  window: { start: number; end: number } | null;
  verdict: string | null;
  checkInAt: number | null;
  camera: string | null;
  before: { presence: string; at: number } | null;
  after: { presence: string; at: number } | null;
  presenceEvents: number;
  dual: { buyer: boolean; seller: boolean };
  receiptId: string | null;
  history: Array<{ state: string; at: number }>;
  active: boolean;
  buyer: string;
}
interface SellerState {
  shop: { displayName: string; zip: string; porchInstructions: string; camera: { id: string; online: boolean; lastFrameAt?: number } | null };
  items: ShopItem[];
  offers: Offer[];
  conversations: Conversation[];
  sales: Sale[];
}

export function Shop({ shop }: { shop: string }) {
  const asBuyer = new URLSearchParams(location.search).get("view") === "buyer";
  const token = tokens.get("seller", shop);
  return token && !asBuyer ? <Dashboard shop={shop} token={token} /> : <Storefront shop={shop} preview={!!token} />;
}

// ======================================================================== seller

function Dashboard({ shop, token }: { shop: string; token: string }) {
  const [st, setSt] = useState<SellerState>();
  const [closed, setClosed] = useState(false);
  const { toast, node } = useToast();
  const refresh = useCallback(async () => {
    try {
      setSt(await api<SellerState>(shop, "/web/seller/state", { token }));
    } catch (e) {
      if (e instanceof ApiError && (e.code === "sandbox_expired" || e.status === 401)) setClosed(true);
    }
  }, [shop, token]);
  usePoll(refresh, 3000, [refresh]);
  const offers = st?.offers.length ?? 0;
  useTitle(st ? `${offers ? `(${offers}) ` : ""}${st.shop.displayName}’s shop` : "Your shop");

  if (closed) return <Closed />;
  if (!st) return <Spinner label="Opening your shop…" />;

  const unlisted = st.items.filter((i) => !i.blocked && (!i.listing || ["AWAITING_SELLER_OK", "RELISTED", "WITHDRAWN", "EXPIRED"].includes(i.listing.state)));
  const live = st.items.filter((i) => i.listing?.state === "LIVE");
  const blocked = st.items.filter((i) => i.blocked);
  const activeSales = st.sales.filter((s) => s.active);
  const pastSales = st.sales.filter((s) => !s.active);
  const camOn = !!st.shop.camera?.online;
  const needsCam = !camOn && (live.length > 0 || activeSales.length > 0);

  return (
    <>
      <a className="skip btn ink" href="#main">
        Skip to Content
      </a>
      <Bar right={<Link to={`/shop/${shop}?view=buyer`}>See It as a Buyer</Link>} />
      <main id="main" className="page" style={{ paddingBottom: 72 }}>
        <header className="stack-s" style={{ paddingBlock: "8px 32px" }}>
          <h1 style={{ fontSize: "var(--t-l)" }}>{st.shop.displayName}’s shop</h1>
          <p className="meta">
            Porch pickup in {st.shop.zip}. {st.shop.porchInstructions}
          </p>
        </header>
        <div className="split">
          <div className="col">
            {st.offers.length ? <Offers shop={shop} token={token} offers={st.offers} onDone={refresh} toast={toast} /> : null}
            {needsCam ? (
              <p className="note warn">
                Your porch camera is off. Without it, you and the buyer confirm each pickup yourselves. <a href="#camera">Turn it on</a>
              </p>
            ) : null}
            {activeSales.length ? (
              <section className="stack" aria-labelledby="sales-h">
                <h2 id="sales-h">Sales in progress</h2>
                <div className="rows">
                  {activeSales.map((s) => (
                    <SaleRow key={s.dealId} shop={shop} token={token} sale={s} porch={st.shop.porchInstructions} camOn={camOn} onDone={refresh} toast={toast} />
                  ))}
                </div>
              </section>
            ) : null}
            <section className="stack" aria-labelledby="items-h">
              <div className="spread">
                <h2 id="items-h">{st.items.length ? "Your things" : "What are you selling?"}</h2>
              </div>
              <AddPhotos shop={shop} token={token} first={!st.items.length} onDone={refresh} toast={toast} />
              {unlisted.length ? (
                <div className="rows">
                  {unlisted.map((it) => (
                    <ListForm key={it.itemId} shop={shop} token={token} item={it} onDone={refresh} toast={toast} />
                  ))}
                </div>
              ) : null}
              {live.length ? (
                <div className="stack">
                  <h3>For sale now</h3>
                  <div className="rows">
                    {live.map((it) => (
                      <LiveRow key={it.itemId} shop={shop} item={it} />
                    ))}
                  </div>
                </div>
              ) : null}
              {blocked.map((it) => (
                <div key={it.itemId} className="item">
                  {it.photoUrl ? <img className="thumb" src={it.photoUrl} alt="" width={96} height={96} /> : <div className="thumb" />}
                  <div className="item-body">
                    <h3>{it.title}</h3>
                    <p className="note bad">
                      {it.blockedReason ?? "This can’t be sold on Stoop."} {it.alternative ?? ""}
                    </p>
                  </div>
                </div>
              ))}
            </section>
            {st.conversations.length ? <Conversations list={st.conversations} /> : null}
            {pastSales.length ? (
              <section className="stack" aria-labelledby="past-h">
                <h2 id="past-h">Past sales</h2>
                <div className="rows">
                  {pastSales.map((s) => (
                    <SaleRow key={s.dealId} shop={shop} token={token} sale={s} porch={st.shop.porchInstructions} camOn={camOn} onDone={refresh} toast={toast} />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
          <aside className="col">
            <CameraPanel shop={shop} token={token} camera={st.shop.camera} />
            <SharePanel shop={shop} name={st.shop.displayName} hasLive={live.length > 0} />
            <AssistantPanel shop={shop} token={token} onChange={refresh} />
            <OtherDevice shop={shop} token={token} />
            <details className="stack-s">
              <summary className="sum small">Tell us how it’s going</summary>
              <Feedback role="seller" shop={shop} />
            </details>
          </aside>
        </div>
      </main>
      {node}
    </>
  );
}

// ---------- photos -> AI appraisal

function AddPhotos({ shop, token, first, onDone, toast }: { shop: string; token: string; first: boolean; onDone(): void; toast(t: string): void }) {
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("");
  const [err, setErr] = useState("");
  const [unknown, setUnknown] = useState(0);
  const busy = !!status;

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = [...files].slice(0, 8);
    setErr("");
    setUnknown(0);
    try {
      setStatus(`Preparing ${list.length} photo${list.length === 1 ? "" : "s"}…`);
      const photos = await Promise.all(list.map(async (f, i) => ({ name: f.name || `photo-${i + 1}.jpg`, dataUrl: await toJpeg(f) })));
      setStatus("Uploading…");
      await api(shop, "/sweep", { token, body: { photos } });
      setStatus(`Identifying and pricing ${list.length === 1 ? "your photo" : `${list.length} photos`}. This takes a few seconds each…`);
      const r = await act(shop, "seller", token, "appraise_photos", {});
      if (r.isError) setErr(r.text);
      else {
        toast(r.text);
        setUnknown((r.data.unidentified as string[] | undefined)?.length ?? 0);
      }
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn’t upload those photos. Try again.");
    } finally {
      setStatus("");
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div className={first ? "tone stack" : "stack-s"}>
      {first ? <p className="lede">Take one photo per thing, in good light, with the whole thing in view. Stoop names it, checks it isn’t recalled and suggests a price.</p> : null}
      <input ref={input} type="file" accept="image/*" multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void upload(e.target.files)} />
      <div className="row">
        <button type="button" className={first ? "btn big" : "btn quiet"} disabled={busy} onClick={() => input.current?.click()}>
          {busy ? "Working…" : first ? "Add Photos" : "Add More Photos"}
        </button>
        {!first ? <span className="meta">One photo per thing. Up to 8 at a time.</span> : null}
      </div>
      {status ? <Spinner label={status} /> : null}
      {unknown ? (
        <p className="note">
          Stoop couldn’t tell what’s in {unknown === 1 ? "one photo" : `${unknown} photos`}. Try a closer shot with the whole thing in view.
        </p>
      ) : null}
      {err ? (
        <p className="err" role="alert">
          {err}
        </p>
      ) : null}
    </div>
  );
}

const CONDITION = { A: "Like new", B: "Light wear", C: "Visible wear", D: "For parts" } as const;

function priceNote(it: ShopItem) {
  if (it.priceSource === "comps") return `Suggested from ${it.comps} similar sale${it.comps === 1 ? "" : "s"}.`;
  if (it.priceSource === "ai-estimate") return "AI estimate from your photo. Check it against similar listings near you.";
  return "No price suggestion for this one. Set your own.";
}

function ListForm({ shop, token, item, onDone, toast }: { shop: string; token: string; item: ShopItem; onDone(): void; toast(t: string): void }) {
  const [price, setPrice] = useState(item.listMinor ? String(item.listMinor / 100) : "");
  const [lowest, setLowest] = useState(item.floorSuggestionMinor ? String(item.floorSuggestionMinor / 100) : "");
  const [auto, setAuto] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const p = dollars(price);
  const l = dollars(lowest);
  const id = item.itemId;

  return (
    <form
      className="item"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!p) return setErr("Set a price.");
        if (!l) return setErr("Set the lowest price you’ll take.");
        if (l > p) return setErr("Your lowest price can’t be above the asking price.");
        setErr("");
        setBusy(true);
        try {
          const r = await act(shop, "seller", token, "list_items", { items: [id], askDollars: p });
          if (r.isError) throw new Error(r.text);
          const listingId = r.data.listings?.[0]?.listingId as string | undefined;
          if (listingId) {
            const m = await act(shop, "seller", token, "set_mandate", { item: listingId, floorDollars: l, ...(auto ? { autoAcceptAboveDollars: p } : {}) });
            if (m.isError) throw new Error(m.text);
          }
          toast(`${item.title} is for sale at ${money(Math.round(p * 100))}. Share the link so people find it.`);
          onDone();
        } catch (e2) {
          setErr(e2 instanceof Error ? e2.message : "Couldn’t list it. Try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      {item.photoUrl ? <img className="thumb" src={item.photoUrl} alt="" width={96} height={96} /> : <div className="thumb" />}
      <div className="item-body">
        <h3>{item.title}</h3>
        <p className="meta">
          {CONDITION[item.condition]}. {priceNote(item)}
        </p>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="field" style={{ flex: "1 1 120px", maxWidth: 170 }}>
            <span>Price</span>
            <span className="money">
              <input className="input" inputMode="decimal" autoComplete="off" name={`price-${id}`} value={price} onChange={(e) => setPrice(e.target.value)} />
            </span>
          </label>
          <label className="field" style={{ flex: "1 1 120px", maxWidth: 170 }}>
            <span>Lowest you’ll take</span>
            <span className="money">
              <input className="input" inputMode="decimal" autoComplete="off" name={`lowest-${id}`} value={lowest} onChange={(e) => setLowest(e.target.value)} />
            </span>
          </label>
        </div>
        <p className="meta">Buyers never see your lowest price. The assistant haggles above it and asks you before accepting less than your price.</p>
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span>Sell right away to anyone who offers the full price</span>
        </label>
        {err ? (
          <p className="err" role="alert">
            {err}
          </p>
        ) : null}
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Listing…" : p ? `List It at ${money(Math.round(p * 100))}` : "List It"}
        </button>
      </div>
    </form>
  );
}

const itemUrl = (shop: string, listingId: string) => `${location.origin}/shop/${shop}/item/${listingId}`;

function LiveRow({ shop, item }: { shop: string; item: ShopItem }) {
  const [qr, setQr] = useState(false);
  const url = itemUrl(shop, item.listing!.id);
  return (
    <div className="item">
      {item.photoUrl ? <img className="thumb" src={item.photoUrl} alt="" width={96} height={96} /> : <div className="thumb" />}
      <div className="item-body">
        <div className="spread">
          <h3>{item.title}</h3>
          <span className="num" style={{ fontWeight: 800, fontSize: "var(--t-m)" }}>
            {money(item.listing!.askMinor)}
          </span>
        </div>
        <p className="meta">
          For sale.{" "}
          <a href={url} target="_blank" rel="noreferrer">
            Open the listing
          </a>
        </p>
        <div className="row">
          <CopyButton text={url} />
          <ShareButton url={url} title={item.title} />
          <button type="button" className="btn quiet" aria-expanded={qr} onClick={() => setQr(!qr)}>
            {qr ? "Hide QR Code" : "QR Code"}
          </button>
        </div>
        {qr ? <QR text={url} label={`QR code for the ${item.title} listing`} /> : null}
      </div>
    </div>
  );
}

// ---------- offers

function Offers({ shop, token, offers, onDone, toast }: { shop: string; token: string; offers: Offer[]; onDone(): void; toast(t: string): void }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const respond = async (o: Offer, decision: "accept" | "decline") => {
    setBusy(o.approvalId);
    setErr("");
    try {
      const r = await act(shop, "seller", token, "respond_to_offer", { decision, approvalId: o.approvalId });
      if (r.isError) throw new Error(r.text);
      toast(decision === "accept" ? `Accepted ${money(o.amountMinor)}. The buyer pays next.` : "Declined. It stays for sale.");
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That didn’t go through.");
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="tone stack" aria-labelledby="offers-h" style={{ background: "color-mix(in oklab, var(--accent) 34%, var(--ground))" }}>
      <h2 id="offers-h">{offers.length === 1 ? "An offer is waiting" : `${offers.length} offers are waiting`}</h2>
      {offers.map((o) => {
        const fee = Math.round(o.amountMinor * 0.05);
        return (
          <div key={o.approvalId} className="stack-s">
            <p className="lede">
              {o.buyer} offers <strong className="num">{money(o.amountMinor)}</strong> for the {o.title}.
            </p>
            <p className="meta">
              You asked {money(o.askMinor)}. You’d get {money(o.amountMinor - fee)} after Stoop’s 5% fee, paid once the pickup is verified.
            </p>
            <div className="row">
              <button className="btn ink" type="button" disabled={!!busy} onClick={() => void respond(o, "accept")}>
                Accept {money(o.amountMinor)}
              </button>
              <button className="btn quiet" type="button" disabled={!!busy} onClick={() => void respond(o, "decline")}>
                Decline
              </button>
            </div>
          </div>
        );
      })}
      {err ? (
        <p className="err" role="alert">
          {err}
        </p>
      ) : null}
    </section>
  );
}

function Conversations({ list }: { list: Conversation[] }) {
  return (
    <details className="stack">
      <summary className="sum">What your assistant said to buyers</summary>
      <div className="rows" style={{ marginTop: 18 }}>
        {list.map((c, i) => (
          <div key={i} className="stack-s">
            <h3>
              {c.title}, with {c.buyer.replace(/ \(.*\)$/, "")}
            </h3>
            <div className="thread">
              {c.offers.map((o, j) => (
                <div key={j} className={`msg${o.by === "seller" ? " me" : ""}`}>
                  {o.message || money(o.amountMinor)}
                  <div className="meta num">
                    {o.by === "seller" ? "Your assistant" : "Buyer"}, {money(o.amountMinor)}, {clock(o.at)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

// ---------- a sale, step by step

const REACHED: Record<string, string[]> = {
  paid: ["FUNDS_HELD", "PASS_ISSUED", "WINDOW_OPEN", "STILL_THERE", "VERIFIED", "INSPECTION", "REVIEW", "DEGRADED", "DUAL_CONFIRMED", "CAPTURED", "PAYOUT_RECORDED", "CLOSED", "DISPUTE", "NO_SHOW", "PIRACY_SUSPECTED"],
  window: ["WINDOW_OPEN", "STILL_THERE", "VERIFIED", "INSPECTION", "REVIEW", "DEGRADED", "DUAL_CONFIRMED", "CAPTURED", "PAYOUT_RECORDED", "CLOSED", "DISPUTE", "NO_SHOW", "PIRACY_SUSPECTED"],
  picked: ["VERIFIED", "INSPECTION", "DUAL_CONFIRMED", "CAPTURED", "PAYOUT_RECORDED", "CLOSED"],
  paidOut: ["CAPTURED", "PAYOUT_RECORDED", "CLOSED"],
};

function SaleRow({ shop, token, sale, porch, camOn, onDone, toast }: { shop: string; token: string; sale: Sale; porch: string; camOn: boolean; onDone(): void; toast(t: string): void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [cancelAsk, setCancelAsk] = useState(false);
  const been = (k: keyof typeof REACHED) => REACHED[k]!.includes(sale.state) || sale.history.some((h) => REACHED[k]!.includes(h.state));
  const steps: Array<{ label: string; sub?: string; done: boolean }> = [
    { label: `Accepted at ${money(sale.amountMinor)}`, sub: sale.buyer, done: true },
    { label: "Buyer paid", sub: been("paidOut") ? `${money(sale.amountMinor)}, charged once the pickup was verified` : `${money(sale.amountMinor)} held, not charged yet`, done: been("paid") },
    {
      label: sale.window ? `Pickup window, until ${clock(sale.window.end)}` : "Pickup window",
      sub: sale.before ? (sale.before.presence === "present" ? "The camera sees the item on the porch." : "The camera doesn’t see the item yet. Put it out; it looks again every minute.") : sale.camera && sale.camera !== "ok" ? "The camera was off when the window opened." : undefined,
      done: been("window"),
    },
    { label: "Buyer at your door", sub: sale.checkInAt ? `Checked in at ${clock(sale.checkInAt)}` : undefined, done: !!sale.checkInAt },
    { label: "Picked up", sub: sale.verdict === "VERIFIED" ? "The camera saw someone at the door, then the item gone." : sale.state === "DUAL_CONFIRMED" || (sale.dual.buyer && sale.dual.seller) ? "You both confirmed." : undefined, done: been("picked") },
    { label: `Paid out ${money(sale.payoutMinor)}`, sub: "After Stoop’s 5% fee. Test payment: no real money moves.", done: been("paidOut") },
  ];
  const nowIdx = sale.active ? steps.findIndex((s) => !s.done) : -1;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
      toast(ok);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That didn’t go through.");
    } finally {
      setBusy(false);
    }
  };
  const tool = async (name: string) => {
    const r = await act(shop, "seller", token, name, { dealId: sale.dealId });
    if (r.isError) throw new Error(r.text);
  };

  let note: ReactNode = null;
  if (sale.state === "FUNDS_HELD" || sale.state === "PASS_ISSUED" || (sale.state === "WINDOW_OPEN" && !sale.checkInAt))
    note = (
      <p className="note warn">
        Put the {sale.title} out now: {porch.replace(/\.$/, "")}.{camOn ? "" : " Turn your porch camera on, too."}
      </p>
    );
  if (sale.state === "STILL_THERE") note = <p className="note warn">The buyer checked in, but the camera still sees the item. It checks again when there’s movement.</p>;
  if (sale.state === "REVIEW" || sale.state === "DEGRADED")
    note = (
      <div className="note warn stack-s">
        <p>The camera couldn’t confirm this pickup, so you both confirm. Once you both do, the payment goes through.</p>
        {sale.dual.seller ? (
          <p className="meta">You confirmed. Waiting for the buyer.</p>
        ) : (
          <button className="btn ink" type="button" disabled={busy} onClick={() => void run(() => tool("confirm_pickup"), "Thanks. Waiting for the buyer to confirm too.")}>
            The Buyer Has It
          </button>
        )}
      </div>
    );
  if (sale.state === "NO_SHOW") note = <p className="note">The buyer didn’t come. Their hold was released and the item is for sale again.</p>;
  if (sale.state === "PIRACY_SUSPECTED") note = <p className="note bad">The item left the porch without the buyer checking in, so they weren’t charged. If that wasn’t them, the camera’s photos are below.</p>;
  if (["VOIDED", "SELLER_CANCELLED", "CHECKOUT_ABANDONED"].includes(sale.state)) note = <p className="note">This sale didn’t happen. Nobody was charged.</p>;
  if (sale.state === "DISPUTE") note = <p className="note bad">The buyer reported a problem. The payment stays held while it’s reviewed.</p>;
  if (sale.state === "INSPECTION") note = <p className="note">Picked up. The buyer has two hours to check it, then the payment goes through.</p>;

  const canCancel = ["AGREED", "CHECKOUT_OPEN", "FUNDS_HELD", "PASS_ISSUED", "WINDOW_OPEN"].includes(sale.state) && !sale.checkInAt;
  const canRetake = sale.state === "WINDOW_OPEN" && !sale.checkInAt && sale.before && sale.before.presence !== "present";

  return (
    <article className="stack-s" aria-label={`Sale of the ${sale.title}`}>
      <div className="spread">
        <h3>{sale.title}</h3>
        <span className="num" style={{ fontWeight: 800 }}>
          {money(sale.amountMinor)}
        </span>
      </div>
      {note}
      <ol className="path">
        {steps.map((s, i) => (
          <li key={s.label} data-state={s.done ? "done" : i === nowIdx ? "now" : "todo"}>
            <span className="dot">{s.done ? <Check /> : null}</span>
            <span>
              <strong>{s.label}</strong>
              {s.sub ? <span className="meta" style={{ display: "block" }}>{s.sub}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      <Frames shop={shop} token={token} sale={sale} />
      {err ? (
        <p className="err" role="alert">
          {err}
        </p>
      ) : null}
      <div className="row">
        {canRetake ? (
          <button className="btn quiet" type="button" disabled={busy} onClick={() => void run(() => api(shop, `/web/sale/${sale.dealId}/before`, { token, body: {} }), "Looking at the porch again…")}>
            It’s Out Now, Look Again
          </button>
        ) : null}
        {sale.receiptId ? (
          <a className="btn quiet" href={`${base(shop)}/verify/${sale.receiptId}`} target="_blank" rel="noreferrer">
            Signed Receipt
          </a>
        ) : null}
        {canCancel ? (
          cancelAsk ? (
            <>
              <button className="btn quiet" type="button" disabled={busy} onClick={() => void run(() => tool("cancel_sale"), "Cancelled. The buyer’s hold was released.")}>
                Yes, Cancel the Sale
              </button>
              <button className="link" type="button" onClick={() => setCancelAsk(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button className="link" type="button" onClick={() => setCancelAsk(true)}>
              Cancel this sale
            </button>
          )
        ) : null}
      </div>
    </article>
  );
}

/** The porch photos of this sale. Only the seller sees them. */
function Frames({ shop, token, sale }: { shop: string; token: string; sale: Sale }) {
  const [urls, setUrls] = useState<{ before?: string; after?: string }>({});
  const key = `${sale.before?.at ?? ""}:${sale.after?.at ?? ""}`;
  useEffect(() => {
    let stop = false;
    const made: string[] = [];
    void (async () => {
      const out: { before?: string; after?: string } = {};
      for (const kind of ["before", "after"] as const) {
        if (!sale[kind]) continue;
        const r = await fetch(`${base(shop)}/web/frame/${sale.dealId}/${kind}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
        if (r?.ok) {
          const u = URL.createObjectURL(await r.blob());
          made.push(u);
          out[kind] = u;
        }
      }
      if (!stop) setUrls(out);
    })();
    return () => {
      stop = true;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, shop, token, sale.dealId]);
  if (!urls.before && !urls.after) return null;
  const word = (p?: string) => (p === "present" ? "item there" : p === "absent" ? "item gone" : "unclear");
  return (
    <div className="row" style={{ alignItems: "flex-start" }}>
      {(["before", "after"] as const).map((k) =>
        urls[k] ? (
          <figure key={k} style={{ margin: 0, width: 168 }}>
            <img className="photo" src={urls[k]} alt={`Porch ${k} the pickup`} width={168} height={126} />
            <figcaption className="meta num">
              {k === "before" ? "Before" : "After"}, {clock(sale[k]!.at)}: {word(sale[k]!.presence)}
            </figcaption>
          </figure>
        ) : null,
      )}
    </div>
  );
}

// ---------- side panels

function CameraPanel({ shop, token, camera }: { shop: string; token: string; camera: SellerState["shop"]["camera"] }) {
  const [link, setLink] = useState("");
  const [err, setErr] = useState("");
  const on = !!camera?.online;
  const phoneLink = async () => {
    setErr("");
    try {
      const r = await api<{ camToken: string }>(shop, "/web/cam/register", { token, body: {} });
      setLink(`${location.origin}/shop/${shop}/camera#ck=${r.camToken}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn’t make a camera link.");
    }
  };
  return (
    <section id="camera" className="tone stack" aria-labelledby="cam-h">
      <div className="spread">
        <h2 id="cam-h" style={{ fontSize: "var(--t-m)" }}>
          Porch camera
        </h2>
        <span className="live" data-on={on}>
          {on ? "On" : "Off"}
        </span>
      </div>
      <p className="meta">
        {on
          ? camera?.lastFrameAt
            ? `Last photo at ${clock(camera.lastFrameAt)}. Keep that page open while you have things for sale.`
            : "Connected. Keep that page open while you have things for sale."
          : "An old phone or a laptop at a window that sees where you leave things. It checks that the item is there before a pickup and gone after."}
      </p>
      {link ? (
        <div className="stack-s">
          <QR text={link} label="QR code that opens the porch camera page on your phone" />
          <p className="meta">Scan with the phone you’ll leave at the window. The link only works as this shop’s camera.</p>
          <CopyButton text={link} label="Copy Camera Link" />
        </div>
      ) : (
        <div className="row">
          {isPhone() ? null : (
            <button className={on ? "btn quiet" : "btn"} type="button" onClick={() => void phoneLink()}>
              {on ? "Move It to Another Phone" : "Use Your Phone"}
            </button>
          )}
          <button className={isPhone() && !on ? "btn" : "btn quiet"} type="button" onClick={() => navigate(`/shop/${shop}/camera`)}>
            {on ? "Use This Device Instead" : "Use This Device"}
          </button>
        </div>
      )}
      {err ? (
        <p className="err" role="alert">
          {err}
        </p>
      ) : null}
    </section>
  );
}

function SharePanel({ shop, name, hasLive }: { shop: string; name: string; hasLive: boolean }) {
  const url = `${location.origin}/shop/${shop}`;
  return (
    <section className="stack-s" aria-labelledby="share-h">
      <h2 id="share-h" style={{ fontSize: "var(--t-m)" }}>
        Share your shop
      </h2>
      <p className="meta">{hasLive ? "Send this to neighbors, a group chat or a local buy-and-sell group. People buy from the link." : "Once something is for sale, share this link."}</p>
      <div className="row">
        <CopyButton text={url} label="Copy Shop Link" />
        <ShareButton url={url} title={`${name}’s shop on Stoop`} />
      </div>
    </section>
  );
}

function OtherDevice({ shop, token }: { shop: string; token: string }) {
  const [show, setShow] = useState(false);
  const url = `${location.origin}/shop/${shop}#sk=${token}`;
  return (
    <section className="stack-s" aria-labelledby="dev-h">
      <h2 id="dev-h" style={{ fontSize: "var(--t-m)" }}>
        Manage from another device
      </h2>
      <p className="meta">Anyone with this private link can run your shop. Don’t share it.</p>
      {show ? (
        <div className="stack-s">
          <QR text={url} label="QR code that opens this shop’s dashboard on another device" />
          <CopyButton text={url} label="Copy Private Link" />
        </div>
      ) : (
        <button className="btn quiet" type="button" onClick={() => setShow(true)}>
          Show Private Link
        </button>
      )}
    </section>
  );
}

function AssistantPanel({ shop, token, onChange }: { shop: string; token: string; onChange(): void }) {
  const conv = useConversation({ shop, role: "seller", token, storeKey: `stoop:thread:${shop}:seller`, context: {}, onChange });
  return (
    <section className="stack-s" aria-labelledby="ask-h">
      <h2 id="ask-h" style={{ fontSize: "var(--t-m)" }}>
        Ask Stoop
      </h2>
      <p className="meta">Type or talk, the way you would to Alexa: “Any offers?” or “Don’t take less than $90 for the stroller.”</p>
      <Thread lines={conv.lines.slice(-8)} />
      {conv.approval ? <ApprovalPrompt a={conv.approval} busy={conv.busy} onAnswer={(d) => void conv.answer(d)} /> : null}
      <Composer onSay={(t, aloud) => void conv.say(t, aloud)} busy={conv.busy} label="Ask Stoop" placeholder="Ask Stoop…" />
      {conv.busy ? <Spinner label="Working…" /> : null}
    </section>
  );
}

// ======================================================================== buyers: the storefront

interface Storefront {
  displayName: string;
  zip: string;
  listings: Array<{ id: string; title: string; askMinor: number; state: string; photoUrl?: string }>;
}

function Storefront({ shop, preview }: { shop: string; preview: boolean }) {
  const [sf, setSf] = useState<Storefront>();
  const [closed, setClosed] = useState(false);
  useTitle(sf ? `${sf.displayName}’s shop` : "Shop");
  usePoll(
    async () => {
      try {
        setSf(await api<Storefront>(shop, "/web/storefront"));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) setClosed(true);
      }
    },
    15_000,
    [shop],
  );
  if (closed) return <Closed />;
  if (!sf) return <Spinner label="Loading…" />;
  const live = sf.listings.filter((l) => l.state === "LIVE");
  return (
    <>
      <Bar right={preview ? <Link to={`/shop/${shop}`}>Back to Your Shop</Link> : <Link to="/sell">Sell Your Own Things</Link>} />
      <main id="main" className="page" style={{ paddingBottom: 72 }}>
        <header className="stack-s" style={{ paddingBlock: "8px 36px" }}>
          <h1 style={{ fontSize: "var(--t-l)" }}>{sf.displayName}’s porch</h1>
          <p className="meta">Contactless pickup in {sf.zip}. Pay first; you’re only charged once your pickup is verified.</p>
        </header>
        {live.length ? (
          <div className="steps" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 260px), 1fr))" }}>
            {live.map((l, i) => (
              <Link key={l.id} to={`/shop/${shop}/item/${l.id}`} className="tile stack-s in" style={{ ["--i" as string]: i }}>
                {l.photoUrl ? <img className="photo" src={l.photoUrl} alt="" width={400} height={300} loading="lazy" /> : <div className="photo" />}
                <span className="spread">
                  <strong>{l.title}</strong>
                  <span className="num" style={{ fontWeight: 800 }}>
                    {money(l.askMinor)}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="lede">Nothing for sale right now. Check back soon.</p>
        )}
      </main>
    </>
  );
}
