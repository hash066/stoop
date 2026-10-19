import "@fontsource-variable/schibsted-grotesk";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { absorbFragment } from "./api.ts";
import { Bar, Link, usePath } from "./ui.tsx";
import { Camera } from "./pages/Camera.tsx";
import { Item } from "./pages/Item.tsx";
import { Landing } from "./pages/Landing.tsx";
import { Pass } from "./pages/Pass.tsx";
import { Sell } from "./pages/Sell.tsx";
import { Shop } from "./pages/Shop.tsx";

function App() {
  const path = usePath();
  const m = path.match(/^\/shop\/([A-Za-z0-9_-]+)(?:\/(item|p)\/([A-Za-z0-9_-]+)|\/(camera))?\/?$/);
  if (m) {
    const shop = m[1]!;
    absorbFragment(shop);
    if (m[2] === "item") return <Item key={path} shop={shop} listingId={m[3]!} />;
    if (m[2] === "p") return <Pass key={path} shop={shop} passId={m[3]!} />;
    if (m[4] === "camera") return <Camera key={path} shop={shop} />;
    return <Shop key={path + location.search} shop={shop} />;
  }
  if (path === "/sell") return <Sell />;
  if (path === "/" || path === "") return <Landing />;
  return (
    <>
      <Bar />
      <main id="main" className="page section stack">
        <h1 style={{ fontSize: "var(--t-l)" }}>There’s nothing here.</h1>
        <p>
          <Link to="/" className="btn">
            Go to Stoop
          </Link>
        </p>
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
