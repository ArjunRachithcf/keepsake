// Guests by link (spec §2, ADR 0009): people outside the household never get an account; their link is who they are.
//
// - A share link shows one person's wishes; the person makes it (or a kid's parent). A kid's own link waits for a
//   parent's yes before it opens anything.
// - A personal draw link, made by a celebration's host for one named guest, puts that guest in the celebration's draw
//   (draws/draws.ts addGuest: the draw's rules hold with them in it). It opens their own person and that person's list
//   for the celebration, and ends with the draw's day (household time), computed when read.
// - The token (256 bits) travels in the link's #fragment, so no request line or log has it; the browser POSTs it once
//   for a short session (keepsake_guest, HttpOnly, Secure, SameSite=Strict, 12 hours). Both are kept as SHA-256 only.
//   Every failure gets the one answer, and the exchange is rate limited like a sign-in.
// - A guest may set their name, claim (then bought, given, back), open their draw and ask a question: nothing else, and
//   only on the one person or draw their link reaches. Revoking a link ends its sessions at once.
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { hashToken, looksLikeToken, newToken } from '../auth/tokens';
import { getCelebration } from '../celebrations/celebrations';
import { Refused } from '../errors';
import { keeps, managesKid, mustGetPerson, type Person } from '../household/people';
import { guestPlace, hostRoleOf, managesDraw, occasionOf, openOwn, participantsOf } from '../draws/draws';
import type { Keyring } from '../draws/sealed';
import { getWish, type Wish } from '../wishes/wishes';

export type GuestLink = typeof t.guestLink.$inferSelect;
export const GUEST_COOKIE = 'keepsake_guest';
export const GUEST_HOURS = 12;
/** Open share links one person may have, and sessions one link keeps (the oldest go first). */
export const MAX_SHARE_LINKS = 20; // the message says it
const MAX_SESSIONS = 10;
const HOUR = 3_600_000;
const ts = () => new Date().toISOString();

const audit = (db: Db, actorId: string, action: 'link_created' | 'link_approved' | 'link_revoked', id: string) =>
  db.insert(t.audit).values({ id: ulid(), at: ts(), actorId, action, subjectId: id }).run();

export const linkUrl = (cfg: Pick<Config, 'origin'>, token: string) => `${cfg.origin}/guest#${token}`;

/** A new link row (with its token's hash) in `db`; returns the id and the token, which is shown once. */
function insertLink(db: Db, v: Pick<GuestLink, 'kind' | 'personId' | 'celebrationId' | 'label' | 'guestName' | 'createdBy' | 'approvedAt'>): { id: string; token: string } {
  const token = newToken();
  const id = ulid();
  db.insert(t.guestLink).values({ id, ...v, tokenHash: hashToken(token), createdAt: ts() }).run();
  return { id, token };
}

/** A share link to a person's wishes: by the person or a kid's parent; a kid's own waits for a parent. */
export function createShareLink(db: Db, me: Person, personId: string, label: string): { id: string; token: string } {
  const owner = mustGetPerson(db, personId);
  if (!keeps(db, me, owner)) throw new Refused(403, 'only the person (or a kid\'s parent) shares their wishes');
  const open = db.select({ n: count() }).from(t.guestLink).where(and(eq(t.guestLink.personId, owner.id), isNull(t.guestLink.revokedAt))).get()?.n ?? 0;
  if (open >= MAX_SHARE_LINKS) throw new Refused(409, 'at most 20 links for one person');
  const waits = owner.role === 'kid' && me.id === owner.id;
  const made = insertLink(db, { kind: 'share', personId: owner.id, celebrationId: null, label: label.trim(), guestName: null, createdBy: me.id, approvedAt: waits ? null : ts() });
  audit(db, me.id, 'link_created', made.id);
  return made;
}

