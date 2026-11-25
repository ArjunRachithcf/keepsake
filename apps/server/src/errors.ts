// What a refusal may say (PR #8 review: nothing from the data leaves through an error). Every `{ error }` Keepsake sends
// is one of MESSAGES, or a field's problem built from a known field name and a fixed template with numbers
// (Refused.field), or "unknown field <name>" for a name made of letters. The seam checks every /api error body against
// these (isCatalogued) and replaces anything else with "something went wrong".

export const MESSAGES = [
  // the API's own
  'something went wrong', 'too many tries; wait a minute', 'send JSON', 'the request is not valid', 'not found',
  'sign in required', 'not allowed', 'request from another origin refused', 'a JSON object is needed', 'unknown field',
  // sign-in
  'that passkey did not sign you in', 'the passkey could not be verified', 'this link is unknown, used or expired',
  'this sign-in step expired; start again', 'sign in again to do this', 'HomersLab signs people in',
  'this passkey is already enrolled', 'your last passkey stays: add another first', 'no such passkey',
  'they already sign in; they add passkeys themselves', 'an admin recovers with keepsake recover',
  'a kid\'s parent or an admin only',
  // household
  'admins only', 'no such person', 'people are managed in HomersLab', 'only kids have managers',
  'the household needs an admin who can sign in', 'you cannot remove yourself', 'managerIds: a kid cannot manage a kid',
  'managerIds: someone is not in the household', 'currency: three capital letters (ISO 4217), or null',
  'sizes: up to 30 { label, value } of 1 to 40 characters', 'only the person (or a kid\'s manager) keeps their profile',
  // wishes
  'no such wish', 'this wish is not yours to change', 'this wish is not yours to remove', 'this wish is not yours to approve',
  'this wish is not yours to decline', 'celebrationId: a celebration this person is part of, or null for any time',
  'the household has no currency yet: an admin sets it first', 'a list holds at most 300 wishes',
  'at most 30 suggestions wait for one person', 'only the person (or a kid\'s manager) orders their wishes',
  'wishIds: each of the person\'s wishes once', 'for: a celebration\'s id, or any',
  // celebrations
  'no such celebration', 'grown-ups host celebrations', 'only its host or an admin changes a celebration',
  'only its host or an admin removes a celebration', 'date: a day, YYYY-MM-DD', 'people: at least one person',
  'people: someone is not in the household',
  // gifts (M2): only ever said to a giver, or to the person and kids before any gift is read
  'your own wishes are for others to give', 'grown-ups claim gifts and chip in', 'only a wish on the list can be given',
  'it is not a group gift', 'it is a group gift: chip in instead', 'you have given it already',
  'someone is getting it already', 'not that many are left to claim', 'you have not claimed it',
  'it was given, and its celebration is over', 'it is given: mark it not given first',
  'only for a gift you gave, once its celebration is over', 'it is a group gift already',
  'whoever started the group gift changes it', 'it is bought: the target stays',
  'others have chipped in: they take their share back first', 'it is bought: shares stay as they are',
  'you have not chipped in', 'targetMinor or state: one of them',
] as const;
export type Message = (typeof MESSAGES)[number];

/** The request fields a refusal may name. */
export const FIELDS = [
  'name', 'role', 'currency', 'managerIds', 'sizes', 'likes', 'pleaseNo', 'wishIds', 'personId', 'link', 'priceMinor',
  'quantity', 'note', 'mostWanted', 'celebrationId', 'date', 'place', 'poster', 'recurrence', 'people', 'token', 'label',
  'targetMinor', 'amountMinor', 'state', 'named',
] as const;
export type Field = (typeof FIELDS)[number];

/** A field's problem: `#` stands for a number, `@` for a list of the code's own words (roles, posters). */
export const TEMPLATES = [
  'required', 'required (an id, or null)', '1 to # characters', 'up to # characters, or null', 'up to # characters',
  'a whole number from # to #', 'true or false', 'an id', 'an id, or null', '# to # ids', 'up to # texts of 1 to # characters',
  'a web address (http or https) of up to # characters', 'a web address (http or https)',
  'a web address (http or https) without a user name or password', 'one of @',
] as const;
export type Template = (typeof TEMPLATES)[number];

const MESSAGE_SET = new Set<string>(MESSAGES);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FIELD_RE = new RegExp(`^(?:${FIELDS.join('|')}): (?:${TEMPLATES.map((t) => esc(t).replace(/#/g, '\\d{1,9}').replace(/@/g, '[a-z_]{1,20}(?:, [a-z_]{1,20}){0,9}')).join('|')})$`);
const UNKNOWN_RE = /^unknown field [A-Za-z]{1,30}$/;

export const isCatalogued = (m: unknown): boolean => typeof m === 'string' && (MESSAGE_SET.has(m) || FIELD_RE.test(m) || UNKNOWN_RE.test(m));

/** A refusal a domain module or route raises; the API sends it as `{ error }` with its status. */
export class Refused extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409, message: Message) { super(message); }

  /** "<field>: <template>" with the template's # filled in, in order, and @ with the code's own words. */
  static field(field: Field, template: Template, ...fill: (number | readonly string[])[]): Refused {
    let i = 0;
    const msg = template.replace(/[#@]/g, (c) => {
      const v = fill[i++];
      return c === '#' ? String(Math.trunc(Number(v))) : (v as readonly string[]).join(', ');
    });
    return Refused.raw(400, `${field}: ${msg}`);
  }

  static unknownField(name: string): Refused {
    return Refused.raw(400, /^[A-Za-z]{1,30}$/.test(name) ? `unknown field ${name}` : 'unknown field');
  }

  private static raw(status: 400, message: string): Refused {
    const r = new Refused(status, 'unknown field');
    r.message = message;
    return r;
  }
}
