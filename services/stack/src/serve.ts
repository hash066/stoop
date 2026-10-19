// Hosted mode: `pnpm build:web && pnpm serve` (or the Docker image). One origin serves the Stoop web
// app (real shops, each its own private world) and, for judges, the Alexa+ device tour. Local
// development keeps using main.ts.
//
//   PORT=8080            listen port (0.0.0.0)
//   PUBLIC_ORIGIN        https://… as browsers see it (else derived from X-Forwarded-* / Host)
//   PUBLIC_PROTO=https   behind a proxy that forwards Host but not X-Forwarded-Proto (CloudFront)
//   DATA_DIR             where feedback.jsonl goes (default <repo>/.data)
//   ADMIN_KEY            enables GET /api/feedback.jsonl?key=…
//   MAX_SANDBOXES        concurrent demo worlds (default 60), SANDBOX_IDLE_MIN (default 30)
//   MAX_SHOPS            concurrent shops (default 150), SHOP_IDLE_HOURS (default 72)
//   DEVICE_DEMO=1        link the Alexa+ device tour from the web app (the judges' site)
//   ALEXA_SKILL_ID       amzn1.ask.skill.… : turns on the Stoop skill's endpoint (POST /alexa)
//   LLM_MODE=bedrock     live models (Bedrock); LLM_DAILY_CALL_CAP bounds calls per day
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
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
  maxShops: Number(process.env.MAX_SHOPS ?? 150),
  shopIdleMs: Number(process.env.SHOP_IDLE_HOURS ?? 72) * 3_600_000,
  deviceDemo: process.env.DEVICE_DEMO === "1",
  alexaSkillId: process.env.ALEXA_SKILL_ID || undefined,
  // shops are saved under DATA_DIR/worlds and come back after a redeploy
  persist: process.env.PERSIST_SHOPS !== "0",
});

const http = serve({ fetch: server.app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`Stoop on :${port} (LLM_MODE=${process.env.LLM_MODE ?? "offline"}, max ${process.env.MAX_SHOPS ?? 150} shops, ${process.env.MAX_SANDBOXES ?? 60} demos)`);
}) as Server;
// CloudFront reuses origin connections for up to 60 s. Node closes idle ones after 5 s by default,
// so CloudFront would sometimes send a request down a closing socket and answer 502. Outlast it.
http.keepAliveTimeout = 65_000;
http.headersTimeout = 66_000;

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.stop();
    process.exit(0);
  });
}
