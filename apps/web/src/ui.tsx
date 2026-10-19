import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { renderSVG } from "uqr";
import { Check as CheckIcon, Copy, Mark, Share } from "./icons.tsx";

// ---------- routing (history API; the server answers every app path with this app)

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
window.addEventListener("popstate", notify);

export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.scrollTo(0, 0);
  notify();
}
export const usePath = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => location.pathname,
  );

export function Link({ to, className, style, children, ...rest }: { to: string; className?: string; style?: CSSProperties; children: ReactNode; "aria-label"?: string }) {
  return (
    <a
      href={to}
      className={className}
      style={style}
      {...rest}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

// ---------- page chrome

export function Nav({ right, dark }: { right?: ReactNode; dark?: boolean }) {
  return (
    <header className={`nav${dark ? " on-dark" : ""}`}>
      <div className="nav-in">
        <Link to="/" className="logo" aria-label="Stoop home">
          <Mark />
          Stoop
        </Link>
        <nav className="nav-links" aria-label="Main">
          {right}
        </nav>
      </div>
    </header>
  );
}

export function useTitle(t: string) {
  useEffect(() => {
    document.title = t ? `${t} · Stoop` : "Stoop: sell it from your porch";
  }, [t]);
}

// ---------- polling while the page is visible

export function usePoll(fn: () => Promise<void> | void, ms: number, deps: unknown[]) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const tick = async () => {
      if (stop) return;
      if (document.visibilityState === "visible") await Promise.resolve(saved.current()).catch(() => undefined);
      if (!stop) timer = window.setTimeout(tick, ms);
    };
    void tick();
    const vis = () => {
      if (document.visibilityState === "visible") {
        window.clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", vis);
    return () => {
      stop = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", vis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// ---------- small pieces

export function QR({ text, label }: { text: string; label: string }) {
  const svg = renderSVG(text, { border: 1, whiteColor: "#ffffff", blackColor: "#0f1813" });
  return <div className="qr" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function Toast({ text, onDone }: { text: string; onDone(): void }) {
  // the page re-renders every few seconds (polling); only a new message restarts the timer
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const t = window.setTimeout(() => done.current(), 4500);
    return () => window.clearTimeout(t);
  }, [text]);
  return (
    <div className="toast" role="status" aria-live="polite">
      <CheckIcon />
      {text}
    </div>
  );
}

export function useToast() {
  const [text, setText] = useState("");
  return { toast: setText, node: text ? <Toast text={text} onDone={() => setText("")} /> : null };
}

export function CopyButton({ text, label = "Copy Link", className = "btn ghost" }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          window.prompt("Copy this link", text);
        }
        setDone(true);
        window.setTimeout(() => setDone(false), 1800);
      }}
    >
      {done ? <CheckIcon /> : <Copy />}
      <span aria-live="polite">{done ? "Copied" : label}</span>
    </button>
  );
}

export function ShareButton({ url, title, className = "btn ghost" }: { url: string; title: string; className?: string }) {
  if (!("share" in navigator)) return null;
  return (
    <button type="button" className={className} onClick={() => navigator.share({ title, url }).catch(() => undefined)}>
      <Share />
      Share…
    </button>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <p className="muted small row" role="status" aria-live="polite" style={{ gap: 10 }}>
      <span className="typing" aria-hidden="true" style={{ padding: "8px 10px", boxShadow: "none", background: "var(--mint-2)" }}>
        <i />
        <i />
        <i />
      </span>
      {label}
    </p>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <>
      <Nav />
      <main id="main" className="page section">
        <Spinner label={label} />
      </main>
    </>
  );
}

export function Closed({ what = "shop" }: { what?: string }) {
  return (
    <>
      <Nav />
      <main id="main" className="page section stack" style={{ maxWidth: 720 }}>
        <h1 style={{ fontSize: "var(--t-xl)" }}>This {what} has closed.</h1>
        <p className="lede">Shops in this early test close after three days without a visit, or when we ship an update.</p>
        <p>
          <Link to="/sell" className="btn lg">
            Open Your Own Shop
          </Link>
        </p>
      </main>
    </>
  );
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "S";
