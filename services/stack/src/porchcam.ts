// The porch camera: a phone or laptop at the door, running Stoop's camera page. It does the job of a
// doorbell camera without one: it sends a frame whenever Stoop asks (the before and after photos of
// a pickup), and a frame whenever its own motion detector fires, which the vision model checks for a
// person (presence, counted only, never identified). Frames are labelled "porchcam", never "ring".
import { randomBytes } from "node:crypto";
import { CameraOfflineError, type Frame, type FrameSource } from "@stoop/ring-bridge";

interface Cam {
  id: string;
  latest?: Frame;
  waiters: Array<(f: Frame) => void>;
  lastSeen: number;
}

export class PorchCamSource implements FrameSource {
  readonly name = "porch_camera";
  private cams = new Map<string, Cam>();
  private now: () => number;
  private waitMs: number;
  constructor(o: { now?: () => number; waitMs?: number } = {}) {
    this.now = o.now ?? (() => Date.now());
    this.waitMs = o.waitMs ?? 20_000;
  }

  register(): string {
    const id = `porchcam_${randomBytes(6).toString("hex")}`;
    this.cams.set(id, { id, waiters: [], lastSeen: this.now() });
    return id;
  }

  has(id: string) {
    return this.cams.has(id);
  }

  /** Online = the camera page checked in within the last 30 seconds. */
  status(id: string) {
    const c = this.cams.get(id);
    return { online: !!c && this.now() - c.lastSeen < 30_000, lastFrameAt: c?.latest?.at };
  }

  /** The camera page polls this; true while Stoop is waiting for a frame from it. */
  wants(id: string): boolean {
    const c = this.cams.get(id);
    if (!c) return false;
    c.lastSeen = this.now();
    return c.waiters.length > 0;
  }

  put(id: string, frame: Frame) {
    const c = this.cams.get(id);
    if (!c) return;
    c.latest = frame;
    c.lastSeen = this.now();
    for (const w of c.waiters.splice(0)) w(frame);
  }

  async getFrame(deviceId: string): Promise<Frame> {
    const c = this.cams.get(deviceId);
    if (!c || this.now() - c.lastSeen > 30_000) throw new CameraOfflineError("porch camera not connected");
    if (c.latest && this.now() - c.latest.at < 3_000) return c.latest;
    return new Promise<Frame>((resolve, reject) => {
      const done = (f: Frame) => {
        clearTimeout(timer);
        resolve(f);
      };
      const timer = setTimeout(() => {
        c.waiters = c.waiters.filter((w) => w !== done);
        reject(new CameraOfflineError("porch camera did not send a frame"));
      }, this.waitMs);
      c.waiters.push(done);
    });
  }
}

/** Decode a `data:image/...;base64,` URL from the camera page into a frame. */
export function frameFromDataUrl(dataUrl: string, at: number): Frame {
  const m = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!m) throw new Error("bad_frame");
  const bytes = new Uint8Array(Buffer.from(m[2]!, "base64"));
  if (bytes.length > 2_500_000) throw new Error("frame_too_large");
  return { bytes, mime: m[1]!, at, origin: "porchcam", sourceName: "porch_camera" };
}
