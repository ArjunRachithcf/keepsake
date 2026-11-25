// Passkeys in the database (standalone): looked up at sign-in, added at enrolment from a one-time link.
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/open';
import { asDb } from '../db/open';
import * as t from '../db/schema';
import { getPerson, setupNeeded, type Person } from '../household/people';
import { openRecovery, removeSetupLink, spendInvites, useInvite, type Invite } from './invites';
import type { Config } from '../config';
import type { NewCredential, StoredCredential } from './webauthn';

const stored = (k: typeof t.passkey.$inferSelect): StoredCredential =>
  ({ id: k.id, publicKey: k.publicKey, counter: k.counter, transports: JSON.parse(k.transportsJson) as string[] });

export function credentialsOf(db: Db, personId: string): StoredCredential[] {
  return db.select().from(t.passkey).where(eq(t.passkey.personId, personId)).all().map(stored);
}

export function findPasskey(db: Db, id: string): { credential: StoredCredential; person: Person } | null {
  const k = db.select().from(t.passkey).where(eq(t.passkey.id, id)).get();
  const p = k ? getPerson(db, k.personId) : undefined;
  return k && p ? { credential: stored(k), person: p } : null;
}

export function usedPasskey(db: Db, id: string, counter: number): void {
  db.update(t.passkey).set({ counter, lastUsedAt: new Date().toISOString() }).where(eq(t.passkey.id, id)).run();
}

export function getInvite(db: Db, id: string): Invite | undefined {
  return db.select().from(t.invite).where(eq(t.invite.id, id)).get();
}

/**
 * Adds the passkey a one-time link was for and spends the link (and every other open link of that person). The
 * setup link makes the first admin, with the name typed. An admin's invite is for someone's first passkey only.
 * Returns the person signed in, 'taken' if the passkey is already enrolled, or null if the link is no longer good.
 */
export function enrol(db: Db, cfg: Pick<Config, 'dataDir'>, inviteId: string, name: string | undefined, cred: NewCredential, label: string): string | 'taken' | null {
  if (db.select({ id: t.passkey.id }).from(t.passkey).where(eq(t.passkey.id, cred.id)).get()) return 'taken';
  const now = new Date().toISOString();
  let personId: string | null = null;
  let recovery = false;
  try {
    db.transaction((tx) => {
      const invite = tx.select().from(t.invite).where(eq(t.invite.id, inviteId)).get();
      if (!invite || !useInvite(asDb(tx), invite.id)) return;
      if (invite.kind === 'setup') {
        personId = ulid();
        tx.insert(t.person).values({ id: personId, name: name ?? 'Admin', role: 'admin', createdAt: now }).run();
      } else {
        personId = invite.personId;
        recovery = invite.kind === 'recovery';
        if (invite.kind === 'admin' && personId && tx.select({ id: t.passkey.id }).from(t.passkey).where(eq(t.passkey.personId, personId)).get()) personId = null;
      }
      if (!personId) return;
      tx.insert(t.passkey).values({
        id: cred.id, personId, publicKey: Buffer.from(cred.publicKey), counter: cred.counter,
        transportsJson: JSON.stringify(cred.transports), backedUp: cred.backedUp ? 1 : 0, label, createdAt: now,
        invitedBy: invite.kind === 'admin' ? invite.createdBy : null,
      }).run();
      spendInvites(asDb(tx), personId);
    });
  } catch (e) {
    // Two enrolments of one passkey at once: the primary key decides.
    if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return 'taken';
    throw e;
  }
  if (personId && (recovery || !setupNeeded(db)) && !openRecovery(db)) removeSetupLink(cfg);
  return personId;
}

export function invitePersonOf(db: Db, invite: Invite): Person | undefined {
  return invite.personId ? getPerson(db, invite.personId) : undefined;
}

