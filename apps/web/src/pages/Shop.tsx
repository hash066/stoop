import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { act, api, ApiError, base, clock, dollars, inSentence, isPhone, money, request, tokens, toJpeg } from "../api.ts";
import { ApprovalPrompt, Composer, Thread, useConversation } from "../conversation.tsx";
import { Alert, Camera, Check, External, Phone, Qr, Receipt, Share as ShareIcon, Spark, Upload, Voice } from "../icons.tsx";
import { Closed, CopyButton, initials, Link, Loading, navigate, Nav, QR, ShareButton, Spinner, usePoll, useTitle, useToast } from "../ui.tsx";
import { Feedback } from "./Feedback.tsx";
import { ReviewList, type ShopReview } from "./Review.tsx";
import { Rating } from "./Street.tsx";

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

const PAID_OUT = ["CAPTURED", "PAYOUT_RECORDED", "CLOSED"];
const cfg = (window as { __STOOP__?: { alexaSkill?: boolean } }).__STOOP__ ?? {};
const buyerName = (label: string) => label.replace(/ \(.*\)$/, "");

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
  if (!st) return <Loading label="Opening your shop…" />;

  const unlisted = st.items.filter((i) => !i.blocked && (!i.listing || ["AWAITING_SELLER_OK", "RELISTED", "WITHDRAWN", "EXPIRED"].includes(i.listing.state)));
  const live = st.items.filter((i) => i.listing?.state === "LIVE");
  const blocked = st.items.filter((i) => i.blocked);
  const activeSales = st.sales.filter((s) => s.active);
  const pastSales = st.sales.filter((s) => !s.active);
  const earned = st.sales.filter((s) => PAID_OUT.includes(s.state)).reduce((t, s) => t + s.payoutMinor, 0);
  const camOn = !!st.shop.camera?.online;
  const needsCam = !camOn && (live.length > 0 || activeSales.length > 0);
  const photoFor = (listingId: string) => st.items.find((i) => i.listing?.id === listingId)?.photoUrl;

  return (
    <>
      <a className="skip btn dark" href="#main">
        Skip to Content
      </a>
      <Nav
        right={
          <Link to={`/shop/${shop}?view=buyer`} className="btn ghost sm">
            See It as a Buyer
          </Link>
        }
      />
      <main id="main" className="page" style={{ paddingBottom: 80 }}>
        <header className="app-head grid-2" style={{ alignItems: "center" }}>
          <div className="row" style={{ gap: 16, flexWrap: "nowrap" }}>
            <span className="avatar lg sun" aria-hidden="true">
              {initials(st.shop.displayName)}
            </span>
            <div>
              <h1 style={{ fontSize: "var(--t-xl)" }}>{st.shop.displayName}’s shop</h1>
              <p className="muted small">
                Porch pickup in {st.shop.zip} · {st.shop.porchInstructions}
              </p>
            </div>
          </div>
          <div className="stats">
            <div className="stat-tile">
              <span className="tiny">For sale</span>
              <b className="num">{live.length}</b>
            </div>
            <div className="stat-tile" style={offers ? { background: "var(--sun)" } : undefined}>
              <span className="tiny" style={offers ? { color: "var(--ink)" } : undefined}>
                Offers
              </span>
              <b className="num">{offers}</b>
            </div>
            <div className="stat-tile">
              <span className="tiny">Earned</span>
              <b className="num">{money(earned)}</b>
            </div>
          </div>
        </header>

        <div className="grid-2">
          <div className="stack" style={{ ["--gap" as string]: "20px" }}>
            {st.offers.length ? <Offers shop={shop} token={token} offers={st.offers} photoFor={photoFor} onDone={refresh} toast={toast} /> : null}
            {needsCam ? (
              <p className="note warn">
                <Alert />
                <span>
                  Your porch camera is off. Without it, you and the buyer confirm each pickup yourselves. <a href="#camera">Turn it on</a>
                </span>
              </p>
            ) : null}
            {activeSales.map((s) => (
              <SaleCard key={s.dealId} shop={shop} token={token} sale={s} photo={photoFor(s.listingId)} porch={st.shop.porchInstructions} camOn={camOn} onDone={refresh} toast={toast} />
            ))}

            <section className="card stack" aria-labelledby="items-h">
              <div className="spread">
                <h2 id="items-h" style={{ fontSize: "var(--t-l)" }}>
                  {st.items.length ? "Your things" : "What are you selling?"}
                </h2>
                {st.items.length ? <span className="tiny">One photo per thing, up to 8 at a time</span> : null}
              </div>
              <AddPhotos shop={shop} token={token} first={!st.items.length} onDone={refresh} toast={toast} />
              {unlisted.map((it) => (
                <ListForm key={it.itemId} shop={shop} token={token} item={it} onDone={refresh} toast={toast} />
              ))}
              {live.length ? (
                <div className="stack-s">
                  <h3>For sale now</h3>
                  <div className="item-grid">
                    {live.map((it) => (
                      <LiveCard key={it.itemId} shop={shop} item={it} />
                    ))}
                  </div>
                </div>
              ) : null}
              {blocked.map((it) => (
                <div key={it.itemId} className="list-form">
                  {it.photoUrl ? <img className="photo" src={it.photoUrl} alt="" width={132} height={132} /> : <div className="photo" />}
                  <div className="stack-s">
                    <h3>{it.title}</h3>
                    <p className="note bad">
                      <Alert />
                      <span>
                        {it.blockedReason ?? "This can’t be sold on Stoop."} {it.alternative ?? ""}
                      </span>
                    </p>
                  </div>
                </div>
              ))}
            </section>

            {pastSales.length ? (
              <section className="card stack" aria-labelledby="past-h">
                <h2 id="past-h" style={{ fontSize: "var(--t-l)" }}>
                  Past sales
                </h2>
                {pastSales.map((s) => (
                  <SaleCard key={s.dealId} shop={shop} token={token} sale={s} photo={photoFor(s.listingId)} porch={st.shop.porchInstructions} camOn={camOn} onDone={refresh} toast={toast} flat />
                ))}
              </section>
            ) : null}
            {st.conversations.length ? <Conversations list={st.conversations} /> : null}
          </div>

          <aside className="stack" style={{ ["--gap" as string]: "16px" }}>
            <CameraPanel shop={shop} token={token} camera={st.shop.camera} />
            {cfg.alexaSkill ? <AlexaPanel shop={shop} token={token} /> : null}
            <SharePanel shop={shop} name={st.shop.displayName} hasLive={live.length > 0} />
            <AssistantPanel shop={shop} token={token} onChange={refresh} />
            <OtherDevice shop={shop} token={token} />
            <details className="card stack">
              <summary>Tell us how it’s going</summary>
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
  const [over, setOver] = useState(false);
  const busy = !!status;

  const upload = async (files: FileList | File[] | null) => {
    const list = [...(files ?? [])].filter((f) => f.type.startsWith("image/")).slice(0, 8);
    if (!list.length) return;
    setErr("");
    setUnknown(0);
    try {
      setStatus(`Preparing ${list.length} photo${list.length === 1 ? "" : "s"}…`);
      const photos = await Promise.all(list.map(async (f, i) => ({ name: f.name || `photo-${i + 1}.jpg`, dataUrl: await toJpeg(f) })));
      setStatus("Uploading…");
      await api(shop, "/sweep", { token, body: { photos } });
      setStatus(`The AI is identifying and pricing ${list.length === 1 ? "your photo" : `${list.length} photos`}. A few seconds each…`);
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
    <div className="stack-s">
      <input ref={input} type="file" accept="image/*" multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void upload(e.target.files)} />
      <button
        type="button"
        className={`drop${over ? " over" : ""}`}
        disabled={busy}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void upload([...e.dataTransfer.files]);
        }}
        style={first ? undefined : { padding: "20px" }}
      >
        <Upload />
        <span style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: first ? "1.375rem" : "1.125rem" }}>{busy ? "Working…" : first ? "Add Photos of What You’re Selling" : "Add More Photos"}</span>
        <span className="small" style={{ color: "var(--green-3)" }}>
          {first ? "One photo per thing, in good light, whole thing in view. Drop them here or tap to choose." : "Drop photos here or tap to choose"}
        </span>
      </button>
      {status ? <Spinner label={status} /> : null}
      {unknown ? (
        <p className="note">
          <Camera />
          <span>Stoop couldn’t tell what’s in {unknown === 1 ? "one photo" : `${unknown} photos`}. Try a closer shot with the whole thing in view.</span>
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
  if (it.priceSource === "comps") return `From ${it.comps} similar sale${it.comps === 1 ? "" : "s"}`;
  if (it.priceSource === "ai-estimate") return "AI estimate: check it against listings near you";
  return "No suggestion: set your own";
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
      className="list-form card flat"
      style={{ padding: 16 }}
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
      {item.photoUrl ? <img className="photo" src={item.photoUrl} alt="" width={132} height={132} /> : <div className="photo" />}
      <div className="stack" style={{ ["--gap" as string]: "14px" }}>
        <div className="stack-s">
          <div className="row" style={{ gap: 8 }}>
            <span className="badge">
              <Spark /> {CONDITION[item.condition]}
            </span>
            <span className={`badge ${item.priceSource === "comps" ? "" : "sun"}`}>{priceNote(item)}</span>
          </div>
          <h3>{item.title}</h3>
        </div>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="field" style={{ flex: "1 1 120px", maxWidth: 170 }}>
            <span className="label">Price</span>
            <span className="money">
              <input className="input" inputMode="decimal" autoComplete="off" name={`price-${id}`} value={price} onChange={(e) => setPrice(e.target.value)} />
            </span>
          </label>
          <label className="field" style={{ flex: "1 1 120px", maxWidth: 170 }}>
            <span className="label">Lowest you’ll take</span>
            <span className="money">
              <input className="input" inputMode="decimal" autoComplete="off" name={`lowest-${id}`} value={lowest} onChange={(e) => setLowest(e.target.value)} />
            </span>
          </label>
        </div>
        <p className="tiny">Buyers never see your lowest price. The AI haggles above it and asks you before accepting less than your price.</p>
        <label className="check small">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span>Sell right away to anyone who offers the full price</span>
        </label>
        {err ? (
          <p className="err" role="alert">
            {err}
          </p>
        ) : null}
        <div>
          <button className="btn lg" type="submit" disabled={busy}>
            {busy ? "Listing…" : p ? `List It at ${money(Math.round(p * 100))}` : "List It"}
          </button>
        </div>
      </div>
    </form>
  );
}

