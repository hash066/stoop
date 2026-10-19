// Live-Bedrock regressions found on Oct 17: the demo's SVG placeholder photos were sent to Nova as
// "jpeg", Bedrock rejected the request, and the appraisal failed instead of falling back.
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { bedrockImageFormat } from "@stoop/shared";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { BedrockIdentifier } from "../src/index.ts";

const bedrock = mockClient(BedrockRuntimeClient);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><text>stroller</text></svg>');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe("Bedrock image handling", () => {
  beforeEach(() => bedrock.reset());

  it("maps MIME types and sniffs bytes; SVG is never sendable", () => {
    expect(bedrockImageFormat("image/jpeg; charset=binary")).toBe("jpeg");
    expect(bedrockImageFormat("image/svg+xml", SVG)).toBeUndefined();
    expect(bedrockImageFormat(undefined, PNG)).toBe("png");
    expect(bedrockImageFormat(undefined, SVG)).toBeUndefined();
  });

  it("identifies an SVG placeholder from the catalog without calling Bedrock", async () => {
    const id = await new BedrockIdentifier("us.amazon.nova-2-lite-v1:0", "us-east-1").identify({ name: "stroller.svg", bytes: SVG, mime: "image/svg+xml" });
    expect(id?.title).toBe("Three-wheel jogging stroller");
    expect(bedrock.commandCalls(ConverseCommand)).toHaveLength(0);
  });

  it("falls back to the catalog when Bedrock refuses a real photo", async () => {
    bedrock.on(ConverseCommand).rejects(new Error("ValidationException"));
    const id = await new BedrockIdentifier("us.amazon.nova-2-lite-v1:0", "us-east-1").identify({ name: "stroller.png", bytes: PNG, mime: "image/png" });
    expect(id?.title).toBe("Three-wheel jogging stroller");
    expect(bedrock.commandCalls(ConverseCommand)).toHaveLength(1);
  });
});

describe("daily model-call cap (LLM_DAILY_CALL_CAP)", () => {
  it("stops paid calls at the cap so callers take their offline path; no cap when unset", async () => {
    const { takeModelCalls, modelCallsToday } = await import("@stoop/shared");
    bedrock.reset();
    const prev = process.env.LLM_DAILY_CALL_CAP;
    try {
      delete process.env.LLM_DAILY_CALL_CAP;
      expect(takeModelCalls(1000)).toBe(true);
      process.env.LLM_DAILY_CALL_CAP = "4";
      const start = modelCallsToday().used;
      expect(start).toBeGreaterThanOrEqual(0);
      process.env.LLM_DAILY_CALL_CAP = String(start + 4);
      expect(takeModelCalls(3)).toBe(true);
      expect(takeModelCalls(3)).toBe(false); // would exceed
      expect(takeModelCalls(1)).toBe(true);
      expect(takeModelCalls(1)).toBe(false);
      // the identifier falls back to the catalog instead of calling Bedrock
      bedrock.on(ConverseCommand).rejects(new Error("must not be called"));
      const id = await new BedrockIdentifier("us.amazon.nova-2-lite-v1:0", "us-east-1").identify({ name: "stroller.png", bytes: PNG, mime: "image/png" });
      expect(id?.title).toBe("Three-wheel jogging stroller");
      expect(bedrock.commandCalls(ConverseCommand)).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.LLM_DAILY_CALL_CAP;
      else process.env.LLM_DAILY_CALL_CAP = prev;
    }
  });
});
