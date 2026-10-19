// A hard daily cap on paid model calls, per process (LLM_DAILY_CALL_CAP; unset = no cap).
// Over the cap, every Bedrock call site uses its offline fallback, so a busy public demo can't run
// up a bill: the AWS budget actions are the second line, but billing data lags by hours.
let day = "";
let used = 0;
// shared also runs in browsers (no Node types there), so read the env defensively
const capFromEnv = () => Number((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LLM_DAILY_CALL_CAP || 0);

/** Reserve `units` model calls for today; false once the cap is reached (use the offline path). */
export function takeModelCalls(units = 1): boolean {
  const cap = capFromEnv();
  if (!cap) return true;
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    used = 0;
  }
  if (used + units > cap) return false;
  used += units;
  return true;
}

/** Calls used today and the cap (for /healthz). */
export function modelCallsToday(): { used: number; cap: number } {
  const cap = capFromEnv();
  return { used: day === new Date().toISOString().slice(0, 10) ? used : 0, cap };
}
