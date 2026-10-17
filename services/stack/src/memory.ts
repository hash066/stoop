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

  get(id: string) {
    return this.byId.get(id);
  }

  async lastSweep(householdId: string) {
    return this.sweeps.get(householdId) ?? [];
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
}
