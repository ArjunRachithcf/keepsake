// Guest links (ADR 0009) on the household's side: a share link to someone's wishes (the person or a kid's parent),
// a personal draw link for a cousin (the celebration's host), the open links you manage with Revoke, and a kid's
// waiting for a parent's yes. A new link's address is shown once: only its hash is kept.
import { useCallback, useEffect, useId, useState } from 'react';
import { api, message, type GuestLink, type GuestLinkMade, type GuestLinks } from './api';
import { day } from './format';
import { Group, Notice } from './ui';

/** The open links the caller manages, filtered (one person's, one celebration's, or all). */
export function LinksList({ title, filter, make, footer }: {
  title: string; filter?: (l: GuestLink) => boolean; footer?: string;
  /** Making a link: its field's label and where it goes. */
  make?: { label: string; field: 'label' | 'name'; url: string; button: string };
}) {
  const id = useId();
  const [links, setLinks] = useState<GuestLink[] | null>(null);
  const [made, setMade] = useState<GuestLinkMade | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<GuestLinks>('/links').then((l) => setLinks(l.links.filter(filter ?? (() => true))), (e) => setError(message(e))), [filter]);
  useEffect(() => { void load(); }, [load]);
  const run = async (f: () => Promise<unknown>) => { setError(null); try { await f(); await load(); } catch (e) { setError(message(e)); } };
  const what = (l: GuestLink) => [
    l.kind === 'share' ? `${l.person?.name ?? 'Someone'}’s wishes` : `${l.celebration?.name ?? 'A celebration'}’s draw`,
    l.guestName && l.guestName !== l.label ? `opened as ${l.guestName}` : null,
    l.lastDay ? `until ${day(l.lastDay)}` : null,
    l.approved ? null : 'waiting for a parent',
  ].filter(Boolean).join(' · ');
  return (
    <>
      <Group title={title} footer={footer}>
        {links?.length === 0 && <li className="row"><span className="row-sub">No links yet.</span></li>}
        {links?.map((l) => (
          <li key={l.id} className="row row-inline">
            <span className="row-text"><span className="row-title">{l.label}</span><span className="row-sub">{what(l)}</span></span>
            {l.canApprove && <button type="button" className="btn btn-sm btn-primary" onClick={() => void run(() => api(`/links/${l.id}/approve`, { method: 'POST' }))}>Allow<span className="sr-only"> {l.label}</span></button>}
            <button type="button" className="btn btn-sm btn-danger" onClick={() => { if (confirm(`Revoke the link for ${l.label}? It stops working at once.`)) void run(() => api(`/links/${l.id}`, { method: 'DELETE' })); }}>
              Revoke<span className="sr-only"> {l.label}</span>
            </button>
          </li>
        ))}
        {make && (
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
            <p>{made.link.approved ? 'Send it yourself. It is shown only now: Keepsake keeps no copy.' : 'A parent says yes before it opens anything. It is shown only now.'}</p>
            <input className="input link-url" readOnly value={made.url} aria-label={`Link for ${made.link.label}`} onFocus={(e) => e.target.select()} />
            {'clipboard' in navigator && <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(made.url)}>Copy</button>}
          </Notice>
        </div>
      )}
      {error && <div className="section"><Notice kind="error">{error}</Notice></div>}
    </>
  );
}

/** Someone's share links, on their page (for the person and a kid's parents). */
export function ShareLinks({ personId, name, self, kid }: { personId: string; name: string; self: boolean; kid: boolean }) {
  const filter = useCallback((l: GuestLink) => l.kind === 'share' && l.person?.id === personId, [personId]);
  return (
    <LinksList title="Shared by link" filter={filter}
      footer={`People outside the family see ${self ? 'your' : `${name}’s`} wishes by link and can say they’ll get one. ${self ? 'You' : name} never see${self ? '' : 's'} who.${kid && self ? ' A parent says yes to each link first.' : ''}`}
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
