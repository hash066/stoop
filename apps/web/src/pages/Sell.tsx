import { useState } from "react";
import { request, tokens } from "../api.ts";
import { Bar, Link, navigate, useTitle } from "../ui.tsx";

const LABEL: Record<string, string> = {
  displayName: "Add your name",
  address: "Add the full pickup address",
  zip: "Add a ZIP code (3 to 10 letters or digits)",
  porchInstructions: "Say where on the porch you’ll leave things",
};

export function Sell() {
  useTitle("Open your shop");
  const [errors, setErrors] = useState<string[]>([]);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <>
      <Bar />
      <main id="main" className="page section split">
        <div className="stack">
          <h1 style={{ fontSize: "var(--t-l)" }}>Open your shop.</h1>
          <p className="lede">Two minutes. Then add photos of what you’re selling.</p>
          <div className="stack-s">
            <h3>Who sees your address</h3>
            <p className="meta">
              Only a buyer who has paid, on their pickup pass, during their two-hour pickup window. It’s encrypted until then. Listings show your ZIP code only.
            </p>
          </div>
          <div className="stack-s">
            <h3>What you’ll need</h3>
            <p className="meta">Photos of the things you want to sell, and an old phone or laptop that can see your porch. That’s your camera.</p>
          </div>
        </div>
        <form
          className="stack tone"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const body = Object.fromEntries(["displayName", "address", "zip", "porchInstructions"].map((k) => [k, String(f.get(k) ?? "").trim()]));
            const local = Object.entries(body)
              .filter(([k, v]) => !v || (k === "address" && v.length < 5) || (k === "zip" && !/^[A-Za-z0-9 -]{3,10}$/.test(v)))
              .map(([k]) => k);
            setErrors(local);
            setFailure("");
            if (local.length) {
              (e.currentTarget.elements.namedItem(local[0]!) as HTMLElement | null)?.focus();
              return;
            }
            setBusy(true);
            try {
              const r = await request<{ id: string; sellerToken: string }>("/api/shops", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
              tokens.set("seller", r.id, r.sellerToken);
              navigate(`/shop/${r.id}`);
            } catch (err) {
              const fields = (err as { fields?: string[] }).fields;
              if (fields?.length) setErrors(fields);
              setFailure(err instanceof Error ? err.message : "Couldn’t open your shop. Try again.");
              setBusy(false);
            }
          }}
        >
          <Field name="displayName" label="Your first name or shop name" autoComplete="given-name" errors={errors} />
          <Field name="address" label="Pickup address" autoComplete="street-address" hint="Street, city and state, as a buyer would type it into a map." errors={errors} />
          <Field name="zip" label="ZIP code" autoComplete="postal-code" inputMode="numeric" hint="Shown on your listings." errors={errors} width="12ch" />
          <Field name="porchInstructions" label="Where you’ll leave things" hint="For example: “On the bench, left of the front door.”" errors={errors} multiline />
          {failure ? (
            <p className="err" role="alert">
              {failure}
            </p>
          ) : null}
          <button className="btn big wide" type="submit" disabled={busy}>
            {busy ? "Opening…" : "Open Shop"}
          </button>
          <p className="meta">
            By opening a shop you agree this is an early test: no real money moves, and shops close after three days without a visit. <Link to="/">Back to the start</Link>
          </p>
        </form>
      </main>
    </>
  );
}

function Field(p: { name: string; label: string; hint?: string; autoComplete?: string; inputMode?: "numeric"; errors: string[]; multiline?: boolean; width?: string }) {
  const bad = p.errors.includes(p.name);
  const hintId = `${p.name}-hint`;
  const errId = `${p.name}-err`;
  const common = {
    id: p.name,
    name: p.name,
    className: "input",
    autoComplete: p.autoComplete ?? "off",
    "aria-invalid": bad || undefined,
    "aria-describedby": [p.hint ? hintId : "", bad ? errId : ""].filter(Boolean).join(" ") || undefined,
  };
  return (
    <div className="field">
      <label htmlFor={p.name}>
        <span style={{ fontWeight: 600 }}>{p.label}</span>
      </label>
      {p.multiline ? <textarea {...common} maxLength={300} /> : <input {...common} type="text" inputMode={p.inputMode} style={p.width ? { maxWidth: p.width } : undefined} maxLength={200} spellCheck={false} />}
      {p.hint ? <small id={hintId}>{p.hint}</small> : null}
      {bad ? (
        <p className="err" id={errId}>
          {LABEL[p.name]}
        </p>
      ) : null}
    </div>
  );
}
