// Shared helpers for the Stoop browser tools (UI QA + demo recording).
//
// Playwright is resolved at runtime from, in order: the root `playwright-core` devDependency, `playwright`,
// $STOOP_PLAYWRIGHT, or the Codex runtime cache. The browser is the *system* Google
// Chrome (via executablePath or channel:'chrome'), so nothing downloads a Chromium.
// Override the binary with $STOOP_CHROME if Chrome lives elsewhere.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

export const PORTS = { stack: 8787, alexa: 5180, pass: 5182, ops: 5183 };
export const URLS = {
  seller: `http://localhost:${PORTS.alexa}/?role=seller`,
  buyer: `http://localhost:${PORTS.alexa}/?role=buyer`,
  ops: `http://localhost:${PORTS.ops}/`,
  pass: (id) => `http://localhost:${PORTS.pass}/p/${id}`,
  stack: process.env.STOOP_STACK_URL ?? `http://localhost:${PORTS.stack}`, // e.g. a second stack with LLM_MODE=bedrock
};
// Local demo tokens from services/stack (DEMO). Not real credentials.
export const TOKENS = { seller: 'seller-demo-okafor', buyer: 'buyer-demo-dana' };

const PW_CANDIDATES = [
  'playwright-core', // root devDependency; never downloads a browser
  'playwright',
  process.env.STOOP_PLAYWRIGHT,
  join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'),
].filter(Boolean);

const CHROME_CANDIDATES = [
  process.env.STOOP_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

export function resolvePlaywright() {
  for (const c of PW_CANDIDATES) {
    try {
      return require(c);
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `Could not load Playwright. Set STOOP_PLAYWRIGHT to a playwright install, or run \`npm i -D playwright\`. Tried:\n  ${PW_CANDIDATES.join('\n  ')}`,
  );
}

/** Launch the system Chrome (no Chromium download). Returns { browser }. */
export async function launchChrome(pw, opts = {}) {
  const exe = CHROME_CANDIDATES.find((p) => existsSync(p));
  const launchOpts = { headless: opts.headless ?? true, args: ['--autoplay-policy=no-user-gesture-required'] };
  if (exe) launchOpts.executablePath = exe;
  else launchOpts.channel = 'chrome'; // let Playwright locate the installed Chrome
  return pw.chromium.launch(launchOpts);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Non-2xx responses that are correct Stoop behaviour, not UI bugs:
//  - the MCP server answers GET with 405 and the client aborts its standalone stream (friction #8)
//  - the pass page returns 403 until the device is bound with the emailed OTP (R2)
//  - dev servers don't serve favicon.ico
const expectedBad = (url, status) =>
  url.includes('/mcp/') ||
  (url.includes('/pass/') && (status === 403 || status === 0)) ||
  url.endsWith('/favicon.ico');

/** Attach collectors that flag only *genuine* issues. Returns an array of {type, text}. */
export function collectConsole(page) {
  const errors = [];
  page.on('response', (r) => {
    const s = r.status();
    if (s >= 400 && !expectedBad(r.url(), s)) errors.push({ type: `http ${s}`, text: r.url() });
  });
  page.on('pageerror', (e) => errors.push({ type: 'pageerror', text: String(e) }));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/i.test(t)) return; // covered by the response handler above
    errors.push({ type: 'console', text: t });
  });
  page.on('requestfailed', (r) => {
    if (!expectedBad(r.url(), 0)) errors.push({ type: 'requestfailed', text: `${r.url()} ${r.failure()?.errorText ?? ''}` });
  });
  return errors;
}

// ---- Stack HTTP helpers (drive a real deal so Ops/Pass have something to show) ----

async function parseMcp(res) {
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch {
    const line = raw.split('\n').find((l) => l.startsWith('data:'));
    return line ? JSON.parse(line.slice(5)) : undefined;
  }
}

