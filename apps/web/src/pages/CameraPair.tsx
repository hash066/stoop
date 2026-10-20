import { useEffect, useRef, useState } from "react";
import { postJson, request, tokens } from "../api.ts";
import { Camera } from "../icons.tsx";
import { Link, navigate, Nav, useTitle } from "../ui.tsx";

/**
 * An old phone becomes a shop's porch camera with a 6-digit code: from the shop page (also as a QR)
 * or spoken by Alexa ("Alexa, ask stoop shop to set up my camera"). A code works once, for ten
 * minutes, so a photo of it is useless afterwards; the camera's own key stays on this phone.
 */
export function CameraPair() {
  useTitle("Connect a porch camera");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const pair = async (c: string) => {
    setErr("");
    if (!/^\d{6}$/.test(c)) {
      setErr("Enter the six digits.");
      input.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const r = await request<{ shop: string; camToken: string }>("/api/camera/pair", postJson({ code: c }));
      tokens.set("cam", r.shop, r.camToken);
      navigate(`/shop/${r.shop}/camera`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That code didn’t work.");
      setBusy(false);
      input.current?.focus();
    }
  };

  // a scanned QR carries the code in the #fragment (never sent to a server); use it once, then drop it
  useEffect(() => {
    const m = /[#&]c=(\d{6})\b/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, "", "/camera");
    setCode(m[1]!);
    void pair(m[1]!);
  }, []);

  return (
    <>
      <Nav />
      <main id="main" className="page section" style={{ paddingTop: "clamp(24px, 4vw, 56px)", maxWidth: 560 }}>
        <form
          className="card stack"
          style={{ padding: "clamp(24px, 4vw, 40px)", ["--gap" as string]: "22px" }}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void pair(code);
          }}
        >
          <div className="stack-s">
            <span className="step-n" aria-hidden="true">
              <Camera />
            </span>
            <h1 style={{ fontSize: "var(--t-l)" }}>Turn this phone into a porch camera</h1>
            <p className="muted">
              Enter the code from your shop page, or ask Alexa: “Alexa, ask stoop shop to set up my camera.” A code works once, for ten minutes.
            </p>
          </div>
          <div className="stack-s">
            <label htmlFor="cam-code" className="label">
              Camera code
            </label>
            <input
              ref={input}
              id="cam-code"
              name="code"
              className="input num"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              aria-invalid={!!err}
              aria-describedby={err ? "cam-err" : undefined}
              style={{ fontSize: "2rem", letterSpacing: "0.3em", maxWidth: "10ch" }}
            />
            {err ? (
              <p id="cam-err" className="err" role="alert">
                {err}
              </p>
            ) : null}
          </div>
          <button className="btn lg block" type="submit" disabled={busy}>
            {busy ? "Connecting…" : "Connect Camera"}
          </button>
          <p className="tiny">
            The camera only sends photos of your porch to your own shop, and only when a pickup needs them. It never identifies anyone. <Link to="/">What is Stoop?</Link>
          </p>
        </form>
      </main>
    </>
  );
}
