// Words and numbers as people read them.
import type { Celebration } from './api';

export function inDays(n: number): string {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n < 0) return n === -1 ? 'yesterday' : `${-n} days ago`;
  return `in ${n} days`;
}

const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', timeZone: 'UTC' });
const dayYearFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
/** A YYYY-MM-DD day, in words ("24 December"; the year when it is not this year). */
export function day(d: string): string {
  const date = new Date(`${d}T00:00:00Z`);
  return (date.getUTCFullYear() === new Date().getFullYear() ? dayFmt : dayYearFmt).format(date);
}

const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
/** "from October 2026", for a dated profile part. */
export const since = (iso: string | null) => (iso ? `from ${monthFmt.format(new Date(iso))}` : '');

export function fractionDigits(currency: string): number {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

export function money(minor: number, currency: string): string {
  const digits = fractionDigits(currency);
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: digits, minimumFractionDigits: minor % 10 ** digits ? digits : 0 }).format(minor / 10 ** digits);
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

export const celebrationLine = (c: Celebration) => [day(c.nextDate), c.place].filter(Boolean).join(' · ');
