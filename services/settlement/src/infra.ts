// Small infrastructure pieces with local implementations. Each has an AWS twin:
//   Store      -> DynamoDB single table (conditional writes, TransactWriteItems)
//   Vault      -> KMS Encrypt/Decrypt with a key only the Settlement role can use
//   Scheduler  -> Step Functions Standard (Wait states with TimestampPath)
//   EventBus   -> EventBridge
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

// ---------- ids / clock ----------

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

/** Test/demo clock that can be moved forward explicitly. */
export class ManualClock implements Clock {
  constructor(private t: number = Date.now()) {}
  now() {
    return this.t;
  }
  set(t: number) {
    this.t = t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

// ---------- store ----------

export interface WriteOp {
  key: string;
  value: unknown;
  /** Fail unless the key does not exist. */
  ifAbsent?: boolean;
  /** Fail unless the stored object's `version` equals this. */
  ifVersion?: number;
}

export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown, cond?: Omit<WriteOp, "key" | "value">): Promise<boolean>;
  /** All-or-nothing conditional write (DynamoDB TransactWriteItems). */
  transact(ops: WriteOp[]): Promise<boolean>;
  list<T>(prefix: string): Promise<T[]>;
  delete(key: string): Promise<void>;
}

export class MemoryStore implements Store {
  private data = new Map<string, string>();

  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }

  private check(op: WriteOp): boolean {
    const cur = this.data.get(op.key);
    if (op.ifAbsent && cur !== undefined) return false;
    if (op.ifVersion !== undefined) {
      if (cur === undefined) return false;
      if ((JSON.parse(cur) as { version?: number }).version !== op.ifVersion) return false;
    }
    return true;
  }

  async put(key: string, value: unknown, cond: Omit<WriteOp, "key" | "value"> = {}): Promise<boolean> {
    return this.transact([{ key, value, ...cond }]);
  }

  async transact(ops: WriteOp[]): Promise<boolean> {
    // JS is single-threaded: check-all-then-write-all is atomic within this process.
    if (!ops.every((op) => this.check(op))) return false;
    for (const op of ops) this.data.set(op.key, JSON.stringify(op.value));
    return true;
  }

  async list<T>(prefix: string): Promise<T[]> {
    const out: T[] = [];
    for (const [k, v] of this.data) if (k.startsWith(prefix)) out.push(JSON.parse(v) as T);
    return out;
  }

  async delete(key: string) {
    this.data.delete(key);
  }

  /** Raw contents, for a snapshot on disk (hosted shops survive restarts). */
  entries(): Array<[string, string]> {
    return [...this.data];
  }
  load(entries: Array<[string, string]>) {
    for (const [k, v] of entries) this.data.set(k, v);
  }
}

// ---------- vault ----------

export interface Vault {
  encrypt(plain: string): Promise<string>;
  decrypt(cipher: string): Promise<string>;
}

/** AES-256-GCM with a local key. In AWS this is KMS with a key policy granting Decrypt only to Settlement. */
export function localVault(secret: string): Vault {
  const key = createHash("sha256").update(secret).digest();
  return {
    async encrypt(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
    },
    async decrypt(cipher) {
      const [v, iv, tag, body] = cipher.split(".");
      if (v !== "v1" || !iv || !tag || !body) throw new Error("vault: bad ciphertext");
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
    },
  };
}

// ---------- events ----------

export interface StoopEvent {
  type: string;
  at: number;
  dealId?: string;
  listingId?: string;
  [k: string]: unknown;
}

export class EventBus {
  private em = new EventEmitter();
  private history: StoopEvent[] = [];
  constructor() {
    this.em.setMaxListeners(100);
  }
  emit(e: StoopEvent) {
    this.history.push(e);
    if (this.history.length > 2000) this.history.shift();
    this.em.emit("event", e);
  }
  on(fn: (e: StoopEvent) => void): () => void {
    this.em.on("event", fn);
    return () => this.em.off("event", fn);
  }
  recent(n = 200): StoopEvent[] {
    return this.history.slice(-n);
  }
}

// ---------- scheduler ----------

export interface ScheduledJob {
  id: string;
  at: number;
  kind: "open_window" | "close_window" | "inspection_elapsed" | "reservation_expired" | "hold_check" | "presence_grace";
  dealId: string;
}

export interface Scheduler {
  schedule(job: Omit<ScheduledJob, "id">): string;
  cancelFor(dealId: string, kind?: ScheduledJob["kind"]): void;
  pending(): ScheduledJob[];
}

/**
 * Deterministic scheduler: jobs fire when runDue(now) is called. The local stack calls runDue on a
 * 1-second tick; tests call it after moving a ManualClock. Mirrors Step Functions Wait+TimestampPath.
 */
export class TickScheduler implements Scheduler {
  private jobs: ScheduledJob[] = [];
  private handler?: (job: ScheduledJob) => Promise<void>;

  onFire(h: (job: ScheduledJob) => Promise<void>) {
    this.handler = h;
  }
  schedule(job: Omit<ScheduledJob, "id">): string {
    const j = { ...job, id: newId("job") };
    this.jobs.push(j);
    return j.id;
  }
  cancelFor(dealId: string, kind?: ScheduledJob["kind"]) {
    this.jobs = this.jobs.filter((j) => !(j.dealId === dealId && (kind === undefined || j.kind === kind)));
  }
  pending() {
    return [...this.jobs].sort((a, b) => a.at - b.at);
  }
  /** Put back jobs saved before a restart (they keep their ids and times). */
  restore(jobs: ScheduledJob[]) {
    for (const j of jobs) if (!this.jobs.some((x) => x.id === j.id)) this.jobs.push(j);
  }
  async runDue(now: number): Promise<number> {
    const due = this.jobs.filter((j) => j.at <= now).sort((a, b) => a.at - b.at);
    this.jobs = this.jobs.filter((j) => j.at > now);
    for (const j of due) await this.handler?.(j);
    return due.length;
  }
}
