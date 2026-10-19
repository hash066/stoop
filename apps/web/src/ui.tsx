import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { renderSVG } from "uqr";

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

export function Link({ to, className, style, children }: { to: string; className?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <a
      href={to}
      className={className}
      style={style}
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

export function Bar({ right }: { right?: ReactNode }) {
  return (
    <header className="bar">
      <Link to="/" className="word">
        Stoop
      </Link>
      <nav className="row" aria-label="Main">
        {right}
      </nav>
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
  const svg = renderSVG(text, { border: 1, whiteColor: "#ffffff", blackColor: "#131714" });
  return <div className="qr" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function Toast({ text, onDone }: { text: string; onDone(): void }) {
  useEffect(() => {
    const t = window.setTimeout(onDone, 4200);
    return () => window.clearTimeout(t);
  }, [text, onDone]);
  return (
    <div className="toast" role="status" aria-live="polite">
      {text}
    </div>
  );
}

export function useToast() {
  const [text, setText] = useState("");
  return { toast: setText, node: text ? <Toast text={text} onDone={() => setText("")} /> : null };
}

export function CopyButton({ text, label = "Copy Link", className = "btn quiet" }: { text: string; label?: string; className?: string }) {
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
      <span aria-live="polite">{done ? "Copied" : label}</span>
    </button>
  );
}

export function ShareButton({ url, title }: { url: string; title: string }) {
  if (!("share" in navigator)) return null;
  return (
    <button type="button" className="btn quiet" onClick={() => navigator.share({ title, url }).catch(() => undefined)}>
      Share…
    </button>
  );
}

export function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M2.5 7.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Mic() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function Send() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <p className="meta" role="status" aria-live="polite">
      {label}
    </p>
  );
}

export function Closed({ what = "shop" }: { what?: string }) {
  return (
    <main id="main" className="page section stack">
      <h1>This {what} has closed.</h1>
      <p className="lede">Shops on this early test close after three days without a visit, or when we ship an update.</p>
      <p>
        <Link to="/sell" className="btn">
          Open Your Own Shop
        </Link>
      </p>
    </main>
  );
}
