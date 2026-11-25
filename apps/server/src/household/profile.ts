// Profiles (spec §3): sizes, likes and "please no", kept by the person (or a kid's manager), each part dated
// ("sizes from October").
import { eq } from 'drizzle-orm';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { Refused } from '../errors';
import { keeps, mustGetPerson, type Person } from './people';

export type ProfileRow = typeof t.profile.$inferSelect;
export interface Size { label: string; value: string }
export interface ProfileInput { sizes?: Size[]; likes?: string[]; pleaseNo?: string[] }

export function getProfile(db: Db, personId: string): ProfileRow {
  return db.select().from(t.profile).where(eq(t.profile.personId, personId)).get()
    ?? { personId, sizesJson: '[]', sizesUpdatedAt: null, likesJson: '[]', likesUpdatedAt: null, pleaseNoJson: '[]', pleaseNoUpdatedAt: null };
}

/** Only the parts given change, and only a part that changed gets today's date. */
export function setProfile(db: Db, me: Person, personId: string, i: ProfileInput): ProfileRow {
  const p = mustGetPerson(db, personId);
  if (!keeps(db, me, p)) throw new Refused(403, 'only the person (or a kid\'s manager) keeps their profile');
  const cur = getProfile(db, personId);
  const now = new Date().toISOString();
  const part = (v: unknown[] | undefined, json: string, at: string | null): [string, string | null] => {
    if (v === undefined) return [json, at];
    const next = JSON.stringify(v);
    return next === json ? [json, at] : [next, now];
  };
  const [sizesJson, sizesUpdatedAt] = part(i.sizes, cur.sizesJson, cur.sizesUpdatedAt);
  const [likesJson, likesUpdatedAt] = part(i.likes, cur.likesJson, cur.likesUpdatedAt);
  const [pleaseNoJson, pleaseNoUpdatedAt] = part(i.pleaseNo, cur.pleaseNoJson, cur.pleaseNoUpdatedAt);
  const row = { personId, sizesJson, sizesUpdatedAt, likesJson, likesUpdatedAt, pleaseNoJson, pleaseNoUpdatedAt };
  db.insert(t.profile).values(row).onConflictDoUpdate({ target: t.profile.personId, set: row }).run();
  return getProfile(db, personId);
}
