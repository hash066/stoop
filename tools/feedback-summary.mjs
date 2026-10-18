// Summarize tester feedback (feedback.jsonl) into numbers you can cite, and the comments.
// Automated tour-check rows are excluded.
//
//   node tools/feedback-summary.mjs .data/feedback.jsonl
//   node tools/feedback-summary.mjs "https://<site>/api/feedback.jsonl?key=<admin key>"
import { readFileSync } from 'node:fs';

const src = process.argv[2];
if (!src) {
  console.error('usage: node tools/feedback-summary.mjs <feedback.jsonl | https://…/api/feedback.jsonl?key=…>');
  process.exit(2);
}
const raw = /^https?:\/\//.test(src) ? await (await fetch(src)).text() : readFileSync(src, 'utf8');
const rows = raw
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => !/^Automated tour check/.test(r.comment ?? ''));

const n = rows.length;
const pct = (k) => (n ? `${Math.round((100 * k) / n)}%` : '–');
const count = (f) => rows.filter(f).length;
const avg = n ? (rows.reduce((t, r) => t + r.rating, 0) / n).toFixed(1) : '–';

console.log(`Responses: ${n} (automated checks excluded)`);
console.log(`Usefulness for selling their own things: ${avg} / 5`);
console.log(`Would use it: yes ${pct(count((r) => r.wouldUse === 'yes'))}, maybe ${pct(count((r) => r.wouldUse === 'maybe'))}, no ${pct(count((r) => r.wouldUse === 'no'))}`);
const sellers = rows.filter((r) => r.sells === 'often' || r.sells === 'sometimes');
if (sellers.length) {
  const yes = sellers.filter((r) => r.wouldUse === 'yes').length;
  console.log(`Among people who sell secondhand (${sellers.length}): ${Math.round((100 * yes) / sellers.length)}% would use it`);
}
console.log(`Finished the whole tour: ${pct(count((r) => r.step >= 7))}`);
console.log(`Agreed to be contacted: ${count((r) => r.consent && r.email)}`);
console.log('\nComments:');
for (const r of rows.filter((x) => x.comment)) console.log(`- [${r.rating}/5, ${r.wouldUse}${r.sells ? `, sells ${r.sells}` : ''}] ${r.comment}`);
