// Keepsake's web app (spec §4): three tabs, My wishes · Family · Celebrations, on a floating glass tab bar; the
// sign-in and the one-time links before them. A screen never calls the network beyond Keepsake's own API.
import { useCallback, useEffect, useState } from 'react';
import { api, message, type AuthSession, type Household } from './api';
import { HouseholdContext } from './household';
import { Celebrations, CelebrationView } from './pages/Celebrations';
import { Family } from './pages/Family';
import { MyWishes } from './pages/MyWishes';
import { Person } from './pages/Person';
import { Enrol, SignIn, takeToken } from './pages/SignIn';
import { Guest } from './pages/Guest';
import { Nav, useRouter } from './router';
import { Link, Loading, Notice, PageHead } from './ui';
import { unsubscribeThisDevice, useKeepSubscription } from './notify';

const TABS = [
  { to: '/', tab: 'wishes', label: 'My wishes' },
  { to: '/family', tab: 'family', label: 'Family' },
  { to: '/celebrations', tab: 'celebrations', label: 'Celebrations' },
] as const;

export function App() {
  const { route, go } = useRouter();
  const [token] = useState(() => (route.tab === 'setup' || route.tab === 'enrol' ? takeToken() : null));
  const [session, setSession] = useState<AuthSession | null>(null);
  const [household, setHousehold] = useState<Household | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => setHousehold(await api<Household>('/household')), []);
  useEffect(() => { if (route.tab !== 'guest') api<AuthSession>('/auth/session').then(setSession, (e) => setError(message(e))); }, [route.tab]);
  useEffect(() => { if (session?.signedIn) reload().catch((e) => setError(message(e))); }, [session, reload]);
  useKeepSubscription(session?.signedIn && route.tab !== 'guest' ? household?.me.id ?? null : null);

  const signedIn = (s: AuthSession) => { setSession(s); go('/'); };
  const signOut = async () => {
    // This device gets nothing more for this person (the server ends it with the session too).
    await unsubscribeThisDevice();
    await api('/auth/sign-out', { method: 'POST' }).catch(() => undefined);
    setHousehold(null);
    setSession(await api<AuthSession>('/auth/session'));
    go('/');
  };

  // A guest has no account: their page needs no session (and the household's sign-in is never shown to them).
  if (route.tab === 'guest') return <Guest />;
  if (error) return <main className="auth" id="main"><PageHead title="Keepsake" /><Notice kind="error" title="Keepsake did not answer.">{error}</Notice></main>;
  if (!session) return <main className="auth" id="main"><Loading /></main>;
  if (route.tab === 'setup' || route.tab === 'enrol') return <Nav.Provider value={go}><Enrol kind={route.tab} token={token} onSignedIn={signedIn} /></Nav.Provider>;
  if (!session.signedIn) return <Nav.Provider value={go}><SignIn session={session} onSignedIn={signedIn} /></Nav.Provider>;
  if (!household) return <main className="screen" id="main"><Loading /></main>;

  return (
    <Nav.Provider value={go}>
      <HouseholdContext.Provider value={{ household, reload }}>
        <a className="skip" href="#main">Skip to the page</a>
        <main className="screen" id="main">
          {route.tab === 'wishes' && <MyWishes />}
          {route.tab === 'family' && (route.person ? <Person key={route.person} id={route.person} /> : <Family onSignOut={household.mode === 'standalone' ? signOut : undefined} />)}
          {route.tab === 'celebrations' && (route.celebration ? <CelebrationView key={route.celebration} id={route.celebration} /> : <Celebrations />)}
        </main>
        <nav className="tab-bar" aria-label="Keepsake">
          <ul className="tabs">
            {TABS.map((t) => (
              <li key={t.tab}><Link to={t.to} className="tab" aria-current={route.tab === t.tab ? 'page' : undefined}>{t.label}</Link></li>
            ))}
          </ul>
        </nav>
      </HouseholdContext.Provider>
    </Nav.Provider>
  );
}