/** A personal draw link's row, written inside draws.addGuest's transaction. */
export function drawLinkWriter(me: Person, celebrationId: string, name: string, out: { id?: string; token?: string }) {
  return (tx: Db) => {
    const made = insertLink(tx, { kind: 'draw', personId: null, celebrationId, label: name.trim(), guestName: name.trim(), createdBy: me.id, approvedAt: ts() });
    audit(tx, me.id, 'link_created', made.id);
    Object.assign(out, made);
    return made.id;
  };
}

export const getLink = (db: Db, id: string) => db.select().from(t.guestLink).where(eq(t.guestLink.id, id)).get();

/** The last day a draw link works (its draw's day, household time), or null when it has no draw. */
export function lastDayOf(db: Db, l: GuestLink): string | null {
  if (l.kind !== 'draw') return null;
  const place = guestPlace(db, l.id);
  return place ? occasionOf(place.c, place.d) : null;
}
/** Whether a link opens anything today: not revoked, approved, and (a draw link) in a draw whose day has not ended. */
export function linkWorks(db: Db, l: GuestLink, today: string): boolean {
  if (l.revokedAt || !l.approvedAt) return false;
  if (l.kind === 'share') return true;
  const last = lastDayOf(db, l);
  return last !== null && today <= last;
}

/** Who may revoke a link (and sees it in their list): its person's keepers, the draw's host, admins. */
export function managesLink(db: Db, me: Person, l: GuestLink): boolean {
  if (me.role === 'admin') return true;
  if (l.kind === 'share') return Boolean(l.personId) && keeps(db, me, mustGetPerson(db, l.personId!));
  const c = l.celebrationId ? getCelebration(db, l.celebrationId) : undefined;
  return Boolean(c && managesDraw(me, c, hostRoleOf(db, c)));
}
/** A kid's link waiting for a parent: that kid's parents say yes. */
export const approvesLink = (db: Db, me: Person, l: GuestLink) =>
  l.kind === 'share' && !l.approvedAt && !l.revokedAt && Boolean(l.personId) && managesKid(db, me, mustGetPerson(db, l.personId!));

/** The open links the caller manages (newest first). */
export function linksFor(db: Db, me: Person): GuestLink[] {
  return db.select().from(t.guestLink).where(isNull(t.guestLink.revokedAt)).orderBy(desc(t.guestLink.createdAt), desc(t.guestLink.id)).all()
    .filter((l) => managesLink(db, me, l));
}

function managed(db: Db, me: Person, id: string): GuestLink {
  const l = getLink(db, id);
  if (!l || l.revokedAt || !managesLink(db, me, l)) throw new Refused(404, 'no such link');
  return l;
}

/** Revoked: its sessions end now. A draw guest leaves a draw not drawn yet; once drawn they stay in it (ADR 0009). */
export function revokeLink(db: Db, me: Person, id: string, leave: (linkId: string) => void): void {
  const l = managed(db, me, id);
  db.transaction((tx) => {
    tx.update(t.guestLink).set({ revokedAt: ts() }).where(eq(t.guestLink.id, l.id)).run();
    tx.delete(t.guestSession).where(eq(t.guestSession.linkId, l.id)).run();
    audit(tx as unknown as Db, me.id, 'link_revoked', l.id);
  });
  if (l.kind === 'draw') leave(l.id);
}

export function approveLink(db: Db, me: Person, id: string): void {
  const l = getLink(db, id);
  if (!l || l.revokedAt || !(managesLink(db, me, l) || approvesLink(db, me, l))) throw new Refused(404, 'no such link');
  if (!approvesLink(db, me, l)) throw new Refused(403, 'a kid\'s parent says yes to it');
  db.update(t.guestLink).set({ approvedAt: ts() }).where(eq(t.guestLink.id, l.id)).run();
  audit(db, me.id, 'link_approved', l.id);
}

// --- The guest's side -----------------------------------------------------------------------------------------------

const UNKNOWN = () => new Refused(401, 'this link is unknown, used or expired');

