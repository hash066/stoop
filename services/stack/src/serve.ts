// Hosted mode: `pnpm build:web && pnpm serve` (or the Docker image). One origin serves the landing
// page, the guided tour and a private sandbox per visitor. Local development keeps using main.ts.
//
//   PORT=8080            listen port (0.0.0.0)
//   PUBLIC_ORIGIN        https://… as browsers see it (else derived from X-Forwarded-* / Host)
//   PUBLIC_PROTO=https   behind a proxy that forwards Host but not X-Forwarded-Proto (CloudFront)
//   DATA_DIR             where feedback.jsonl goes (default <repo>/.data)
//   ADMIN_KEY            enables GET /api/feedback.jsonl?key=…
//   MAX_SANDBOXES        concurrent worlds (default 60), SANDBOX_IDLE_MIN (default 30)
//   LLM_MODE=bedrock     live models for every sandbox (the judge instance); unset = offline agents
import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSandboxServer } from "./sandboxes.ts";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const port = Number(process.env.PORT ?? 8080);

const server = await createSandboxServer({
  rootDir: root,
  origin: process.env.PUBLIC_ORIGIN,
  publicProto: process.env.PUBLIC_PROTO,
  dataDir: process.env.DATA_DIR ?? resolve(root, ".data"),
  adminKey: process.env.ADMIN_KEY,
  maxWorlds: Number(process.env.MAX_SANDBOXES ?? 60),
  idleMs: Number(process.env.SANDBOX_IDLE_MIN ?? 30) * 60_000,
});

serve({ fetch: server.app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`Stoop hosted sandboxes on :${port} (LLM_MODE=${process.env.LLM_MODE ?? "offline"}, max ${process.env.MAX_SANDBOXES ?? 60} sandboxes)`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.stop();
    process.exit(0);
  });
}
