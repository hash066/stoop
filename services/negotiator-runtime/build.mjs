// One self-contained ESM file for AgentCore's NODE_22 runtime. AgentCore wants a .js entry point,
// so the bundle is server.js next to a package.json that marks it as an ES module.
import { writeFileSync } from "node:fs";
import { build } from "esbuild";

await build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/server.js",
  // some AWS SDK and Strands internals still call require(); give the ESM bundle one
  banner: { js: "import { createRequire as __stoopRequire } from 'node:module'; const require = __stoopRequire(import.meta.url);" },
  legalComments: "none",
  logLevel: "info",
});
writeFileSync("dist/package.json", JSON.stringify({ type: "module" }));
