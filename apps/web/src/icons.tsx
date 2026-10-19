// Inline icons (24px grid, 2px strokes) and the Stoop mark: a front door with the porch light on.
import type { ReactNode, SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const S = (props: P & { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props} />
);

export const Mark = (p: P) => (
  <svg viewBox="0 0 32 32" aria-hidden="true" className="logo-mark" {...p}>
    <rect width="32" height="32" rx="9" fill="#0f3b2c" />
    <path d="M10 26V12.5a6 6 0 0 1 12 0V26" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
    <circle cx="19" cy="19" r="1.4" fill="#fff" />
    <circle cx="25" cy="8" r="3.2" fill="#ffc83d" />
    <path d="M6 26h20" stroke="#ffc83d" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);

export const Camera = (p: P) => (
  <S {...p}>
    <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H7l1.5-2h7L17 6h1.5A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />
    <circle cx="12" cy="13" r="3.5" />
  </S>
);
export const Tag = (p: P) => (
  <S {...p}>
    <path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" />
    <circle cx="7.5" cy="7.5" r="1.5" />
  </S>
);
export const Chat = (p: P) => (
  <S {...p}>
    <path d="M20 12a8 8 0 0 1-11.8 7L4 20l1-4.2A8 8 0 1 1 20 12z" />
  </S>
);
export const Shield = (p: P) => (
  <S {...p}>
    <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />
    <path d="M8.5 12l2.5 2.5 4.5-5" />
  </S>
);
export const Check = (p: P) => (
  <S {...p} strokeWidth={2.6}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </S>
);
export const Clock = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </S>
);
export const Pin = (p: P) => (
  <S {...p}>
    <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" />
    <circle cx="12" cy="9.5" r="2.5" />
  </S>
);
export const Mic = (p: P) => (
  <S {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </S>
);
export const Send = (p: P) => (
  <S {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </S>
);
export const Arrow = Send;
export const Play = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}>
    <path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.4-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5z" fill="currentColor" />
  </svg>
);
export const Upload = (p: P) => (
  <S {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <circle cx="9" cy="10" r="2" />
    <path d="M21 16l-5-5-8 9" />
  </S>
);
export const Spark = (p: P) => (
  <S {...p}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    <path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />
  </S>
);
export const Lock = (p: P) => (
  <S {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </S>
);
export const Receipt = (p: P) => (
  <S {...p}>
    <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
    <path d="M9 8h6M9 12h6" />
  </S>
);
export const Voice = (p: P) => (
  <S {...p}>
    <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
  </S>
);
export const Phone = (p: P) => (
  <S {...p}>
    <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
  </S>
);
export const Copy = (p: P) => (
  <S {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2.5" />
    <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" />
  </S>
);
export const Share = (p: P) => (
  <S {...p}>
    <path d="M12 3v12M7.5 7.5L12 3l4.5 4.5" />
    <path d="M5 12v6.5A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V12" />
  </S>
);
export const Qr = (p: P) => (
  <S {...p}>
    <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1" />
    <rect x="14" y="3.5" width="6.5" height="6.5" rx="1" />
    <rect x="3.5" y="14" width="6.5" height="6.5" rx="1" />
    <path d="M14 14h2.5v2.5H14zM18 18h2.5v2.5H18zM14 18.5v2M18.5 14h2" />
  </S>
);
export const Alert = (p: P) => (
  <S {...p}>
    <path d="M12 3.5l9.5 16.5h-19z" />
    <path d="M12 10v4.5M12 17.5v.01" />
  </S>
);
export const Home = (p: P) => (
  <S {...p}>
    <path d="M3.5 11L12 4l8.5 7" />
    <path d="M6 9.5V20h12V9.5" />
    <path d="M10 20v-5h4v5" />
  </S>
);
export const Wallet = (p: P) => (
  <S {...p}>
    <rect x="3" y="6" width="18" height="14" rx="3" />
    <path d="M3 10h18M16.5 15h.01" />
    <path d="M6 6l9-3 1.5 3" />
  </S>
);
export const Star = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}>
    <path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z" fill="currentColor" />
  </svg>
);
export const Search = (p: P) => (
  <S {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M20 20l-4.8-4.8" />
  </S>
);
export const Bot = (p: P) => (
  <S {...p}>
    <rect x="4" y="7" width="16" height="12" rx="4" />
    <path d="M12 3v4M9 12.5v1M15 12.5v1M9.5 16h5" />
  </S>
);
export const External = (p: P) => (
  <S {...p}>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
  </S>
);
