// Guest links (ADR 0009) on the household's side: a share link to someone else's wishes (another grown-up; a kid's:
// a parent; never the person, since it shows what is taken), a personal draw link for a cousin (the celebration's
// host), and the links you made with New address (the same link, a new token: the way back for a guest locked out
// of the one device it opens on) and Revoke. A new link's address is shown to its maker once, right where it was made
// (under the field that made it, or under its row for a new address): only its hash is kept.
// Under HomersLab, guests cannot reach Keepsake yet (Homeward #317): no link is made there.
import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { api, message, type GuestLink, type GuestLinkMade, type GuestLinks } from './api';
import { day, numericDate } from './format';
import { HouseholdContext } from './household';
import { rows } from './motion';
import { Group, MadeLink, Notice, useConfirm } from './ui';

/** What to tell the maker of a link they have just been shown. */
function MadeWords({ made }: { made: GuestLinkMade }) {
  const l = made.link;
  return (
    <MadeLink title={`The link for ${l.label}`} url={made.url}>
      <p>Send it yourself. It opens on one device, and it is shown only now: Keepsake keeps no copy (New address makes another).</p>
      {l.person
        ? <p><strong>Don’t open it yourself, and never send it to {l.person.name}: it shows what has been taken, and once opened it opens nowhere else.</strong></p>
        : <p><strong>Don’t open it yourself, and never send it to anyone in the draw: it shows whom {l.label} drew and what is taken. Once opened it opens nowhere else.</strong></p>}
    </MadeLink>
  );
}

/** The open links the caller manages, filtered (one person's, one celebration's, or all). */
export function LinksList({ title, filter, make, footer, plain }: {
  title: string; filter?: (l: GuestLink) => boolean; footer?: string;
  /** In a section that names it already: the list without its own heading. */
  plain?: boolean;
  /** Making a link: its field's label and where it goes. */
  make?: { label: string; field: 'label' | 'name'; url: string; button: string };
}) {
  const id = useId();
  const ask = useConfirm();
  const homersLab = useContext(HouseholdContext)?.household.mode === 'homerslab';
  const [links, setLinks] = useState<GuestLink[] | null>(null);
  const shown = useRef(false);
  /** The address just made, and where: under a link's row (a new address) or under the field ('new'). */
  const [made, setMade] = useState<{ at: string; made: GuestLinkMade } | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const next = (await api<GuestLinks>('/links')).links.filter(filter ?? (() => true));
      if (shown.current) rows(() => setLinks(next)); else setLinks(next);
      shown.current = true;
    } catch (e) { setError(message(e)); }
  }, [filter]);
  useEffect(() => { void load(); }, [load]);
  const run = async (f: () => Promise<unknown>) => { setError(null); try { await f(); await load(); } catch (e) { setError(message(e)); } };
  const what = (l: GuestLink) => [
    l.kind === 'share' ? `${l.person?.name ?? 'Someone'}’s wishes` : `${l.celebration?.name ?? 'A celebration'}’s draw`,
    l.openedAt ? `opened ${day(l.openedAt)}${l.guestName && l.guestName !== l.label ? ` as ${l.guestName}` : ''}` : 'not opened yet',
    l.reissuedAt ? `new address ${day(l.reissuedAt)}${l.reissueCount > 1 ? ` (${l.reissueCount} so far)` : ''}` : null,
    l.revokedAt ? `revoked ${day(l.revokedAt)}` : l.lastDay ? `until ${numericDate(l.lastDay)}` : `made ${day(l.createdAt)}`,
  ].filter(Boolean).join(' · ');
  const address = async (l: GuestLink) => {
    if (!(await ask({ title: `A new address for ${l.label}?`, body: `The old one stops working at once, on every device. ${l.label} keeps everything done with it.`, confirm: 'Make a new address', dismiss: 'Not now' }))) return;
    void run(async () => setMade({ at: l.id, made: await api<GuestLinkMade>(`/links/${l.id}/address`, { method: 'POST' }) }));
  };
  const revoke = async (l: GuestLink) => {
    if (!(await ask({ title: `Revoke the link for ${l.label}?`, body: 'It stops working at once, on every device.', confirm: 'Revoke', dismiss: 'Keep it', destructive: true }))) return;
    void run(() => api(`/links/${l.id}`, { method: 'DELETE' }));
  };
  return (
    <>
      <Group title={plain ? undefined : title} label={plain ? title : undefined} footer={footer}>
        {links?.length === 0 && !make && <li className="row"><span className="row-sub">No links yet.</span></li>}
        {links?.map((l) => [
          <li key={l.id} className="row row-wrap" data-row={l.id}>
            <span className="row-main"><span className="row-title">{l.label}</span><span className="row-sub wrap">{what(l)}</span></span>
            {!l.revokedAt && (
              <span className="row-trail">
                <button type="button" className="btn btn-sm" onClick={() => void address(l)}>New address<span className="sr-only"> for {l.label}</span></button>
                <button type="button" className="btn btn-sm btn-destructive" onClick={() => void revoke(l)}>Revoke<span className="sr-only"> {l.label}</span></button>
              </span>
            )}
          </li>,
          made?.at === l.id ? <MadeWords key={`${l.id}-made`} made={made.made} /> : null,
        ])}
        {make && homersLab && <li className="row"><span className="row-sub wrap">Links for guests work once HomersLab lets guests in (Homeward #317). Until then nobody outside the household can open one.</span></li>}
        {make && !homersLab && (
          <li className="row">
            <form className="row-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { setMade({ at: 'new', made: await api<GuestLinkMade>(make.url, { method: 'POST', body: { [make.field]: text.trim() } }) }); setText(''); }); }}>
              <label className="sr-only" htmlFor={`${id}-l`}>{make.label}</label>
              <input className="input" id={`${id}-l`} maxLength={60} placeholder={make.label} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
              <button type="submit" className="btn btn-primary btn-sm" disabled={!text.trim()}>{make.button}</button>
            </form>
          </li>
        )}
        {made?.at === 'new' && <MadeWords made={made.made} />}
      </Group>
      {error && <Notice kind="error">{error}</Notice>}
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
      footer="Each guest draws with everyone, sees their own person’s list and can ask them a question. The link ends with the celebration’s day. Inviting after the draw draws the names again."
      make={{ label: 'The guest’s name', field: 'name', url: `/celebrations/${celebrationId}/guests`, button: 'Invite' }} />
  );
}
