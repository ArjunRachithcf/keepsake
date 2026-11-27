// Signing in (standalone: passkeys only) and the one-time links: the first admin's setup link (/setup#token) and an
// invite (/enrol#token). The token is read from the #fragment, kept in memory only, and taken out of the address bar
// and history at once. The logo kit's lockup leads each of them; on a desktop the words sit beside the card.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError, message, type AuthSession } from '../api';
import { Icon } from '../icons';
import { enrolOptions, finishEnrol, PasskeyNotUsed, signIn } from '../passkeys';
import { AppIcon, Field, Logo, Notice, tabTitle, useBusy } from '../ui';

export function takeToken(): string | null {
  const t = location.hash.slice(1);
  if (location.hash) history.replaceState(null, '', location.pathname);
  return /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
}

/** What this device is, in a word, for its passkey's name ("Inês’s iPhone"). */
export function deviceWord(ua: string): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua))) return 'iPad';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux PC';
  return 'device';
}
/** A sensible name for the passkey made now: the person's and the device's ("Inês’s iPhone"), or the device's alone. */
export const passkeyName = (name: string, ua: string) => {
  const d = deviceWord(ua);
  const n = name.trim();
  return n ? `${n}’s ${d}` : d === 'device' ? 'This device' : `This ${d}`;
};

/** What the server says of a link that is unknown, used or expired (the same for each: it names no reason). */
const LINK_GONE = 'this link is unknown, used or expired';
/** What the server says of a passkey that matched nobody (one answer for every failure). */
const NO_MATCH = 'that passkey did not sign you in';
export const NO_PASSKEY = 'No passkey for Keepsake on this device yet. Ask an admin for a sign-in link.';

/**
 * Why signing in did not work, in words that say what to do: no passkey here matched anyone, or the browser used
 * none (it cannot tell us whether there was none for Keepsake on this device or the window was closed).
 */
export function signInWords(e: unknown): string {
  if (e instanceof ApiError && e.status === 401 && e.message === NO_MATCH) return NO_PASSKEY;
  if (e instanceof PasskeyNotUsed) return `${NO_PASSKEY} If there is one, try again.`;
  return message(e);
}

/** Why a one-time link did not work: a setup link is replaced at a start once it expired, or spent by its use. */
export function linkWords(kind: 'setup' | 'enrol', e: unknown): string {
  if (e instanceof ApiError && e.status === 401 && e.message === LINK_GONE) {
    return kind === 'setup'
      ? 'This setup link has been replaced or used. Use the newest one in keys/setup-link.txt.'
      : 'This sign-in link has been used or has expired. Ask whoever made it for a new one.';
  }
  return message(e);
}

/** The frame of the pages before an account: the lockup, a line about this Keepsake, the words and the card. */
function AuthFrame({ badge, intro, children, foot }: { badge?: ReactNode; intro: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <main className="ks-auth" id="main">
      <div className="ks-auth-inner">
        <div className="ks-auth-bar">
          <span className="ks-narrow"><Logo size="sm" /></span>
          <span className="ks-wide" aria-hidden="true" />
          {badge}
        </div>
        <div className="ks-auth-split">
          <div className="ks-auth-intro"><Logo size="lg" />{intro}</div>
          {children}
        </div>
        {foot && <p className="footnote">{foot}</p>}
      </div>
    </main>
  );
}

const Host = () => <span className="pill"><span className="dot dot-green dot-sm" aria-hidden="true" /><span className="mono">{location.host}</span></span>;

export function SignIn({ session, onSignedIn }: { session: AuthSession; onSignedIn: (s: AuthSession) => void }) {
  const [busy, guard] = useBusy();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { document.title = tabTitle('Keepsake'); }, []);
  const intro = (
    <>
      <h1>Wishes and celebrations for the family. <span className="ks-soft">The surprise stays a surprise.</span></h1>
      <p>Every wish for a birthday, for Christmas or for any time; names drawn so only you know yours; questions asked anonymously. What others get you, Keepsake never tells you.</p>
    </>
  );
  if (session.mode === 'homerslab') {
    return (
      <AuthFrame intro={intro}>
        <section className="glass-thick ks-auth-card" aria-labelledby="si-h">
          <div className="ks-card-head"><AppIcon small /><h2 className="title" id="si-h">Open Keepsake from HomersLab</h2></div>
          <p className="ks-auth-lede">HomersLab signs you in; Keepsake has no sign-in of its own here.</p>
        </section>
      </AuthFrame>
    );
  }
  const go = async () => {
    if (!guard.start()) return; setError(null);
    try { onSignedIn(await signIn()); } catch (e) { setError(signInWords(e)); } finally { guard.end(); }
  };
  return (
    <AuthFrame badge={<Host />} intro={intro}>
      <section className="glass-thick ks-auth-card is-hero" aria-labelledby="si-h">
        <div className="ks-card-head">
          <span className="ks-narrow"><AppIcon /></span>
          <span className="ks-wide"><AppIcon small /></span>
          <div>
            <h1 className="ks-auth-title ks-narrow" id="si-h">Wishes and celebrations for the family</h1>
            <h2 className="title ks-wide">Sign in</h2>
            <p className="subhead ks-wide">With the passkey on this computer or your phone.</p>
          </div>
        </div>
        <p className="ks-auth-lede ks-narrow">What others get you stays a surprise. Your passkey signs you in; there is no password.</p>
        {session.setupNeeded && (
          <Notice title="Keepsake needs its first admin.">
            Open the setup link in the file <code>keys/setup-link.txt</code>, beside Keepsake’s data folder. It works once, for 24 hours; a restart keeps it until then, and writes a new one after.
          </Notice>
        )}
        <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => void go()} aria-busy={busy} disabled={busy}>
          <Icon name="key" className="icon icon-md" />{busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
        </button>
        {error && <Notice kind="error">{error}</Notice>}
        <ul className="group" aria-label="No passkey here?">
          <li className="row"><span className="row-lead"><Icon name="link" className="icon icon-md" /></span><span className="row-main"><span className="row-title">New here?</span><span className="row-sub wrap">An admin of the household makes you a sign-in link.</span></span></li>
          <li className="row"><span className="row-lead"><Icon name="shield" className="icon icon-md" /></span><span className="row-main"><span className="row-title">Lost every device?</span><span className="row-sub wrap">An admin can reset your passkeys; you are told first and can call it off. An admin who lost every passkey asks whoever runs Keepsake for a recovery link (<code>keepsake recover</code>).</span></span></li>
        </ul>
      </section>
    </AuthFrame>
  );
}

