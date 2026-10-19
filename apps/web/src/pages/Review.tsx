import { useState } from "react";
import { api, ApiError, base } from "../api.ts";
import { Check, Receipt, Star } from "../icons.tsx";

export interface ShopReview {
  dealId: string;
  itemTitle: string;
  rating: number;
  text?: string;
  by: string;
  receiptId?: string;
  verified: boolean;
  at: number;
}

/** After a pickup: rate it. A camera-verified pickup's review links to its signed receipt. */
export function ReviewForm({ shop, dealId, token }: { shop: string; dealId: string; token: string }) {
  const [rating, setRating] = useState(0);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [err, setErr] = useState("");
  if (state === "sent")
    return (
      <p className="note">
        <Check />
        <span>Thanks. Your review is on the seller’s page, linked to the signed pickup receipt.</span>
      </p>
    );
  return (
    <form
      className="card flat stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!rating) return setErr("Pick 1 to 5 stars.");
        setErr("");
        setState("sending");
        try {
          await api(shop, "/web/review", { token, body: { dealId, rating, ...(text.trim() ? { text: text.trim() } : {}) } });
          setState("sent");
        } catch (e2) {
          if (e2 instanceof ApiError && e2.code === "already_reviewed") return setState("sent");
          setErr(e2 instanceof Error ? e2.message : "Couldn’t post that. Try again.");
          setState("idle");
        }
      }}
    >
      <h3>How was the pickup?</h3>
      <div className="row" style={{ gap: 4 }} role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} star${n === 1 ? "" : "s"}`} className="icon-btn" style={{ background: "transparent", color: n <= rating ? "var(--sun)" : "var(--line-2)" }} onClick={() => setRating(n)}>
            <Star width={30} height={30} />
          </button>
        ))}
      </div>
      <label className="field">
        <span className="label">Anything the next buyer should know? (optional)</span>
        <textarea className="input" maxLength={280} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {err ? (
        <p className="err" role="alert">
          {err}
        </p>
      ) : null}
      <div>
        <button className="btn dark" type="submit" disabled={state === "sending"}>
          {state === "sending" ? "Posting…" : "Post Review"}
        </button>
      </div>
      <p className="tiny">Shows your first name. Stoop only lets the buyer of a finished pickup review it, once.</p>
    </form>
  );
}

export function ReviewList({ shop, reviews }: { shop: string; reviews: ShopReview[] }) {
  if (!reviews.length) return null;
  return (
    <div className="stack-s">
      {reviews.map((r) => (
        <article key={r.dealId} className="card flat stack-s">
          <div className="spread">
            <span className="row" style={{ gap: 2, color: "var(--sun)" }} aria-label={`${r.rating} out of 5`}>
              {[1, 2, 3, 4, 5].map((n) => (
                <Star key={n} width={16} height={16} style={{ color: n <= r.rating ? "var(--sun)" : "var(--line-2)" }} />
              ))}
            </span>
            {r.verified && r.receiptId ? (
              <a className="badge" href={`${base(shop)}/verify/${r.receiptId}`} target="_blank" rel="noreferrer">
                <Receipt /> Verified pickup
              </a>
            ) : (
              <span className="badge gray">Confirmed by both</span>
            )}
          </div>
          {r.text ? <p>{r.text}</p> : null}
          <p className="tiny">
            {r.by} · {r.itemTitle}
          </p>
        </article>
      ))}
    </div>
  );
}
