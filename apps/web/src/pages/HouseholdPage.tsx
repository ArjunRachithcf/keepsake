// The household, for admins (spec §4, board 5b): the currency, the people (roles, kids' parents, one-time sign-in
// links shown right under whom they are for, signing out and resetting passkeys), every guest link, and the sheet's
// one-time import. Removing someone is on their own page (Family › their name › Remove).
import { useEffect, useId, useState, type ReactNode } from 'react';
import { api, ApiError, message, type Celebration, type OneTimeLink, type PasskeyReset, type Person } from '../api';
import { dateTime, weekdayDate } from '../format';
import { roleLabel, useHousehold } from '../household';
import { ImportWizard } from '../import';
import { LinksList } from '../links';
import { Avatar, Check, MadeLink, Notice, PageHead, TopLine, useConfirm } from '../ui';

function Sec({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="sec" aria-labelledby={id}>
      <div className="sec-head"><h2 id={id}>{title}</h2>{sub && <p>{sub}</p>}</div>
      <div className="sec-body">{children}</div>
    </section>
  );
}

export function HouseholdPage() {
  const { household, me, reload } = useHousehold();
  const ask = useConfirm();
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  /** What appears under one person's row: their new sign-in link, or what a reset is waiting for. */
  const [under, setUnder] = useState<{ person: string; link?: OneTimeLink; text?: string } | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Person['role']>('adult');
  const [currency, setCurrency] = useState(household.currency ?? '');
  const [links, setLinks] = useState<number | null>(null);
  const [celebrations, setCelebrations] = useState<Celebration[]>([]);
  const standalone = household.mode === 'standalone';
  useEffect(() => { api<{ upcoming: Celebration[] }>('/celebrations').then((c) => setCelebrations(c.upcoming), () => undefined); }, []);
  useEffect(() => { api<{ links: unknown[] }>('/links').then((l) => setLinks(l.links.length), () => undefined); }, []);
  const run = async (f: () => Promise<unknown>) => {
    setError(null);
    try { await f(); await reload(); } catch (e) { setError(message(e)); }
  };
  const grownUps = household.people.filter((p) => p.role !== 'kid');

  /** Adds someone; a name like a guest's by link is asked about first (their claims would read alike). */
  const add = async () => {
    const n = name.trim();
    try {
      await api('/people', { method: 'POST', body: { name: n, role } });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409 && e.message.startsWith('a guest by link has that name'))) throw e;
      if (!(await ask({ title: `Add ${n} anyway?`, body: `A guest by link is called ${n} too, so their claims would read alike.`, confirm: `Add ${n}`, dismiss: 'Change the name' }))) return;
      await api('/people', { method: 'POST', body: { name: n, role, confirmName: true } });
    }
    setName('');
  };
  const signOutDevices = async (p: Person) => {
    if (!(await ask({ title: `Sign ${p.name} out on every device?`, body: 'Their passkeys stay: they sign in again with one.', confirm: 'Sign out', dismiss: 'Not now' }))) return;
    void run(() => api(`/people/${p.id}/sessions/end`, { method: 'POST' }));
  };
  const reset = async (p: Person) => {
    if (!(await ask({
      title: `Reset ${p.name}’s passkeys?`,
      body: `For when they lost every device. ${p.name} is told at once and can call it off. Their passkeys go and they are signed out everywhere an hour after another admin says yes too (or a day from now); then you send them a new sign-in link.`,
      confirm: 'Reset passkeys', dismiss: 'Not now', destructive: true,
    }))) return;
    void run(async () => {
      setUnder(null);
      const r = await api<PasskeyReset>(`/people/${p.id}/passkeys/reset`, { method: 'POST' });
      if (r.state === 'done') { setUnder({ person: p.id, link: await api<OneTimeLink>(`/people/${p.id}/invites`, { method: 'POST' }) }); return; }
      const from = r.notBefore ? dateTime(r.notBefore) : 'tomorrow';
      setUnder({ person: p.id, text: r.waitsFor === 'an_hour'
        ? `${r.approvedBy?.name ?? 'Another admin'} said yes: press Reset passkeys again from ${from} to reset them. ${p.name} is told, and can call it off until then.`
        : `Asked: press Reset passkeys again from ${from} to reset them, or sooner, an hour after another admin presses it too. ${p.name}, the other admins and the people of their draws are told; ${p.name} can call it off.` });
    });
  };

  return (
    <>
      <TopLine back={{ to: '/family', label: 'Family' }} />
      <PageHead title="Household" sub={`${household.people.length} ${household.people.length === 1 ? 'person' : 'people'}${links !== null ? `, ${links} guest ${links === 1 ? 'link' : 'links'}` : ''}. Only admins see this page.`} />
      {error && <Notice kind="error">{error}</Notice>}

      <div>
        <Sec title="Currency" sub="Every price in Keepsake is in it.">
          <ul className="group glass">
            <li className="row">
              <form className="row-form" onSubmit={(e) => { e.preventDefault(); void run(() => api('/household', { method: 'PATCH', body: { currency: currency.trim().toUpperCase() || null } })); }}>
                <label className="row-main" htmlFor={`${id}-cur`}><span className="row-title">Currency</span><span className="row-sub" id={`${id}-cur-hint`}>Three letters, like CHF, EUR or USD</span></label>
                <input className="input" style={{ width: 96, flex: 'none' }} id={`${id}-cur`} value={currency} maxLength={3} autoCapitalize="characters" onChange={(e) => setCurrency(e.target.value)} aria-describedby={`${id}-cur-hint`} />
                <button type="submit" className="btn btn-sm">Save</button>
              </form>
            </li>
          </ul>
        </Sec>

        <Sec title="People" sub={standalone ? 'Add someone, then make them a one-time sign-in link. It appears right where you made it.' : 'People and roles come from HomersLab. Kids’ parents are set here.'}>
          {standalone && (
            <ul className="group glass">
              <li className="row">
                <form className="row-form" onSubmit={(e) => { e.preventDefault(); void run(add); }}>
                  <label className="sr-only" htmlFor={`${id}-name`}>Name</label>
                  <input className="input" id={`${id}-name`} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" />
                  <label className="sr-only" htmlFor={`${id}-role`}>Role</label>
                  <select className="select" style={{ width: 140, height: 36, flex: 'none' }} id={`${id}-role`} value={role} onChange={(e) => setRole(e.target.value as Person['role'])}>
                    <option value="adult">Grown-up</option><option value="kid">Kid</option><option value="admin">Admin</option>
                  </select>
                  <button type="submit" className="btn btn-primary btn-sm" disabled={!name.trim()}>Add</button>
                </form>
              </li>
            </ul>
          )}
          <ul className="group glass lead-md">
            {household.people.map((p) => [
              <li className={`row row-wrap${p.role === 'kid' ? ' is-top' : ''}`} key={p.id} data-row={p.id}>
                <span className="row-lead"><Avatar id={p.id} name={p.name} /></span>
                <span className="row-main">
                  <span className="row-title">{p.id === me.id ? `${p.name} (you)` : p.name}</span>
                  <span className="row-sub">{roleLabel(p)}{standalone ? (p.signsIn === false ? ' · no passkey yet' : ' · signs in with a passkey') : ''}</span>
                  {p.role === 'kid' && (
                    <fieldset className="ks-checks" style={{ marginTop: 10 }}>
                      <legend className="row-sub wrap">Parents approve {p.name}’s wishes (none ticked: the admins)</legend>
                      <span className="ks-checks-row">
                        {grownUps.map((g) => (
                          <Check key={g.id} label={g.id === me.id ? `${g.name} (you)` : g.name} checked={p.managers.includes(g.id)} onChange={(on) => void run(() => api(`/people/${p.id}/managers`, {
                            method: 'PUT', body: { managerIds: on ? [...p.managers, g.id] : p.managers.filter((m) => m !== g.id) },
                          }))} />
                        ))}
                      </span>
                    </fieldset>
                  )}
                </span>
                {standalone && (
                  <span className="row-trail">
                    {p.signsIn === false && (
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => void run(async () => setUnder({ person: p.id, link: await api<OneTimeLink>(`/people/${p.id}/invites`, { method: 'POST' }) }))}>
                        Make a sign-in link<span className="sr-only"> for {p.name}</span>
                      </button>
                    )}
                    {p.id !== me.id && p.signsIn && <button type="button" className="btn btn-sm" onClick={() => void signOutDevices(p)}>Sign out their devices<span className="sr-only"> ({p.name})</span></button>}
                    {p.signsIn && p.role !== 'admin' && <button type="button" className="btn btn-sm" onClick={() => void reset(p)}>Reset passkeys<span className="sr-only"> ({p.name})</span></button>}
                  </span>
                )}
              </li>,
              under?.person === p.id && under.link ? (
                <MadeLink key={`${p.id}-link`} indented title={`A one-time link for ${p.name}`} url={under.link.url}>
                  <p>Send it to {p.name} yourself. It works once, until {weekdayDate(under.link.expiresAt)}.</p>
                </MadeLink>
              ) : under?.person === p.id && under.text ? (
                <li key={`${p.id}-asked`} className="ks-made is-indented" role="status"><p>{under.text}</p></li>
              ) : null,
            ])}
          </ul>
          <p className="group-foot">{standalone ? 'Remove someone from their own page: Family › their name › Remove.' : 'Someone leaves the household in HomersLab.'}</p>
        </Sec>

        <Sec title="Guest links" sub="Every share link and personal draw link but those to your own wishes. No address is shown again; revoking one stops it at once.">
          <LinksList plain title="Guest links" />
        </Sec>

        <Sec title="Import the sheet, once" sub="The “Gift List” tab saved as CSV. First a dry run: nothing is written until you import.">
          <ImportWizard celebrations={celebrations} />
        </Sec>
      </div>
    </>
  );
}
