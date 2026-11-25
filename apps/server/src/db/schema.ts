// The database (SQLite via Drizzle, ADR 0002). Migrations in drizzle/ come from `pnpm db:generate` after a change here
// (test/migrations.contract.test.ts checks they agree). Routes never import this file: they go through the domain
// modules, and every answer is built by the view layer (src/view, ADR 0003).
import { sql } from 'drizzle-orm';
import { blob, check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** The household's people (spec §2). Under HomersLab, external_id is the edge's stable person id. */
export const person = sqliteTable('person', {
  id: text('id').primaryKey(),
  externalId: text('external_id'),
  name: text('name').notNull(),
  role: text('role', { enum: ['admin', 'adult', 'kid'] }).notNull(),
  createdAt: text('created_at').notNull(),
}, (t) => [
  uniqueIndex('person_external_id').on(t.externalId),
  check('person_role', sql`${t.role} IN ('admin', 'adult', 'kid')`),
]);

/** Who manages a kid (their parents): they approve the kid's wishes and keep the kid's list and profile. */
export const manager = sqliteTable('manager', {
  kidId: text('kid_id').notNull().references(() => person.id, { onDelete: 'cascade' }),
  managerId: text('manager_id').notNull().references(() => person.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.kidId, t.managerId] }), check('manager_not_self', sql`${t.kidId} <> ${t.managerId}`)]);

/** Household settings that are not security settings (those come from the environment only, spec §10). */
export const setting = sqliteTable('setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// Standalone sign-in (Philobiblos ADR 0010): passkeys, sessions and one-time links. Tokens are stored as SHA-256.
export const passkey = sqliteTable('passkey', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => person.id, { onDelete: 'cascade' }),
  publicKey: blob('public_key', { mode: 'buffer' }).notNull(),
  counter: integer('counter').notNull().default(0),
  transportsJson: text('transports_json').notNull().default('[]'),
  backedUp: integer('backed_up').notNull().default(0),
  label: text('label').notNull(),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
  invitedBy: text('invited_by').references(() => person.id, { onDelete: 'set null' }),
}, (t) => [index('passkey_person').on(t.personId)]);

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => person.id, { onDelete: 'cascade' }),
  passkeyId: text('passkey_id').references(() => passkey.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  expiresAt: text('expires_at').notNull(),
}, (t) => [index('session_person').on(t.personId)]);

export const invite = sqliteTable('invite', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['setup', 'admin', 'self', 'recovery'] }).notNull(),
  personId: text('person_id').references(() => person.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  createdBy: text('created_by').references(() => person.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
}, (t) => [
  uniqueIndex('invite_token').on(t.tokenHash),
  check('invite_kind', sql`${t.kind} IN ('setup', 'admin', 'self', 'recovery')`),
]);

/** A date gifts are given for (spec §3, ADR 0007). A yearly one comes back on the same day each year. */
export const celebration = sqliteTable('celebration', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** YYYY-MM-DD: the first (or only) date. */
  date: text('date').notNull(),
  place: text('place'),
  poster: text('poster', { enum: ['pine', 'berry', 'night', 'gold'] }).notNull(),
  recurrence: text('recurrence', { enum: ['none', 'yearly'] }).notNull(),
  hostId: text('host_id').references(() => person.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull(),
}, (t) => [
  check('celebration_poster', sql`${t.poster} IN ('pine', 'berry', 'night', 'gold')`),
  check('celebration_recurrence', sql`${t.recurrence} IN ('none', 'yearly')`),
]);

/** The people a celebration is for (whose lists it has). */
export const celebrationPerson = sqliteTable('celebration_person', {
  celebrationId: text('celebration_id').notNull().references(() => celebration.id, { onDelete: 'cascade' }),
  personId: text('person_id').notNull().references(() => person.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.celebrationId, t.personId] }), index('celebration_person_person').on(t.personId)]);

