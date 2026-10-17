// Render docs/architecture.svg to docs/architecture.png (2x, for Devpost and the video) with the
// same web fonts as the sims. `node tools/record-demo/diagram.mjs`
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolvePlaywright, launchChrome } from './lib.mjs';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');
const svg = readFileSync(join(DOCS, 'architecture.svg'), 'utf8');
const html = `<!doctype html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400&display=swap" rel="stylesheet">
<style>html,body{margin:0;background:#f4efe4}</style></head><body>${svg}</body></html>`;

const browser = await launchChrome(resolvePlaywright(), { headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.locator('svg').screenshot({ path: join(DOCS, 'architecture.png') });
await browser.close();
console.log(`wrote ${join(DOCS, 'architecture.png')}`);
