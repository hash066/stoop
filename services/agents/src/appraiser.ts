// Appraiser: photos -> identified items with a price band, cited comps and a recall verdict.
// Vision identifies (Bedrock Nova 2 Lite in AWS; offline catalog matching otherwise). Prices come from
// comps (cached asking prices or eBay Browse), never invented: fewer than 3 comps = "low confidence".
import { createHash } from "node:crypto";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { bedrockImageFormat, takeModelCalls } from "@stoop/shared";
import { matchCatalog, type CatalogEntry } from "./catalog.ts";
import { llmMode, modelIdFor } from "./llm.ts";
import type { RecallChecker, RecallVerdict } from "./recall.ts";

export interface PhotoInput {
  name: string;
  bytes?: Uint8Array;
  mime?: string;
  /** Optional caller hint, e.g. what the seller said ("the old stroller"). */
  hint?: string;
}

export interface Identification {
  title: string;
  category: string;
  condition: "A" | "B" | "C" | "D";
  confidence: "high" | "low";
}

export interface Comp {
  source: string;
  title: string;
  priceMinor: number;
  url?: string;
}

export interface CompsProvider {
  readonly name: string;
  find(title: string, category: string): Promise<Comp[]>;
}

export interface AppraisedItem {
  photoName: string;
  photoHash: string;
  identification: Identification;
  priceBand: { listMinor: number; quickSaleMinor: number; floorSuggestionMinor: number };
  comps: Comp[];
  compsConfidence: "high" | "low";
  compsSource: string;
  /** Where the price came from: market comparables, an AI estimate (labelled as such), or nothing. */
  priceSource: "comps" | "ai-estimate" | "none";
  recall: RecallVerdict;
}

/** Fallback pricing for items with no comparables: an estimate, always shown to the seller as one. */
export interface PriceEstimator {
  readonly name: string;
  estimate(id: Identification): Promise<{ lowMinor: number; highMinor: number } | undefined>;
}

const CONDITION_WORDS = { A: "like new", B: "light wear", C: "visible wear", D: "for parts" } as const;

/** Bedrock estimate of a typical local secondhand price range (USD), bounded and sanity-checked. */
export class BedrockPriceEstimator implements PriceEstimator {
  readonly name: string;
  private client: BedrockRuntimeClient;
  constructor(
    private modelId = modelIdFor("VISION"),
    region = process.env.AWS_REGION ?? "us-east-1",
  ) {
    this.name = `ai-estimate:${modelId}`;
    this.client = new BedrockRuntimeClient({ region });
  }
  async estimate(id: Identification) {
    if (!takeModelCalls(1)) return undefined;
    try {
      const out = await this.client.send(
        new ConverseCommand({
          modelId: this.modelId,
          messages: [
            {
              role: "user",
              content: [
                {
                  text:
                    `Typical price this would sell for secondhand, local pickup in the US (Facebook Marketplace, Craigslist): "${id.title}" (${id.category}), condition: ${CONDITION_WORDS[id.condition]}. ` +
                    'Reply ONLY JSON: {"low":<dollars>,"high":<dollars>}.',
                },
              ],
            },
          ],
          inferenceConfig: { maxTokens: 60, temperature: 0 },
        }),
      );
      const text = out.output?.message?.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "";
      const j = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "") as { low?: number; high?: number };
      const low = Math.round(Number(j.low) * 100);
      const high = Math.round(Number(j.high) * 100);
      if (!(low >= 100 && high >= low && high <= 2_000_000)) return undefined;
      return { lowMinor: low, highMinor: high };
    } catch {
      return undefined;
    }
  }
}

/** Turns what someone says about an item ("the wooden bench on the porch, a few scratches") into an identification. */
export interface Describer {
  readonly name: string;
  describe(text: string): Promise<Identification | undefined>;
}