const itemUrl = (shop: string, listingId: string) => `${location.origin}/shop/${shop}/item/${listingId}`;

function LiveCard({ shop, item }: { shop: string; item: ShopItem }) {
  const [qr, setQr] = useState(false);
  const [post, setPost] = useState(false);
  const url = itemUrl(shop, item.listing!.id);
  return (
    <div className="item-card card flat" style={{ padding: 12 }}>
      {item.photoUrl ? <img className="photo" src={item.photoUrl} alt="" width={400} height={300} /> : <div className="photo" />}
      <div className="spread" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
        <h3 style={{ fontSize: "var(--t-b)" }}>{item.title}</h3>
        <span className="price" style={{ fontSize: "1.375rem" }}>
          {money(item.listing!.askMinor)}
        </span>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <span className="badge">
          <span className="dot live" /> For sale
        </span>
        <a className="tiny" href={url} target="_blank" rel="noreferrer">
          Open listing
        </a>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <CopyButton text={url} className="btn ghost sm" />
        <button type="button" className="btn ghost sm" aria-expanded={qr} onClick={() => setQr(!qr)}>
          <Qr /> {qr ? "Hide" : "QR"}
        </button>
      </div>
      <button type="button" className="btn soft sm" aria-expanded={post} onClick={() => setPost(!post)}>
        <ShareIcon /> Post Everywhere
      </button>
      {qr ? <QR text={url} label={`QR code for the ${inSentence(item.title)} listing`} /> : null}
      {post ? <PostEverywhere item={item} url={url} /> : null}
    </div>
  );
}