/**
 * A wish (ADR 0007): belongs to its person; for one celebration, or any time (celebration_id null).
 * state: 'listed' (the household sees it), 'awaiting_parent' (a kid's, until a manager approves it), 'suggested'
 * (someone else's idea for the person, until the person or a kid's manager approves it).
 */
export const wish = sqliteTable('wish', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => person.id, { onDelete: 'cascade' }),
  celebrationId: text('celebration_id').references(() => celebration.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  /** Stored as typed, never fetched (spec §8: adding from a link comes in M5 through a hardened egress). */
  link: text('link'),
  /** In minor units of the household's currency. */
  priceMinor: integer('price_minor'),
  quantity: integer('quantity').notNull().default(1),
  note: text('note'),
  mostWanted: integer('most_wanted').notNull().default(0),
  position: integer('position').notNull(),
  state: text('state', { enum: ['listed', 'awaiting_parent', 'suggested'] }).notNull(),
  addedBy: text('added_by').references(() => person.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  /**
   * The one-off celebration it was for until that day passed and it became any time (ADR 0007); cleared when it is
   * moved. Never sent: a late gift for that day still counts for it (ADR 0003).
   */
  wasFor: text('was_for').references(() => celebration.id, { onDelete: 'set null' }),
}, (t) => [
  index('wish_person').on(t.personId, t.position),
  index('wish_celebration').on(t.celebrationId),
  check('wish_state', sql`${t.state} IN ('listed', 'awaiting_parent', 'suggested')`),
  check('wish_quantity', sql`${t.quantity} BETWEEN 1 AND 99`),
  check('wish_price', sql`${t.priceMinor} IS NULL OR ${t.priceMinor} >= 0`),
]);

/** Sizes, likes and "please no" (spec §3), kept by the person (or a kid's manager), each part dated. */
export const profile = sqliteTable('profile', {
  personId: text('person_id').primaryKey().references(() => person.id, { onDelete: 'cascade' }),
  sizesJson: text('sizes_json').notNull().default('[]'),
  sizesUpdatedAt: text('sizes_updated_at'),
  likesJson: text('likes_json').notNull().default('[]'),
  likesUpdatedAt: text('likes_updated_at'),
  pleaseNoJson: text('please_no_json').notNull().default('[]'),
  pleaseNoUpdatedAt: text('please_no_updated_at'),
});

/**
 * What an admin did to someone else's sign-in (an admin's passkey reset), and what a host did to a draw (ADR 0004:
 * who created, changed, drew, re-drew, removed it or set its reveal, and refused tries; never the pairs). Kept when a
 * person or the draw is removed.
 */
export const AUDIT_ACTIONS = ['passkeys_reset', 'draw_created', 'draw_changed', 'drawn', 'redrawn', 'draw_refused', 'reveal_set', 'draw_removed', 'draw_moved', 'draw_cleared'] as const;
export const audit = sqliteTable('audit', {
  id: text('id').primaryKey(),
  at: text('at').notNull(),
  actorId: text('actor_id').notNull(),
  action: text('action', { enum: AUDIT_ACTIONS }).notNull(),
  subjectId: text('subject_id').notNull(),
}, (t) => [
  index('audit_subject').on(t.subjectId),
  check('audit_action', sql.raw(`action IN (${AUDIT_ACTIONS.map((a) => `'${a}'`).join(', ')})`)),
]);

// Gifts (spec §3, ADR 0003): claims and group gifts. The surprise: nothing here ever reaches the person a wish is for
// (or a kid) except through the view layer's thank-yous after the occasion, for givers who chose to be named. When a
// gift reaches its person is computed when read: the day after the later of the occasion stored when it was given,
// the wish's current occasion and the day it was given (gifts/gifts.ts), so the reveal only ever moves later; once its
// person has it, `revealed_on` keeps it theirs.

/**
 * "I'll get this": one giver's claim on a wish, for `quantity` of it; then bought, then given (`given_on`). A removed
 * giver's bought or given claim stays, without a giver and never named, so neither the wish nor a thank-you changes
 * because of it; one only claimed goes with them. `named`: the giver puts their name on it (thank-yous).
 */