/** A link's token for a session (one answer for every failure). Returns the session's token and when it ends. */
export function startGuestSession(db: Db, token: unknown, today: string, now = new Date()): { token: string; expiresAt: Date; link: GuestLink } {
  if (!looksLikeToken(token)) throw UNKNOWN();
  const l = db.select().from(t.guestLink).where(eq(t.guestLink.tokenHash, hashToken(token))).get();
  if (!l || !linkWorks(db, l, today)) throw UNKNOWN();
  const s = newToken();
  const expiresAt = new Date(now.getTime() + GUEST_HOURS * HOUR);
  db.transaction((tx) => {
    tx.insert(t.guestSession).values({ id: hashToken(s), linkId: l.id, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString() }).run();
    const old = tx.select({ id: t.guestSession.id }).from(t.guestSession).where(eq(t.guestSession.linkId, l.id))
      .orderBy(desc(t.guestSession.createdAt)).all().slice(MAX_SESSIONS).map((x) => x.id);
    if (old.length) tx.delete(t.guestSession).where(inArray(t.guestSession.id, old)).run();
  });
  return { token: s, expiresAt, link: l };
}

/** The guest behind a session cookie: an open session of a link that still works. */
export function liveGuest(db: Db, cookie: string | undefined, today: string, now = new Date()): GuestLink | null {
  if (!looksLikeToken(cookie)) return null;
  const s = db.select().from(t.guestSession).where(eq(t.guestSession.id, hashToken(cookie))).get();
  if (!s) return null;
  if (s.expiresAt <= now.toISOString()) {
    db.delete(t.guestSession).where(eq(t.guestSession.id, s.id)).run();
    return null;
  }
  const l = getLink(db, s.linkId);
  return l && linkWorks(db, l, today) ? l : null;
}

export function endGuestSession(db: Db, cookie: string | undefined): void {
  if (looksLikeToken(cookie)) db.delete(t.guestSession).where(eq(t.guestSession.id, hashToken(cookie))).run();
}

export function setGuestName(db: Db, l: GuestLink, name: string): void {
  db.update(t.guestLink).set({ guestName: name.trim() }).where(eq(t.guestLink.id, l.id)).run();
}

/**
 * Whom a guest reaches: a share link, its person (every listed wish); a draw link, their own person once they opened
 * their draw (that person's list for the celebration). Null: nobody yet (or their person is another guest).
 */
export function reachOf(db: Db, l: GuestLink, ring: Keyring): { personId: string; celebrationId: string | null } | null {
  if (l.kind === 'share') return l.personId ? { personId: l.personId, celebrationId: null } : null;
  const place = guestPlace(db, l.id);
  if (!place || !place.d.drawnAt) return null;
  const own = openOwn(db, ring, place.d, place.me);
  if (!own || own === 'unreadable') return null;
  const receiver = participantsOf(db, [place.d.id]).find((p) => p.id === own);
  return receiver?.kind === 'person' && receiver.personId ? { personId: receiver.personId, celebrationId: place.c.id } : null;
}

/** A wish on what the guest reaches: listed, the person's, and for a draw link for the celebration or any time. */
export const reaches = (reach: { personId: string; celebrationId: string | null } | null, w: Pick<Wish, 'personId' | 'state' | 'celebrationId'>) =>
  Boolean(reach) && w.state === 'listed' && w.personId === reach!.personId && (reach!.celebrationId === null || w.celebrationId === null || w.celebrationId === reach!.celebrationId);

/** The wish a guest acts on (404 like any wish they cannot see); claims wait for their name. */
export function guestGiving(db: Db, l: GuestLink, ring: Keyring, wishId: string): Wish {
  const w = getWish(db, wishId);
  if (!w || !reaches(reachOf(db, l, ring), w)) throw new Refused(404, 'no such wish');
  if (!l.guestName) throw new Refused(409, 'tell us your name first');
  return w;
}
