// Motion and glass through HomersLab's motion.js (vendored, it sets window.HL): screens push, pop and fade with the View
// Transitions API, rows glide when a list gains or loses one, the tab bar's lens slides, and the glass level. Where
// motion.js or the API is missing (tests, an older browser) every change simply happens; under reduced motion
// motion.js cross-fades screens and changes lists at once.
import { useCallback, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

interface HL {
  still: () => boolean;
  run: (update: () => void, opts?: { type?: 'push' | 'pop' | 'fade' | 'list' }) => Promise<void>;
  list: (update: () => void, scope?: ParentNode) => Promise<void>;
  lens: (bar: Element | null) => void;
  glass: (v: string) => string | number;
  glassValue: () => string | number;
}

declare global {
  interface Window { HL?: HL; HL_ICONS?: Record<string, string> }
}

const hl = (): HL | undefined => (typeof window === 'undefined' ? undefined : window.HL);

export type ScreenMove = 'push' | 'pop' | 'fade';

/** A screen change: React renders it inside the transition (flushSync), so the new screen is what animates in. */
export function screen(update: () => void, type: ScreenMove): void {
  const m = hl();
  if (!m) { update(); return; }
  void m.run(() => flushSync(update), { type });
}

/** A list that gains or loses rows (rows carry data-row="<id>"): the others glide, the row fades in or out. */
export function rows(update: () => void, tries = 8): void {
  const m = hl();
  if (!m) { update(); return; }
  // A sheet in the way: the moving rows would be drawn over it. One that is leaving is waited for (a moment); one that
  // stays open gets the change without the glide.
  if (document.querySelector('dialog.ks-dialog')) {
    if (tries > 0) setTimeout(() => rows(update, tries - 1), 80); else update();
    return;
  }
  void m.list(() => flushSync(update));
}

/**
 * State whose later changes are a list's (a reload after a claim, a removal): the first value is simply there, every
 * one after it goes through rows(), so the rows that came or went glide.
 */
export function useRows<T>(): [T | null, (next: T) => void] {
  const [v, set] = useState<T | null>(null);
  const had = useRef(false);
  const put = useCallback((next: T) => {
    if (had.current) rows(() => set(next)); else set(next);
    had.current = true;
  }, []);
  return [v, put];
}

/** The tab bar's lens, slid to the current tab. */
export const lens = (bar: Element | null) => hl()?.lens(bar);

/** Whether motion is reduced (the system setting). */
export const still = () => hl()?.still() ?? (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

// ---------- the glass level: per device, kept in this browser only ----------
export const GLASS_LEVELS = [
  { id: 'clear', label: 'Clear' }, { id: 'balanced', label: 'Balanced' }, { id: 'frosted', label: 'Frosted' }, { id: 'solid', label: 'Solid' },
] as const;
export type GlassLevel = (typeof GLASS_LEVELS)[number]['id'];
const KEY = 'keepsake.glass';
const isLevel = (v: unknown): v is GlassLevel => GLASS_LEVELS.some((l) => l.id === v);

export function savedGlass(): GlassLevel {
  try { const v = localStorage.getItem(KEY); return isLevel(v) ? v : 'balanced'; } catch { return 'balanced'; }
}

/** Sets the level on <html> (it glides there on the smooth spring) and keeps it for this device. */
export function setGlass(v: GlassLevel, keep = true): void {
  const m = hl();
  if (m) m.glass(v); else document.documentElement.dataset.glass = v;
  if (keep) { try { localStorage.setItem(KEY, v); } catch { /* private mode: the level holds until the page closes */ } }
}
