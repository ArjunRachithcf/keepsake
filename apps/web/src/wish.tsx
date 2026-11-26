// A wish as a row (with a giver's actions when the server sent its gifts: gift.tsx), and the sheet's form to add or
// change one (spec §4 "New wish": what, link, price, how many, For, most wanted, note).
import { useId, useState } from 'react';
import { api, message, type Celebration, type LinkPreview, type Wish, type WishInput, type WishPatch } from './api';
import { host, money, parseMoney, toMoneyText } from './format';
import { GiftLine, isBought } from './gift';
import { useHousehold } from './household';
import { Star } from './icons';
import { Field, Notice, Switch, useConfirm, useBusy } from './ui';

const STATE_LABEL: Record<Wish['state'], string | null> = { listed: null, awaiting_parent: 'Waiting for a parent', suggested: 'Suggestion' };

export function WishRow({ wish, celebrations, onEdit, onChanged, showFor = true, move, guest }: {
  wish: Wish; celebrations: Celebration[]; onEdit?: (w: Wish) => void; onChanged: () => void; showFor?: boolean;
  move?: { up?: () => void; down?: () => void };
  /** On the guest page: a guest's claims go to /guest/wishes/…, and there are no group gifts to start. */
  guest?: boolean;
}) {
  const { household, name } = useHousehold();
  const [busy, guard] = useBusy();
  const [error, setError] = useState<string | null>(null);
  const forName = wish.celebrationId ? celebrations.find((c) => c.id === wish.celebrationId)?.name ?? 'A celebration' : 'Any time';
  const grp = wish.gift?.group;
  const meta = [
    wish.priceMinor !== null && household.currency ? money(wish.priceMinor, household.currency) : null,
    wish.quantity > 1 ? `${wish.quantity} wanted` : null,
    showFor ? forName : null,
    wish.link ? host(wish.link) : null,
    grp ? `a group gift${grp.givers.length ? ` · ${grp.givers.length} chipping in` : ''}` : null,
    wish.addedBy && wish.state !== 'suggested' ? `${wish.addedBy.name} added it` : null,
    wish.addedBy && wish.state === 'suggested' ? `${name(wish.addedBy.id)} suggested it for ${name(wish.personId).replace(/^You$/, 'you')}` : null,
  ].filter(Boolean).join(' · ');
  const act = async (what: 'approve' | 'decline') => {
    if (!guard.start()) return; setError(null);
    try { await api(`/wishes/${wish.id}/${what}`, { method: 'POST' }); onChanged(); } catch (e) { setError(message(e)); } finally { guard.end(); }
  };
  const state = STATE_LABEL[wish.state];
  const edit = wish.canEdit && onEdit;
  const own = Boolean(wish.link || wish.canApprove || move);
  return (
    <li className="row ks-wish" data-row={wish.id}>
      <span className="row-main">
        <span className={`row-title${isBought(wish.gift) ? ' is-done' : ''}`}>
          {wish.mostWanted && <Star />}{wish.name}
          {state && <span className="badge">{state}</span>}
        </span>
        {meta && <span className="row-sub">{meta}</span>}
        {wish.note && <span className="row-note">{wish.note}</span>}
        {wish.gift && <GiftLine wish={wish} onChanged={onChanged} guest={guest} />}
        {error && <span className="row-error" role="alert">{error}</span>}
        {own && (
          <span className="ks-wish-actions">
            {wish.link && <a className="btn btn-sm" href={wish.link} target="_blank" rel="noopener noreferrer">Open<span className="sr-only"> the link for {wish.name} (another site)</span></a>}
            {wish.canApprove && <>
              <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act('approve')}>Approve<span className="sr-only"> {wish.name}</span></button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act('decline')}>Decline<span className="sr-only"> {wish.name}</span></button>
            </>}
            {move && <>
              <button type="button" className="btn btn-sm btn-icon" disabled={!move.up} onClick={move.up} aria-label={`Move ${wish.name} up`}>↑</button>
              <button type="button" className="btn btn-sm btn-icon" disabled={!move.down} onClick={move.down} aria-label={`Move ${wish.name} down`}>↓</button>
            </>}
          </span>
        )}
      </span>
      {edit && <span className="row-trail"><button type="button" className="btn btn-sm" onClick={() => onEdit(wish)}>Edit<span className="sr-only"> {wish.name}</span></button></span>}
    </li>
  );
}

