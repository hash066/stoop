import { useEffect, useRef, useState } from "react";
import { api, ApiError, clock, inSentence, tokens } from "../api.ts";
import { Camera as CameraIcon, Check as CheckIcon } from "../icons.tsx";
import { Closed, Link, Nav, useTitle } from "../ui.tsx";

type Phase = "idle" | "starting" | "on" | "denied" | "replaced" | "noauth" | "closed" | "error";

/**
 * This device as the shop's porch camera. It sends a photo when Stoop asks for one (before and
 * after a pickup) and, during a pickup only, when it sees movement, so Stoop can check whether
 * someone is at the door. Nothing is sent when no pickup is happening.
 */
export function Camera({ shop }: { shop: string }) {
  useTitle("Porch camera");
  const video = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [why, setWhy] = useState("");
  const [watching, setWatching] = useState<string[]>([]);
  const [placement, setPlacement] = useState("");
  const [lastSent, setLastSent] = useState<{ at: number; kind: "asked" | "motion" }>();
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  const run = useRef({ on: false, auth: "", cam: "", stream: undefined as MediaStream | undefined, lock: undefined as { release(): Promise<void> } | undefined });

  useEffect(() => {
    const v = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", v);
    return () => {
      document.removeEventListener("visibilitychange", v);
      stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function auth() {
    const cam = tokens.get("cam", shop);
    if (cam) return { token: cam };
    const seller = tokens.get("seller", shop);
    if (!seller) return undefined;
    const r = await api<{ camera: string; camToken: string }>(shop, "/web/cam/register", { token: seller, body: {} });
    tokens.set("cam", shop, r.camToken);
    return { token: r.camToken };
  }

  function stopAll() {
    const r = run.current;
    r.on = false;
    r.stream?.getTracks().forEach((t) => t.stop());
    r.stream = undefined;
    void r.lock?.release().catch(() => undefined);
    r.lock = undefined;
  }

  async function start(mode = facing) {
    setPhase("starting");
    setWhy("");
    try {
      const a = await auth();
      if (!a) return setPhase("noauth");
      run.current.auth = a.token;
      stopAll();
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: mode }, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
      run.current.stream = stream;
      const v = video.current!;
      v.srcObject = stream;
      await v.play().catch(() => undefined);
      run.current.on = true;
      setPhase("on");
      await keepAwake();
      void loop();
      void motion();
    } catch (e) {
      if (e instanceof ApiError && e.code === "sandbox_expired") return setPhase("closed");
      if (e instanceof ApiError && e.status === 401) return setPhase("noauth");
      const name = (e as { name?: string }).name;
      if (name === "NotAllowedError" || name === "SecurityError") return setPhase("denied");
      setWhy(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  async function keepAwake() {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (wl) run.current.lock = await wl.request("screen");
    } catch {
      /* not supported or not allowed: the tip on the page covers it */
    }
  }
  // the browser drops the wake lock when the page is hidden; take it again when it's back
  useEffect(() => {
    if (!visible) run.current.lock = undefined;
    else if (phase === "on" && !run.current.lock) void keepAwake();
  }, [visible, phase]);

  function grab(maxW = 1280, quality = 0.78) {
    const v = video.current;
    if (!v || !v.videoWidth) return undefined;
    const s = Math.min(1, maxW / v.videoWidth);
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * s);
    c.height = Math.round(v.videoHeight * s);
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", quality);
  }

  async function send(kind: "asked" | "motion") {
    const dataUrl = grab();
    if (!dataUrl) return;
    await api(shop, "/web/cam/frame", { token: run.current.auth, body: { dataUrl, motion: kind === "motion" } });
    setLastSent({ at: Date.now(), kind });
  }

  // Answer Stoop's photo requests. The poll is also how Stoop knows this camera is on.
  const watchingRef = useRef<string[]>([]);
  async function loop() {
    while (run.current.on) {
      try {
        const r = await api<{ want: boolean; watching: string[]; placement: string }>(shop, "/web/cam/next", { token: run.current.auth });
        watchingRef.current = r.watching;
        setWatching(r.watching);
        setPlacement(r.placement);
        if (r.want) await send("asked");
      } catch (e) {
        if (e instanceof ApiError && e.status === 410) {
          stopAll();
          tokens.clear("cam", shop);
          return setPhase("replaced");
        }
        if (e instanceof ApiError && e.code === "sandbox_expired") {
          stopAll();
          return setPhase("closed");
        }
        if (e instanceof ApiError && e.status === 401) {
          stopAll();
          tokens.clear("cam", shop);
          return setPhase("noauth");
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Movement in view, measured on a tiny grey copy of the picture; only matters during a pickup.
  async function motion() {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 48;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    let prev: Uint8ClampedArray | undefined;
    let lastPost = 0;
    while (run.current.on) {
      const v = video.current;
      if (v?.videoWidth) {
        g.drawImage(v, 0, 0, 64, 48);
        const px = g.getImageData(0, 0, 64, 48).data;
        const grey = new Uint8ClampedArray(64 * 48);
        for (let i = 0; i < grey.length; i++) grey[i] = (px[i * 4]! * 3 + px[i * 4 + 1]! * 6 + px[i * 4 + 2]!) / 10;
        if (prev) {
          let changed = 0;
          for (let i = 0; i < grey.length; i++) if (Math.abs(grey[i]! - prev[i]!) > 26) changed++;
          const now = Date.now();
          if (changed / grey.length > 0.04 && watchingRef.current.length && now - lastPost > 8000) {
            lastPost = now;
            void send("motion").catch(() => undefined);
          }
        }
        prev = grey;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  if (phase === "closed") return <Closed />;

  const on = phase === "on";
  return (
    <div className="cam-page">
      <Nav
        dark
        right={
          tokens.get("seller", shop) ? (
            <Link to={`/shop/${shop}`} className="btn on-dark sm">
              Your Shop
            </Link>
          ) : undefined
        }
      />
      <main id="main" className="page grid-2" style={{ paddingBlock: "clamp(12px, 3vw, 32px) 48px", ["--cols" as string]: "minmax(0, 1.4fr) minmax(0, 1fr)" }}>
        <div className="stack-s">
          <div className="cam-video">
            <video ref={video} playsInline muted aria-label="What the porch camera sees" />
            <div className="cam-overlay">
              <span className={`cam-chip${on && visible ? "" : " off"}`}>
                <span className={`dot${on && visible ? " live" : ""}`} />
                {on ? (visible ? (watching.length ? "Watching a pickup" : "On, waiting for a pickup") : "Paused") : "Camera off"}
              </span>
              {on ? (
                <button
                  type="button"
                  className="cam-chip"
                  style={{ border: 0, color: "#fff", cursor: "pointer" }}
                  onClick={() => {
                    const next = facing === "environment" ? "user" : "environment";
                    setFacing(next);
                    void start(next);
                  }}
                >
                  Switch Camera
                </button>
              ) : null}
            </div>
            {!on ? (
              <div className="video-empty">
                <CameraIcon style={{ width: 56, height: 56, color: "var(--sun)" }} />
              </div>
            ) : null}
          </div>
          {lastSent ? (
            <p className="tiny num">
              Last photo sent at {clock(lastSent.at)} ({lastSent.kind === "asked" ? "Stoop asked for it" : "movement during a pickup"}).
            </p>
          ) : null}
        </div>
        <div className="stack" style={{ ["--gap" as string]: "18px" }}>
          <h1 style={{ fontSize: "var(--t-xl)", color: "#fff" }}>Porch camera</h1>
          {phase === "idle" || phase === "starting" || phase === "error" ? (
            <>
              <p className="lede" style={{ color: "rgb(255 255 255 / 0.8)" }}>
                Point this phone or laptop at the spot where you leave things{placement ? `: ${placement.replace(/\.$/, "")}` : ""}.
              </p>
              <div className="card stack-s">
                {[
                  "Stoop asks for a photo when a buyer’s pickup window opens, and again after they’ve been.",
                  "During a pickup, movement sends a photo so Stoop can count whether someone is at the door. It never identifies anyone.",
                  "When no pickup is happening, nothing leaves this device.",
                ].map((s) => (
                  <p key={s} className="row small" style={{ gap: 10, alignItems: "flex-start", flexWrap: "nowrap" }}>
                    <CheckIcon style={{ width: 18, height: 18, color: "var(--sun)", flex: "none", marginTop: 3 }} />
                    <span>{s}</span>
                  </p>
                ))}
              </div>
              {phase === "error" ? (
                <p className="note bad" role="alert">
                  The camera didn’t start{why ? `: ${why}` : ""}. Close other apps using it and try again.
                </p>
              ) : null}
              <button className="btn xl block" type="button" disabled={phase === "starting"} onClick={() => void start()}>
                {phase === "starting" ? "Starting…" : "Start Camera"}
              </button>
            </>
          ) : null}
          {on ? (
            <div className="stack">
              {watching.length ? (
                <div className="card stack-s" style={{ background: "rgb(255 200 61 / 0.14)" }}>
                  <span className="badge sun">Pickup in progress</span>
                  <p>Watching for the pickup of the {watching.map(inSentence).join(", the ")}.</p>
                </div>
              ) : null}
              <p className="muted">Leave this page open, on screen and plugged in. Stoop checks in with it every second.</p>
              <p className="tiny">If the camera is off when a pickup starts, the seller and buyer confirm the pickup themselves instead.</p>
              <div>
                <button
                  className="btn on-dark"
                  type="button"
                  onClick={() => {
                    stopAll();
                    setPhase("idle");
                  }}
                >
                  Stop Camera
                </button>
              </div>
            </div>
          ) : null}
          {phase === "denied" ? <p className="note bad">This page isn’t allowed to use the camera. Allow camera access for this site in your browser’s settings, then reload.</p> : null}
          {phase === "replaced" ? <p className="note">Another device is now this shop’s porch camera, so this one stopped.</p> : null}
          {phase === "noauth" ? <p className="note">Open the camera link from your shop page (Porch camera, then Use Your Phone) to use this device.</p> : null}
        </div>
      </main>
    </div>
  );
}
