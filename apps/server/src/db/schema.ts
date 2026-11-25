// The database (SQLite via Drizzle, ADR 0002). Migrations in drizzle/ come from `pnpm db:generate` after a change here
// (test/migrations.contract.test.ts checks they agree). Routes never import this file: they go through the domain
// modules, and every answer is built by the view layer (src/view, ADR 0003).
import { sql } from 'drizzle-orm';
import { blob, check, index, integer, primaryKey, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

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
export const AUDIT_ACTIONS = [
  'passkeys_reset', 'draw_created', 'draw_changed', 'drawn', 'redrawn', 'draw_refused', 'reveal_set', 'draw_removed', 'draw_moved', 'draw_cleared',
  // M4: an admin removed a question (never who asked it); guest links made, opened (on their one device) and revoked;
  // a sheet imported; an admin released an imported reservation.
  'question_removed', 'link_created', 'link_revoked', 'imported', 'reservation_released', 'link_opened', 'link_reissued',
] as const;
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
  /**
   * A guest's claim (ADR 0009): the link they came with; giver_id is then null (gifts/gifts.ts never sets both). Added
   * by ALTER TABLE in 0003 (a rebuild inside the migration's transaction would cascade), hence last and without a CHECK.
   */
  guestId: text('guest_id').references((): AnySQLiteColumn => guestLink.id, { onDelete: 'set null' }),
  /** A Reserved row of the sheet import whose buyer is nobody here (review L1): nobody's claim, an admin releases it. */
  imported: integer('imported').notNull().default(0),
}, (t) => [
  uniqueIndex('claim_wish_giver').on(t.wishId, t.giverId),
  uniqueIndex('claim_wish_guest').on(t.wishId, t.guestId),
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
 * Who is in a draw. kind 'person': someone of the household; 'guest': someone with a personal draw link (ADR 0009, M4).
 * opened_at: when they first opened theirs (counted for "4 of 6 opened", never shown per person).
 */
export const drawParticipant = sqliteTable('draw_participant', {
  id: text('id').primaryKey(),
  drawId: text('draw_id').notNull().references(() => draw.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['person', 'guest'] }).notNull(),
  personId: text('person_id').references(() => person.id, { onDelete: 'cascade' }),
  openedAt: text('opened_at'),
  createdAt: text('created_at').notNull(),
  /**
   * kind 'guest': their link (draws/draws.ts sets it, and never a person_id, for a guest). Added by ALTER TABLE in 0003:
   * rebuilding this table inside the migration's transaction would cascade into the sealed rows.
   */
  guestId: text('guest_id').references((): AnySQLiteColumn => guestLink.id, { onDelete: 'cascade' }),
}, (t) => [
  uniqueIndex('draw_participant_person').on(t.drawId, t.personId),
  uniqueIndex('draw_participant_guest').on(t.drawId, t.guestId),
  check('draw_participant_kind', sql`${t.kind} IN ('person', 'guest')`),
  check('draw_participant_has_person', sql`${t.kind} <> 'person' OR ${t.personId} IS NOT NULL`),
]);

/**
 * What stays of a drawn, unrevealed draw that went (its celebration removed, the draw removed, its people or rules
 * changed, someone leaving): who was in it and its day, never its pairs. Gifts its people made for each other up to that
 * day stay unnamed, as while the draw was there (ADR 0003, 0004; second review M3, L6): while its draw lives, until the
 * draw itself is revealed; once the draw is gone, until the reveal date it had, if it had one and it has passed after
 * its day; with "never", for good.
 */
export const drawVeil = sqliteTable('draw_veil', {
  id: text('id').primaryKey(),
  /**
   * The draw it was written for while that draw lives on (a re-draw, someone leaving): it then follows the draw's own
   * reveal and day, as they are now (third review L8). When the draw goes, its day and reveal date are copied here.
   */
  drawId: text('draw_id').references(() => draw.id, { onDelete: 'set null' }),
  peopleJson: text('people_json').notNull(),
  on: text('on').notNull(),
  revealOn: text('reveal_on'),
  createdAt: text('created_at').notNull(),
});

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

// M4 (spec §2, ADR 0008, 0009): guests by link, anonymous questions, ideas.