/** Add a wish for `personId` (yourself, a kid you manage, or a suggestion), or change `wish`. */
export function WishForm({ personId, wish, celebrations, initialFor, onDone, answering }: {
  personId: string; wish?: Wish; celebrations: Celebration[]; initialFor?: string | null; onDone: () => void;
  /** "Add a wish instead": the new wish answers this question. */
  answering?: string;
}) {
  const { household, me, person, name: nameOf } = useHousehold();
  const ask = useConfirm();
  const id = useId();
  const currency = household.currency;
  const [name, setName] = useState(wish?.name ?? '');
  const [link, setLink] = useState(wish?.link ?? '');
  const [price, setPrice] = useState(toMoneyText(wish?.priceMinor ?? null, currency));
  const [quantity, setQuantity] = useState(String(wish?.quantity ?? 1));
  const [forId, setForId] = useState<string>(wish ? wish.celebrationId ?? '' : initialFor ?? '');
  const [mostWanted, setMostWanted] = useState(wish?.mostWanted ?? false);
  const [note, setNote] = useState(wish?.note ?? '');
  const [busy, guard] = useBusy();
  const [error, setError] = useState<string | null>(null);
  const forOptions = celebrations.filter((c) => c.people.includes(personId));
  const owner = person(personId);
  const mine = personId === me.id;
  const keeps = mine || (owner?.role === 'kid' && me.role !== 'kid' && (owner.managers.length ? owner.managers.includes(me.id) : me.role === 'admin'));
  const who = mine ? 'you' : nameOf(personId);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const priceMinor = currency ? parseMoney(price, currency) : null;
    if (priceMinor === undefined) return setError(`The price is a number, like 24 or 24.50.`);
    const q = Number(quantity);
    if (!Number.isInteger(q) || q < 1 || q > 99) return setError('How many: a whole number from 1 to 99.');
    const fields = {
      name: name.trim(), link: link.trim() || null, quantity: q, note: note.trim() || null, mostWanted,
      celebrationId: forId || null, ...(currency ? { priceMinor } : {}),
    } satisfies WishPatch;
    if (!guard.start()) return; setError(null);
    try {
      if (wish) await api(`/wishes/${wish.id}`, { method: 'PATCH', body: fields });
      else if (answering) await api(`/questions/${answering}/wish`, { method: 'POST', body: fields });
      else await api('/wishes', { method: 'POST', body: { ...fields, personId } satisfies WishInput });
      onDone();
    } catch (err) { setError(message(err)); } finally { guard.end(); }
  };
  /** "Add from a link" (ADR 0011): the server reads the shop's page; what it finds fills the empty fields, to check. */
  const [found, setFound] = useState<string | null>(null);
  const fill = async () => {
    if (!guard.start()) return; setError(null); setFound(null);
    try {
      const p = await api<LinkPreview>('/link-preview', { method: 'POST', body: { url: link.trim() } });
      if (p.name && !name.trim()) setName(p.name);
      if (p.priceMinor !== null && currency && !price.trim()) setPrice(toMoneyText(p.priceMinor, currency));
      setFound(p.name || p.pagePrice
        ? `From the page: ${[p.name, p.pagePrice ? money(p.pagePrice.amountMinor, p.pagePrice.currency) : null].filter(Boolean).join(', ')}. Check it before you save.`
        : 'The page did not say its name or price: type them in.');
    } catch (err) { setError(message(err)); } finally { guard.end(); }
  };
  const remove = async () => {
    if (!wish) return;
    if (!(await ask({ title: `Remove “${wish.name}”?`, body: 'It goes from every list it is on. This cannot be undone.', confirm: 'Remove', dismiss: 'Keep it', destructive: true }))) return;
    if (!guard.start()) return; setError(null);
    try { await api(`/wishes/${wish.id}`, { method: 'DELETE' }); onDone(); } catch (err) { setError(message(err)); } finally { guard.end(); }
  };

  return (
    <form onSubmit={save} noValidate>
      {!wish && !keeps && <Notice>{`A suggestion: ${nameOf(personId)} says yes or no before it is on their list.`}</Notice>}
      {!wish && mine && me.role === 'kid' && <Notice>A grown-up looks at it first, then everyone can see it.</Notice>}
      <Field label="What" id={`${id}-name`}>
        <input className="input" id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoComplete="off" />
      </Field>
      <Field label="Link to the shop" id={`${id}-link`} hint={household.addFromLink ? 'Optional. Keepsake keeps it as you type it; it reads the page only when you ask it to fill in the wish, from the shops this Keepsake knows.' : 'Optional. Keepsake keeps it as you type it and never opens it.'}>
        <input className="input" id={`${id}-link`} name="link" type="url" inputMode="url" value={link} onChange={(e) => setLink(e.target.value)} maxLength={2000}
          placeholder="https://" autoComplete="off" aria-describedby={`${id}-link-hint`} />
      </Field>
      {household.addFromLink && /^https:\/\//.test(link.trim()) && (
        <div className="btn-row"><button type="button" className="btn btn-sm" disabled={busy} onClick={() => void fill()}>Fill in from the link</button></div>
      )}
      {found && <p className="hint" role="status">{found}</p>}
      <div className="fields fields-2">
        {currency ? (
          <Field label={`Price (${currency})`} id={`${id}-price`} hint="Optional.">
            <input className="input" id={`${id}-price`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} autoComplete="off" aria-describedby={`${id}-price-hint`} />
          </Field>
        ) : <p className="hint">Prices come once an admin sets the household’s currency.</p>}
        <Field label="How many" id={`${id}-q`}>
          <input className="input" id={`${id}-q`} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
      </div>
      <Field label="For" id={`${id}-for`} hint={`A celebration ${who === 'you' ? 'you are' : `${who} is`} part of, or any time.`}>
        <select className="select" id={`${id}-for`} value={forId} onChange={(e) => setForId(e.target.value)} aria-describedby={`${id}-for-hint`}>
          {forOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          <option value="">Any time</option>
        </select>
      </Field>
      <Switch label="Most wanted" hint={mostWanted ? 'On: it shows with a star.' : 'Off: no star.'} checked={mostWanted} onChange={setMostWanted} />
      <Field label="Note" id={`${id}-note`} hint="Optional: a size, a colour, where to find it.">
        <textarea className="textarea" id={`${id}-note`} rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} aria-describedby={`${id}-note-hint`} />
      </Field>
      {error && <Notice kind="error">{error}</Notice>}
      <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy || !name.trim()} aria-busy={busy}>
        {wish ? 'Save' : answering ? 'Add it and answer' : keeps ? 'Add the wish' : 'Suggest it'}
      </button>
      {wish && <button type="button" className="btn btn-destructive btn-block" disabled={busy} onClick={() => void remove()}>Remove the wish</button>}
    </form>
  );
}
