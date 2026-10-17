// Public, server-rendered pages: receipt verification and the refund policy linked from UCP sessions.
import type { VerifyOutcome } from "@stoop/proof-of-handoff";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const t = (ms?: number) => (ms ? new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : "–");

const SHELL = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--paper:#f4efe4;--ink:#1f1d1a;--muted:#6d665b;--rule:#d6cdbb;--amber:#c97a1a;--ok:#2f6b3b;--bad:#9b2c1f}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 "IBM Plex Sans",system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}h1{font:700 34px/1.1 Fraunces,serif;margin:0 0 4px}h2{font:500 20px Fraunces,serif;margin:28px 0 8px}
.sub{color:var(--muted)}table{width:100%;border-collapse:collapse;margin-top:8px}td{padding:8px 0;border-top:1px solid var(--rule);vertical-align:top}
td:first-child{color:var(--muted);width:38%}.mono{font-family:"IBM Plex Mono",monospace;font-size:13px;word-break:break-all;font-variant-numeric:tabular-nums}
.stamp{display:inline-block;margin:16px 0;padding:6px 12px;border:2px solid currentColor;font:500 14px "IBM Plex Mono",monospace;letter-spacing:.08em}
.ok{color:var(--ok)}.bad{color:var(--bad)}code{font-family:"IBM Plex Mono",monospace;font-size:13px;background:#ebe3d3;padding:2px 4px}
</style></head><body><main>${body}</main></body></html>`;

export function verifyPageHtml(r: { id: string; jws: string; hash: string }, out: VerifyOutcome, base: string) {
  if (!out.valid) {
    return SHELL("Receipt not valid", `<h1>Stoop receipt</h1><div class="stamp bad">NOT VALID · ${esc(out.reason)}</div><p class="sub">This receipt did not verify against Stoop's published keys.</p>`);
  }
  const x = out.receipt;
  const ring = x.evidence.ringEvents.map((e) => `${esc(e.kind)}${e.subType ? ` (${esc(e.subType)})` : ""} · ${t(e.at)} · ${e.origin === "simulator" ? "simulator-signed" : "Ring"}`).join("<br>") || "–";
  return SHELL(
    "Stoop receipt verified",
    `<h1>Proof of handoff</h1><p class="sub">Receipt ${esc(x.receiptId)} · deal ${esc(x.dealId)}</p>
<div class="stamp ok">SIGNATURE VALID · ${esc(x.verdict)}</div>
<table>
<tr><td>Signed by</td><td class="mono">${esc(x.issuer)} · key ${esc(out.kid)}</td></tr>
<tr><td>Issued</td><td class="mono">${t(x.issuedAt)}</td></tr>
<tr><td>Pickup window</td><td class="mono">${t(x.window.start)} → ${t(x.window.end)}</td></tr>
<tr><td>Buyer check-in (P)</td><td class="mono">${x.signals.P ? "yes" : "no"} · ${t(x.evidence.checkInAt)}</td></tr>
<tr><td>Doorbell presence (D)</td><td class="mono">${x.signals.D ? "yes" : "no"}<br>${ring}</td></tr>
<tr><td>Item seen before (B)</td><td class="mono">${x.signals.B ? "yes" : "no"}</td></tr>
<tr><td>Before frame SHA-256</td><td class="mono">${esc(x.evidence.beforeFrameSha256 ?? "–")}</td></tr>
<tr><td>After frame SHA-256</td><td class="mono">${esc(x.evidence.afterFrameSha256 ?? "–")}</td></tr>
<tr><td>Item hash</td><td class="mono">${esc(x.itemHash)}</td></tr>
<tr><td>Policy decisions</td><td class="mono">${x.decisionIds.length} recorded</td></tr>
<tr><td>Receipt hash</td><td class="mono">${esc(r.hash)}</td></tr>
</table>
<h2>Verify it yourself</h2>
<p>This page contains hashes only: no address, no images, no identities. Check the signature offline with the open-source verifier:</p>
<p><code>npx @stoop/proof-of-handoff verify ${esc(base)}/receipts/${esc(r.id)} --jwks ${esc(base)}/.well-known/jwks.json</code></p>`,
  );
}

export function refundPolicyHtml() {
  return SHELL(
    "Stoop refund policy",
    `<h1>Refunds &amp; holds</h1>
<p>When you buy on Stoop, your card is <strong>authorized, not charged</strong>. The money moves only after your doorbell-verified pickup and a two-hour inspection window.</p>
<table>
<tr><td>You don't show up</td><td>The hold is released when your pickup window ends.</td></tr>
<tr><td>The item isn't on the porch</td><td>Nothing is charged; the hold is released.</td></tr>
<tr><td>The item isn't as described</td><td>Tap "Not as described" on your pass within two hours. We review the evidence before any money moves.</td></tr>
<tr><td>The seller cancels</td><td>The hold is released immediately.</td></tr>
<tr><td>Fees</td><td>Buyers pay a $1.99 verified-pickup fee. Sellers pay 5% on completed sales only.</td></tr>
</table>`,
  );
}