/** Stateless MCP tools/call; auto-answers an `approval_required` with confirm_action. */
export async function mcp(role, name, args = {}, idRef = { n: 0 }) {
  const token = TOKENS[role];
  const body = { jsonrpc: '2.0', id: ++idRef.n, method: 'tools/call', params: { name, arguments: args } };
  const res = await fetch(`${URLS.stack}/mcp/${role}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify(body),
  });
  const msg = await parseMcp(res);
  const result = msg?.result ?? {};
  const data = result.structuredContent ?? {};
  if (data.kind === 'approval_required' && data.pendingActionId) {
    return mcp(role, 'confirm_action', { approvalId: data.pendingActionId, decision: 'accept' }, idRef);
  }
  const text = (result.content ?? []).map((c) => c.text ?? '').join(' ').trim();
  return { text, data, isError: !!result.isError };
}

/** A refused offer usually means a long-running stack has rate-limited the demo buyer (X2). */
export function assertOffer(res) {
  if (res.isError) throw new Error(`make_offer refused: "${res.text}". Restart the stack for a fresh demo state.`);
  return res;
}

export async function stackJson(method, path, body, headers = {}) {
  const res = await fetch(`${URLS.stack}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, json: ct.includes('json') ? await res.json() : undefined };
}

/** Drive sweep -> list -> mandate -> offer -> accept -> checkout. Returns { dealId, passId }. */
export async function createDealToWindow({ offerDollars = 95 } = {}) {
  const idRef = { n: 0 };
  await stackJson('POST', '/sweep/demo', undefined, { Authorization: `Bearer ${TOKENS.seller}` });
  await mcp('seller', 'appraise_photos', {}, idRef);
  await mcp('seller', 'list_items', { items: ['stroller'] }, idRef);
  await mcp('seller', 'set_mandate', { item: 'stroller', floorDollars: 90 }, idRef);
  await mcp('seller', 'set_pickup_preferences', { preset: 'evenings' }, idRef);
  const found = await mcp('buyer', 'search_listings', { query: 'jogging stroller', maxPriceDollars: 100 }, idRef);
  const listingId = found.data?.results?.[0]?.listingId;
  if (!listingId) throw new Error(`no listing found: ${found.text}`);
  assertOffer(await mcp('buyer', 'make_offer', { listingId, amountDollars: offerDollars }, idRef));
  const accepted = await mcp('seller', 'respond_to_offer', { decision: 'accept' }, idRef);
  const dealId = accepted.data?.dealId;
  await mcp('buyer', 'checkout', {}, idRef);
  // Window opens immediately (IMMEDIATE_WINDOW) and autoTick issues the pass; poll Ops state.
  let passId;
  for (let i = 0; i < 40 && !passId; i++) {
    const { json } = await stackJson('GET', '/ops/state');
    const deal = (json?.deals ?? []).find((d) => d.id === dealId) ?? json?.deal;
    passId = deal?.passId;
    if (!passId) await sleep(250);
  }
  return { dealId, listingId, passId };
}

/** Given a LIVE listing already exists, settle a deal over HTTP: offer -> accept -> checkout.
 * Returns { dealId, passId }. Used by the recorder to guarantee the handoff clips regardless of
 * how the offline planner interprets the spoken utterances. */
export async function settleDeal({ query = 'jogging stroller', maxPriceDollars = 100, offerDollars = 95 } = {}) {
  const idRef = { n: 0 };
  const found = await mcp('buyer', 'search_listings', { query, maxPriceDollars }, idRef);
  const listingId = found.data?.results?.[0]?.listingId;
  if (!listingId) throw new Error(`settleDeal: no live listing for "${query}" (${found.text})`);
  assertOffer(await mcp('buyer', 'make_offer', { listingId, amountDollars: offerDollars }, idRef));
  const accepted = await mcp('seller', 'respond_to_offer', { decision: 'accept' }, idRef);
  const dealId = accepted.data?.dealId;
  await mcp('buyer', 'checkout', {}, idRef);
  let passId;
  for (let i = 0; i < 40 && !passId; i++) {
    const { json } = await stackJson('GET', '/ops/state');
    passId = (json?.deals ?? []).find((d) => d.id === dealId)?.passId;
    if (!passId) await sleep(250);
  }
  return { dealId, passId };
}

/** Read the emailed OTP for a pass from the Ops state outbox. */
export async function otpFor(passId) {
  for (let i = 0; i < 20; i++) {
    const { json } = await stackJson('GET', '/ops/state');
    const mail = (json?.outbox ?? []).find((o) => o.passId === passId);
    if (mail?.otp) return String(mail.otp);
    await sleep(250);
  }
  throw new Error(`no OTP found for ${passId}`);
}
