// Family (spec §4): the grown-ups and the kids (with how many wishes wait for you); for admins, the household:
// people, roles, kids' managers, one-time links and the currency.
import { useEffect, useId, useState } from 'react';
import { api, message, type Home, type OneTimeLink, type Passkeys, type Person } from '../api';
import { roleLabel, useHousehold } from '../household';
import { Field, Group, Link, Notice, PageHead, Sheet } from '../ui';

export function Family({ onSignOut }: { onSignOut?: () => void }) {
  const { household, me } = useHousehold();
  const [waiting, setWaiting] = useState<Record<string, number>>({});
  const [manage, setManage] = useState(false);
  useEffect(() => {
    api<Home>('/home').then((h) => {
      const n: Record<string, number> = {};
      for (const w of h.toApprove) n[w.personId] = (n[w.personId] ?? 0) + 1;
      setWaiting(n);
    }, () => undefined);
  }, []);
  const grownUps = household.people.filter((p) => p.role !== 'kid');
  const kids = household.people.filter((p) => p.role === 'kid');
  const row = (p: Person) => (
    <li className="row" key={p.id}>
      <Link to={`/family/${p.id}`} className="row-link">
        <span className="avatar" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>
        <span className="row-text">
          <span className="row-title">{p.id === me.id ? `${p.name} (you)` : p.name}</span>
          <span className="row-sub">{roleLabel(p)}{waiting[p.id] ? ` · ${waiting[p.id]} to approve` : ''}</span>
        </span>
        <span className="chevron" aria-hidden="true">›</span>
      </Link>
    </li>
  );
  return (
    <>
      <PageHead title="Family" action={me.role === 'admin' ? <button type="button" className="btn" onClick={() => setManage(true)}>Household</button> : undefined} />
      <Group title="Grown-ups">{grownUps.map(row)}</Group>
      {kids.length > 0 && <Group title="Kids" footer="A kid’s new wish waits for a parent before anyone else sees it.">{kids.map(row)}</Group>}
      {onSignOut && <You onSignOut={onSignOut} />}
      <Sheet title="Household" open={manage} onClose={() => setManage(false)}>
        <ManageHousehold />
      </Sheet>
    </>
  );
}

