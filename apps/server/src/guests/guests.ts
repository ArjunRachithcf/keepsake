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
// - A link opens on one device (review N2): the first exchange spends the token and records the device (review M-a:
//   the cookie keepsake_guest is the device, and holds the sessions of every link it opened; a request names its link
//   in the X-Keepsake-Link header). A session lasts as long as the link (up to GUEST_DAYS, a browser's limit) unless
//   unused for GUEST_IDLE_DAYS; that device may exchange the token again, any other is told it was opened on another
//   device. Its maker sees it opened, and the opening is audited: someone who opens a link not meant for them locks its
//   guest out, and the guest notices. A link's managers give it a new address (review M-b): a new token on the same
//   row, so a draw guest keeps their place, pair and claims.
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
import { getPerson, managesKid, mustGetPerson, type Person } from '../household/people';
import { seesGifts } from '../gifts/gifts';
import { drawnBy, guestPlace, hostRoleOf, managesDraw, occasionOf, openOwn, participantsOf } from '../draws/draws';
import type { Keyring } from '../draws/sealed';
import { getWish, type Wish } from '../wishes/wishes';

export type GuestLink = typeof t.guestLink.$inferSelect;
export const GUEST_COOKIE = 'keepsake_guest';
/** A guest session's longest life: a link's own end comes first (linkWorks); browsers keep a cookie 400 days at most. */
export const GUEST_DAYS = 400;
/** A guest session unused this long ends (review L-2: a session left in a browser nobody uses). */
export const GUEST_IDLE_DAYS = 30;
/** The request header naming the link a guest route is for (one device holds the sessions of several links). */
export const LINK_HEADER = 'x-keepsake-link';
/** Open share links one person may have. */
export const MAX_SHARE_LINKS = 20; // the message says it
const DAY = 86_400_000;
const ts = () => new Date().toISOString();

const audit = (db: Db, actorId: string, action: 'link_created' | 'link_revoked' | 'link_opened' | 'link_reissued', id: string) =>
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

/** A name as compared with the household's: case, accents, spacing and characters that show nothing (review L-b) aside. */
export const sameName = (a: string, b: string) => {
  const n = (s: string) => s.normalize('NFKD').replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en');
  return n(a) === n(b);
};
/** A guest's name never passes for someone of the household (review M2): their claims would read as that person's. */
function checkGuestName(db: Db, name: string): void {
  if (db.select({ name: t.person.name }).from(t.person).all().some((p) => sameName(p.name, name))) {
    throw new Refused(409, 'someone in the household has that name: add something to tell them apart');
  }
}

/**
 * The other way round (review L-b): a new member, or a new name, like a guest's that the caller already sees (the
 * guests of links they manage, so nobody learns of a link to their own wishes) is refused until confirmed.
 */
