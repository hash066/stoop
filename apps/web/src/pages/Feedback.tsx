import { useId, useState } from "react";
import { request } from "../api.ts";

/** A short survey. An email is kept only if the person ticks the box to be contacted. */
export function Feedback({ role, shop, step }: { role: "seller" | "buyer" | "visitor"; shop?: string; step?: number }) {
  const id = useId();
  const [rating, setRating] = useState<number>();
  const [wouldUse, setWouldUse] = useState<"yes" | "maybe" | "no">();
  const [comment, setComment] = useState("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");

  if (state === "sent") return <p className="lede" role="status">Thank you. We read every one.</p>;

  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!rating || !wouldUse) {
          setError("Pick a rating and an answer to “Would you use it?”");
          return;
        }
        setError("");
        setState("sending");
        try {
          await request("/api/feedback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ world: shop, role, step, rating, wouldUse, comment: comment.trim() || undefined, email: consent && email.trim() ? email.trim() : undefined, consent }),
          });
          setState("sent");
        } catch (err) {
          setState("idle");
          setError(err instanceof Error ? err.message : "Couldn’t send that. Try again.");
        }
      }}
    >
      <fieldset className="fs">
        <legend>How was it?</legend>
        <div className="choices">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n}>
              <input type="radio" name={`${id}-r`} value={n} checked={rating === n} onChange={() => setRating(n)} />
              <span aria-label={`${n} out of 5`}>{n}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="fs">
        <legend>Would you use it for real?</legend>
        <div className="choices">
          {(["yes", "maybe", "no"] as const).map((v) => (
            <label key={v}>
              <input type="radio" name={`${id}-w`} value={v} checked={wouldUse === v} onChange={() => setWouldUse(v)} />
              <span>{v === "yes" ? "Yes" : v === "maybe" ? "Maybe" : "No"}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span>What was confusing, or what would make you trust it?</span>
        <textarea className="input" name="comment" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} autoComplete="off" />
      </label>
      <label className="check">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>You can email me about my answer.</span>
      </label>
      {consent ? (
        <label className="field">
          <span>Email</span>
          <input className="input" type="email" name="email" autoComplete="email" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
      ) : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
      <div>
        <button className="btn ink" type="submit" disabled={state === "sending"}>
          {state === "sending" ? "Sending…" : "Send Feedback"}
        </button>
      </div>
    </form>
  );
}
