// A small router over the History API: /, /family, /family/:id, /celebrations, /celebrations/:id, and the one-time
// links /setup and /enrol. The server answers every one of them with the page (apps/server/src/paths.ts).
import { createContext, useCallback, useContext, useEffect, useState } from 'react';

export type Route =
  | { tab: 'wishes' }
  | { tab: 'family'; person?: string }
  | { tab: 'celebrations'; celebration?: string }
  | { tab: 'setup' | 'enrol' };

const ID = /^[0-9A-Za-z_-]{1,40}$/;

export function parse(path: string): Route {
  const [, a, b] = path.replace(/\/+$/, '').split('/');
  if (a === 'family') return b && ID.test(b) ? { tab: 'family', person: b } : { tab: 'family' };
  if (a === 'celebrations') return b && ID.test(b) ? { tab: 'celebrations', celebration: b } : { tab: 'celebrations' };
  if (a === 'setup' || a === 'enrol') return { tab: a };
  return { tab: 'wishes' };
}

export function useRouter() {
  const [path, setPath] = useState(() => location.pathname);
  useEffect(() => {
    const pop = () => setPath(location.pathname);
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);
  const go = useCallback((to: string) => {
    if (to !== location.pathname) history.pushState(null, '', to);
    setPath(to);
    scrollTo({ top: 0 });
  }, []);
  return { route: parse(path), path, go };
}

export const Nav = createContext<(to: string) => void>(() => undefined);
export const useGo = () => useContext(Nav);
