// Build each card into one self-contained HTML file (MCP Apps requires a single HTML resource).
import { mkdirSync, renameSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const root = dirname(fileURLToPath(import.meta.url));
const cards = ["appraisal-grid", "listing-card", "negotiation-live", "deal-approval", "handoff-timeline", "receipt"];
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

for (const card of cards) {
  const tmp = join(root, ".build", card);
  rmSync(tmp, { recursive: true, force: true });
  await build({
    root: join(root, "src", "cards"),
    logLevel: "warn",
    plugins: [viteSingleFile()],
    build: { outDir: tmp, emptyOutDir: true, rollupOptions: { input: join(root, "src", "cards", `${card}.html`) }, target: "es2022" },
  });
  const out = join(tmp, `${card}.html`);
  if (!existsSync(out)) throw new Error(`missing build output for ${card}`);
  renameSync(out, join(dist, `${card}.html`));
  console.log(`built ${card}.html`);
}
rmSync(join(root, ".build"), { recursive: true, force: true });
