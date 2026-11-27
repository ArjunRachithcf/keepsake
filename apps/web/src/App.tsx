// Keepsake's web app (spec §4, UI round 4): My wishes · Family · Celebrations, on Homeward's floating glass tab bar on a
// phone and its floating glass sidebar from a tablet up (with Coming up, Household for admins and the account at its
// foot); the sign-in and the one-time links before them. A screen never calls the network beyond Keepsake's own API.
import { setTimeZone } from './format';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, message, type AuthSession, type Celebration, type Celebrations as List, type Household } from './api';
import { HouseholdContext, roleLabel } from './household';
import { Celebrations, CelebrationView } from './pages/Celebrations';
import { Family } from './pages/Family';
import { HouseholdPage } from './pages/HouseholdPage';
import { MyWishes } from './pages/MyWishes';
import { Person } from './pages/Person';
import { Enrol, SignIn, takeToken } from './pages/SignIn';
import { Guest } from './pages/Guest';
import { Nav, useRouter, type Route } from './router';
import { Avatar, ConfirmHost, Link, Loading, Logo, Notice } from './ui';
import { Icon, type IconName } from './icons';
import { unsubscribeThisDevice, useKeepSubscription } from './notify';
import { lens } from './motion';
import { AccountContext, AccountSheet } from './account';
import { dayMonth, inDays } from './format';

const TABS: { to: string; tab: 'wishes' | 'family' | 'celebrations'; label: string; icon: IconName }[] = [
  { to: '/', tab: 'wishes', label: 'My wishes', icon: 'gift' },
  { to: '/family', tab: 'family', label: 'Family', icon: 'people' },
  { to: '/celebrations', tab: 'celebrations', label: 'Celebrations', icon: 'calendar' },
];
/** The tab a page is under (Household is Family's, on a phone). */
const tabOf = (r: Route) => (r.tab === 'household' ? 'family' : r.tab);

export function App() {
  return <ConfirmHost><Keepsake /></ConfirmHost>;
}

function Keepsake() {
  const { route, path, go } = useRouter();
  const [token] = useState(() => (route.tab === 'setup' || route.tab === 'enrol' ? takeToken() : null));
  const [session, setSession] = useState<AuthSession | null>(null);
  const [household, setHousehold] = useState<Household | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState(false);

  const reload = useCallback(async () => { const h = await api<Household>('/household'); setTimeZone(h.timeZone); setHousehold(h); }, []);
  useEffect(() => { if (route.tab !== 'guest') api<AuthSession>('/auth/session').then(setSession, (e) => setError(message(e))); }, [route.tab]);
  useEffect(() => { if (session?.signedIn) reload().catch((e) => setError(message(e))); }, [session, reload]);
  useKeepSubscription(session?.signedIn && route.tab !== 'guest' ? household?.me.id ?? null : null);

  const signedIn = (s: AuthSession) => { setSession(s); go('/'); };
  const signOut = async () => {
    // This device gets nothing more for this person (the server ends it with the session too).
    await unsubscribeThisDevice();
    await api('/auth/sign-out', { method: 'POST' }).catch(() => undefined);
    setAccount(false);
    setHousehold(null);
    setSession(await api<AuthSession>('/auth/session'));
    go('/');
  };

  // A guest has no account: their page needs no session (and the household's sign-in is never shown to them).
  if (route.tab === 'guest') return <Guest />;
  if (error) return <main className="ks-auth" id="main"><div className="ks-auth-inner"><Logo size="sm" /><Notice kind="error" title="Keepsake did not answer.">{error}</Notice></div></main>;
  if (!session) return <main className="ks-auth" id="main"><Loading /></main>;
  if (route.tab === 'setup' || route.tab === 'enrol') return <Nav.Provider value={go}><Enrol kind={route.tab} token={token} onSignedIn={signedIn} /></Nav.Provider>;
  if (!session.signedIn) return <Nav.Provider value={go}><SignIn session={session} onSignedIn={signedIn} /></Nav.Provider>;
  if (!household) return <main className="ks-auth" id="main"><Loading /></main>;

  const admin = household.me.role === 'admin';
  return (
    <Nav.Provider value={go}>
      <HouseholdContext.Provider value={{ household, reload }}>
        <AccountContext.Provider value={() => setAccount(true)}>
          <a className="skip" href="#main">Skip to the page</a>
          <div className="ks-shell">
            <Sidebar route={route} path={path} admin={admin} onAccount={() => setAccount(true)} />
            <main className="ks-main" id="main">
              <div className="ks-page vt-screen" key={path}>
                {route.tab === 'wishes' && <MyWishes />}
                {route.tab === 'family' && (route.person ? <Person key={route.person} id={route.person} /> : <Family onSignOut={household.mode === 'standalone' ? signOut : undefined} />)}
                {route.tab === 'household' && (admin ? <HouseholdPage /> : <Family onSignOut={household.mode === 'standalone' ? signOut : undefined} />)}
                {route.tab === 'celebrations' && (route.celebration ? <CelebrationView key={route.celebration} id={route.celebration} /> : <Celebrations />)}
              </div>
            </main>
            <TabBar current={tabOf(route)} />
          </div>
          <AccountSheet open={account} onClose={() => setAccount(false)} onSignOut={household.mode === 'standalone' ? signOut : undefined} />
        </AccountContext.Provider>
      </HouseholdContext.Provider>
    </Nav.Provider>
  );
}

