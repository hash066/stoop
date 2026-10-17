import { describe, expect, it } from "vitest";
import { FootageSource } from "@stoop/ring-bridge";
import { LabelVision, parseVisionJson, Verifier, type EvidenceSink } from "../src/index.ts";

function sink(state = "WINDOW_OPEN") {
  const frames: Array<{ kind: string; presence: string; origin: string }> = [];
  const cams: string[] = [];
  const s: EvidenceSink = {
    async recordFrame(_d, kind, obs) {
      frames.push({ kind, presence: obs.presence, origin: obs.origin });
    },
    async setCameraStatus(_d, c) {
      cams.push(c);
    },
    async dealInfo() {
      return { itemTitle: "jogging stroller", deviceId: "dev1", state };
    },
  };
  return { s, frames, cams };
}

const immediate = (_ms: number, fn: () => Promise<void>) => void fn();
const flush = () => new Promise((r) => setTimeout(r, 10));

describe("Verifier", () => {
  it("records before/after observations from labelled footage", async () => {
    const src = new FootageSource("missing-dir", { item_present: [], item_absent: [], unclear: [] });
    const { s, frames } = sink();
    const v = new Verifier({ sink: s, frames: src, vision: new LabelVision(), now: () => 1000, delay: immediate });
    v.request({ dealId: "d1", kind: "before" });
    await flush();
    src.setScene("dev1", "item_absent");
    v.request({ dealId: "d1", kind: "after" });
    await flush();
    expect(frames).toEqual([
      { kind: "before", presence: "present", origin: "simulator" },
      { kind: "after", presence: "absent", origin: "simulator" },
    ]);
  });

  it("offline camera -> camera status offline (DEGRADED path)", async () => {
    const src = new FootageSource("x", { item_present: [], item_absent: [], unclear: [] });
    src.setScene("dev1", "offline");
    const { s, cams, frames } = sink();
    await new Verifier({ sink: s, frames: src, vision: new LabelVision(), now: () => 0, delay: immediate }).capture({ dealId: "d1", kind: "after" });
    expect(cams).toEqual(["offline"]);
    expect(frames).toHaveLength(0);
  });

  it("ignores deals that are no longer waiting for evidence", async () => {
    const src = new FootageSource("x", { item_present: [], item_absent: [], unclear: [] });
    const { s, frames } = sink("CLOSED");
    await new Verifier({ sink: s, frames: src, vision: new LabelVision(), now: () => 0, delay: immediate }).capture({ dealId: "d1", kind: "after" });
    expect(frames).toHaveLength(0);
  });

  it("parses model JSON defensively; anything odd becomes unsure", () => {
    expect(parseVisionJson('Sure! {"item":"absent","rationale":"empty","personCount":0}', "m").presence).toBe("absent");
    expect(parseVisionJson('{"item":"maybe"}', "m").presence).toBe("unsure");
    expect(parseVisionJson("no json", "m").presence).toBe("unsure");
  });
});
