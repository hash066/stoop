// Local Stoop stack: `pnpm --filter @stoop/stack start` (or `pnpm demo` from the repo root).
import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStack, DEMO } from "./compose.ts";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const port = Number(process.env.PORT ?? 8787);
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
const passBaseUrl = process.env.PASS_BASE_URL ?? "http://localhost:5182";
const origins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5180,http://localhost:5181,http://localhost:5182,http://localhost:5183").split(",");

const stack = await createStack({
  publicBaseUrl,
  passBaseUrl,
  allowedOrigins: origins,
  rootDir: root,
  frameDelayScale: Number(process.env.FRAME_DELAY_SCALE ?? 0.15),
  immediateWindow: process.env.IMMEDIATE_WINDOW !== "0",
  autoTick: true,
  persistKeys: true,
  frameSource: process.env.FRAME_SOURCE === "ring" ? "ring" : "footage",
  ringHmacKey: process.env.RING_WEBHOOK_HMAC_KEY,
});

serve({ fetch: stack.app.fetch, port, hostname: "127.0.0.1" }, () => {
  const line = "─".repeat(64);
  console.log(`\n${line}\n Stoop local stack  ${publicBaseUrl}   (LLM_MODE=${process.env.LLM_MODE ?? "offline"})\n${line}`);
  console.log(` MCP seller  ${publicBaseUrl}/mcp/seller   Bearer ${DEMO.sellerToken}`);
  console.log(` MCP buyer   ${publicBaseUrl}/mcp/buyer    Bearer ${DEMO.buyers[0]!.token}`);
  console.log(` UCP         ${publicBaseUrl}/ucp/checkout-sessions   (.well-known/ucp)`);
  console.log(` Ring hook   ${publicBaseUrl}/ring/webhook  (Ring HMAC + simulator key, labelled)`);
  console.log(` JWKS        ${publicBaseUrl}/.well-known/jwks.json`);
  console.log(` Demo tokens are for local use only.\n${line}\n`);
});

process.on("SIGINT", () => {
  stack.stop();
  process.exit(0);
});
