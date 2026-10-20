// Local twins of S3 (photos) and AgentCore Memory (seller preferences across sessions).
import { createHash } from "node:crypto";
import type { PhotoStore, PickupPrefs, PreferenceMemory, SweepPhoto } from "@stoop/mcp-server";
import { stripMetadata } from "./exif.ts";

export class LocalPhotoStore implements PhotoStore {
  private sweeps = new Map<string, SweepPhoto[]>();
  private byId = new Map<string, SweepPhoto>();
  constructor(private publicBase: string) {}

  add(householdId: string, photos: Array<{ name: string; bytes: Uint8Array; mime: string; hint?: string }>, replace = true): SweepPhoto[] {
    const stored = photos.map((p) => {
      const clean = stripMetadata(p.bytes, p.mime);
      const id = createHash("sha256").update(clean).digest("hex").slice(0, 16);
      const ext = p.mime.includes("png") ? "png" : p.mime.includes("svg") ? "svg" : "jpg";
      const photo: SweepPhoto = { id, name: p.name, url: `${this.publicBase}/photos/${id}.${ext}`, mime: p.mime, bytes: clean, hint: p.hint };
      this.byId.set(id, photo);
      return photo;
    });
    this.sweeps.set(householdId, replace ? stored : [...(this.sweeps.get(householdId) ?? []), ...stored]);
    return stored;
  }

  /** A photo that isn't part of a sweep (the porch camera's listing photo). */
  keep(photo: { name: string; bytes: Uint8Array; mime: string }): SweepPhoto {
    const clean = stripMetadata(photo.bytes, photo.mime);
    const id = createHash("sha256").update(clean).digest("hex").slice(0, 16);
    const ext = photo.mime.includes("png") ? "png" : "jpg";
    const kept: SweepPhoto = { id, name: photo.name, url: `${this.publicBase}/photos/${id}.${ext}`, mime: photo.mime, bytes: clean };
    this.byId.set(id, kept);
    return kept;
  }

  get(id: string) {
    return this.byId.get(id);
  }

  async lastSweep(householdId: string) {
    return this.sweeps.get(householdId) ?? [];
  }

  /** For a snapshot: every photo (with bytes, saved once each by the caller) and the latest sweeps. */
  all() {
    return [...this.byId.values()];
  }
  sweepIds(): Array<[string, string[]]> {
    return [...this.sweeps].map(([h, ps]) => [h, ps.map((p) => p.id)]);
  }
  load(photos: SweepPhoto[], sweeps: Array<[string, string[]]>) {
    for (const p of photos) this.byId.set(p.id, p);
    for (const [h, ids] of sweeps) this.sweeps.set(h, ids.map((id) => this.byId.get(id)).filter((p): p is SweepPhoto => !!p));
  }
}

/** Seller preferences. Addresses are never stored here (redaction filter, rule R2). */
export class LocalPreferenceMemory implements PreferenceMemory {
  private prefs = new Map<string, PickupPrefs>();
  constructor(private redactions: () => string[] = () => []) {}
  async get(householdId: string) {
    return this.prefs.get(householdId);
  }
  async set(householdId: string, p: PickupPrefs) {
    let label = p.label;
    for (const r of this.redactions()) if (r && label.includes(r)) label = label.replaceAll(r, "[redacted]");
    this.prefs.set(householdId, { ...p, label });
  }
  dump(): Array<[string, PickupPrefs]> {
    return [...this.prefs];
  }
  load(e: Array<[string, PickupPrefs]>) {
    for (const [k, v] of e) this.prefs.set(k, v);
  }
}
