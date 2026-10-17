// Proof-of-Handoff confusion matrix. Each case = before frame + after frame + whether the buyer
// checked in + whether Ring saw someone -> expected verdict. With real footage listed in
// fixtures/footage/eval.json and LLM_MODE=bedrock this measures vision + truth table end to end;
// offline (labelled frames) it measures the decision logic only. The report says which.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateHandoff } from "@stoop/policy";
import { placeholderSvg, type Frame } from "@stoop/ring-bridge";
import type { HandoffVerdict, ItemPresence } from "@stoop/shared";
import { BedrockVision, LabelVision, type VisionAdapter } from "@stoop/verifier";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const T = Date.UTC(2026, 9, 20, 22);

interface Case {
  id: string;
  before: { file?: string; label: ItemPresence };
  after: { file?: string; label: ItemPresence };
  checkIn: boolean;
  ringPresence: boolean;
  expected: HandoffVerdict;
}

function syntheticCases(): Case[] {
  const out: Case[] = [];
  let i = 0;
  const add = (before: ItemPresence, after: ItemPresence, checkIn: boolean, ring: boolean, expected: HandoffVerdict, reps: number) => {
    for (let k = 0; k < reps; k++) out.push({ id: `syn_${i++}`, before: { label: before }, after: { label: after }, checkIn, ringPresence: ring, expected });
  };
  add("present", "absent", true, true, "VERIFIED", 12); // normal pickups
  add("present", "absent", false, true, "PIRACY_SUSPECTED", 8); // stranger took it
  add("present", "absent", false, false, "PIRACY_SUSPECTED", 4); // taken, camera missed the person
  add("present", "present", true, true, "STILL_THERE", 8); // buyer came, didn't take it
  add("present", "absent", true, false, "REVIEW", 4); // checked in, doorbell never fired
  add("present", "unsure", true, true, "REVIEW", 2); // glare after retries
  add("unsure", "absent", true, true, "REVIEW", 2); // bad baseline
  return out;
}

function loadCases(): { cases: Case[]; source: string } {
  const f = join(root, "fixtures", "footage", "eval.json");
  if (existsSync(f)) {
    const cases = JSON.parse(readFileSync(f, "utf8")) as Case[];
    if (cases.length) return { cases, source: `our labelled footage (${cases.length} pairs, fixtures/footage/eval.json)` };
  }
  return { cases: syntheticCases(), source: "synthetic labelled frames (add real footage to fixtures/footage/eval.json)" };
}

function frameFor(spec: { file?: string; label: ItemPresence }, at: number): Frame {
  if (spec.file) {
    const p = join(root, "fixtures", "footage", spec.file);
    return { bytes: new Uint8Array(readFileSync(p)), mime: spec.file.endsWith(".png") ? "image/png" : "image/jpeg", at, origin: "our_footage", label: spec.label, sourceName: "our_footage" };
  }
  const scene = spec.label === "present" ? "item_present" : spec.label === "absent" ? "item_absent" : "unclear";
  return { bytes: placeholderSvg(scene, at), mime: "image/svg+xml", at, origin: "simulator", label: spec.label, sourceName: "placeholder" };
}

const vision: VisionAdapter =
  process.env.LLM_MODE === "bedrock" ? new BedrockVision(process.env.BEDROCK_MODEL_ID_VISION ?? "us.amazon.nova-2-lite-v1:0", process.env.AWS_REGION ?? "us-east-1") : new LabelVision();

const { cases, source } = loadCases();
const verdicts: HandoffVerdict[] = ["VERIFIED", "PIRACY_SUSPECTED", "STILL_THERE", "REVIEW"];
const matrix: Record<string, Record<string, number>> = {};
for (const e of verdicts) matrix[e] = Object.fromEntries(verdicts.map((p) => [p, 0]));
const rows: Array<Case & { predicted: HandoffVerdict; visionBefore: string; visionAfter: string }> = [];

for (const c of cases) {
  const before = await vision.assess({ frame: frameFor(c.before, T), itemTitle: "jogging stroller", placement: "left of the front door, by the bench" });
  const after = await vision.assess({ frame: frameFor(c.after, T + 90_000), itemTitle: "jogging stroller", placement: "left of the front door, by the bench" });
  const checkInAt = c.checkIn ? T + 60_000 : undefined;
  const res = evaluateHandoff(
    {
      window: { start: T, end: T + 2 * 3600_000 },
      checkInAt,
      ringEvents: c.ringPresence ? [{ kind: "button_press", deviceId: "d", at: T + 70_000, origin: "simulator", requestId: c.id }] : [],
      before: before.presence,
      after: after.presence,
      unsureRetries: after.presence === "unsure" ? 3 : 0,
      camera: "ok",
    },
    T + 10 * 60_000,
  );
  const predicted = res.verdict === "PENDING" ? "REVIEW" : res.verdict;
  matrix[c.expected]![predicted] = (matrix[c.expected]![predicted] ?? 0) + 1;
  rows.push({ ...c, predicted, visionBefore: before.presence, visionAfter: after.presence });
}

const correct = rows.filter((r) => r.predicted === r.expected).length;
const perClass = verdicts.map((v) => {
  const tp = matrix[v]![v] ?? 0;
  const fp = verdicts.filter((e) => e !== v).reduce((t, e) => t + (matrix[e]![v] ?? 0), 0);
  const fn = verdicts.filter((p) => p !== v).reduce((t, p) => t + (matrix[v]![p] ?? 0), 0);
  return { verdict: v, precision: tp + fp ? tp / (tp + fp) : 1, recall: tp + fn ? tp / (tp + fn) : 1 };
});
const falseReleases = rows.filter((r) => r.predicted === "VERIFIED" && r.expected !== "VERIFIED").length;

mkdirSync(join(here, "..", "results"), { recursive: true });
writeFileSync(join(here, "..", "results", "poh.json"), JSON.stringify({ generatedAt: new Date().toISOString(), source, vision: vision.name, matrix, perClass, rows }, null, 2));
const table = [`| expected \\ predicted | ${verdicts.join(" | ")} |`, `|---|${verdicts.map(() => "---").join("|")}|`, ...verdicts.map((e) => `| ${e} | ${verdicts.map((p) => matrix[e]![p]).join(" | ")} |`)].join("\n");
const md = `# Proof-of-Handoff evaluation

Cases: **${rows.length}** from ${source}. Vision: \`${vision.name}\`${vision.name.startsWith("offline") ? " (offline: frames carry their labels, so this measures the deterministic truth table, not vision)" : ""}.

Accuracy **${correct}/${rows.length}**. **False releases (money released when it shouldn't be): ${falseReleases}.**

${table}

${perClass.map((c) => `- ${c.verdict}: precision ${(c.precision * 100).toFixed(0)}%, recall ${(c.recall * 100).toFixed(0)}%`).join("\n")}

_Reproduce: \`pnpm eval:poh\` · with real footage + Bedrock: \`LLM_MODE=bedrock pnpm eval:poh\`._
`;
writeFileSync(join(here, "..", "POH_REPORT.md"), md);
console.log(md);