export function Enrol({ kind, token, onSignedIn }: { kind: 'setup' | 'enrol'; token: string | null; onSignedIn: (s: AuthSession) => void }) {
  const id = useId();
  const h1 = useRef<HTMLHeadingElement>(null);
  const [name, setName] = useState('');
  const [label, setLabel] = useState(() => passkeyName('', navigator.userAgent));
  const [labelTouched, setLabelTouched] = useState(false);
  const [invitee, setInvitee] = useState<string | null>(null);
  const [busy, guard] = useBusy();
  const [error, setError] = useState<string | null>(token ? null : 'This link is incomplete. Open the whole link again.');
  useEffect(() => {
    if (!token) return;
    if (kind === 'enrol') { enrolOptions(token).then((s) => setInvitee(s.person.name), (e) => setError(linkWords(kind, e))); return; }
    // The setup link is checked before anyone types a name: without one the server answers "name: required" (400)
    // for a good link and the 401 for a replaced or used one, so a stale link says so at once.
    enrolOptions(token).then(() => undefined, (e) => { if (!(e instanceof ApiError && e.status === 400)) setError(linkWords(kind, e)); });
  }, [kind, token]);
  // The passkey's name follows the person's ("Inês’s iPhone") until they change it themselves.
  const who = kind === 'setup' ? name : invitee ?? '';
  useEffect(() => { if (!labelTouched) setLabel(passkeyName(who, navigator.userAgent)); }, [who, labelTouched]);
  const title = kind === 'setup' ? 'Set up Keepsake' : invitee ? `Welcome, ${invitee}` : 'Make your passkey';
  useEffect(() => { document.title = tabTitle(title); }, [title]);
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    if (!guard.start()) return; setError(null);
    try { onSignedIn(await finishEnrol(await enrolOptions(token, kind === 'setup' ? name.trim() : undefined), label.trim() || 'Passkey')); }
    catch (err) { setError(linkWords(kind, err)); } finally { guard.end(); }
  };
  const lede = kind === 'setup' ? 'You become the household’s admin. A passkey on this device signs you in; there is no password.' : 'A passkey on this device signs you in; there is no password.';
  return (
    <AuthFrame badge={<span className="pill">{kind === 'setup' ? 'One-time setup link' : 'One-time sign-in link'}</span>}
      intro={<><p className="ks-auth-display" aria-hidden="true">{title}. <span className="ks-soft">No password, ever.</span></p><p>{lede}</p></>}
      foot={kind === 'setup' ? 'The link works once and only on this machine’s address. Nobody becomes admin by arriving first.' : 'The link works once. Whoever made it can make you another.'}>
      <section className="glass-thick ks-auth-card" aria-labelledby={`${id}-h`}>
        <div className="ks-center">
          <span className="ks-plate" aria-hidden="true"><Icon name="key" /></span>
          <h1 className="ks-auth-title" id={`${id}-h`} ref={h1} tabIndex={-1}>{title}</h1>
          <p className="ks-auth-lede">{lede}</p>
        </div>
        <form className="fields" onSubmit={go} noValidate>
          {kind === 'setup' && (
            <Field label="Your name" id={`${id}-n`} hint="As the family calls you.">
              <input className="input" id={`${id}-n`} value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoComplete="given-name" aria-describedby={`${id}-n-hint`} />
            </Field>
          )}
          <Field label="A name for this passkey" id={`${id}-l`} hint="So you know it again in your list of passkeys.">
            <input className="input" id={`${id}-l`} value={label} onChange={(e) => { setLabel(e.target.value); setLabelTouched(true); }} maxLength={40} autoComplete="off" aria-describedby={`${id}-l-hint`} />
          </Field>
          <button type="submit" className="btn btn-primary btn-lg btn-block" aria-busy={busy} disabled={busy || !token || (kind === 'setup' && !name.trim())}>
            <Icon name="key" className="icon icon-md" />{busy ? 'Waiting for your passkey…' : 'Create a passkey'}
          </button>
          {error && <Notice kind="error">{error}</Notice>}
        </form>
      </section>
    </AuthFrame>
  );
}
