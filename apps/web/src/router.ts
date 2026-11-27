// A small router over the History API: /, /family, /family/:id, /household, /celebrations, /celebrations/:id, and the
// one-time links /setup and /enrol, and the guest page /guest (ADR 0009). The server answers every one of them with
// the page (apps/server/src/paths.ts). A move pushes deeper (a list to its detail), pops back, or fades between tabs,
// on motion.js's screen transitions.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { screen, type ScreenMove } from './motion';

export type Route =
  | { tab: 'wishes' }
  | { tab: 'family'; person?: string }
  | { tab: 'household' }
  | { tab: 'celebrations'; celebration?: string }
  | { tab: 'setup' | 'enrol' | 'guest' };

const ID = /^[0-9A-Za-z_-]{1,40}$/;

export function parse(path: string): Route {
  const [, a, b] = path.replace(/\/+$/, '').split('/');
  if (a === 'family') return b && ID.test(b) ? { tab: 'family', person: b } : { tab: 'family' };
  if (a === 'celebrations') return b && ID.test(b) ? { tab: 'celebrations', celebration: b } : { tab: 'celebrations' };
  if (a === 'household') return { tab: 'household' };
  if (a === 'setup' || a === 'enrol' || a === 'guest') return { tab: a };
  return { tab: 'wishes' };
}

/** Where a page sits: its section (the tab it is under) and how deep (a list 0, its detail 1). */
export function place(path: string): { section: string; depth: number } {
  const r = parse(path);
  if (r.tab === 'family') return { section: 'family', depth: r.person ? 1 : 0 };
  if (r.tab === 'household') return { section: 'family', depth: 1 };
  if (r.tab === 'celebrations') return { section: 'celebrations', depth: r.celebration ? 1 : 0 };
  return { section: r.tab, depth: 0 };
}

/** How the screen moves from one page to the next: deeper in a section pushes, back pops, anything else fades. */
export function move(from: string, to: string): ScreenMove {
  const a = place(from), b = place(to);
  if (a.section !== b.section) return 'fade';
  if (b.depth > a.depth) return 'push';
  if (b.depth < a.depth) return 'pop';
  return 'fade';
}

/** Set when the person moved to another page (a link, Back): the next page's heading then takes the focus. */
let moved = false;
export const takeMoved = () => { const m = moved; moved = false; return m; };

/** The page shown now (the last one moved to), to know how the next move goes. */
let at = typeof location === 'undefined' ? '/' : location.pathname;

export function useRouter() {
  const [path, setPath] = useState(() => location.pathname);
  useEffect(() => {
    const pop = () => {
      const to = location.pathname;
      const how = move(at, to);
      at = to;
      moved = true;
      screen(() => setPath(to), how);
    };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);
  const go = useCallback((to: string) => {
    const from = location.pathname;
    if (to !== from) history.pushState(null, '', to);
    at = to;
    moved = true;
    screen(() => { setPath(to); scrollTo({ top: 0 }); }, move(from, to));
  }, []);
  return { route: parse(path), path, go };
}

export const Nav = createContext<(to: string) => void>(() => undefined);
export const useGo = () => useContext(Nav);
