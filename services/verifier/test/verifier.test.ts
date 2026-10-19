import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { mockClient } from "aws-sdk-client-mock";
import { describe, expect, it } from "vitest";
import { FootageSource, NoMediaError } from "@stoop/ring-bridge";
import { BedrockVision, LabelVision, parseVisionJson, Verifier, type EvidenceSink } from "../src/index.ts";

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

  it("no recording at the time (Ring 416) -> camera unavailable, never a frame", async () => {
    const asked: Array<{ kind?: string }> = [];
    const src = {
      name: "ring_snapshot",
      async getFrame(_dev: string, _at: number, opts?: { kind?: "before" | "after" }) {
        asked.push({ kind: opts?.kind });
        throw new NoMediaError("no recording");
      },
    };
    const { s, cams, frames } = sink();
    await new Verifier({ sink: s, frames: src, vision: new LabelVision(), now: () => 0, delay: immediate }).capture({ dealId: "d1", kind: "after" });
    expect(asked).toEqual([{ kind: "after" }]); // the source picks its lookback per frame kind
    expect(cams).toEqual(["unavailable"]);
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

describe("BedrockVision input hygiene", () => {
  it("drops reference photos Bedrock can't take (SVG) instead of failing the whole check", async () => {
    const bedrock = mockClient(BedrockRuntimeClient);
    bedrock.on(ConverseCommand).resolves({ output: { message: { role: "assistant", content: [{ text: '{"item":"absent","rationale":"porch is empty","personCount":0}' }] } } } as never);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const svg = new TextEncoder().encode("<svg/>");
    const v = await new BedrockVision("us.amazon.nova-2-lite-v1:0", "us-east-1").assess({
      frame: { bytes: jpeg, mime: "image/jpeg", at: 1, origin: "ring", sourceName: "ring_snapshot" },
      itemTitle: "Three-wheel jogging stroller",
      referencePhotos: [{ bytes: svg, mime: "image/svg+xml" }],
    });
    expect(v.presence).toBe("absent");
    const sent = bedrock.commandCalls(ConverseCommand)[0]!.args[0].input.messages![0]!.content!;
    expect(sent.filter((c) => "image" in c && c.image)).toHaveLength(1); // the frame only
    bedrock.restore();
  });
});
