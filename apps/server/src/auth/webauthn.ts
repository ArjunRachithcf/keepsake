// Passkeys (Philobiblos ADR 0010) with @simplewebauthn/server: discoverable credentials, user verification required at enrolment
// and at every sign-in, no attestation. Challenges live in memory for 5 minutes and are used once.
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransport, type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { randomBytes } from 'node:crypto';
import type { Config } from '../config';

export interface NewCredential { id: string; publicKey: Uint8Array; counter: number; transports: string[]; backedUp: boolean }
export interface StoredCredential { id: string; publicKey: Uint8Array; counter: number; transports: string[] }

/** The WebAuthn operations Keepsake needs; tests swap in a fake, production uses @simplewebauthn/server. */
export interface WebAuthn {
  registrationOptions(i: { userId: string; userName: string; exclude: StoredCredential[] }): Promise<{ challenge: string; options: PublicKeyCredentialCreationOptionsJSON }>;
  verifyRegistration(i: { response: unknown; challenge: string }): Promise<NewCredential | null>;
  authenticationOptions(): Promise<{ challenge: string; options: PublicKeyCredentialRequestOptionsJSON }>;
  /** The credential id the response claims, before any verification (to look the passkey up). */
  credentialId(response: unknown): string | null;
  verifyAuthentication(i: { response: unknown; challenge: string; credential: StoredCredential }): Promise<{ newCounter: number } | null>;
}

const transports = (t: string[]) => t as AuthenticatorTransport[];

export function simpleWebAuthn(cfg: Pick<Config, 'origin' | 'rpId'>): WebAuthn {
  return {
    async registrationOptions({ userId, userName, exclude }) {
      const options = await generateRegistrationOptions({
        rpName: 'Keepsake', rpID: cfg.rpId, userName, userDisplayName: userName,
        userID: new TextEncoder().encode(userId),
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: exclude.map((c) => ({ id: c.id, transports: transports(c.transports) })),
      });
      return { challenge: options.challenge, options };
    },
    async verifyRegistration({ response, challenge }) {
      try {
        const r = await verifyRegistrationResponse({
          response: response as RegistrationResponseJSON, expectedChallenge: challenge,
          expectedOrigin: cfg.origin, expectedRPID: cfg.rpId, requireUserVerification: true,
        });
        if (!r.verified) return null;
        const c = r.registrationInfo.credential;
        return { id: c.id, publicKey: c.publicKey, counter: c.counter, transports: c.transports ?? [], backedUp: r.registrationInfo.credentialBackedUp };
      } catch {
        return null;
      }
    },
    async authenticationOptions() {
      const options = await generateAuthenticationOptions({ rpID: cfg.rpId, userVerification: 'required' });
      return { challenge: options.challenge, options };
    },
    credentialId(response) {
      const id = (response as { id?: unknown } | null)?.id;
      return typeof id === 'string' && /^[A-Za-z0-9_-]{16,1400}$/.test(id) ? id : null;
    },
    async verifyAuthentication({ response, challenge, credential }) {
      try {
        const r = await verifyAuthenticationResponse({
          response: response as AuthenticationResponseJSON, expectedChallenge: challenge,
          expectedOrigin: cfg.origin, expectedRPID: cfg.rpId, requireUserVerification: true,
          credential: { id: credential.id, publicKey: new Uint8Array(credential.publicKey), counter: credential.counter, transports: transports(credential.transports) },
        });
        return r.verified ? { newCounter: r.authenticationInfo.newCounter } : null;
      } catch {
        return null;
      }
    },
  };
}

export interface Pending { challenge: string; kind: 'enrol' | 'sign-in'; inviteId?: string; name?: string; newPersonId?: string; expires: number }

/**
 * One-time challenges, 5 minutes. Each client (its rate-limit key) holds at most 20 waiting, and all together at most
 * 1000: a flood from one client pushes out only its own, never someone else's sign-in in progress.
 */
export class Challenges {
  private readonly m = new Map<string, Pending & { key: string }>();
  constructor(private readonly ttlMs = 5 * 60_000, private readonly max = 1000, private readonly perKey = 20) {}
  put(p: Omit<Pending, 'expires'>, key = '', now = Date.now()): string {
    for (const [k, v] of this.m) if (v.expires <= now) this.m.delete(k);
    const mine = [...this.m].filter(([, v]) => v.key === key);
    if (mine.length >= this.perKey) this.m.delete(mine[0]![0]);
    if (this.m.size >= this.max) {
      // the oldest of whoever holds the most
      const counts = new Map<string, number>();
      for (const v of this.m.values()) counts.set(v.key, (counts.get(v.key) ?? 0) + 1);
      const top = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
      for (const [k, v] of this.m) if (v.key === top) { this.m.delete(k); break; }
    }
    const id = randomBytes(18).toString('base64url');
    this.m.set(id, { ...p, key, expires: now + this.ttlMs });
    return id;
  }
  take(id: unknown, kind: Pending['kind'], now = Date.now()): Pending | null {
    if (typeof id !== 'string') return null;
    const p = this.m.get(id);
    this.m.delete(id);
    return p && p.kind === kind && p.expires > now ? p : null;
  }
}
