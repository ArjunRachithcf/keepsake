// One-time links to enrol a passkey (Philobiblos ADR 0010): the first admin's setup link, an admin's invite, your own
// link for another device, and `keepsake recover`'s. The token travels in the link's #fragment (never in a request
// line or a log) and the database keeps only its hash.
import { closeSync, constants, fchmodSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { setupNeeded } from '../household/people';
import { hashToken, looksLikeToken, newToken } from './tokens';

export type Invite = typeof t.invite.$inferSelect;
export type InviteKind = Invite['kind'];
const HOUR = 3_600_000;
export const SETUP_FILE = 'setup-link.txt';
const HOURS: Record<InviteKind, number> = { setup: 24, admin: 7 * 24, self: 24, recovery: 24 };

export function createInvite(db: Db, cfg: Pick<Config, 'origin'>, o: { kind: InviteKind; personId?: string; createdBy?: string; now?: Date }) {
  const now = o.now ?? new Date();
  const token = newToken();
  const expiresAt = new Date(now.getTime() + HOURS[o.kind] * HOUR);
  db.insert(t.invite).values({
    id: ulid(), kind: o.kind, personId: o.personId ?? null, tokenHash: hashToken(token),
    createdBy: o.createdBy ?? null, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
  }).run();
  return { url: `${cfg.origin}/${o.kind === 'setup' ? 'setup' : 'enrol'}#${token}`, token, expiresAt };
}

/** The open link a token belongs to (unused, unexpired), or null. */
export function findInvite(db: Db, token: unknown, now = new Date()): Invite | null {
  if (!looksLikeToken(token)) return null;
  return db.select().from(t.invite)
    .where(and(eq(t.invite.tokenHash, hashToken(token)), isNull(t.invite.usedAt), gt(t.invite.expiresAt, now.toISOString()))).get() ?? null;
}

/** Ends every open link of a person (one enrolment spends them all). */
export function spendInvites(db: Db, personId: string, now = new Date()): void {
  db.update(t.invite).set({ usedAt: now.toISOString() }).where(and(eq(t.invite.personId, personId), isNull(t.invite.usedAt))).run();
}

/** Marks a link used; false if someone else used it first. */
export function useInvite(db: Db, id: string, now = new Date()): boolean {
  return db.update(t.invite).set({ usedAt: now.toISOString() }).where(and(eq(t.invite.id, id), isNull(t.invite.usedAt))).run().changes === 1;
}

export function openRecovery(db: Db, now = new Date()): boolean {
  return Boolean(db.select({ id: t.invite.id }).from(t.invite)
    .where(and(eq(t.invite.kind, 'recovery'), isNull(t.invite.usedAt), gt(t.invite.expiresAt, now.toISOString()))).get());
}

/**
 * Standalone start-up: while no admin can sign in, a fresh setup link (older ones stop working) is written to
 * KEEPSAKE_DATA_DIR/setup-link.txt, readable by Keepsake's user only. Never the first visitor: whoever can read the
 * data folder becomes the first admin. The log says where the file is, never the link.
 */
export function ensureSetupLink(db: Db, cfg: Pick<Config, 'mode' | 'origin' | 'dataDir'>): string | null {
  if (cfg.mode !== 'standalone' || !setupNeeded(db)) {
    if (!openRecovery(db)) removeSetupLink(cfg);
    return null;
  }
  db.delete(t.invite).where(eq(t.invite.kind, 'setup')).run();
  const { url } = createInvite(db, cfg, { kind: 'setup' });
  return writeLinkFile(cfg, url);
}

/** `keepsake recover <admin id>`: a one-time link (24 hours) for an admin who lost every passkey, into the same file. */
export function createRecoveryLink(db: Db, cfg: Pick<Config, 'mode' | 'origin' | 'dataDir'>, personId: string): string {
  if (cfg.mode !== 'standalone') throw new Error('under HomersLab, HomersLab signs people in');
  const p = db.select().from(t.person).where(eq(t.person.id, personId)).get();
  if (!p || p.role !== 'admin') throw new Error(`no admin with the id ${personId}`);
  const { url } = createInvite(db, cfg, { kind: 'recovery', personId: p.id });
  return writeLinkFile(cfg, url);
}

/** Never follows a link someone put at the path: the old name is removed, then the file is created anew, 0600. */
function writeLinkFile(cfg: Pick<Config, 'dataDir'>, url: string): string {
  const file = join(cfg.dataDir, SETUP_FILE);
  rmSync(file, { force: true });
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${url}\n`);
  } finally {
    closeSync(fd);
  }
  return file;
}

export function removeSetupLink(cfg: Pick<Config, 'dataDir'>): void {
  rmSync(join(cfg.dataDir, SETUP_FILE), { force: true });
}
