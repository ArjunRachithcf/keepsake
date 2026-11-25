// Guest links (ADR 0009) on the household's side: a share link to someone else's wishes (another grown-up; a kid's:
// a parent; never the person, since it shows what is taken), a personal draw link for a cousin (the celebration's
// host), and the links you made with Revoke. A new link's address is shown to its maker once: only its hash is kept.
// Under HomersLab, guests cannot reach Keepsake yet (Homeward #317): no link is made there.
import { useCallback, useContext, useEffect, useId, useState } from 'react';
import { api, message, type GuestLink, type GuestLinkMade, type GuestLinks } from './api';
import { day } from './format';
import { HouseholdContext } from './household';
import { Group, Notice } from './ui';

/** The open links the caller manages, filtered (one person's, one celebration's, or all). */
export function LinksList({ title, filter, make, footer }: {
  title: string; filter?: (l: GuestLink) => boolean; footer?: string;
  /** Making a link: its field's label and where it goes. */
  make?: { label: string; field: 'label' | 'name'; url: string; button: string };
}) {
  const id = useId();
  const homersLab = useContext(HouseholdContext)?.household.mode === 'homerslab';
  const [links, setLinks] = useState<GuestLink[] | null>(null);
  const [made, setMade] = useState<GuestLinkMade | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<GuestLinks>('/links').then((l) => setLinks(l.links.filter(filter ?? (() => true))), (e) => setError(message(e))), [filter]);
  useEffect(() => { void load(); }, [load]);
  const run = async (f: () => Promise<unknown>) => { setError(null); try { await f(); await load(); } catch (e) { setError(message(e)); } };
  const what = (l: GuestLink) => [
    l.kind === 'share' ? `${l.person?.name ?? 'Someone'}’s wishes` : `${l.celebration?.name ?? 'A celebration'}’s draw`,
    l.openedAt ? `opened ${day(l.openedAt.slice(0, 10))}${l.guestName && l.guestName !== l.label ? ` as ${l.guestName}` : ''}` : 'not opened yet',
    l.revokedAt ? `revoked ${day(l.revokedAt.slice(0, 10))}` : l.lastDay ? `until ${day(l.lastDay)}` : `made ${day(l.createdAt.slice(0, 10))}`,
  ].filter(Boolean).join(' · ');
  return (
    <>
      <Group title={title} footer={footer}>
        {links?.length === 0 && <li className="row"><span className="row-sub">No links yet.</span></li>}
        {links?.map((l) => (
          <li key={l.id} className="row row-inline">
            <span className="row-text"><span className="row-title">{l.label}</span><span className="row-sub">{what(l)}</span></span>
            {!l.revokedAt && (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => { if (confirm(`Revoke the link for ${l.label}? It stops working at once.`)) void run(() => api(`/links/${l.id}`, { method: 'DELETE' })); }}>
                Revoke<span className="sr-only"> {l.label}</span>
              </button>
            )}
          </li>
        ))}
        {make && homersLab && <li className="row"><span className="row-sub">Links for guests work once HomersLab lets guests in (Homeward #317). Until then nobody outside the household can open one.</span></li>}
        {make && !homersLab && (
          <li className="row">
            <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { setMade(await api<GuestLinkMade>(make.url, { method: 'POST', body: { [make.field]: text.trim() } })); setText(''); }); }}>
              <label className="sr-only" htmlFor={`${id}-l`}>{make.label}</label>
              <input className="input" id={`${id}-l`} maxLength={60} placeholder={make.label} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
              <button type="submit" className="btn" disabled={!text.trim()}>{make.button}</button>
            </form>
          </li>
        )}
      </Group>
      {made && (
        <div className="section">
          <Notice title={`The link for ${made.link.label}`}>
            <p>Send it yourself. It is shown only now: Keepsake keeps no copy. Making a new one is the way to see one again.</p>
            <p>It opens on one device only: whoever opens it first keeps it, and the list here then says “opened”.</p>
            {made.link.person
              ? <p><strong>Don’t open it yourself, not even to try it, and never send it to {made.link.person.name}: it shows what has been taken, and once opened it opens nowhere else.</strong></p>
              : <p><strong>Don’t open it yourself, not even to try it, and never send it to anyone in the draw: it shows whom {made.link.label} drew and what is taken. If you are in the draw, you would see your own gifts. Once opened it opens nowhere else, so {made.link.label} would be told it was opened on another device.</strong></p>}
            <input className="input link-url" readOnly value={made.url} aria-label={`Link for ${made.link.label}`} onFocus={(e) => e.target.select()} />
            {'clipboard' in navigator && <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(made.url)}>Copy</button>}
          </Notice>
        </div>
      )}
      {error && <div className="section"><Notice kind="error">{error}</Notice></div>}
    </>
  );
}

/** Share links to someone else's wishes, on their page (another grown-up; for a kid, a parent): the ones you made. */
export function ShareLinks({ personId, name }: { personId: string; name: string }) {
  const filter = useCallback((l: GuestLink) => l.kind === 'share' && l.person?.id === personId, [personId]);
  return (
    <LinksList title="Shared by link" filter={filter}
      footer={`People outside the family see ${name}’s wishes by your link and can say they’ll get one, so nobody buys a thing twice. ${name} never sees the link or who.`}
      make={{ label: 'Who it is for (Godmother, the neighbours)', field: 'label', url: `/people/${personId}/links`, button: 'Make a link' }} />
  );
}

/** A celebration's personal draw links, for its host. */
export function DrawGuests({ celebrationId }: { celebrationId: string }) {
  const filter = useCallback((l: GuestLink) => l.kind === 'draw' && l.celebration?.id === celebrationId, [celebrationId]);
  return (
    <LinksList title="Cousins by link" filter={filter}
      footer="Each guest draws names with everyone, sees their own person’s list and can ask them a question. The link ends with the celebration’s day. Inviting after the draw draws the names again."
      make={{ label: 'The guest’s name', field: 'name', url: `/celebrations/${celebrationId}/guests`, button: 'Invite' }} />
  );
}
