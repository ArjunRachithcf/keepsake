// A wish as a row (with a giver's actions when the server sent its gifts: gift.tsx), and the sheet to add or change one (spec §4 "New wish": name, link, price, For, most wanted, note).
import { useId, useState } from 'react';
import { api, message, type Celebration, type Wish, type WishInput, type WishPatch } from './api';
import { host, money, parseMoney, toMoneyText } from './format';
import { GiftLine, isBought } from './gift';
import { useHousehold } from './household';
import { Field, Notice, Switch } from './ui';

const STATE_LABEL: Record<Wish['state'], string | null> = { listed: null, awaiting_parent: 'Waiting for a parent', suggested: 'Suggestion' };

export function WishRow({ wish, celebrations, onEdit, onChanged, showFor = true, move }: {
  wish: Wish; celebrations: Celebration[]; onEdit?: (w: Wish) => void; onChanged: () => void; showFor?: boolean;
  move?: { up?: () => void; down?: () => void };
}) {
  const { household, name } = useHousehold();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const forName = wish.celebrationId ? celebrations.find((c) => c.id === wish.celebrationId)?.name ?? 'A celebration' : 'Any time';
  const meta = [
    wish.priceMinor !== null && household.currency ? money(wish.priceMinor, household.currency) : null,
    wish.quantity > 1 ? `${wish.quantity} wanted` : null,
    wish.link ? host(wish.link) : null,
    showFor ? forName : null,
    wish.addedBy && wish.state !== 'suggested' ? `${wish.addedBy.name} added it` : null,
    wish.addedBy && wish.state === 'suggested' ? `${name(wish.addedBy.id)} suggested it for ${name(wish.personId).replace(/^You$/, 'you')}` : null,
  ].filter(Boolean).join(' · ');
  const act = async (what: 'approve' | 'decline') => {
    setBusy(true); setError(null);
    try { await api(`/wishes/${wish.id}/${what}`, { method: 'POST' }); onChanged(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const state = STATE_LABEL[wish.state];
  return (
    <li className="row wish-row">
      <div className="wish-main">
        <p className={`row-title${isBought(wish.gift) ? ' row-title-done' : ''}`}>
          {wish.mostWanted && <span className="star" aria-label="Most wanted" role="img">★</span>}
          {wish.name}
        </p>
        {meta && <p className="row-sub">{meta}</p>}
        {wish.note && <p className="row-note">{wish.note}</p>}
        {state && <p className="badge">{state}</p>}
        {wish.gift && <GiftLine wish={wish} onChanged={onChanged} />}
        {error && <p className="row-error" role="alert">{error}</p>}
      </div>
      <div className="wish-actions">
        {wish.link && <a className="btn btn-sm" href={wish.link} target="_blank" rel="noopener noreferrer">Open<span className="sr-only"> the link for {wish.name} (another site)</span></a>}
        {wish.canApprove && <>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => act('approve')}>Approve<span className="sr-only"> {wish.name}</span></button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act('decline')}>Decline<span className="sr-only"> {wish.name}</span></button>
        </>}
        {wish.canEdit && onEdit && <button type="button" className="btn btn-sm" onClick={() => onEdit(wish)}>Edit<span className="sr-only"> {wish.name}</span></button>}
        {move && <>
          <button type="button" className="btn btn-sm btn-icon" disabled={!move.up} onClick={move.up} aria-label={`Move ${wish.name} up`}>↑</button>
          <button type="button" className="btn btn-sm btn-icon" disabled={!move.down} onClick={move.down} aria-label={`Move ${wish.name} down`}>↓</button>
        </>}
      </div>
    </li>
  );
}

/** Add a wish for `personId` (yourself, a kid you manage, or a suggestion), or change `wish`. */
export function WishForm({ personId, wish, celebrations, initialFor, onDone }: {
  personId: string; wish?: Wish; celebrations: Celebration[]; initialFor?: string | null; onDone: () => void;
}) {
  const { household, me, person, name: nameOf } = useHousehold();
  const id = useId();
  const currency = household.currency;
  const [name, setName] = useState(wish?.name ?? '');
  const [link, setLink] = useState(wish?.link ?? '');
  const [price, setPrice] = useState(toMoneyText(wish?.priceMinor ?? null, currency));
  const [quantity, setQuantity] = useState(String(wish?.quantity ?? 1));
  const [forId, setForId] = useState<string>(wish ? wish.celebrationId ?? '' : initialFor ?? '');
  const [mostWanted, setMostWanted] = useState(wish?.mostWanted ?? false);
  const [note, setNote] = useState(wish?.note ?? '');
  const [busy, setBusy] = useState(false);
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
    setBusy(true); setError(null);
    try {
      if (wish) await api(`/wishes/${wish.id}`, { method: 'PATCH', body: fields });
      else await api('/wishes', { method: 'POST', body: { ...fields, personId } satisfies WishInput });
      onDone();
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!wish || !confirm(`Remove “${wish.name}”? This cannot be undone.`)) return;
    setBusy(true); setError(null);
    try { await api(`/wishes/${wish.id}`, { method: 'DELETE' }); onDone(); } catch (err) { setError(message(err)); } finally { setBusy(false); }
  };

  return (
    <form className="stack" onSubmit={save} noValidate>
      {!wish && !keeps && <Notice>{`A suggestion: ${nameOf(personId)} says yes or no before it is on their list.`}</Notice>}
      {!wish && mine && me.role === 'kid' && <Notice>A grown-up looks at it first, then everyone can see it.</Notice>}
      <Field label="What" id={`${id}-name`}>
        <input className="input" id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoComplete="off" />
      </Field>
      <Field label="Link" id={`${id}-link`} hint="Optional. Keepsake keeps it as you type it and never opens it.">
        <input className="input" id={`${id}-link`} type="url" inputMode="url" value={link} onChange={(e) => setLink(e.target.value)} maxLength={2000}
          placeholder="https://" autoComplete="off" aria-describedby={`${id}-link-hint`} />
      </Field>
      {currency ? (
        <Field label={`Price (${currency})`} id={`${id}-price`} hint="Optional.">
          <input className="input" id={`${id}-price`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} autoComplete="off" aria-describedby={`${id}-price-hint`} />
        </Field>
      ) : <p className="hint">Prices come once an admin sets the household’s currency.</p>}
      <Field label="How many" id={`${id}-q`}>
        <input className="input input-short" id={`${id}-q`} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </Field>
      <Field label="For" id={`${id}-for`} hint={`A celebration ${who === 'you' ? 'you are' : `${who} is`} part of, or any time.`}>
        <select className="input" id={`${id}-for`} value={forId} onChange={(e) => setForId(e.target.value)} aria-describedby={`${id}-for-hint`}>
          {forOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          <option value="">Any time</option>
        </select>
      </Field>
      <Switch label="Most wanted" checked={mostWanted} onChange={setMostWanted} />
      <Field label="Note" id={`${id}-note`} hint="Optional: a size, a colour, where to find it.">
        <textarea className="input" id={`${id}-note`} rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} aria-describedby={`${id}-note-hint`} />
      </Field>
      {error && <Notice kind="error">{error}</Notice>}
      <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy || !name.trim()} aria-busy={busy}>
        {wish ? 'Save' : keeps ? 'Add the wish' : 'Suggest it'}
      </button>
      {wish && <button type="button" className="btn btn-danger btn-block" disabled={busy} onClick={remove}>Remove the wish</button>}
    </form>
  );
}
