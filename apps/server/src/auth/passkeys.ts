// Passkeys in the database (standalone): looked up at sign-in, added at enrolment from a one-time link.
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { ulid } from 'ulid';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Db } from '../db/open';
import { asDb } from '../db/open';
import * as t from '../db/schema';
import { getPerson, mustGetPerson, setupNeeded, wasAdmin, type Person } from '../household/people';
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
 * session ends, and their unused invites go (a lost or stolen device keeps nothing). Returns the person signed in, 'taken' if the passkey is
 * already enrolled, or null if the link is no longer good.
 */
export function enrol(db: Db, cfg: Pick<Config, 'dataDir' | 'keysDir'>, o: { inviteId: string; name?: string; newPersonId?: string }, cred: NewCredential, label: string): string | 'taken' | null {
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
        // and the admin's open invites: whoever held the lost device could have made some
        tx.delete(t.invite).where(and(eq(t.invite.createdBy, personId), eq(t.invite.kind, 'admin'), isNull(t.invite.usedAt))).run();
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

/** A reset needs a sign-in of the last few minutes. */
export const RESET_FRESH_MINUTES = 5;

/** A reset asked in a household with one admin waits this long; one not carried out goes after RESET_ASK_DAYS. */
export const RESET_WAIT_HOURS = 24;
export const RESET_ASK_DAYS = 7;
export type PasskeyReset = typeof t.passkeyReset.$inferSelect;
/** Who is told what of a reset (the queue's `tell`): asked, the person and the other admins; done, the person and their draws' people. */
export type ResetTelling = (kind: 'reset_asked' | 'signin_reset', resetId: string, people: string[]) => void;

/** The reset asked for this person and not carried out yet, if any (one asked more than RESET_ASK_DAYS ago is over). */
export function openReset(db: Db, personId: string, now = new Date()): PasskeyReset | undefined {
  const since = new Date(now.getTime() - RESET_ASK_DAYS * 86_400_000).toISOString();
  return db.select().from(t.passkeyReset).where(and(eq(t.passkeyReset.personId, personId), isNull(t.passkeyReset.doneAt), gt(t.passkeyReset.askedAt, since))).get();
}

/**
 * An admin's reset of someone's passkeys, for a person who lost every device (an admin who did uses `keepsake
 * recover`). Decided by Arjun at the Gate (routes M1): an admin alone can no longer become anyone. The first call asks:
 * the reset is carried out when **another admin** makes the same call, or, in a household with one admin, when its
 * asker calls again a day later (RESET_WAIT_HOURS). Meanwhile the person (who may still have a device) and the other
 * admins are told, and the person or any admin can cancel it. Carried out: their passkeys go, their sessions end with
 * them and their open links are spent, their draws stay sealed to them until they confirm the reset on their new
 * device, and they and the people of their open draws are told. Someone who is or was recently an admin
 * (`wasAdmin`) is never reset. Every step is audited.
 */
export function resetPasskeys(db: Db, actorId: string, personId: string, tellOf: ResetTelling, openDrawsOf: (personId: string) => string[], now = new Date()): PasskeyReset {
  const p = mustGetPerson(db, personId);
  if (wasAdmin(p, now)) throw new Refused(409, 'an admin recovers with keepsake recover');
  const at = now.toISOString();
  return db.transaction((tx0) => {
    const tx = asDb(tx0);
    const open = openReset(tx, p.id, now);
    if (!open) {
      const admins = tx.select({ id: t.person.id }).from(t.person).where(eq(t.person.role, 'admin')).all().map((a) => a.id)
        .filter((id) => id !== actorId && id !== p.id && Boolean(tx.select({ id: t.passkey.id }).from(t.passkey).where(eq(t.passkey.personId, id)).get()));
      const r = { id: ulid(), personId: p.id, askedBy: actorId, askedAt: at, notBefore: admins.length ? null : new Date(now.getTime() + RESET_WAIT_HOURS * 3_600_000).toISOString(), approvedBy: null, approvedAt: null, doneAt: null, doneBy: null };
      tx.insert(t.passkeyReset).values(r).run();
      tx.insert(t.audit).values({ id: ulid(), at, actorId, action: 'reset_asked', subjectId: p.id }).run();
      tellOf('reset_asked', r.id, [p.id, ...admins]);
      return r;
    }
    // The asker again: only once its day has passed, in a household with one admin; anyone else here is the second admin.
    const second = open.askedBy !== actorId;
    if (!second && (open.notBefore === null || at < open.notBefore)) return open;
    tx.delete(t.session).where(eq(t.session.personId, p.id)).run();
    tx.delete(t.passkey).where(eq(t.passkey.personId, p.id)).run();
    spendInvites(tx, p.id, now);
    tx.update(t.person).set({ drawsSealedAt: at }).where(eq(t.person.id, p.id)).run();
    tx.update(t.passkeyReset).set({ doneAt: at, doneBy: actorId }).where(eq(t.passkeyReset.id, open.id)).run();
    tx.insert(t.audit).values({ id: ulid(), at, actorId, action: 'passkeys_reset', subjectId: p.id }).run();
    tellOf('signin_reset', open.id, [p.id, ...openDrawsOf(p.id)]);
    return { ...open, doneAt: at, doneBy: actorId };
  });
}

/** The person, or any admin, calls off a reset not carried out yet. */
export function cancelReset(db: Db, actorId: string, personId: string, now = new Date()): void {
  const open = openReset(db, personId, now);
  if (!open) throw new Refused(404, 'no reset is waiting');
  db.transaction((tx) => {
    tx.delete(t.passkeyReset).where(eq(t.passkeyReset.id, open.id)).run();
    tx.insert(t.audit).values({ id: ulid(), at: now.toISOString(), actorId, action: 'reset_cancelled', subjectId: personId }).run();
  });
}

/** The person, signed in on their new device, confirms the reset: their draws open to them again. */
export function confirmReset(db: Db, personId: string, now = new Date()): void {
  const p = mustGetPerson(db, personId);
  if (!p.drawsSealedAt) throw new Refused(404, 'no reset is waiting');
  db.transaction((tx) => {
    tx.update(t.person).set({ drawsSealedAt: null }).where(eq(t.person.id, p.id)).run();
    tx.insert(t.audit).values({ id: ulid(), at: now.toISOString(), actorId: p.id, action: 'reset_confirmed', subjectId: p.id }).run();
  });
}