export function checkMemberName(db: Db, me: Person, name: string): void {
  const guests = db.select().from(t.guestLink).where(isNull(t.guestLink.revokedAt)).all().filter((l) => managesLink(db, me, l));
  if (guests.some((l) => [l.guestName, l.kind === 'draw' ? l.label : null].some((g) => g && sameName(g, name)))) {
    throw new Refused(409, 'a guest by link has that name: add something to tell them apart, or confirm');
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
 * (an admin included) nor a kid; a kid's share link, the kid's current parents (review L-c: when the parents change,
 * its links go with the kid) and admins; a draw link, the draw's host and admins. Nobody ever gets its token again.
 */
export function managesLink(db: Db, me: Person, l: GuestLink): boolean {
  if (me.role === 'kid') return false;
  if (l.kind === 'share') {
    if (!l.personId || l.personId === me.id) return false;
    if (me.role === 'admin') return true;
    const owner = getPerson(db, l.personId);
    return owner?.role === 'kid' ? managesKid(db, me, owner) : l.createdBy === me.id;
  }
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

/**
 * A new address for a link (review M-b), by whoever manages it: a new token on the same row, opened by nobody yet, its
 * sessions ended. A draw guest keeps their place in the draw, their pair and their claims; whoever held the old
 * address is out. Audited; the token is shown once, as at creation.
 */
export function reissueLink(db: Db, me: Person, id: string): { id: string; token: string } {
  const l = managed(db, me, id);
  const token = newToken();
  db.transaction((tx) => {
    tx.update(t.guestLink).set({ tokenHash: hashToken(token), openedAt: null, openedBy: null }).where(eq(t.guestLink.id, l.id)).run();
    tx.delete(t.guestSession).where(eq(t.guestSession.linkId, l.id)).run();
    audit(tx as unknown as Db, me.id, 'link_reissued', l.id);
  });
  return { id: l.id, token };
}

// --- The guest's side -----------------------------------------------------------------------------------------------

const UNKNOWN = () => new Refused(401, 'this link is unknown, used or expired');
const OPENED = () => new Refused(409, 'this link was opened on another device: ask whoever sent it for a new address');

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
const deviceOf = (cookie: string | undefined) => (looksLikeToken(cookie) ? hashToken(cookie) : null);

/** The open session of a link on a device (one past its end or idle too long is deleted; use is noted once a minute). */
function sessionFor(db: Db, device: string | null, linkId: unknown, now: Date): GuestSession | null {
  if (!device || typeof linkId !== 'string') return null;
  const s = db.select().from(t.guestSession).where(and(eq(t.guestSession.deviceHash, device), eq(t.guestSession.linkId, linkId))).get();
  if (!s) return null;
  if (s.expiresAt <= now.toISOString() || now.getTime() - new Date(s.lastSeenAt).getTime() > GUEST_IDLE_DAYS * DAY) {
    db.delete(t.guestSession).where(eq(t.guestSession.id, s.id)).run();
    return null;
  }
  if (now.getTime() - new Date(s.lastSeenAt).getTime() > 60_000) db.update(t.guestSession).set({ lastSeenAt: now.toISOString() }).where(eq(t.guestSession.id, s.id)).run();
  return s;
}

const newSession = (db: Db, linkId: string, device: string, now: Date) => {
  const expiresAt = new Date(now.getTime() + GUEST_DAYS * DAY);
  db.insert(t.guestSession).values({ id: ulid(), linkId, deviceHash: device, createdAt: now.toISOString(), lastSeenAt: now.toISOString(), expiresAt: expiresAt.toISOString() }).run();
  return expiresAt;
};

/**
 * A link's first exchange, from `l` as read before (review N2): spends it in one statement (`opened_at` set only while
 * unset, so a stale read can never open it twice), records the device, ends any session it had and audits it.
 */
export function openLink(db: Db, l: GuestLink, device: string, now: Date, actorId: string): Date {
  return db.transaction((tx) => {
    const spent = tx.update(t.guestLink).set({ openedAt: now.toISOString(), openedBy: device }).where(and(eq(t.guestLink.id, l.id), isNull(t.guestLink.openedAt))).run();
    if (spent.changes !== 1) throw OPENED();
    tx.delete(t.guestSession).where(eq(t.guestSession.linkId, l.id)).run();
    audit(tx as unknown as Db, actorId, 'link_opened', l.id);
    return newSession(tx as unknown as Db, l.id, device, now);
  });
}

/**
 * A link's token for a session, on one device (review N2, M-a). One answer for every failure, also to a household
 * member it is not for (`by`, the browser's own household session, if any). After those: a link opened already opens
 * again only on the device that opened it (`deviceCookie`, the browser's keepsake_guest), else it answers so; a link
 * not opened yet is spent (openLink). Returns the device cookie (the browser's own, or a new one) and the link.
 */
export function startGuestSession(db: Db, token: unknown, today: string, now = new Date(), by?: Pick<Person, 'id' | 'role'> | null, deviceCookie?: string): { device: string; expiresAt: Date; link: GuestLink } {
  if (!looksLikeToken(token)) throw UNKNOWN();
  const l = db.select().from(t.guestLink).where(eq(t.guestLink.tokenHash, hashToken(token))).get();
  if (!l || !linkWorks(db, l, today) || (by && !mayOpenAsGuest(db, by, l))) throw UNKNOWN();
  const cookie = looksLikeToken(deviceCookie) ? deviceCookie : newToken();
  const device = hashToken(cookie);
  if (l.openedAt) {
    if (l.openedBy !== device) throw OPENED();
    const s = sessionFor(db, device, l.id, now);
    return { device: cookie, expiresAt: s ? new Date(s.expiresAt) : newSession(db, l.id, device, now), link: l };
  }
  const expiresAt = openLink(db, l, device, now, by?.id ?? l.id);
  return { device: cookie, expiresAt, link: { ...l, openedAt: now.toISOString(), openedBy: device } };
}

/** The guest behind a request: the device's open session of the named link, a link that still works. */
export function liveGuest(db: Db, deviceCookie: string | undefined, linkId: unknown, today: string, now = new Date()): GuestLink | null {
  const s = sessionFor(db, deviceOf(deviceCookie), linkId, now);
  if (!s) return null;
  const l = getLink(db, s.linkId);
  return l && linkWorks(db, l, today) ? l : null;
}

/** The device's session of one link ends (review N1: a household session it is not for came along). */
export function endGuestSession(db: Db, deviceCookie: string | undefined, linkId: string): void {
  const device = deviceOf(deviceCookie);
  if (device) db.delete(t.guestSession).where(and(eq(t.guestSession.deviceHash, device), eq(t.guestSession.linkId, linkId))).run();
}

/** "Forget this link on this device": its session ends and no device holds the link any more (a new address opens it). */
export function forgetLink(db: Db, deviceCookie: string | undefined, linkId: string): void {
  const device = deviceOf(deviceCookie);
  if (!device) return;
  db.transaction((tx) => {
    tx.delete(t.guestSession).where(and(eq(t.guestSession.deviceHash, device), eq(t.guestSession.linkId, linkId))).run();
    tx.update(t.guestLink).set({ openedBy: null }).where(and(eq(t.guestLink.id, linkId), eq(t.guestLink.openedBy, device))).run();
  });
}

/** A household sign-in in this browser (review L-2): every guest session of its device ends (the cookie is cleared). */
export function endDeviceSessions(db: Db, deviceCookie: string | undefined): void {
  const device = deviceOf(deviceCookie);
  if (device) db.delete(t.guestSession).where(eq(t.guestSession.deviceHash, device)).run();
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
 * revoked (or going: `going`, links about to be deleted with their celebration), a re-draw gave a draw guest someone
 * else, or the wish moved out of what their link reaches (to another celebration than a draw guest's, review L-a). A
 * claim only made goes; a bought or given one stays, with nobody's name. Run by the changing request (never a
 * person's reading one), after the change or, for `going`, before it. A wish waiting for a parent stays within reach:
 * it comes back as it was.
 */
export function settleGuestClaims(db: Db, ring: Keyring, going: ReadonlySet<string> = new Set()): void {
  const claims = db.select().from(t.claim).where(isNotNull(t.claim.guestId)).all();
  if (!claims.length) return;
  type Reach = { personId: string; celebrationId: string | null } | null | 'keep';
  const reachOfLink = new Map<string, Reach>();
  const reached = (linkId: string): Reach => {
    if (reachOfLink.has(linkId)) return reachOfLink.get(linkId)!;
    const l = getLink(db, linkId);
    let v: Reach = null;
    if (l && !l.revokedAt && !going.has(l.id)) {
      if (l.kind === 'share') v = l.personId ? { personId: l.personId, celebrationId: null } : null;
      else {
        const place = guestPlace(db, l.id);
        const own = place?.d.drawnAt ? drawnBy(db, ring, place.d, place.me) : null;
        // A row that does not open with the keys here: nothing is known, so nothing is undone.
        if (own === 'unreadable') v = 'keep';
        else if (own && place) {
          const personId = participantsOf(db, [place.d.id]).find((p) => p.id === own)?.personId;
          v = personId ? { personId, celebrationId: place.c.id } : null;
        }
      }
    }
    reachOfLink.set(linkId, v);
    return v;
  };
  for (const c of claims) {
    const r = reached(c.guestId!);
    if (r === 'keep') continue;
    const w = getWish(db, c.wishId);
    if (w && r && w.personId === r.personId && (r.celebrationId === null || w.celebrationId === null || w.celebrationId === r.celebrationId)) continue;
    if (c.state === 'claimed') db.delete(t.claim).where(eq(t.claim.id, c.id)).run();
    else db.update(t.claim).set({ guestId: null, updatedAt: ts() }).where(eq(t.claim.id, c.id)).run();
  }
}

/** The draw links of a celebration (about to go with it). */
export const drawLinksOf = (db: Db, celebrationId: string) =>
  new Set(db.select({ id: t.guestLink.id }).from(t.guestLink).where(and(eq(t.guestLink.celebrationId, celebrationId), eq(t.guestLink.kind, 'draw'))).all().map((l) => l.id));
