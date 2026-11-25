// The household (spec §2, ADR 0001): people, their roles, and who manages which kid. Standalone keeps them here; under
// HomersLab they arrive with each request from the edge (identity.ts) and are kept in step. Kids' managers are
// Keepsake's own in both modes (HomersLab's household API may give them later).
import { and, count, eq, inArray, ne } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/open';
import { asDb } from '../db/open';
import * as t from '../db/schema';
import { Refused } from '../errors';
import type { Identity, Role } from '../identity';

export type Person = typeof t.person.$inferSelect;

const rank = (r: Role) => ({ admin: 0, adult: 1, kid: 2 })[r];

export function household(db: Db): Person[] {
  return db.select().from(t.person).all().sort((a, b) => rank(a.role) - rank(b.role) || a.name.localeCompare(b.name));
}

export function getPerson(db: Db, id: string): Person | undefined {
  return db.select().from(t.person).where(eq(t.person.id, id)).get();
}

export function mustGetPerson(db: Db, id: string): Person {
  const p = getPerson(db, id);
  if (!p) throw new Refused(404, 'no such person');
  return p;
}

/** The kid's managers as set; empty when none are set (then the admins act as managers: managesKid). */
export function managersOf(db: Db, kidId: string): string[] {
  return db.select({ id: t.manager.managerId }).from(t.manager).where(eq(t.manager.kidId, kidId)).all().map((r) => r.id);
}

/**
 * Whether `me` manages the kid `kidId`: a manager set for the kid, or, while the kid has none, any admin (so a kid's
 * wish never waits for nobody). False for anyone who is not a kid.
 */
export function managesKid(db: Db, me: Pick<Person, 'id' | 'role'>, kid: Pick<Person, 'id' | 'role'>): boolean {
  if (kid.role !== 'kid' || me.id === kid.id || me.role === 'kid') return false;
  const set = managersOf(db, kid.id);
  return set.length ? set.includes(me.id) : me.role === 'admin';
}

/** Who keeps a person's list and profile: the person, and a kid's managers. */
export function keeps(db: Db, me: Pick<Person, 'id' | 'role'>, p: Pick<Person, 'id' | 'role'>): boolean {
  return me.id === p.id || managesKid(db, me, p);
}

export function hasPasskey(db: Db, personId: string): boolean {
  return Boolean(db.select({ id: t.passkey.id }).from(t.passkey).where(eq(t.passkey.personId, personId)).get());
}

/** No admin can sign in yet (standalone): the household needs its setup link. */
export function setupNeeded(db: Db): boolean {
  const row = db.select({ n: count() }).from(t.passkey).innerJoin(t.person, eq(t.person.id, t.passkey.personId))
    .where(eq(t.person.role, 'admin')).get();
  return (row?.n ?? 0) === 0;
}

/** Admins who can sign in (standalone), other than `except`: at least one must stay. */
function adminsWithPasskey(db: Db, except: string): number {
  return db.selectDistinct({ id: t.person.id }).from(t.person).innerJoin(t.passkey, eq(t.passkey.personId, t.person.id))
    .where(and(eq(t.person.role, 'admin'), ne(t.person.id, except))).all().length;
}

export interface PersonInput { name: string; role: Role }

export function addPerson(db: Db, i: PersonInput): Person {
  const p = { id: ulid(), name: i.name.trim(), role: i.role, createdAt: new Date().toISOString() };
  db.insert(t.person).values(p).run();
  return getPerson(db, p.id)!;
}

export function editPerson(db: Db, id: string, patch: Partial<PersonInput>): Person {
  const p = mustGetPerson(db, id);
  const role = patch.role ?? p.role;
  if (role !== 'admin' && p.role === 'admin' && adminsWithPasskey(db, id) === 0) throw new Refused(409, 'the household needs an admin who can sign in');
  applyPerson(db, p, patch.name?.trim() ?? p.name, role);
  return getPerson(db, id)!;
}

/** A person's new name and role, and what follows from the role (managers, a former kid's waiting wishes). */
function applyPerson(db: Db, p: Person, name: string, role: Role): void {
  const id = p.id;
  db.transaction((tx) => {
    tx.update(t.person).set({ name, role }).where(eq(t.person.id, id)).run();
    // Someone who stops being a kid has no managers; a kid manages nobody.
    if (role !== 'kid') tx.delete(t.manager).where(eq(t.manager.kidId, id)).run();
    if (role === 'kid') tx.delete(t.manager).where(eq(t.manager.managerId, id)).run();
    if (role !== 'kid' && p.role === 'kid') settleKidWishes(asDb(tx), id);
  });
}

/** A former kid's waiting wishes are theirs to keep now: listed. */
function settleKidWishes(db: Db, personId: string): void {
  db.update(t.wish).set({ state: 'listed' }).where(and(eq(t.wish.personId, personId), eq(t.wish.state, 'awaiting_parent'))).run();
}

export function removePerson(db: Db, id: string, by: string): void {
  const p = mustGetPerson(db, id);
  if (id === by) throw new Refused(409, 'you cannot remove yourself');
  if (p.role === 'admin' && adminsWithPasskey(db, id) === 0) throw new Refused(409, 'the household needs an admin who can sign in');
  db.delete(t.person).where(eq(t.person.id, id)).run();
}

/** Sets a kid's managers (adults or admins of the household). */
export function setManagers(db: Db, kidId: string, managerIds: string[]): void {
  const kid = mustGetPerson(db, kidId);
  if (kid.role !== 'kid') throw new Refused(409, 'only kids have managers');
  const ids = [...new Set(managerIds)];
  const found = ids.length ? db.select().from(t.person).where(inArray(t.person.id, ids)).all() : [];
  if (found.length !== ids.length) throw new Refused(400, 'managerIds: someone is not in the household');
  if (found.some((m) => m.role === 'kid')) throw new Refused(400, 'managerIds: a kid cannot manage a kid');
  db.transaction((tx) => {
    tx.delete(t.manager).where(eq(t.manager.kidId, kidId)).run();
    for (const m of ids) tx.insert(t.manager).values({ kidId, managerId: m }).run();
  });
}

/**
 * Under HomersLab: the person the edge names, added the first time and kept in step after (name, role). A request
 * without a valid role is refused by the caller: Keepsake cannot tell an adult from a kid without it.
 */
export function syncHomersLabPerson(db: Db, id: Identity & { role: Role }): Person {
  const existing = db.select().from(t.person).where(eq(t.person.externalId, id.externalId)).get();
  if (!existing) {
    const p = { id: ulid(), externalId: id.externalId, name: id.name ?? 'Someone', role: id.role, createdAt: new Date().toISOString() };
    db.insert(t.person).values(p).run();
    return getPerson(db, p.id)!;
  }
  if (existing.role !== id.role || (id.name && existing.name !== id.name)) {
    // HomersLab decides roles there: no last-admin check (nobody signs in with a Keepsake passkey).
    applyPerson(db, existing, id.name ?? existing.name, id.role);
    return getPerson(db, existing.id)!;
  }
  return existing;
}

/** The household's currency (ISO 4217), or null until an admin sets it: prices wait for it (no default). */
export function currency(db: Db): string | null {
  return db.select().from(t.setting).where(eq(t.setting.key, 'currency')).get()?.value ?? null;
}

export function setCurrency(db: Db, code: string | null): void {
  if (code === null) db.delete(t.setting).where(eq(t.setting.key, 'currency')).run();
  else db.insert(t.setting).values({ key: 'currency', value: code }).onConflictDoUpdate({ target: t.setting.key, set: { value: code } }).run();
}
