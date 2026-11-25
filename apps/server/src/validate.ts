// Request bodies checked against what contracts/openapi.yaml declares (the contract tests send the spec's samples).
// Each reader returns the value or throws Refused(400) with a message naming the field.
import { Refused, type Field, type Template } from './errors';

export type Body = Record<string, unknown>;

export function object(body: unknown, allowed: readonly string[]): Body {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Refused(400, 'a JSON object is needed');
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw Refused.unknownField(k);
  return body as Body;
}

const bad = (field: string, what: Template, ...fill: (number | readonly string[])[]): never => { throw Refused.field(field as Field, what, ...fill); };

export function text(b: Body, field: string, max: number, o: { required?: boolean } = {}): string | undefined {
  const v = b[field];
  if (v === undefined) return o.required ? bad(field, 'required') : undefined;
  if (typeof v !== 'string' || !v.trim() || v.length > max) return bad(field, '1 to # characters', max);
  return v;
}

export function nullableText(b: Body, field: string, max: number): string | null | undefined {
  const v = b[field];
  if (v === undefined || v === null) return v;
  if (typeof v !== 'string' || v.length > max) return bad(field, 'up to # characters, or null', max);
  return v.trim() ? v : null;
}

export function oneOf<T extends string>(b: Body, field: string, values: readonly T[], o: { required?: boolean } = {}): T | undefined {
  const v = b[field];
  if (v === undefined) return o.required ? bad(field, 'required') : undefined;
  if (typeof v !== 'string' || !values.includes(v as T)) return bad(field, 'one of @', values);
  return v as T;
}

export function int(b: Body, field: string, min: number, max: number): number | undefined {
  const v = b[field];
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) return bad(field, 'a whole number from # to #', min, max);
  return v as number;
}

export function nullableInt(b: Body, field: string, min: number, max: number): number | null | undefined {
  return b[field] === null ? null : int(b, field, min, max);
}

export function bool(b: Body, field: string): boolean | undefined {
  const v = b[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') return bad(field, 'true or false');
  return v;
}

export const ID = /^[0-9A-Za-z_-]{1,40}$/;
export const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

export function id(b: Body, field: string, o: { required?: boolean } = {}): string | undefined {
  const v = b[field];
  if (v === undefined) return o.required ? bad(field, 'required') : undefined;
  return isId(v) ? v : bad(field, 'an id');
}

export function nullableId(b: Body, field: string, o: { required?: boolean } = {}): string | null | undefined {
  const v = b[field];
  if (v === undefined) return o.required ? bad(field, 'required (an id, or null)') : undefined;
  if (v === null) return null;
  return isId(v) ? v : bad(field, 'an id, or null');
}

export function ids(b: Body, field: string, o: { min?: number; max: number }): string[] | undefined {
  const v = b[field];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length < (o.min ?? 0) || v.length > o.max || !v.every(isId)) return bad(field, '# to # ids', o.min ?? 0, o.max);
  return v as string[];
}

export function strings(b: Body, field: string, o: { maxItems: number; maxLength: number }): string[] | undefined {
  const v = b[field];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > o.maxItems || !v.every((s) => typeof s === 'string' && s.trim() && s.length <= o.maxLength)) {
    return bad(field, 'up to # texts of 1 to # characters', o.maxItems, o.maxLength);
  }
  return (v as string[]).map((s) => s.trim());
}

/**
 * A link as typed: http or https, no user name or password, at most 2000 characters. Stored as given (normalised by
 * URL) and never fetched: the server opens no connection (test/architecture.test.ts).
 */
export function link(b: Body, field: string): string | null | undefined {
  const v = b[field];
  if (v === undefined || v === null) return v;
  if (typeof v !== 'string' || v.length > 2000) return bad(field, 'a web address (http or https) of up to # characters', 2000);
  if (!v.trim()) return null;
  let u: URL;
  try { u = new URL(v.trim()); } catch { return bad(field, 'a web address (http or https)'); }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return bad(field, 'a web address (http or https) without a user name or password');
  return u.href.length > 2000 ? bad(field, 'up to # characters', 2000) : u.href;
}

export function sizes(b: Body) {
  const v = b.sizes;
  if (v === undefined) return undefined;
  const ok = Array.isArray(v) && v.length <= 30 && v.every((s) => s && typeof s === 'object' && !Array.isArray(s)
    && Object.keys(s).every((k) => k === 'label' || k === 'value')
    && typeof s.label === 'string' && s.label.trim() && s.label.length <= 40
    && typeof s.value === 'string' && s.value.trim() && s.value.length <= 40);
  if (!ok) throw new Refused(400, 'sizes: up to 30 { label, value } of 1 to 40 characters');
  return (v as { label: string; value: string }[]).map((s) => ({ label: s.label.trim(), value: s.value.trim() }));
}
import { isDate as isDay } from './celebrations/dates';
export { isDate } from './celebrations/dates';

/** An instant with its time zone (ISO 8601, e.g. 2026-12-24T18:00:00.000Z or +01:00), or null. Returned in UTC. */
export function nullableDateTime(b: Body, field: string): string | null | undefined {
  const v = b[field];
  if (v === undefined || v === null) return v;
  const ok = typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v));
  return ok ? new Date(v).toISOString() : bad(field, 'a date and time (ISO 8601 with a time zone), or null');
}

export function nullableDay(b: Body, field: string): string | null | undefined {
  const v = b[field];
  if (v === undefined || v === null) return v;
  return isDay(v) ? v : bad(field, 'a day (YYYY-MM-DD), or null');
}

/** Pairs of two ids ([[a, b], …]). */
export function idPairs(b: Body, field: string, max: number): [string, string][] | undefined {
  const v = b[field];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > max || !v.every((p) => Array.isArray(p) && p.length === 2 && p.every(isId))) return bad(field, 'up to # pairs of two ids', max);
  return v as [string, string][];
}
