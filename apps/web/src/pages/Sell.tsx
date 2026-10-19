import { useState } from "react";
import { request, tokens } from "../api.ts";
import { Camera, Lock, Phone, Tag } from "../icons.tsx";
import { Link, navigate, Nav, useTitle } from "../ui.tsx";

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
      <Nav />
      <main id="main" className="page section" style={{ paddingTop: "clamp(24px, 4vw, 56px)" }}>
        <div className="grid-2" style={{ ["--cols" as string]: "minmax(0, 1fr) minmax(0, 1.1fr)" }}>
          <div className="card green stack" style={{ ["--gap" as string]: "28px", padding: "clamp(24px, 4vw, 44px)" }}>
            <div className="stack">
              <h1 style={{ fontSize: "var(--t-xl)", color: "#fff" }}>Open your shop.</h1>
              <p className="lede" style={{ color: "rgb(255 255 255 / 0.8)" }}>
                Two minutes now. Then the AI does the selling.
              </p>
            </div>
            {[
              [Camera, "Add photos", "One per thing. Stoop names it and suggests a price."],
              [Tag, "Set your lowest price", "Buyers never see it. The assistant haggles above it."],
              [Phone, "Turn an old phone into the camera", "Prop it at a window that sees your porch."],
              [Lock, "Your address stays hidden", "Only a buyer who has paid sees it, on their pickup pass, during their two-hour window."],
            ].map(([Icon, h, p], i) => {
              const I = Icon as typeof Camera;
              return (
                <div key={i} className="row" style={{ alignItems: "flex-start", gap: 16, flexWrap: "nowrap" }}>
                  <span className="step-n" style={{ background: "rgb(255 255 255 / 0.12)", color: "var(--sun)" }}>
                    <I />
                  </span>
                  <div>
                    <h3 style={{ color: "#fff" }}>{h as string}</h3>
                    <p className="muted small">{p as string}</p>
                  </div>
                </div>
              );
            })}
          </div>
          <form
            className="card stack"
            style={{ padding: "clamp(24px, 4vw, 44px)", ["--gap" as string]: "22px" }}
            noValidate
            onSubmit={async (e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const f = new FormData(form);
              const body = Object.fromEntries(["displayName", "address", "zip", "porchInstructions"].map((k) => [k, String(f.get(k) ?? "").trim()]));
              const local = Object.entries(body)
                .filter(([k, v]) => !v || (k === "address" && v.length < 5) || (k === "zip" && !/^[A-Za-z0-9 -]{3,10}$/.test(v)))
                .map(([k]) => k);
              setErrors(local);
              setFailure("");
              if (local.length) {
                (form.elements.namedItem(local[0]!) as HTMLElement | null)?.focus();
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
            <div className="stack-s">
              <h2 style={{ fontSize: "var(--t-l)" }}>About your shop</h2>
              <p className="muted small">No account, no password. This browser keeps your shop’s key.</p>
            </div>
            <Field name="displayName" label="Your first name or shop name" autoComplete="given-name" errors={errors} />
            <Field name="address" label="Pickup address" autoComplete="street-address" hint="Street, city and state, as a buyer would type it into a map." errors={errors} />
            <Field name="zip" label="ZIP code" autoComplete="postal-code" inputMode="numeric" hint="Shown on your listings." errors={errors} width="14ch" />
            <Field name="porchInstructions" label="Where you’ll leave things" hint="For example: “On the bench, left of the front door.”" errors={errors} multiline />
            {failure ? (
              <p className="err" role="alert">
                {failure}
              </p>
            ) : null}
            <button className="btn lg block" type="submit" disabled={busy}>
              {busy ? "Opening…" : "Open Shop"}
            </button>
            <p className="tiny">
              Early test: payments use a test card and are never charged, and shops close after three days without a visit. <Link to="/">Back to the start</Link>
            </p>
          </form>
        </div>
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
      <label htmlFor={p.name} className="label">
        {p.label}
      </label>
      {p.multiline ? <textarea {...common} maxLength={300} /> : <input {...common} type="text" inputMode={p.inputMode} style={p.width ? { maxWidth: p.width } : undefined} maxLength={200} spellCheck={false} />}
      {p.hint ? (
        <span id={hintId} className="hint">
          {p.hint}
        </span>
      ) : null}
      {bad ? (
        <p className="err" id={errId}>
          {LABEL[p.name]}
        </p>
      ) : null}
    </div>
  );
}