function ManageHousehold() {
  const { household, me, reload } = useHousehold();
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ name: string; link: OneTimeLink } | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Person['role']>('adult');
  const [currency, setCurrency] = useState(household.currency ?? '');
  const standalone = household.mode === 'standalone';
  const run = async (f: () => Promise<unknown>) => {
    setError(null);
    try { await f(); await reload(); } catch (e) { setError(message(e)); }
  };
  const grownUps = household.people.filter((p) => p.role !== 'kid');
  return (
    <div className="stack">
      {error && <Notice kind="error">{error}</Notice>}
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(() => api('/household', { method: 'PATCH', body: { currency: currency.trim().toUpperCase() || null } })); }}>
        <Field label="Currency" id={`${id}-cur`} hint="Three letters (ISO 4217), like CHF, EUR or USD. Every price is in it.">
          <input className="input input-short" id={`${id}-cur`} value={currency} maxLength={3} autoCapitalize="characters" onChange={(e) => setCurrency(e.target.value)} aria-describedby={`${id}-cur-hint`} />
        </Field>
        <button type="submit" className="btn">Save the currency</button>
      </form>

      {standalone && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('/people', { method: 'POST', body: { name: name.trim(), role } }); setName(''); }); }}>
          <h3 className="sub-title">Add someone</h3>
          <Field label="Name" id={`${id}-name`}><input className="input" id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></Field>
          <Field label="Role" id={`${id}-role`}>
            <select className="input" id={`${id}-role`} value={role} onChange={(e) => setRole(e.target.value as Person['role'])}>
              <option value="adult">Grown-up</option><option value="kid">Kid</option><option value="admin">Admin</option>
            </select>
          </Field>
          <button type="submit" className="btn" disabled={!name.trim()}>Add</button>
        </form>
      )}
      {!standalone && <p className="hint">People and roles come from HomersLab. Kids’ parents are set here.</p>}

      <h3 className="sub-title">People</h3>
      <ul className="group">
        {household.people.map((p) => (
          <li className="row manage-row" key={p.id}>
            <p className="row-title">{p.name} <span className="row-sub">· {roleLabel(p)}{standalone && p.signsIn === false ? ' · no passkey yet' : ''}</span></p>
            {p.role === 'kid' && (
              <fieldset className="managers">
                <legend className="row-sub">Parents (they approve {p.name}’s wishes; none ticked: the admins)</legend>
                {grownUps.map((g) => (
                  <label key={g.id} className="check">
                    <input type="checkbox" checked={p.managers.includes(g.id)} onChange={(e) => void run(() => api(`/people/${p.id}/managers`, {
                      method: 'PUT', body: { managerIds: e.target.checked ? [...p.managers, g.id] : p.managers.filter((m) => m !== g.id) },
                    }))} /> {g.name}
                  </label>
                ))}
              </fieldset>
            )}
            {standalone && p.signsIn === false && (
              <button type="button" className="btn btn-sm" onClick={() => void run(async () => setLink({ name: p.name, link: await api<OneTimeLink>(`/people/${p.id}/invites`, { method: 'POST' }) }))}>
                Make a sign-in link<span className="sr-only"> for {p.name}</span>
              </button>
            )}
            {standalone && p.id !== me.id && p.signsIn && (
              <button type="button" className="btn btn-sm" onClick={() => { if (confirm(`Sign ${p.name} out on every device? Their passkeys stay.`)) void run(() => api(`/people/${p.id}/sessions/end`, { method: 'POST' })); }}>
                Sign out their devices<span className="sr-only"> ({p.name})</span>
              </button>
            )}
            {standalone && p.signsIn && p.role !== 'admin' && (
              <button type="button" className="btn btn-sm" onClick={() => {
                if (!confirm(`Lost every device? This removes ${p.name}’s passkeys and signs them out everywhere; then you send them a new sign-in link.`)) return;
                void run(async () => {
                  await api(`/people/${p.id}/passkeys/reset`, { method: 'POST' });
                  setLink({ name: p.name, link: await api<OneTimeLink>(`/people/${p.id}/invites`, { method: 'POST' }) });
                });
              }}>
                Reset passkeys<span className="sr-only"> ({p.name})</span>
              </button>
            )}
            {standalone && p.id !== me.id && (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => { if (confirm(`Remove ${p.name} and all their wishes?`)) void run(() => api(`/people/${p.id}`, { method: 'DELETE' })); }}>
                Remove<span className="sr-only"> {p.name}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
      {link && (
        <Notice title={`A one-time link for ${link.name}`}>
          <p>Send it to them yourself. It works once, until {new Date(link.link.expiresAt).toLocaleDateString()}.</p>
          <input className="input" readOnly value={link.link.url} aria-label={`Sign-in link for ${link.name}`} onFocus={(e) => e.target.select()} />
        </Notice>
      )}
    </div>
  );
}

/** Standalone: your passkeys (remove one: its sessions end; the last stays), another device, sign out, everywhere. */
function You({ onSignOut }: { onSignOut: () => void }) {
  const [link, setLink] = useState<OneTimeLink | null>(null);
  const [keys, setKeys] = useState<Passkeys['passkeys']>([]);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<Passkeys>('/me/passkeys').then((p) => setKeys(p.passkeys), (e) => setError(message(e)));
  useEffect(() => { void load(); }, []);
  const run = async (f: () => Promise<unknown>) => { setError(null); try { await f(); } catch (e) { setError(message(e)); } };
  return (
    <>
      <Group title="Your passkeys" footer="Removing one signs out the devices it signed in. Your last one stays.">
        {keys.map((k) => (
          <li className="row row-inline" key={k.id}>
            <span className="row-text">
              <span className="row-title">{k.label}</span>
              <span className="row-sub">{[k.lastUsedAt ? `used ${new Date(k.lastUsedAt).toLocaleDateString()}` : 'not used yet', k.invitedBy ? `from ${k.invitedBy}’s invite` : null].filter(Boolean).join(' · ')}</span>
            </span>
            {keys.length > 1 && (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => { if (confirm(`Remove the passkey “${k.label}”?`)) void run(async () => { await api(`/me/passkeys/${encodeURIComponent(k.id)}`, { method: 'DELETE' }); await load(); }); }}>
                Remove<span className="sr-only"> {k.label}</span>
              </button>
            )}
          </li>
        ))}
      </Group>
      <section className="section stack" aria-label="Your devices">
        <button type="button" className="btn btn-block" onClick={() => void run(async () => setLink(await api<OneTimeLink>('/me/passkeys/invite', { method: 'POST' })))}>Sign in on another device</button>
        {link && (
          <Notice title="A one-time link for your other device">
            <p>Open it there within 24 hours; it works once.</p>
            <input className="input" readOnly value={link.url} aria-label="Your one-time link" onFocus={(e) => e.target.select()} />
          </Notice>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        <button type="button" className="btn btn-block" onClick={onSignOut}>Sign out</button>
        <button type="button" className="btn btn-block btn-danger" onClick={() => { if (confirm('Sign out on every device, this one too?')) void run(async () => { await api('/me/sessions/end', { method: 'POST' }); onSignOut(); }); }}>Sign out everywhere</button>
      </section>
    </>
  );
}
