// Verifier: reacts to `frame_needed`, fetches a frame, asks vision, records the observation.
// The verdict itself is computed by Settlement with the deterministic truth table.
import { createHash } from "node:crypto";
import { CameraOfflineError, NoMediaError, type Frame, type FrameSource } from "@stoop/ring-bridge";
import type { ItemPresence } from "@stoop/shared";
import type { VisionAdapter, VisionVerdict } from "./vision.ts";

export interface EvidenceSink {
  recordFrame(
    dealId: string,
    kind: "before" | "after",
    obs: { presence: ItemPresence; sha256: string; at: number; rationale?: string; origin: "ring" | "our_footage" | "simulator" },
  ): Promise<unknown>;
  setCameraStatus(dealId: string, camera: "ok" | "offline" | "e2ee" | "unavailable"): Promise<unknown>;
  dealInfo(dealId: string): Promise<{ itemTitle: string; placement?: string; deviceId?: string; state: string }>;
}

export interface FrameNeeded {
  dealId: string;
  kind: "before" | "after";
  notBefore?: number;
  deviceId?: string;
}

export interface VerifierDeps {
  sink: EvidenceSink;
  frames: FrameSource;
  vision: VisionAdapter;
  now(): number;
  /** Run fn after ms (setTimeout locally, Step Functions Wait in AWS). Tests pass an immediate runner. */
  delay(ms: number, fn: () => Promise<void>): void;
  onFrame?(info: { dealId: string; kind: "before" | "after"; frame: Frame; verdict: VisionVerdict; sha256: string }): void;
  log?(msg: string, data?: Record<string, unknown>): void;
}

const ACTIVE = new Set(["WINDOW_OPEN", "STILL_THERE"]);

export class Verifier {
  private inflight = new Set<string>();
  constructor(private d: VerifierDeps) {}

  /** Handle a frame_needed request (deduped per deal+kind while one is in flight). */
  request(req: FrameNeeded) {
    const key = `${req.dealId}:${req.kind}`;
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    const wait = Math.max(0, (req.notBefore ?? 0) - this.d.now());
    this.d.delay(wait, async () => {
      try {
        await this.capture(req);
      } catch (e) {
        this.d.log?.("verifier_error", { dealId: req.dealId, error: String(e) });
      } finally {
        this.inflight.delete(key);
      }
    });
  }

  async capture(req: FrameNeeded) {
    const info = await this.d.sink.dealInfo(req.dealId);
    if (!ACTIVE.has(info.state)) return;
    const deviceId = req.deviceId ?? info.deviceId;
    if (!deviceId) {
      await this.d.sink.setCameraStatus(req.dealId, "unavailable");
      return;
    }
    let frame: Frame;
    try {
      frame = await this.d.frames.getFrame(deviceId, this.d.now(), { kind: req.kind });
    } catch (e) {
      if (e instanceof CameraOfflineError) {
        await this.d.sink.setCameraStatus(req.dealId, "offline");
        return;
      }
      // No recording to look at is never evidence: the deal falls back to the capped dual-confirm path
      if (e instanceof NoMediaError) {
        this.d.log?.("no_recording", { dealId: req.dealId, kind: req.kind });
        await this.d.sink.setCameraStatus(req.dealId, "unavailable");
        return;
      }
      throw e;
    }
    const verdict = await this.d.vision.assess({ frame, itemTitle: info.itemTitle, placement: info.placement });
    const sha256 = createHash("sha256").update(frame.bytes).digest("hex");
    this.d.onFrame?.({ dealId: req.dealId, kind: req.kind, frame, verdict, sha256 });
    await this.d.sink.recordFrame(req.dealId, req.kind, {
      presence: verdict.presence,
      sha256,
      at: frame.at,
      rationale: `${verdict.rationale} [${verdict.adapter}]`,
      origin: frame.origin,
    });
  }
}