/** The phone's floating glass tab bar; its lens slides to the chosen tab (motion.js). */
function TabBar({ current }: { current: string }) {
  const bar = useRef<HTMLElement>(null);
  useLayoutEffect(() => { lens(bar.current); }, [current]);
  return (
    <nav className="tabbar ks-tabbar vt-tabs" aria-label="Keepsake" ref={bar}>
      <span className="tabbar-lens" aria-hidden="true" />
      {TABS.map((t) => (
        <Link key={t.tab} to={t.to} className="tab" aria-current={current === t.tab ? 'page' : undefined}><Icon name={t.icon} />{t.label}</Link>
      ))}
    </nav>
  );
}

/** The floating glass sidebar (a tablet and up): the places, Coming up, then Household (admins) and the account. */
function Sidebar({ route, path, admin, onAccount }: { route: Route; path: string; admin: boolean; onAccount: () => void }) {
  const { household } = useContext(HouseholdContext)!;
  const me = household.me;
  const [coming, setComing] = useState<Celebration[]>([]);
  useEffect(() => { api<List>('/celebrations').then((l) => setComing(l.upcoming), () => undefined); }, [path]);
  const nav = useRef<HTMLElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  // The chosen place's pill slides to it (the snappy spring); the first time it is simply there.
  useLayoutEffect(() => {
    const n = nav.current, p = pill.current;
    if (!n || !p) return;
    const cur = n.querySelector<HTMLElement>('.nav-item[aria-current="page"]');
    p.classList.toggle('is-on', Boolean(cur));
    if (!cur) return;
    p.classList.toggle('is-still', !placed.current);
    p.style.setProperty('--y', `${cur.offsetTop}px`);
    p.style.height = `${cur.offsetHeight}px`;
    placed.current = true;
  }, [path, coming.length]);
  const tab = route.tab === 'household' ? 'household' : route.tab;
  const next = coming[0];
  return (
    <aside className="sidebar glass ks-side ks-wide vt-side" aria-label="Keepsake">
      <div className="ks-brand"><Logo size="side" /></div>
      <div className="sidebar-scope"><b>Your family</b>{next && <span>{next.name} {inDays(next.daysUntil)}</span>}</div>
      <nav className="nav" aria-label="Places" ref={nav}>
        <span className="ks-nav-lens" ref={pill} aria-hidden="true" />
        {TABS.map((t) => (
          <Link key={t.tab} to={t.to} className="nav-item" aria-current={tab === t.tab ? 'page' : undefined}><Icon name={t.icon} />{t.label}</Link>
        ))}
        {coming.length > 0 && <p className="nav-group">Coming up</p>}
        {coming.slice(0, 4).map((c) => (
          <Link key={c.id} to={`/celebrations/${c.id}`} className={`nav-item${route.tab === 'celebrations' && route.celebration === c.id ? ' is-here' : ''}`}>
            <span className={`poster-small poster-${c.poster}`} aria-hidden="true" />{c.name}<span className="nav-count">{dayMonth(c.nextDate)}</span>
          </Link>
        ))}
      </nav>
      <div className="sidebar-foot">
        {admin && <Link to="/household" className="nav-item" aria-current={tab === 'household' ? 'page' : undefined}><Icon name="home" />Household</Link>}
        <button type="button" className="me-row" onClick={onAccount} aria-label={`${me.name}, your account`}>
          <Avatar id={me.id} name={me.name} />
          <span className="me-text"><b>{me.name}</b><span>{roleLabel(me)}</span></span>
        </button>
      </div>
    </aside>
  );
}