const PLACES = [
  ["Facebook Marketplace", "https://www.facebook.com/marketplace/create/item"],
  ["Craigslist", "https://post.craigslist.org/"],
  ["Nextdoor", "https://nextdoor.com/for_sale_and_free/"],
  ["OfferUp", "https://offerup.com/sell/"],
] as const;

/** Ready-to-paste posts for other marketplaces. Every buyer comes back to Stoop's checkout through the link. */
function PostEverywhere({ item, url }: { item: ShopItem; url: string }) {
  const price = money(item.listing!.askMinor);
  const text = `${item.title}, ${price}. ${CONDITION[item.condition]}.\nContactless porch pickup: pay on Stoop, and you’re only charged once the pickup is verified. Ask questions or make an offer here: ${url}`;
  return (
    <div className="stack-s" style={{ paddingTop: 4 }}>
      <p className="tiny">Paste this anywhere people buy secondhand. Offers and payment all come back through your Stoop link.</p>
      <pre className="small" style={{ whiteSpace: "pre-wrap", margin: 0, padding: 12, borderRadius: 12, background: "var(--mint-2)", fontFamily: "inherit" }}>
        {text}
      </pre>
      <div className="row" style={{ gap: 8 }}>
        <CopyButton text={text} label="Copy Post" className="btn dark sm" />
        {item.photoUrl ? (
          <a className="btn ghost sm" href={item.photoUrl} download={`${item.title}.jpg`}>
            Photo
          </a>
        ) : null}
      </div>
      <div className="row" style={{ gap: 8 }}>
        {PLACES.map(([name, href]) => (
          <a key={name} className="btn ghost sm" href={href} target="_blank" rel="noreferrer">
            {name} <External />
          </a>
        ))}
      </div>
    </div>
  );
}

