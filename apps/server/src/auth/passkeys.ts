// Passkeys in the database (standalone): looked up at sign-in, added at enrolment from a one-time link.
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Db } from '../db/open';
import { asDb } from '../db/open';
import * as t from '../db/schema';
import { getPerson, setupNeeded, type Person } from '../household/people';
import { openRecovery, removeSetupLink, spendInvites, useInvite, type Invite } from './invites';
import type { Config } from '../config';
import { Refused } from '../errors';
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
 * Adds the passkey a one-time link was for and spends the link (and every other open link of that person). The link
 * must still be unused and unexpired at this last step. The setup link makes the first admin, with the name typed
 * and the id chosen when the passkey's options were made (the authenticator's user handle). An admin's invite is for
 * someone's first passkey only. A recovery link replaces the admin's passkeys: the others are removed and every
 * session ends (a lost or stolen device keeps nothing). Returns the person signed in, 'taken' if the passkey is
 * already enrolled, or null if the link is no longer good.
 */
export function enrol(db: Db, cfg: Pick<Config, 'dataDir'>, o: { inviteId: string; name?: string; newPersonId?: string }, cred: NewCredential, label: string): string | 'taken' | null {
  const { inviteId, name } = o;
  if (db.select({ id: t.passkey.id }).from(t.passkey).where(eq(t.passkey.id, cred.id)).get()) return 'taken';
  const now = new Date().toISOString();
  let personId: string | null = null;
  let recovery = false;
  try {
    db.transaction((tx) => {
      const invite = tx.select().from(t.invite).where(and(eq(t.invite.id, inviteId), isNull(t.invite.usedAt), gt(t.invite.expiresAt, now))).get();
      if (!invite || !useInvite(asDb(tx), invite.id)) return;
      if (invite.kind === 'setup') {
        if (!o.newPersonId) return;
        personId = o.newPersonId;
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
      if (recovery) {
        tx.delete(t.session).where(eq(t.session.personId, personId)).run();
        tx.delete(t.passkey).where(and(eq(t.passkey.personId, personId), ne(t.passkey.id, cred.id))).run();
      }
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

/** A person's passkeys, with who invited each (shown in "Your passkeys"). */
export function passkeysOf(db: Db, personId: string) {
  const by = alias(t.person, 'by');
  return db.select({ k: t.passkey, by: by.name }).from(t.passkey).leftJoin(by, eq(by.id, t.passkey.invitedBy))
    .where(eq(t.passkey.personId, personId)).all()
    .map(({ k, by }) => ({ id: k.id, label: k.label, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, backedUp: k.backedUp === 1, invitedBy: by ?? null }));
}

/** Removes one of your passkeys (the sessions it signed in end with it); your last one stays. */
export function removePasskey(db: Db, personId: string, id: string): void {
  const mine = db.select({ id: t.passkey.id }).from(t.passkey).where(eq(t.passkey.personId, personId)).all();
  if (!mine.some((k) => k.id === id)) throw new Refused(404, 'no such passkey');
  if (mine.length === 1) throw new Refused(409, 'your last passkey stays: add another first');
  db.delete(t.passkey).where(and(eq(t.passkey.id, id), eq(t.passkey.personId, personId))).run();
}
