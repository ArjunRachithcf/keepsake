// Guests by link (spec §2, ADR 0009): people outside the household never get an account; their link is who they are.
//
// - A share link shows one person's wishes, with what is taken: so another grown-up of the household makes it (for a
//   kid, a parent), never the person. Its address is shown to its maker once, at creation; nobody else ever receives
//   it, and the person's own pages list no link for them. A household session that may not see those gifts (the
//   person, a kid; for a draw link, anyone in that draw) cannot exchange it either.
// - A personal draw link, made by a celebration's host for one named guest, puts that guest in the celebration's draw
//   (draws/draws.ts addGuest: the draw's rules hold with them in it). It opens their own person and that person's list
//   for the celebration, and ends with the draw's day (household time), computed when read.
// - The token (256 bits) travels in the link's #fragment, so no request line or log has it; the browser POSTs it once
//   for a session (keepsake_guest, HttpOnly, Secure, SameSite=Strict). Both are kept as SHA-256 only. Every failure
//   gets the one answer, and the exchange is rate limited like a sign-in.
// - A link opens on one device (review N2): the first exchange spends the token and its session lasts as long as the
//   link (up to GUEST_DAYS, a browser's limit); another exchange answers that it was opened on another device. Its
//   maker sees it opened, and the opening is audited: someone who opens a link not meant for them locks its guest out,
//   and the guest notices.
// - A guest may set their name, claim (then bought, given, back), open their draw and ask a question: nothing else, and
//   only on the one person or draw their link reaches. Revoking a link ends its sessions at once.
import { and, count, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { hashToken, looksLikeToken, newToken } from '../auth/tokens';
import { getCelebration } from '../celebrations/celebrations';
import { Refused } from '../errors';
import { managesKid, mustGetPerson, type Person } from '../household/people';
import { seesGifts } from '../gifts/gifts';
import { drawnBy, guestPlace, hostRoleOf, managesDraw, occasionOf, openOwn, participantsOf } from '../draws/draws';
import type { Keyring } from '../draws/sealed';
import { getWish, type Wish } from '../wishes/wishes';

export type GuestLink = typeof t.guestLink.$inferSelect;
export const GUEST_COOKIE = 'keepsake_guest';
/** A guest session's longest life: a link's own end comes first (linkWorks); browsers keep a cookie 400 days at most. */
export const GUEST_DAYS = 400;
/** Open share links one person may have. */
export const MAX_SHARE_LINKS = 20; // the message says it
const DAY = 86_400_000;
const ts = () => new Date().toISOString();

const audit = (db: Db, actorId: string, action: 'link_created' | 'link_revoked' | 'link_opened', id: string) =>
  db.insert(t.audit).values({ id: ulid(), at: ts(), actorId, action, subjectId: id }).run();

export const linkUrl = (cfg: Pick<Config, 'origin'>, token: string) => `${cfg.origin}/guest#${token}`;

/** A new link row (with its token's hash) in `db`; returns the id and the token, which is shown once. */
function insertLink(db: Db, v: Pick<GuestLink, 'kind' | 'personId' | 'celebrationId' | 'label' | 'guestName' | 'createdBy'>): { id: string; token: string } {
  const token = newToken();
  const id = ulid();
  db.insert(t.guestLink).values({ id, ...v, approvedAt: ts(), tokenHash: hashToken(token), createdAt: ts() }).run();
  return { id, token };
}

/**
 * Who may make a share link to `owner`'s wishes (the link shows what is taken): another grown-up of the household, for
 * a kid one of the kid's parents; never the person themselves, never a kid.
 */
export const sharesFor = (db: Db, me: Person, owner: Person) =>
  me.role !== 'kid' && me.id !== owner.id && (owner.role !== 'kid' || managesKid(db, me, owner));

/** A share link to a person's wishes, by another grown-up (a kid's: a parent). The token is shown to its maker once. */
export function createShareLink(db: Db, me: Person, personId: string, label: string): { id: string; token: string } {
  const owner = mustGetPerson(db, personId);
  if (!sharesFor(db, me, owner)) throw new Refused(403, owner.role === 'kid' ? 'a kid\'s parent shares their wishes' : 'another grown-up shares someone\'s wishes, never they themselves');
  const open = db.select({ n: count() }).from(t.guestLink).where(and(eq(t.guestLink.personId, owner.id), isNull(t.guestLink.revokedAt))).get()?.n ?? 0;
  if (open >= MAX_SHARE_LINKS) throw new Refused(409, 'at most 20 links for one person');
  const made = insertLink(db, { kind: 'share', personId: owner.id, celebrationId: null, label: label.trim(), guestName: null, createdBy: me.id });
  audit(db, me.id, 'link_created', made.id);
  return made;
}

/** A name as compared with the household's: case, accents and spacing aside. */
export const sameName = (a: string, b: string) => {
  const n = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en');
  return n(a) === n(b);
};
/** A guest's name never passes for someone of the household (review M2): their claims would read as that person's. */
function checkGuestName(db: Db, name: string): void {
  if (db.select({ name: t.person.name }).from(t.person).all().some((p) => sameName(p.name, name))) {
    throw new Refused(409, 'someone in the household has that name: add something to tell them apart');
  }
}

/** A personal draw link's row, written inside draws.addGuest's transaction. */
export function drawLinkWriter(me: Person, celebrationId: string, name: string, out: { id?: string; token?: string }) {
  return (tx: Db) => {
    checkGuestName(tx, name);
    const made = insertLink(tx, { kind: 'draw', personId: null, celebrationId, label: name.trim(), guestName: name.trim(), createdBy: me.id });
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
/** Whether a link opens anything today: not revoked and (a draw link) in a draw whose day has not ended. */
export function linkWorks(db: Db, l: GuestLink, today: string): boolean {
  if (l.revokedAt || !l.approvedAt) return false;
  if (l.kind === 'share') return true;
  const last = lastDayOf(db, l);
  return last !== null && today <= last;
}

/**
 * Who sees a link in their list and may revoke it: a share link, its maker and admins, but never the person it shares
 * (an admin included) nor a kid; a draw link, the draw's host and admins. Nobody ever gets its token again.
 */
export function managesLink(db: Db, me: Person, l: GuestLink): boolean {
  if (me.role === 'kid') return false;
  if (l.kind === 'share') return l.personId !== me.id && (l.createdBy === me.id || me.role === 'admin');
  if (me.role === 'admin') return true;
  const c = l.celebrationId ? getCelebration(db, l.celebrationId) : undefined;
  return Boolean(c && managesDraw(me, c, hostRoleOf(db, c)));
}

/** The links the caller manages, revoked ones too (newest first). */
export function linksFor(db: Db, me: Person): GuestLink[] {
  return db.select().from(t.guestLink).orderBy(desc(t.guestLink.createdAt), desc(t.guestLink.id)).all()
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

// --- The guest's side -----------------------------------------------------------------------------------------------

const UNKNOWN = () => new Refused(401, 'this link is unknown, used or expired');
const OPENED = () => new Refused(409, 'this link was opened on another device: ask whoever sent it for a new one');

/**
 * Whether a household member may hold a guest session of this link (defence in depth: they never receive the token
 * of a link they may not open): a share link, someone who sees gifts on its person's wishes; a draw link, a grown-up
 * who is not in that draw (its pairs and the gifts between its people stay secret from them).
 */
export function mayOpenAsGuest(db: Db, p: Pick<Person, 'id' | 'role'>, l: GuestLink): boolean {
  if (p.role === 'kid') return false;
  if (l.kind === 'share') return Boolean(l.personId) && seesGifts(p, { personId: l.personId! });
  const place = guestPlace(db, l.id);
  return !place || !participantsOf(db, [place.d.id]).some((x) => x.personId === p.id);
}

type GuestSession = typeof t.guestSession.$inferSelect;
/** The open session behind a guest cookie (an expired one is deleted). */
function sessionOf(db: Db, cookie: string | undefined, now: Date): GuestSession | null {
  if (!looksLikeToken(cookie)) return null;
  const s = db.select().from(t.guestSession).where(eq(t.guestSession.id, hashToken(cookie))).get();
  if (!s) return null;
  if (s.expiresAt <= now.toISOString()) {
    db.delete(t.guestSession).where(eq(t.guestSession.id, s.id)).run();
    return null;
  }
  return s;
}

/**
 * A link's token for a session, on one device (review N2). One answer for every failure, also to a household member
 * it is not for (`by`, the browser's own household session, if any); after those, a link opened already answers so,
 * unless this very browser holds its session (`current`, its guest cookie: the guest followed the link again), which
 * then goes on. The first exchange spends the token, in one statement, and is audited (`by` as the actor, else the
 * link). Returns the session's token and when it ends.
 */
export function startGuestSession(db: Db, token: unknown, today: string, now = new Date(), by?: Pick<Person, 'id' | 'role'> | null, current?: string): { token: string; expiresAt: Date; link: GuestLink } {
  if (!looksLikeToken(token)) throw UNKNOWN();
  const l = db.select().from(t.guestLink).where(eq(t.guestLink.tokenHash, hashToken(token))).get();
  if (!l || !linkWorks(db, l, today) || (by && !mayOpenAsGuest(db, by, l))) throw UNKNOWN();
  const mine = sessionOf(db, current, now);
  if (mine && mine.linkId === l.id) return { token: current!, expiresAt: new Date(mine.expiresAt), link: l };
  if (l.openedAt) throw OPENED();
  const s = newToken();
  const expiresAt = new Date(now.getTime() + GUEST_DAYS * DAY);
  db.transaction((tx) => {
    const spent = tx.update(t.guestLink).set({ openedAt: now.toISOString() }).where(and(eq(t.guestLink.id, l.id), isNull(t.guestLink.openedAt))).run();
    if (spent.changes !== 1) throw OPENED();
    tx.insert(t.guestSession).values({ id: hashToken(s), linkId: l.id, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString() }).run();
    audit(tx as unknown as Db, by?.id ?? l.id, 'link_opened', l.id);
  });
  return { token: s, expiresAt, link: { ...l, openedAt: now.toISOString() } };
}

/** The guest behind a session cookie: an open session of a link that still works. */
export function liveGuest(db: Db, cookie: string | undefined, today: string, now = new Date()): GuestLink | null {
  const s = sessionOf(db, cookie, now);
  if (!s) return null;
  const l = getLink(db, s.linkId);
  return l && linkWorks(db, l, today) ? l : null;
}

export function endGuestSession(db: Db, cookie: string | undefined): void {
  if (looksLikeToken(cookie)) db.delete(t.guestSession).where(eq(t.guestSession.id, hashToken(cookie))).run();
}

export function setGuestName(db: Db, l: GuestLink, name: string): void {
  checkGuestName(db, name);
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

/**
 * A guest's claims once they can no longer manage them (review M1), as when a giver leaves (ADR 0003): their link
 * revoked (or going: `going`, links about to be deleted with their celebration), or a re-draw gave a draw guest
 * someone else. A claim only made goes; a bought or given one stays, with nobody's name. Run by the changing request
 * (never a person's reading one), after the change or, for `going`, before it.
 */
export function settleGuestClaims(db: Db, ring: Keyring, going: ReadonlySet<string> = new Set()): void {
  const claims = db.select().from(t.claim).where(isNotNull(t.claim.guestId)).all();
  if (!claims.length) return;
  const links = new Map<string, GuestLink>();
  const personOf = new Map<string, string | null | 'keep'>();
  const reached = (linkId: string): string | null | 'keep' => {
    if (personOf.has(linkId)) return personOf.get(linkId)!;
    const l = links.get(linkId) ?? getLink(db, linkId);
    let v: string | null | 'keep' = null;
    if (l && !l.revokedAt && !going.has(l.id)) {
      if (l.kind === 'share') v = l.personId;
      else {
        const place = guestPlace(db, l.id);
        const own = place?.d.drawnAt ? drawnBy(db, ring, place.d, place.me) : null;
        // A row that does not open with the keys here: nothing is known, so nothing is undone.
        if (own === 'unreadable') v = 'keep';
        else if (own && place) v = participantsOf(db, [place.d.id]).find((p) => p.id === own)?.personId ?? null;
      }
    }
    personOf.set(linkId, v);
    return v;
  };
  for (const c of claims) {
    const p = reached(c.guestId!);
    if (p === 'keep') continue;
    const w = getWish(db, c.wishId);
    if (w && p === w.personId) continue;
    if (c.state === 'claimed') db.delete(t.claim).where(eq(t.claim.id, c.id)).run();
    else db.update(t.claim).set({ guestId: null, updatedAt: ts() }).where(eq(t.claim.id, c.id)).run();
  }
}

/** The draw links of a celebration (about to go with it). */
export const drawLinksOf = (db: Db, celebrationId: string) =>
  new Set(db.select({ id: t.guestLink.id }).from(t.guestLink).where(and(eq(t.guestLink.celebrationId, celebrationId), eq(t.guestLink.kind, 'draw'))).all().map((l) => l.id));
