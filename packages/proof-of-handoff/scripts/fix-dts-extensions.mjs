// tsc rewrites relative ".ts" imports to ".js" in emitted JS (rewriteRelativeImportExtensions)
// but not in .d.ts files. Rewrite them so published types resolve for consumers.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dist = new URL("../dist/", import.meta.url);
for (const name of readdirSync(dist)) {
  if (!name.endsWith(".d.ts")) continue;
  const path = join(dist.pathname.replace(/^\/([A-Za-z]:)/, "$1"), name);
  const src = readFileSync(path, "utf8");
  const out = src.replace(/(from\s+["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2");
  if (out !== src) writeFileSync(path, out);
}
