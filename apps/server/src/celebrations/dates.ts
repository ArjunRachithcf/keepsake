// Celebration dates (ADR 0007): a yearly one (birthdays, Christmas) comes back on the same day every year; 29 February
// falls on 28 February in other years. Pure functions over YYYY-MM-DD strings, in the household's time zone.

const DAY = 86_400_000;

/** Today in a time zone, as YYYY-MM-DD. */
export function today(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export const isDate = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && y <= 2200 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const pad = (n: number) => String(n).padStart(2, '0');

/** A yearly date on a given year (29 February on 28 February in other years). */
export function onYear(date: string, year: number): string {
  const [, m, d] = date.split('-').map(Number) as [number, number, number];
  const day = m === 2 && d === 29 && !isLeap(year) ? 28 : d;
  return `${year}-${pad(m)}-${pad(day)}`;
}

/** The celebration's next date on or after `from`: its date, or for a yearly one its next return (never before its first date). */
export function nextDate(date: string, recurrence: 'none' | 'yearly', from: string): string {
  if (recurrence === 'none' || date >= from) return date;
  const year = Number(from.slice(0, 4));
  const thisYear = onYear(date, year);
  return thisYear >= from ? thisYear : onYear(date, year + 1);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

/** The day `n` days after `day` (YYYY-MM-DD). */
export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** The wall-clock time in a zone as if it were UTC (for the offset). */
function wallClock(timeZone: string, at: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

/** The instant a day's `hour`:00 falls on in a time zone (the morning batch, ADR 0008). */
export function atHour(day: string, hour: number, timeZone: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const want = Date.UTC(y, m - 1, d, hour);
  let at = want - (wallClock(timeZone, want) - want);
  // Once more across a change of offset (summer time) between the guess and the answer.
  at = want - (wallClock(timeZone, at) - at);
  return new Date(at);
}