// ---------- offers

function Offers({ shop, token, offers, photoFor, onDone, toast }: { shop: string; token: string; offers: Offer[]; photoFor(id: string): string | undefined; onDone(): void; toast(t: string): void }) {
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
    <section className="card attn stack" aria-labelledby="offers-h">
      <div className="row" style={{ gap: 10 }}>
        <span className="dot live" style={{ color: "var(--sun)", width: 10, height: 10 }} />
        <h2 id="offers-h" style={{ fontSize: "var(--t-l)" }}>
          {offers.length === 1 ? "You have an offer" : `You have ${offers.length} offers`}
        </h2>
      </div>
      {offers.map((o) => {
        const fee = Math.round(o.amountMinor * 0.05);
        const photo = photoFor(o.listingId);
        return (
          <div key={o.approvalId} className="row" style={{ alignItems: "flex-start", gap: 16, flexWrap: "nowrap" }}>
            {photo ? <img className="thumb" src={photo} alt="" width={72} height={72} /> : null}
            <div className="stack-s" style={{ flex: 1 }}>
              <p style={{ fontSize: "var(--t-m)" }}>
                <strong>{buyerName(o.buyer)}</strong> offers <span className="price" style={{ fontSize: "1.75rem" }}>{money(o.amountMinor)}</span> for the {inSentence(o.title)}.
              </p>
              <p className="tiny">
                You asked {money(o.askMinor)}. You’d get {money(o.amountMinor - fee)} after Stoop’s 5% fee, paid once the pickup is verified.
              </p>
              <div className="row">
                <button className="btn dark" type="button" disabled={!!busy} onClick={() => void respond(o, "accept")}>
                  <Check /> Accept {money(o.amountMinor)}
                </button>
                <button className="btn ghost" type="button" disabled={!!busy} onClick={() => void respond(o, "decline")}>
                  Decline
                </button>
              </div>
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
    <details className="card stack">
      <summary>What your AI assistant said to buyers</summary>
      <div className="stack" style={{ marginTop: 18 }}>
        {list.map((c, i) => (
          <div key={i} className="stack-s">
            <h4>
              {c.title} · {buyerName(c.buyer)}
            </h4>
            <div className="chat">
              {c.offers.map((o, j) => (
                <div key={j} className={`bubble-row${o.by === "seller" ? "" : " me"}`}>
                  <div className="bubble small">
                    {o.message || money(o.amountMinor)}
                    <span className="who" style={o.by === "buyer" ? { color: "rgb(255 255 255 / 0.7)" } : undefined}>
                      {o.by === "seller" ? "Your assistant" : "Buyer"} · {money(o.amountMinor)} · {clock(o.at)}
                    </span>
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
  paidOut: PAID_OUT,
};

function SaleCard(p: { shop: string; token: string; sale: Sale; photo?: string; porch: string; camOn: boolean; onDone(): void; toast(t: string): void; flat?: boolean }) {
  const { shop, token, sale } = p;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [cancelAsk, setCancelAsk] = useState(false);
  const been = (k: keyof typeof REACHED) => REACHED[k]!.includes(sale.state) || sale.history.some((h) => REACHED[k]!.includes(h.state));
  const steps: Array<{ label: string; sub?: string; done: boolean }> = [
    { label: `Accepted at ${money(sale.amountMinor)}`, sub: buyerName(sale.buyer), done: true },
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
      p.toast(ok);
      p.onDone();
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
  if (sale.state === "FUNDS_HELD" || sale.state === "PASS_ISSUED" || (sale.state === "WINDOW_OPEN" && !sale.checkInAt && sale.before?.presence !== "present"))
    note = (
      <p className="note warn">
        <Alert />
        <span>
          Put the {inSentence(sale.title)} out now: {p.porch.replace(/\.$/, "")}.{p.camOn ? "" : " Turn your porch camera on, too."}
        </span>
      </p>
    );
  if (sale.state === "STILL_THERE")
    note = (
      <p className="note warn">
        <Alert />
        <span>The buyer checked in, but the camera still sees the item. It checks again when there’s movement.</span>
      </p>
    );
  if (sale.state === "REVIEW" || sale.state === "DEGRADED")
    note = (
      <div className="note warn" style={{ display: "grid" }}>
        <p>The camera couldn’t confirm this pickup, so you both confirm. Once you both do, the payment goes through.</p>
        {sale.dual.seller ? (
          <p className="small">You confirmed. Waiting for the buyer.</p>
        ) : (
          <div>
            <button className="btn dark" type="button" disabled={busy} onClick={() => void run(() => tool("confirm_pickup"), "Thanks. Waiting for the buyer to confirm too.")}>
              The Buyer Has It
            </button>
          </div>
        )}
      </div>
    );
  if (sale.state === "NO_SHOW") note = <p className="note">The buyer didn’t come. Their hold was released and the item is for sale again.</p>;
  if (sale.state === "PIRACY_SUSPECTED")
    note = (
      <p className="note bad">
        <Alert />
        <span>The item left the porch without the buyer checking in, so they weren’t charged. The camera’s photos are below.</span>
      </p>
    );
  if (["VOIDED", "SELLER_CANCELLED", "CHECKOUT_ABANDONED"].includes(sale.state)) note = <p className="note">This sale didn’t happen. Nobody was charged.</p>;
  if (sale.state === "DISPUTE") note = <p className="note bad">The buyer reported a problem. The payment stays held while it’s reviewed.</p>;
  if (sale.state === "INSPECTION") note = <p className="note">Picked up. The buyer has two hours to check it, then the payment goes through.</p>;

  const canCancel = ["AGREED", "CHECKOUT_OPEN", "FUNDS_HELD", "PASS_ISSUED", "WINDOW_OPEN"].includes(sale.state) && !sale.checkInAt;
  const canRetake = sale.state === "WINDOW_OPEN" && !sale.checkInAt && sale.before && sale.before.presence !== "present";
  const done = PAID_OUT.includes(sale.state);

  return (
    <article className={p.flat ? "stack" : "card stack"} aria-label={`Sale of the ${inSentence(sale.title)}`} style={p.flat ? { paddingTop: 18, borderTop: "1px solid var(--line)" } : undefined}>
      <div className="row" style={{ gap: 14, flexWrap: "nowrap" }}>
        {p.photo ? <img className="thumb" src={p.photo} alt="" width={72} height={72} /> : null}
        <div style={{ flex: 1 }}>
          <span className={`badge ${done ? "" : sale.active ? "sun" : "gray"}`}>{done ? "Sold" : sale.active ? "Sale in progress" : "Ended"}</span>
          <h3 style={{ marginTop: 6 }}>{sale.title}</h3>
        </div>
        <span className="price" style={{ fontSize: "1.75rem" }}>
          {money(sale.amountMinor)}
        </span>
      </div>
      {note}
      <ol className="path">
        {steps.map((s, i) => (
          <li key={s.label} data-state={s.done ? "done" : i === nowIdx ? "now" : "todo"}>
            <span className="step-dot">{s.done ? <Check /> : null}</span>
            <span>
              <strong>{s.label}</strong>
              {s.sub ? <span className="tiny" style={{ display: "block" }}>{s.sub}</span> : null}
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
          <button className="btn soft" type="button" disabled={busy} onClick={() => void run(() => api(shop, `/web/sale/${sale.dealId}/before`, { token, body: {} }), "Looking at the porch again…")}>
            <Camera /> It’s Out Now, Look Again
          </button>
        ) : null}
        {sale.receiptId ? (
          <a className="btn soft" href={`${base(shop)}/verify/${sale.receiptId}`} target="_blank" rel="noreferrer">
            <Receipt /> Signed Receipt
          </a>
        ) : null}
        {canCancel ? (
          cancelAsk ? (
            <>
              <button className="btn danger" type="button" disabled={busy} onClick={() => void run(() => tool("cancel_sale"), "Cancelled. The buyer’s hold was released.")}>
                Yes, Cancel the Sale
              </button>
              <button className="link" type="button" onClick={() => setCancelAsk(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button className="link tiny" type="button" onClick={() => setCancelAsk(true)}>
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
    <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
      {(["before", "after"] as const).map((k) =>
        urls[k] ? (
          <figure key={k} style={{ margin: 0, width: 180 }}>
            <img className="photo" src={urls[k]} alt={`Porch ${k} the pickup`} width={180} height={135} style={{ borderRadius: 14 }} />
            <figcaption className="tiny" style={{ marginTop: 6 }}>
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
    <section id="camera" className="card cam-tile stack" aria-labelledby="cam-h">
      <div className="spread">
        <div className="row" style={{ gap: 10 }}>
          <span className="step-n" style={{ background: "rgb(255 255 255 / 0.1)", color: "var(--sun)" }}>
            <Camera />
          </span>
          <h2 id="cam-h" style={{ fontSize: "var(--t-m)" }}>
            Porch camera
          </h2>
        </div>
        <span className={`badge ${on ? "sun" : "dark"}`}>
          <span className={`dot${on ? " live" : ""}`} /> {on ? "On" : "Off"}
        </span>
      </div>
      <p className="muted small">
        {on
          ? camera?.lastFrameAt
            ? `Last photo at ${clock(camera.lastFrameAt)}. Keep that page open while you have things for sale.`
            : "Connected. Keep that page open while you have things for sale."
          : "An old phone or a laptop at a window that sees where you leave things. It checks the item is there before a pickup and gone after."}
      </p>
      {link ? (
        <div className="stack-s">
          <QR text={link} label="QR code that opens the porch camera page on your phone" />
          <p className="tiny">Scan with the phone you’ll leave at the window. The link only works as this shop’s camera.</p>
          <CopyButton text={link} label="Copy Camera Link" className="btn on-dark sm" />
        </div>
      ) : (
        <div className="row">
          {isPhone() ? null : (
            <button className={on ? "btn on-dark" : "btn"} type="button" onClick={() => void phoneLink()}>
              <Phone /> {on ? "Move to Another Phone" : "Use Your Phone"}
            </button>
          )}
          <button className={isPhone() && !on ? "btn" : "btn on-dark"} type="button" onClick={() => navigate(`/shop/${shop}/camera`)}>
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

/** Link this shop to the seller's Alexa: a 6-digit code they say to the Stoop skill. */
function AlexaPanel({ shop, token }: { shop: string; token: string }) {
  const [code, setCode] = useState<string>();
  const [err, setErr] = useState("");
  const get = async () => {
    setErr("");
    try {
      setCode((await request<{ code: string }>("/api/alexa/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shop, token }) })).code);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn’t get a code. Try again.");
    }
  };
  return (
    <section className="card green stack" aria-labelledby="alexa-h">
      <div className="row" style={{ gap: 10 }}>
        <span className="step-n">
          <Voice />
        </span>
        <h2 id="alexa-h" style={{ fontSize: "var(--t-m)", color: "#fff" }}>
          Talk to your shop on Alexa
        </h2>
      </div>
      {code ? (
        <div className="stack-s">
          <p className="small">Say “Alexa, open stoop shop”, then tell it this code:</p>
          <p className="countdown num" style={{ color: "var(--sun)", letterSpacing: "0.08em" }} aria-label={`Code ${code.split("").join(" ")}`}>
            {code.slice(0, 3)} {code.slice(3)}
          </p>
          <p className="tiny">It works once, for the next 10 minutes. After that, try “Alexa, ask stoop shop if I have any offers.”</p>
        </div>
      ) : (
        <>
          <p className="muted small">Hear offers, say yes to a sale and check on a pickup from any Echo or the Alexa app.</p>
          <div>
            <button className="btn" type="button" onClick={() => void get()}>
              Get a Code
            </button>
          </div>
        </>
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
    <section className="card sun stack-s" aria-labelledby="share-h">
      <h2 id="share-h" style={{ fontSize: "var(--t-m)" }}>
        Share your shop
      </h2>
      <p className="small">{hasLive ? "Send it to neighbors, a group chat or a local buy-and-sell group. People buy from the link." : "Once something is for sale, share this link."}</p>
      <div className="row">
        <CopyButton text={url} label="Copy Shop Link" className="btn dark" />
        <ShareButton url={url} title={`${name}’s shop on Stoop`} className="btn ghost" />
      </div>
    </section>
  );
}

function OtherDevice({ shop, token }: { shop: string; token: string }) {
  const [show, setShow] = useState(false);
  const url = `${location.origin}/shop/${shop}#sk=${token}`;
  return (
    <section className="card flat stack-s" aria-labelledby="dev-h">
      <h2 id="dev-h" style={{ fontSize: "var(--t-b)" }}>
        Manage from another device
      </h2>
      <p className="tiny">Anyone with this private link can run your shop. Don’t share it.</p>
      {show ? (
        <div className="stack-s">
          <QR text={url} label="QR code that opens this shop’s dashboard on another device" />
          <CopyButton text={url} label="Copy Private Link" className="btn ghost sm" />
        </div>
      ) : (
        <div>
          <button className="btn ghost sm" type="button" onClick={() => setShow(true)}>
            Show Private Link
          </button>
        </div>
      )}
    </section>
  );
}

function AssistantPanel({ shop, token, onChange }: { shop: string; token: string; onChange(): void }) {
  const conv = useConversation({ shop, role: "seller", token, storeKey: `stoop:thread:${shop}:seller`, context: {}, onChange });
  return (
    <section className="card stack" aria-labelledby="ask-h">
      <div className="row" style={{ gap: 10 }}>
        <span className="step-n" style={{ background: "var(--sun)", color: "var(--ink)" }}>
          <Spark />
        </span>
        <div>
          <h2 id="ask-h" style={{ fontSize: "var(--t-m)" }}>
            Ask Stoop
          </h2>
          <p className="tiny">Type or talk, like you would to Alexa.</p>
        </div>
      </div>
      {conv.lines.length ? (
        <Thread lines={conv.lines.slice(-8)} typing={conv.busy && !conv.pending} />
      ) : (
        <div className="row" style={{ gap: 8 }}>
          {["Any offers?", "How’s my sale going?", "What am I selling?"].map((q) => (
            <button key={q} type="button" className="btn ghost sm" disabled={conv.busy} onClick={() => void conv.say(q)}>
              “{q}”
            </button>
          ))}
        </div>
      )}
      {conv.pending ? <ApprovalPrompt a={conv.pending} onAnswer={(d, c) => conv.answer(d, c)} /> : null}
      <Composer onSay={(t, aloud) => void conv.say(t, aloud)} busy={conv.busy} label="Ask Stoop" placeholder="Ask Stoop…" />
    </section>
  );
}

// ======================================================================== buyers: the storefront

interface StorefrontData {
  displayName: string;
  zip: string;
  rating: { avg: number | null; count: number; verified: number };
  reviews: ShopReview[];
  listings: Array<{ id: string; title: string; askMinor: number; state: string; photoUrl?: string }>;
}

function Storefront({ shop, preview }: { shop: string; preview: boolean }) {
  const [sf, setSf] = useState<StorefrontData>();
  const [closed, setClosed] = useState(false);
  useTitle(sf ? `${sf.displayName}’s porch` : "Shop");
  usePoll(
    async () => {
      try {
        setSf(await api<StorefrontData>(shop, "/web/storefront"));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) setClosed(true);
      }
    },
    15_000,
    [shop],
  );
  if (closed) return <Closed />;
  if (!sf) return <Loading />;
  const live = sf.listings.filter((l) => l.state === "LIVE");
  return (
    <>
      <Nav
        right={
          preview ? (
            <Link to={`/shop/${shop}`} className="btn dark sm">
              Back to Your Shop
            </Link>
          ) : (
            <Link to="/sell" className="btn sm">
              Sell Your Own Things
            </Link>
          )
        }
      />
      <main id="main" className="page" style={{ paddingBottom: 80 }}>
        <header className="app-head row" style={{ gap: 16, flexWrap: "nowrap" }}>
          <span className="avatar lg sun" aria-hidden="true">
            {initials(sf.displayName)}
          </span>
          <div>
            <h1 style={{ fontSize: "var(--t-xl)" }}>{sf.displayName}’s porch</h1>
            <p className="muted small">Contactless pickup in {sf.zip}. Pay first; you’re only charged once your pickup is verified.</p>
            <Rating r={sf.rating} />
          </div>
        </header>
        {live.length ? (
          <div className="item-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 260px), 1fr))" }}>
            {live.map((l, i) => (
              <Link key={l.id} to={`/shop/${shop}/item/${l.id}`} className="item-card card in" style={{ ["--i" as string]: i, padding: 12 }}>
                {l.photoUrl ? <img className="photo" src={l.photoUrl} alt="" width={400} height={300} loading="lazy" /> : <div className="photo" />}
                <div className="spread" style={{ flexWrap: "nowrap", alignItems: "flex-start", padding: "0 4px 4px" }}>
                  <h3 style={{ fontSize: "var(--t-b)" }}>{l.title}</h3>
                  <span className="price" style={{ fontSize: "1.375rem" }}>
                    {money(l.askMinor)}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="card stack-s" style={{ textAlign: "center", padding: 48 }}>
            <h2 style={{ fontSize: "var(--t-l)" }}>Nothing for sale right now.</h2>
            <p className="muted">Check back soon.</p>
          </div>
        )}
        {sf.reviews.length ? (
          <section className="stack" style={{ marginTop: 40, maxWidth: 720 }} aria-labelledby="rev-h">
            <h2 id="rev-h" style={{ fontSize: "var(--t-l)" }}>
              What buyers said
            </h2>
            <ReviewList shop={shop} reviews={sf.reviews} />
          </section>
        ) : null}
        <p style={{ marginTop: 32 }}>
          <Link to="/street">See everything else on Stoop Street</Link>
        </p>
      </main>
    </>
  );
}
