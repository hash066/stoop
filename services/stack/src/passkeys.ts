// Face ID or a fingerprint on the pickup pass (WebAuthn passkeys). Optional for the buyer: once they
// lock their pass, the address, the lockbox code, the check-in and the "Got it" need a fresh unlock on
// that phone. The private key never leaves the phone; Stoop keeps only the public key, per pass.
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture, RegistrationResponseJSON } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { Hono } from "hono";
import type { Store } from "@stoop/settlement";

interface SavedKey {
  id: string;
  publicKey: string;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
}

export class PassLocks {
  private challenges = new Map<string, { challenge: string; exp: number }>();
  private unlockedUntil = new Map<string, number>();
  constructor(
    private o: {
      store: Store;
      /** The site the pass page is served from (the passkey's relying party). */
      origin: string;
      now: () => number;
      /** The phone the pass is bound to, if any. */
      boundDevice(passId: string): Promise<string | undefined>;
      unlockMs?: number;
    },
  ) {}

  private rpID() {
    return new URL(this.o.origin).hostname;
  }
  private key(passId: string) {
    return `passkey#${passId}`;
  }

  async locked(passId: string) {
    return !!(await this.o.store.get<SavedKey>(this.key(passId)));
  }
  /** True when the pass has no passkey, or this phone unlocked it in the last few minutes. */
  async open(passId: string, device: string) {
    if (!(await this.locked(passId))) return true;
    return (this.unlockedUntil.get(`${passId}:${device}`) ?? 0) > this.o.now();
  }

  private remember(passId: string, challenge: string) {
    const t = this.o.now();
    for (const [k, v] of this.challenges) if (v.exp < t) this.challenges.delete(k);
    this.challenges.set(passId, { challenge, exp: t + 5 * 60_000 });
  }
  private take(passId: string) {
    const c = this.challenges.get(passId);
    this.challenges.delete(passId);
    return c && c.exp >= this.o.now() ? c.challenge : undefined;
  }
  private unlock(passId: string, device: string) {
    const until = this.o.now() + (this.o.unlockMs ?? 10 * 60_000);
    this.unlockedUntil.set(`${passId}:${device}`, until);
    return until;
  }

  /** Mounted at /pass/:id/lock and /pass/:id/unlock; only the phone the pass is bound to may use them. */
  router(device: (h: string | undefined) => string) {
    const app = new Hono();
    const bound = async (passId: string, dev: string) => !!dev && (await this.o.boundDevice(passId)) === dev;

    app.post("/:id/lock/options", async (c) => {
      const passId = c.req.param("id");
      if (!(await bound(passId, device(c.req.header("X-Stoop-Device"))))) return c.json({ error: "device_not_bound" }, 403);
      if (await this.locked(passId)) return c.json({ error: "already_locked" }, 409);
      const options = await generateRegistrationOptions({
        rpName: "Stoop",
        rpID: this.rpID(),
        userName: `Stoop pickup pass ${passId.slice(-6)}`,
        userID: new TextEncoder().encode(passId),
        attestationType: "none",
        authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "discouraged", userVerification: "required" },
        timeout: 60_000,
      });
      this.remember(passId, options.challenge);
      return c.json(options);
    });

    app.post("/:id/lock", async (c) => {
      const passId = c.req.param("id");
      const dev = device(c.req.header("X-Stoop-Device"));
      if (!(await bound(passId, dev))) return c.json({ error: "device_not_bound" }, 403);
      const expectedChallenge = this.take(passId);
      if (!expectedChallenge) return c.json({ error: "expired", message: "That took too long. Try again." }, 410);
      const response = (await c.req.json().catch(() => undefined)) as RegistrationResponseJSON | undefined;
      try {
        const v = await verifyRegistrationResponse({ response: response!, expectedChallenge, expectedOrigin: this.o.origin, expectedRPID: this.rpID(), requireUserVerification: true });
        if (!v.verified || !v.registrationInfo) throw new Error("not verified");
        const cred = v.registrationInfo.credential;
        await this.o.store.put(this.key(passId), { id: cred.id, publicKey: isoBase64URL.fromBuffer(cred.publicKey), counter: cred.counter, transports: cred.transports, version: 1 });
        return c.json({ locked: true, unlockedUntil: this.unlock(passId, dev) });
      } catch {
        return c.json({ error: "not_verified", message: "That didn’t work. Try again." }, 400);
      }
    });

    app.post("/:id/unlock/options", async (c) => {
      const passId = c.req.param("id");
      if (!(await bound(passId, device(c.req.header("X-Stoop-Device"))))) return c.json({ error: "device_not_bound" }, 403);
      const saved = await this.o.store.get<SavedKey>(this.key(passId));
      if (!saved) return c.json({ error: "not_locked" }, 409);
      const options = await generateAuthenticationOptions({ rpID: this.rpID(), allowCredentials: [{ id: saved.id, transports: saved.transports }], userVerification: "required", timeout: 60_000 });
      this.remember(passId, options.challenge);
      return c.json(options);
    });

    app.post("/:id/unlock", async (c) => {
      const passId = c.req.param("id");
      const dev = device(c.req.header("X-Stoop-Device"));
      if (!(await bound(passId, dev))) return c.json({ error: "device_not_bound" }, 403);
      const saved = await this.o.store.get<SavedKey & { version: number }>(this.key(passId));
      const expectedChallenge = this.take(passId);
      if (!saved || !expectedChallenge) return c.json({ error: "expired", message: "That took too long. Try again." }, 410);
      const response = (await c.req.json().catch(() => undefined)) as AuthenticationResponseJSON | undefined;
      try {
        const v = await verifyAuthenticationResponse({
          response: response!,
          expectedChallenge,
          expectedOrigin: this.o.origin,
          expectedRPID: this.rpID(),
          credential: { id: saved.id, publicKey: isoBase64URL.toBuffer(saved.publicKey), counter: saved.counter, transports: saved.transports },
          requireUserVerification: true,
        });
        if (!v.verified) throw new Error("not verified");
        await this.o.store.put(this.key(passId), { ...saved, counter: v.authenticationInfo.newCounter, version: saved.version + 1 });
        return c.json({ unlockedUntil: this.unlock(passId, dev) });
      } catch {
        return c.json({ error: "not_verified", message: "That didn’t work. Try again." }, 400);
      }
    });
    return app;
  }
}