export const claim = sqliteTable('claim', {
  id: text('id').primaryKey(),
  wishId: text('wish_id').notNull().references(() => wish.id, { onDelete: 'cascade' }),
  giverId: text('giver_id').references(() => person.id, { onDelete: 'set null' }),
  quantity: integer('quantity').notNull(),
  state: text('state', { enum: ['claimed', 'bought', 'given'] }).notNull(),
  givenOn: text('given_on'),
  /** When given: its occasion's day then. The reveal only ever moves later (ADR 0003). */
  occasionOn: text('occasion_on'),
  /** The first day its person had it: from then on it stays theirs (no un-giving, no date correction hides it again). */
  revealedOn: text('revealed_on'),
  named: integer('named').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (t) => [
  uniqueIndex('claim_wish_giver').on(t.wishId, t.giverId),
  index('claim_giver').on(t.giverId),
  check('claim_state', sql`${t.state} IN ('claimed', 'bought', 'given')`),
  check('claim_quantity', sql`${t.quantity} BETWEEN 1 AND 99`),
  check('claim_named', sql`${t.named} IN (0, 1)`),
  check('claim_given', sql`(${t.state} = 'given') = (${t.givenOn} IS NOT NULL)`),
]);

/** A wish several givers chip into: its organizer, a target, open → bought → given (`given_on`). */
export const groupGift = sqliteTable('group_gift', {
  wishId: text('wish_id').primaryKey().references(() => wish.id, { onDelete: 'cascade' }),
  organizerId: text('organizer_id').references(() => person.id, { onDelete: 'set null' }),
  targetMinor: integer('target_minor').notNull(),
  state: text('state', { enum: ['open', 'bought', 'given'] }).notNull(),
  givenOn: text('given_on'),
  occasionOn: text('occasion_on'),
  revealedOn: text('revealed_on'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (t) => [
  check('group_gift_state', sql`${t.state} IN ('open', 'bought', 'given')`),
  check('group_gift_target', sql`${t.targetMinor} BETWEEN 1 AND 100000000`),
  check('group_gift_given', sql`(${t.state} = 'given') = (${t.givenOn} IS NOT NULL)`),
]);

/** One giver's share of a group gift; `named` as for a claim; a removed giver's share stays, without a giver, once the gift is given (before, it goes with them). */
export const share = sqliteTable('share', {
  id: text('id').primaryKey(),
  wishId: text('wish_id').notNull().references(() => groupGift.wishId, { onDelete: 'cascade' }),
  giverId: text('giver_id').references(() => person.id, { onDelete: 'set null' }),
  amountMinor: integer('amount_minor').notNull(),
  named: integer('named').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (t) => [
  uniqueIndex('share_wish_giver').on(t.wishId, t.giverId),
  index('share_giver').on(t.giverId),
  check('share_amount', sql`${t.amountMinor} BETWEEN 1 AND 100000000`),
  check('share_named', sql`${t.named} IN (0, 1)`),
]);

// Draws (spec §3, ADR 0004): one per celebration and year. Who draws whom is only ever in draw_assignment, sealed per
// giver with AES-256-GCM under a key that is not in the database (draws/sealed.ts); nothing else here depends on it.

/**
 * A celebration's draw for one year (its occasion: the celebration's day that year, read from the celebration, so a
 * postponed day moves it). Rules: kids draw only with kids_draw; not_last_year keeps everyone from last year's person.
 * draw_together_at: nobody opens before it. reveal_on: from that day (and only after the occasion) the participants
 * see every pair; null is never.
 */
export const draw = sqliteTable('draw', {
  id: text('id').primaryKey(),
  celebrationId: text('celebration_id').notNull().references(() => celebration.id, { onDelete: 'cascade' }),
  year: integer('year').notNull(),
  rulesVersion: integer('rules_version').notNull(),
  budgetMinor: integer('budget_minor'),
  kidsDraw: integer('kids_draw').notNull().default(0),
  notLastYear: integer('not_last_year').notNull().default(0),
  drawTogetherAt: text('draw_together_at'),
  revealOn: text('reveal_on'),
  drawnAt: text('drawn_at'),
  /**
   * The celebration's day this draw was drawn for (set at drawing, only ever moved later): the draw's day is the later
   * of this and the celebration's day now, so moving the celebration can never bring "its day has come" or the reveal
   * forward (PR #10 review, H2).
   */
  occasionOn: text('occasion_on'),
  /** The day every pair was first shown: once revealed, it stays revealed. */
  revealedAt: text('revealed_at'),
  /** Set when the names were drawn again after someone had opened theirs: everyone is told to open theirs again. */
  redrawnAt: text('redrawn_at'),
  createdBy: text('created_by').references(() => person.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (t) => [
  uniqueIndex('draw_celebration_year').on(t.celebrationId, t.year),
  check('draw_budget', sql`${t.budgetMinor} IS NULL OR ${t.budgetMinor} BETWEEN 1 AND 100000000`),
  check('draw_flags', sql`${t.kidsDraw} IN (0, 1) AND ${t.notLastYear} IN (0, 1)`),
]);

/**
 * Who is in a draw. kind 'person': someone of the household; 'guest' is M4's (a personal draw link, ADR 0009) and has
 * no rows yet. opened_at: when they first opened theirs (counted for "4 of 6 opened", never shown per person).
 */
export const drawParticipant = sqliteTable('draw_participant', {
  id: text('id').primaryKey(),
  drawId: text('draw_id').notNull().references(() => draw.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['person', 'guest'] }).notNull(),
  personId: text('person_id').references(() => person.id, { onDelete: 'cascade' }),
  openedAt: text('opened_at'),
  createdAt: text('created_at').notNull(),
}, (t) => [
  uniqueIndex('draw_participant_person').on(t.drawId, t.personId),
  check('draw_participant_kind', sql`${t.kind} IN ('person', 'guest')`),
  check('draw_participant_has_person', sql`${t.kind} <> 'person' OR ${t.personId} IS NOT NULL`),
]);

/** Each try to draw a celebration's names in a year (drawn, re-drawn or refused): counted per celebration and year, so removing and re-creating a draw does not reset them. */
export const drawTry = sqliteTable('draw_try', {
  id: text('id').primaryKey(),
  celebrationId: text('celebration_id').notNull().references(() => celebration.id, { onDelete: 'cascade' }),
  year: integer('year').notNull(),
  at: text('at').notNull(),
}, (t) => [index('draw_try_celebration').on(t.celebrationId, t.year, t.at)]);

/** Two participants who never draw each other, either way (the host's to see and change). */
export const drawExclusion = sqliteTable('draw_exclusion', {
  drawId: text('draw_id').notNull().references(() => draw.id, { onDelete: 'cascade' }),
  a: text('a').notNull().references(() => drawParticipant.id, { onDelete: 'cascade' }),
  b: text('b').notNull().references(() => drawParticipant.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.drawId, t.a, t.b] }), check('draw_exclusion_order', sql`${t.a} < ${t.b}`)]);

/**
 * One giver's receiver, sealed (AES-256-GCM, its own IV, the draw and the giver bound in as associated data, a padded
 * plaintext so every row is the same length). Written in the givers' order, so neither the order of rows nor their
 * size says anything about who drew whom. key_id: which key sealed it (a short hash, not the key).
 */
export const drawAssignment = sqliteTable('draw_assignment', {
  drawId: text('draw_id').notNull().references(() => draw.id, { onDelete: 'cascade' }),
  giverId: text('giver_id').notNull().references(() => drawParticipant.id, { onDelete: 'cascade' }),
  sealed: blob('sealed', { mode: 'buffer' }).notNull(),
  keyId: text('key_id').notNull(),
}, (t) => [primaryKey({ columns: [t.drawId, t.giverId] })]);
