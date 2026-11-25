// Signing in (standalone: passkeys only) and the one-time links: the first admin's setup link (/setup#token) and an
// invite (/enrol#token). The token is read from the #fragment, kept in memory only, and taken out of the address bar
// and history at once.
import { useEffect, useId, useState } from 'react';
import { message, type AuthSession } from '../api';
import { enrolOptions, finishEnrol, signIn } from '../passkeys';
import { Field, Notice, PageHead } from '../ui';

export function takeToken(): string | null {
  const t = location.hash.slice(1);
  if (location.hash) history.replaceState(null, '', location.pathname);
  return /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
}

export function SignIn({ session, onSignedIn }: { session: AuthSession; onSignedIn: (s: AuthSession) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (session.mode === 'homerslab') {
    return (
      <main className="auth" id="main">
        <PageHead title="Keepsake" />
        <Notice title="Open Keepsake from HomersLab.">HomersLab signs you in; Keepsake has no sign-in of its own here.</Notice>
      </main>
    );
  }
  const go = async () => {
    setBusy(true); setError(null);
    try { onSignedIn(await signIn()); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return (
    <main className="auth" id="main">
      <PageHead title="Keepsake" sub="Wishes and celebrations for the family. The surprise stays a surprise." />
      <div className="stack">
        {session.setupNeeded && (
          <Notice title="Keepsake needs its first admin.">
            Open the setup link in the file <code>setup-link.txt</code> in Keepsake’s data folder. It works once, for 24 hours;
            restarting Keepsake makes a new one.
          </Notice>
        )}
        <button type="button" className="btn btn-primary btn-lg btn-block" onClick={go} aria-busy={busy} disabled={busy}>
          {busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
        </button>
        {error && <Notice kind="error">{error}</Notice>}
        <p className="hint">No passkey yet? An admin of the household makes you a link. An admin who lost every passkey asks whoever runs Keepsake for a recovery link (<code>keepsake recover</code>).</p>
      </div>
    </main>
  );
}

export function Enrol({ kind, token, onSignedIn }: { kind: 'setup' | 'enrol'; token: string | null; onSignedIn: (s: AuthSession) => void }) {
  const id = useId();
  const [name, setName] = useState('');
  const [label, setLabel] = useState('This device');
  const [invitee, setInvitee] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : 'This link is incomplete. Open the whole link again.');
  useEffect(() => {
    if (kind !== 'enrol' || !token) return;
    enrolOptions(token).then((s) => setInvitee(s.person.name), (e) => setError(message(e)));
  }, [kind, token]);
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setBusy(true); setError(null);
    try { onSignedIn(await finishEnrol(await enrolOptions(token, kind === 'setup' ? name.trim() : undefined), label.trim() || 'Passkey')); }
    catch (err) { setError(message(err)); } finally { setBusy(false); }
  };
  return (
    <main className="auth" id="main">
      <PageHead title={kind === 'setup' ? 'Set up Keepsake' : invitee ? `Welcome, ${invitee}` : 'Make your passkey'}
        sub={kind === 'setup' ? 'You become the household’s admin. Your passkey signs you in; there is no password.' : 'A passkey on this device signs you in; there is no password.'} />
      <form className="stack" onSubmit={go} noValidate>
        {kind === 'setup' && (
          <Field label="Your name" id={`${id}-n`} hint="As the family calls you.">
            <input className="input" id={`${id}-n`} value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoComplete="given-name" aria-describedby={`${id}-n-hint`} />
          </Field>
        )}
        <Field label="A name for this passkey" id={`${id}-l`}>
          <input className="input" id={`${id}-l`} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} autoComplete="off" />
        </Field>
        <button type="submit" className="btn btn-primary btn-lg btn-block" aria-busy={busy} disabled={busy || !token || (kind === 'setup' && !name.trim())}>
          {busy ? 'Waiting for your passkey…' : 'Create a passkey'}
        </button>
        {error && <Notice kind="error">{error}</Notice>}
      </form>
    </main>
  );
}
