// Where camera frames come from. Three sources, always labelled in the UI and on receipts:
//  - RingSnapshotSource: the real Ring Partner API (Playground or a US device)
//  - FootageSource: our own labelled porch footage stills, played as "the camera" (judge-approved)
// The FootageSource carries a ground-truth label per still, used by evals and by MockVision offline.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ItemPresence } from "@stoop/shared";
import { RingApiError, type RingClient } from "./client.ts";

export interface Frame {
  bytes: Uint8Array;
  mime: string;
  at: number;
  origin: "ring" | "our_footage" | "simulator" | "porchcam";
  /** Ground truth for labelled footage (never trusted in production paths). */
  label?: ItemPresence;
  sourceName: string;
}

export interface FrameSource {
  readonly name: string;
  getFrame(deviceId: string, at: number, opts?: { kind?: "before" | "after" }): Promise<Frame>;
}

export class CameraOfflineError extends Error {}
/** The camera is online but has no recording in the range (no press, motion or live view; or no recording plan). */
export class NoMediaError extends Error {}

/**
 * How far back to look for an existing image. Ring's image download never captures a new image, so
 * "now" usually has nothing: the before frame takes the latest recording up to the window (when the
 * seller set the item out), the after frame the latest from the visit (the doorbell press and the
 * motion after it). The frame's own timestamp is kept as evidence.
 */
export const FRAME_LOOKBACK_MS = { before: 6 * 60 * 60 * 1000, after: 5 * 60 * 1000 } as const;

export class RingSnapshotSource implements FrameSource {
  readonly name = "ring_snapshot";
  constructor(private client: RingClient) {}
  async getFrame(deviceId: string, at: number, opts: { kind?: "before" | "after" } = {}): Promise<Frame> {
    const lookback = FRAME_LOOKBACK_MS[opts.kind ?? "after"];
    try {
      const s = await this.client.snapshot(deviceId, { type: "latest_in_range", startTimestamp: at - lookback, endTimestamp: at + 60_000 });
      return { bytes: s.bytes, mime: s.mime, at: s.mediaTimestamp ?? at, origin: "ring", sourceName: this.name };
    } catch (e) {
      if (e instanceof RingApiError && e.offline) throw new CameraOfflineError("device offline");
      if (e instanceof RingApiError && e.noMedia) throw new NoMediaError(e.message);
      throw e;
    }
  }
}

export type Scene = "item_present" | "item_absent" | "unclear" | "offline";

export interface FootageStill {
  file: string;
  label: ItemPresence;
}

/**
 * Plays labelled stills as a camera. The current scene per device is set by the simulator
 * (or by the Ops console scenario buttons). Falls back to generated placeholder SVGs.
 */
export class FootageSource implements FrameSource {
  readonly name = "our_footage";
  private scenes = new Map<string, Scene>();
  constructor(
    private dir: string,
    private stills: Record<Exclude<Scene, "offline">, FootageStill[]>,
  ) {}

  setScene(deviceId: string, scene: Scene) {
    this.scenes.set(deviceId, scene);
  }
  scene(deviceId: string): Scene {
    return this.scenes.get(deviceId) ?? "item_present";
  }

  async getFrame(deviceId: string, at: number): Promise<Frame> {
    const scene = this.scene(deviceId);
    if (scene === "offline") throw new CameraOfflineError("device offline (simulated)");
    const pool = this.stills[scene];
    const pick = pool[Math.floor(at / 1000) % Math.max(pool.length, 1)];
    const label: ItemPresence = scene === "item_present" ? "present" : scene === "item_absent" ? "absent" : "unsure";
    if (pick) {
      try {
        const bytes = new Uint8Array(await readFile(join(this.dir, pick.file)));
        return { bytes, mime: pick.file.endsWith(".png") ? "image/png" : "image/jpeg", at, origin: "our_footage", label: pick.label, sourceName: this.name };
      } catch {
        /* fall through to placeholder */
      }
    }
    return { bytes: placeholderSvg(scene, at), mime: "image/svg+xml", at, origin: "simulator", label, sourceName: "placeholder" };
  }
}

/** Simple labelled porch illustration for offline demos before real footage exists. */
export function placeholderSvg(scene: Exclude<Scene, "offline">, at: number): Uint8Array {
  const item =
    scene === "item_present"
      ? `<g><rect x="380" y="300" width="120" height="70" rx="10" fill="#3b3a36"/><circle cx="400" cy="385" r="18" fill="#1f1e1b"/><circle cx="480" cy="385" r="18" fill="#1f1e1b"/><path d="M500 300 L540 250" stroke="#3b3a36" stroke-width="8"/></g>`
      : scene === "unclear"
        ? `<rect x="0" y="0" width="800" height="450" fill="#ffffff" opacity="0.7"/>`
        : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
<rect width="800" height="450" fill="#d9cdb4"/><rect x="0" y="380" width="800" height="70" fill="#a89a7d"/>
<rect x="250" y="80" width="160" height="300" fill="#6b4f36"/><rect x="560" y="300" width="180" height="40" fill="#8a7a5c"/>
${item}
<text x="16" y="28" font-family="monospace" font-size="16" fill="#1f1e1b">SIMULATED FRAME · ${scene} · ${new Date(at).toISOString()}</text></svg>`;
  return new TextEncoder().encode(svg);
}
