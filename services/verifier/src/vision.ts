// Vision adapters: "is THIS item on the porch?" -> present | absent | unsure.
// Rules: categorical labels only (no fake similarity scores); never identify people (Ring content
// policy restricts face recognition to customer-enrolled faces; we use none).
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { bedrockImageFormat, type ItemPresence } from "@stoop/shared";
import type { Frame } from "@stoop/ring-bridge";

export interface VisionInput {
  frame: Frame;
  itemTitle: string;
  /** Short description of where the item was left, e.g. "by the bench, left of the door". */
  placement?: string;
  referencePhotos?: Array<{ bytes: Uint8Array; mime: string }>;
}

export interface VisionVerdict {
  presence: ItemPresence;
  rationale: string;
  personCount?: number;
  adapter: string;
}

export interface VisionAdapter {
  readonly name: string;
  assess(input: VisionInput): Promise<VisionVerdict>;
}

/**
 * Offline adapter: reads the ground-truth label carried by labelled footage / simulator frames.
 * Shown in the UI as "offline vision (footage label)" so nobody mistakes it for a model.
 */
export class LabelVision implements VisionAdapter {
  readonly name = "offline-footage-label";
  async assess({ frame }: VisionInput): Promise<VisionVerdict> {
    if (!frame.label) return { presence: "unsure", rationale: "No label on this frame and no vision model configured.", adapter: this.name };
    const why = { present: "Item visible in the porch zone.", absent: "Porch zone is empty where the item was.", unsure: "Frame too unclear to judge." };
    return { presence: frame.label, rationale: why[frame.label], adapter: this.name };
  }
}

export const VISION_PROMPT = (title: string, placement?: string) =>
  [
    `You check a doorbell-camera frame for one item: "${title}".`,
    placement ? `The seller left it ${placement}.` : "",
    "Answer ONLY with JSON: {\"item\":\"present\"|\"absent\"|\"unsure\",\"rationale\":\"<one sentence>\",\"personCount\":<int>}.",
    "Use \"unsure\" if the view is blocked, dark, blurry, or the item could be hidden.",
    "Do not describe or identify any person. Count people only.",
    "A watermark with a logo, device id and timestamp may appear; ignore it.",
  ]
    .filter(Boolean)
    .join("\n");

/** Amazon Bedrock Converse with an image block (Nova 2 Lite by default). Used once AWS is configured. */
export class BedrockVision implements VisionAdapter {
  readonly name: string;
  private client: BedrockRuntimeClient;
  constructor(
    private modelId: string,
    region: string,
  ) {
    this.name = `bedrock:${modelId}`;
    this.client = new BedrockRuntimeClient({ region });
  }

  async assess(input: VisionInput): Promise<VisionVerdict> {
    const frameFormat = bedrockImageFormat(input.frame.mime, input.frame.bytes);
    if (!frameFormat) return { presence: input.frame.label ?? "unsure", rationale: "Placeholder frame (not an image Bedrock accepts) skipped.", adapter: this.name };
    // An unsendable reference photo (e.g. an SVG placeholder) would make Bedrock reject the whole call
    const refs = (input.referencePhotos ?? [])
      .flatMap((p) => {
        const format = bedrockImageFormat(p.mime, p.bytes);
        return format ? [{ image: { format, source: { bytes: p.bytes } } }] : [];
      })
      .slice(0, 2);
    try {
      const out = await this.client.send(
        new ConverseCommand({
          modelId: this.modelId,
          messages: [
            {
              role: "user",
              content: [
                ...(refs.length ? [{ text: "Reference photos of the item:" }, ...refs] : []),
                { text: "Doorbell camera frame to check:" },
                { image: { format: frameFormat, source: { bytes: input.frame.bytes } } },
                { text: VISION_PROMPT(input.itemTitle, input.placement) },
              ],
            },
          ],
          inferenceConfig: { maxTokens: 200, temperature: 0 },
        }),
      );
      const text = out.output?.message?.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "";
      return parseVisionJson(text, this.name);
    } catch (e) {
      return { presence: "unsure", rationale: `Vision call failed: ${e instanceof Error ? e.name : "error"}`, adapter: this.name };
    }
  }
}

export function parseVisionJson(text: string, adapter: string): VisionVerdict {
  const m = text.match(/\{[\s\S]*\}/);
  try {
    const j = JSON.parse(m?.[0] ?? "") as { item?: string; rationale?: string; personCount?: number };
    const presence: ItemPresence = j.item === "present" || j.item === "absent" ? j.item : "unsure";
    return { presence, rationale: String(j.rationale ?? "").slice(0, 300), personCount: Number.isInteger(j.personCount) ? j.personCount : undefined, adapter };
  } catch {
    return { presence: "unsure", rationale: "Unparseable model output.", adapter };
  }
}
