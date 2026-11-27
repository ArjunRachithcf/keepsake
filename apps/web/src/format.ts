// Words and numbers as people read them.
import type { Celebration } from './api';

export function inDays(n: number): string {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n < 0) return n === -1 ? 'yesterday' : `${-n} days ago`;
  return `in ${n} days`;
}

// Dates as the household writes them (UI round 4): day first, never the US order. A calendar day is
// "25.12.2026", with its weekday "Fri 25.12.2026", without its year "25.12."; when something happened, "26 Nov" (its
// year added when it is not this year); a time is 24-hour ("Fri 25.12.2026, 18:00"). The words stay English, as the
// app's are. Written out here rather than left to Intl, so a browser set to en-US still shows the household's dates.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const two = (n: number) => String(n).padStart(2, '0');

// Every instant is written in the household's time zone (KEEPSAKE_TZ, from the household or a guest's page), never
// the device's: "You drew the names · 26 Nov" is the household's 26 Nov, as the days of its celebrations are.
let zone: string | undefined;
let zoned: Intl.DateTimeFormat | null = null;
/** The household's time zone, once it is known (an unknown name leaves the device's). */
export function setTimeZone(tz: string | null | undefined) {
  try { zoned = tz ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }) : null; zone = tz ?? undefined; }
  catch { zoned = null; zone = undefined; }
}
export const timeZone = () => zone;

/** A YYYY-MM-DD calendar day as its parts; an instant (with a time) as the day and time it is in the household. */
function parts(d: string | Date): { y: number; m: number; day: number; wd: number; h: number; min: number } {
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const x = new Date(`${d}T00:00:00Z`);
    return { y: x.getUTCFullYear(), m: x.getUTCMonth(), day: x.getUTCDate(), wd: x.getUTCDay(), h: 0, min: 0 };
  }
  const x = typeof d === 'string' ? new Date(d) : d;
  if (!zoned) return { y: x.getFullYear(), m: x.getMonth(), day: x.getDate(), wd: x.getDay(), h: x.getHours(), min: x.getMinutes() };
  const f = Object.fromEntries(zoned.formatToParts(x).map((p) => [p.type, p.value]));
  return { y: Number(f.year), m: Number(f.month) - 1, day: Number(f.day), wd: WEEKDAYS.indexOf(f.weekday!), h: Number(f.hour), min: Number(f.minute) };
}

/** "25.12.2026" */
export const numericDate = (d: string) => { const p = parts(d); return `${two(p.day)}.${two(p.m + 1)}.${p.y}`; };
/** "Fri 25.12.2026": a celebration's day. */
export const weekdayDate = (d: string) => `${WEEKDAYS[parts(d).wd]} ${numericDate(d)}`;
/** "25.12.": a day in the sidebar's Coming up. */
export const dayMonth = (d: string) => { const p = parts(d); return `${two(p.day)}.${two(p.m + 1)}.`; };
/** "26 Nov" (and its year when it is not this year): when something happened. */
export function day(d: string, now = new Date()): string {
  const p = parts(d);
  return `${p.day} ${MONTHS[p.m]}${p.y === parts(now).y ? '' : ` ${p.y}`}`;
}
/** "Fri 25.12.2026, 18:00": an instant, in the household's time. */
export function dateTime(iso: string): string {
  const p = parts(iso);
  return `${weekdayDate(iso)}, ${two(p.h)}:${two(p.min)}`;
}

/** "from October 2026", for a dated profile part. */
export const since = (iso: string | null) => { if (!iso) return ''; const p = parts(iso); return `from ${MONTHS_LONG[p.m]} ${p.y}`; };

export function fractionDigits(currency: string): number {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** "CHF 89.00": always with the currency's cents, as a price tag has them. */
export function money(minor: number, currency: string): string {
  const digits = fractionDigits(currency);
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: digits, minimumFractionDigits: digits }).format(minor / 10 ** digits);
}

/** What someone typed as a price ("12.50", "12,5", "1 200") in minor units; undefined if it is not a price. */
export function parseMoney(text: string, currency: string): number | null | undefined {
  const t = text.replace(/[\s'’]/g, '').replace(',', '.');
  if (!t) return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
  const digits = fractionDigits(currency);
  const [whole, frac = ''] = t.split('.');
  if (frac.length > digits) return undefined;
  return Number(whole) * 10 ** digits + Number(frac.padEnd(digits, '0') || 0);
}

export const toMoneyText = (minor: number | null, currency: string | null) => {
  if (minor === null || !currency) return '';
  const digits = fractionDigits(currency);
  return digits ? (minor / 10 ** digits).toFixed(digits) : String(minor);
};

export const host = (link: string) => { try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** "Fri 25.12.2026 · at Avó’s": a celebration's day and place. */
export const celebrationLine = (c: Celebration) => [weekdayDate(c.nextDate), c.place].filter(Boolean).join(' · ');