/**
 * A guest's link (ADR 0009), which is also the guest: nobody outside the household gets an account. kind 'share': one
 * person's wishes (person_id), made by another grown-up (a kid's: a parent), never the person. kind 'draw': a personal
 * link for one named guest to one celebration's draw (celebration_id), made by its host; it expires at the end of the
 * draw's day, household time (computed when read). The token (256 bits) travels in the link's #fragment and is kept
 * here as its SHA-256 only. A link opens on one device: opened_at and opened_by (the device's hash) are set by the
 * first exchange, which spends the token (review N2, M-a); a new address (review M-b) puts a new token on the same row. label: who it is for, from its maker; guest_name: the name the guest gives (claims wait for it).
 * approved_at: set when it is made.
 */
export const guestLink = sqliteTable('guest_link', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['share', 'draw'] }).notNull(),
  personId: text('person_id').references(() => person.id, { onDelete: 'cascade' }),
  celebrationId: text('celebration_id').references(() => celebration.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  guestName: text('guest_name'),
  tokenHash: text('token_hash').notNull(),
  createdBy: text('created_by').references(() => person.id, { onDelete: 'set null' }),
  approvedAt: text('approved_at'),
  createdAt: text('created_at').notNull(),
  revokedAt: text('revoked_at'),
  openedAt: text('opened_at'),
  openedBy: text('opened_by'),
  // A new address (review M-b, R-1): when it last got one, how often, and when its earlier address was last used.
  reissuedAt: text('reissued_at'),
  reissueCount: integer('reissue_count').notNull().default(0),
  earlierLastUsedAt: text('earlier_last_used_at'),
}, (t) => [
  uniqueIndex('guest_link_token').on(t.tokenHash),
  index('guest_link_person').on(t.personId),
  index('guest_link_celebration').on(t.celebrationId),
  check('guest_link_kind', sql`${t.kind} IN ('share', 'draw')`),
  check('guest_link_target', sql`(${t.kind} = 'share' AND ${t.personId} IS NOT NULL AND ${t.celebrationId} IS NULL) OR (${t.kind} = 'draw' AND ${t.celebrationId} IS NOT NULL AND ${t.personId} IS NULL)`),
]);

/**
 * A guest's session of one link on one device (review M-a): the device is the cookie __Host-keepsake_guest (256 random bits,
 * SHA-256 here as device_hash), which holds the sessions of every link it opened; a session is found by link and
 * device. Made from a link's token by a POST; it ends with the link (expires_at: at most 400 days) or after 30 days
 * without use (last_seen_at).
 */
export const guestSession = sqliteTable('guest_session', {
  id: text('id').primaryKey(),
  linkId: text('link_id').notNull().references(() => guestLink.id, { onDelete: 'cascade' }),
  deviceHash: text('device_hash').notNull(),
  createdAt: text('created_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  expiresAt: text('expires_at').notNull(),
}, (t) => [index('guest_session_link').on(t.linkId), uniqueIndex('guest_session_device').on(t.deviceHash, t.linkId)]);

/**
 * One anonymous question to a person about their wishes (ADR 0008): one answer, no chat. The asker (a person or a
 * guest) is kept so they find theirs and so limits hold; only questions/questions.ts compares it with the caller, and
 * nothing ever returns it. deliver_at: 08:00 household time on the day after it was asked; before then only its asker
 * sees it. Ids are random (no time in them). state: open → answered (in words, or with a wish: answer_wish_id) or
 * declined.
 */
export const question = sqliteTable('question', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => person.id, { onDelete: 'cascade' }),
  askerId: text('asker_id').references(() => person.id, { onDelete: 'set null' }),
  askerGuestId: text('asker_guest_id').references(() => guestLink.id, { onDelete: 'set null' }),
  text: text('text').notNull(),
  askedAt: text('asked_at').notNull(),
  deliverAt: text('deliver_at').notNull(),
  state: text('state', { enum: ['open', 'answered', 'declined'] }).notNull(),
  answer: text('answer'),
  answerWishId: text('answer_wish_id').references(() => wish.id, { onDelete: 'set null' }),
  answeredAt: text('answered_at'),
}, (t) => [
  index('question_person').on(t.personId, t.deliverAt),
  index('question_asker').on(t.askerId),
  check('question_state', sql`${t.state} IN ('open', 'answered', 'declined')`),
  check('question_one_asker', sql`${t.askerId} IS NULL OR ${t.askerGuestId} IS NULL`),
]);

/** A gift idea a grown-up keeps for a person (spec §3): shared with the other givers, never shown to that person or a kid. */
export const idea = sqliteTable('idea', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => person.id, { onDelete: 'cascade' }),
  authorId: text('author_id').references(() => person.id, { onDelete: 'set null' }),
  text: text('text').notNull(),
  createdAt: text('created_at').notNull(),
}, (t) => [index('idea_person').on(t.personId)]);