/** Condition from the person's own words; "light wear" when they said nothing about it. */
export function conditionFromWords(t: string): Identification["condition"] {
  if (/\b(broken|for parts|doesn'?t work|not working)\b/i.test(t)) return "D";
  if (/\b(like new|brand new|never used|barely used|mint|unused)\b/i.test(t)) return "A";
  if (/\b(worn|scratch\w*|stain\w*|scuff\w*|dent\w*|faded|well used|rough|chipped)\b/i.test(t)) return "C";
  return "B";
}

const LEAD_WORDS = /^(?:my|the|our|an?|this|that|old)\s+/i;

/** Offline: the catalog when the words match it, otherwise the person's own words become the title. */
export class WordsDescriber implements Describer {
  readonly name = "offline-words";
  async describe(text: string): Promise<Identification | undefined> {
    const said = text.trim().replace(/[.!?]+$/, "").replace(/\s+/g, " ");
    if (said.length < 2) return undefined;
    const e = matchCatalog(said);
    let title = said.split(/,|\b(?:with|but|and it|it'?s|in (?:good|great|ok|okay|fair|bad|rough) (?:shape|condition))\b/i)[0]!.trim() || said;
    while (LEAD_WORDS.test(title)) title = title.replace(LEAD_WORDS, "");
    title = title.replace(/\s+(?:on|in|from|at|by|out of) (?:my|the|our) (?:front |back )?(?:porch|garage|basement|yard|house|attic|closet|shed|kitchen|room|bedroom|living room|stoop)\b/i, "").trim() || title;
    return {
      title: e?.title ?? (title.charAt(0).toUpperCase() + title.slice(1)).slice(0, 80),
      category: e?.category ?? "other",
      condition: conditionFromWords(said),
      confidence: e ? "high" : "low",
    };
  }
}

/** Bedrock: a listing title, category and condition from the spoken description (no brand it wasn't told). */
export class BedrockDescriber implements Describer {
  readonly name: string;
  private client: BedrockRuntimeClient;
  constructor(
    private modelId = modelIdFor("PLANNER"),
    region = process.env.AWS_REGION ?? "us-east-1",
  ) {
    this.name = `bedrock-words:${modelId}`;
    this.client = new BedrockRuntimeClient({ region });
  }
  async describe(text: string): Promise<Identification | undefined> {
    const words = new WordsDescriber();
    if (!takeModelCalls(1)) return words.describe(text);
    try {
      const out = await this.client.send(
        new ConverseCommand({
          modelId: this.modelId,
          messages: [
            {
              role: "user",
              content: [
                {
                  text:
                    'Someone described, out loud, a household item they want to sell. Turn it into a resale listing. Reply ONLY JSON: {"title":"<short listing title>","category":"<one word>","condition":"A|B|C|D","confidence":"high|low"}. ' +
                    "Use only what they said: name a brand or model only if they did. Condition: A like new, B light wear, C visible wear, D for parts; B if they said nothing about it. " +
                    `What they said: "${text.slice(0, 300).replace(/"/g, "'")}"`,
                },
              ],
            },
          ],
          inferenceConfig: { maxTokens: 120, temperature: 0 },
        }),
      );
      const reply = out.output?.message?.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "";
      const j = JSON.parse(reply.match(/\{[\s\S]*\}/)?.[0] ?? "") as Partial<Identification>;
      if (!j.title) return words.describe(text);
      return {
        title: j.title.slice(0, 80),
        category: (j.category ?? "other").toLowerCase(),
        condition: j.condition && ["A", "B", "C", "D"].includes(j.condition) ? j.condition : conditionFromWords(text),
        confidence: j.confidence === "high" ? "high" : "low",
      };
    } catch {
      return words.describe(text);
    }
  }
}

export interface Identifier {
  readonly name: string;
  identify(photo: PhotoInput): Promise<Identification | undefined>;
}

/** Offline identifier: catalog match on filename + hint. Clearly labelled in the UI. */
export class CatalogIdentifier implements Identifier {
  readonly name = "offline-catalog";
  async identify(photo: PhotoInput): Promise<Identification | undefined> {
    const e = matchCatalog(`${photo.name} ${photo.hint ?? ""}`);
    return e ? { title: e.title, category: e.category, condition: e.condition, confidence: "high" } : undefined;
  }
}

/** Bedrock vision identifier (used when LLM_MODE=bedrock). */
export class BedrockIdentifier implements Identifier {
  readonly name: string;
  private client: BedrockRuntimeClient;
  constructor(
    private modelId = modelIdFor("VISION"),
    region = process.env.AWS_REGION ?? "us-east-1",
  ) {
    this.name = `bedrock:${modelId}`;
    this.client = new BedrockRuntimeClient({ region });
  }
  async identify(photo: PhotoInput): Promise<Identification | undefined> {
    const format = bedrockImageFormat(photo.mime, photo.bytes);
    // No bytes, a format Bedrock rejects (the SVG demo placeholders), or the daily cap: the catalog
    if (!photo.bytes || !format || !takeModelCalls(1)) return new CatalogIdentifier().identify(photo);
    let out;
    try {
      out = await this.client.send(
        new ConverseCommand({
          modelId: this.modelId,
          messages: [
            {
              role: "user",
              content: [
                { image: { format, source: { bytes: photo.bytes } } },
                {
                  text:
                    'Identify the single main household item for a resale listing. Reply ONLY JSON: {"title":"<short description>","category":"<one word>","condition":"A|B|C|D","confidence":"high|low"}. ' +
                    "The title describes what is visible (type, color, size), like \"Green three-wheel jogging stroller\". Name a brand or model only if its name is legible in the photo; never guess one. " +
                    "Condition: A like new, B light wear, C visible wear, D for parts. Ignore people and do not describe them." +
                    (photo.hint ? ` Seller's hint: ${photo.hint}` : ""),
                },
              ],
            },
          ],
          inferenceConfig: { maxTokens: 150, temperature: 0 },
        }),
      );
    } catch {
      return new CatalogIdentifier().identify(photo); // Bedrock refused or is unreachable: never fail the appraisal
    }
    const text = out.output?.message?.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "";
    try {
      const j = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "") as Identification;
      if (!j.title) return undefined;
      return {
        title: j.title.slice(0, 80),
        category: (j.category ?? "other").toLowerCase(),
        condition: ["A", "B", "C", "D"].includes(j.condition) ? j.condition : "C",
        confidence: j.confidence === "high" ? "high" : "low",
      };
    } catch {
      return undefined;
    }
  }
}

export class CachedComps implements CompsProvider {
  readonly name = "cached-asking-prices";
  async find(title: string, category: string): Promise<Comp[]> {
    const e: CatalogEntry | undefined = matchCatalog(`${title} ${category}`);
    return (e?.comps ?? []).map((c) => ({ ...c }));
  }
}

/** eBay Browse item_summary/search: active asking prices (sold data is restricted). Needs app keys. */
export class EbayBrowseComps implements CompsProvider {
  readonly name = "ebay-browse-asking-prices";
  constructor(
    private getAppToken: () => Promise<string>,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async find(title: string): Promise<Comp[]> {
    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(title.slice(0, 100))}&limit=20&filter=conditions:{USED}`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${await this.getAppToken()}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { itemSummaries?: Array<{ title: string; price?: { value: string; currency: string }; itemWebUrl?: string }> };
    return (j.itemSummaries ?? [])
      .filter((i) => i.price?.currency === "USD")
      .map((i) => ({ source: "ebay:active-listing", title: i.title, priceMinor: Math.round(Number(i.price!.value) * 100), url: i.itemWebUrl }));
  }
}

const CONDITION_FACTOR = { A: 1.0, B: 0.9, C: 0.75, D: 0.4 } as const;
const roundTo5 = (minor: number) => Math.max(500, Math.round(minor / 500) * 500);

export function priceBand(comps: Comp[], condition: Identification["condition"]) {
  const prices = comps.map((c) => c.priceMinor).sort((a, b) => a - b);
  const median = prices.length ? (prices[Math.floor((prices.length - 1) / 2)]! + prices[Math.ceil((prices.length - 1) / 2)]!) / 2 : 0;
  const list = roundTo5(median * CONDITION_FACTOR[condition]);
  return { listMinor: list, quickSaleMinor: roundTo5(list * 0.8), floorSuggestionMinor: roundTo5(list * 0.7) };
}

export class Appraiser {
  constructor(
    private deps: { identifier: Identifier; comps: CompsProvider; recalls: RecallChecker; estimator?: PriceEstimator; describer?: Describer },
  ) {}

  static offline(recalls: RecallChecker) {
    return new Appraiser({ identifier: new CatalogIdentifier(), comps: new CachedComps(), recalls, describer: new WordsDescriber() });
  }

  static forMode(recalls: RecallChecker, comps: CompsProvider = new CachedComps()) {
    const live = llmMode() === "bedrock";
    return new Appraiser({
      identifier: live ? new BedrockIdentifier() : new CatalogIdentifier(),
      comps,
      recalls,
      estimator: live ? new BedrockPriceEstimator() : undefined,
      describer: live ? new BedrockDescriber() : new WordsDescriber(),
    });
  }

  get identifierName() {
    return this.deps.identifier.name;
  }

  async appraise(photos: PhotoInput[]): Promise<{ items: AppraisedItem[]; unidentified: string[] }> {
    const items: AppraisedItem[] = [];
    const unidentified: string[] = [];
    for (const p of photos) {
      const id = await this.deps.identifier.identify(p);
      if (!id) {
        unidentified.push(p.name);
        continue;
      }
      items.push(await this.priced(id, p.name, createHash("sha256").update(p.bytes ?? p.name).digest("hex")));
    }
    return { items, unidentified };
  }

  /** Price something from what the person said about it, with no photo (selling by voice). */
  async appraiseDescription(text: string): Promise<AppraisedItem | undefined> {
    const id = await (this.deps.describer ?? new WordsDescriber()).describe(text);
    return id ? this.priced(id, text.slice(0, 80), createHash("sha256").update(`said:${text}`).digest("hex")) : undefined;
  }

  /** Comparables, then an AI estimate when there are none, plus the recall check. */
  private async priced(id: Identification, photoName: string, photoHash: string): Promise<AppraisedItem> {
    const comps = await this.deps.comps.find(id.title, id.category);
    const recall = await this.deps.recalls.check(id.title, id.category);
    let band = comps.length ? priceBand(comps, id.condition) : undefined;
    let priceSource: AppraisedItem["priceSource"] = band ? "comps" : "none";
    let compsSource = this.deps.comps.name;
    if (!band && this.deps.estimator) {
      const est = await this.deps.estimator.estimate(id);
      if (est) {
        const list = roundTo5((est.lowMinor + est.highMinor) / 2);
        band = { listMinor: list, quickSaleMinor: roundTo5(list * 0.8), floorSuggestionMinor: roundTo5(list * 0.7) };
        priceSource = "ai-estimate";
        compsSource = this.deps.estimator.name;
      }
    }
    return {
      photoName,
      photoHash,
      identification: id,
      priceBand: band ?? { listMinor: 0, quickSaleMinor: 0, floorSuggestionMinor: 0 },
      comps: comps.slice(0, 5),
      compsConfidence: comps.length >= 3 ? "high" : "low",
      compsSource,
      priceSource,
      recall,
    };
  }
}
