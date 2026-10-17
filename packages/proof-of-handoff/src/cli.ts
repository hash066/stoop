#!/usr/bin/env node
// poh verify <receipt.jws | -> --jwks <url|file>
import { readFile } from "node:fs/promises";
import { verifyReceipt } from "./verify.ts";

async function load(src: string): Promise<string> {
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`GET ${src} -> ${r.status}`);
    return r.text();
  }
  return readFile(src, "utf8");
}

async function main() {
  const [cmd, file, flag, jwksSrc] = process.argv.slice(2);
  if (cmd !== "verify" || !file || flag !== "--jwks" || !jwksSrc) {
    console.error("usage: poh verify <receipt.jws|url> --jwks <jwks.json|url>");
    process.exit(2);
  }
  const jws = (await load(file)).trim();
  const jwks = JSON.parse(await load(jwksSrc));
  const out = await verifyReceipt(jws, jwks);
  if (!out.valid) {
    console.error(`INVALID: ${out.reason}`);
    process.exit(1);
  }
  const r = out.receipt;
  console.log(`VALID  kid=${out.kid}`);
  console.log(`deal=${r.dealId} verdict=${r.verdict} signals=P:${r.signals.P} D:${r.signals.D} B:${r.signals.B}`);
  console.log(`issued=${new Date(r.issuedAt).toISOString()} issuer=${r.issuer}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
