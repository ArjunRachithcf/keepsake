// What a giver sees and does on someone's wish (spec §4, the person's page on the design canvas): "I'll get it",
// "Mark bought", "Anna is getting this", bought struck through, a group gift with "Chip in". Only a wish that comes
// with `gift` shows any of it, and the server sends `gift` to givers only, never to the wish's person or a kid.
//
// A group gift shows only "Not enough yet" or "Enough" and your own share: never a bar, never a total (ADR 0003: with
// two sharers either would give away the other's amount).
import { useContext, useId, useState, type ReactNode } from 'react';
import { api, message, type Gift, type Wish } from './api';
import { money, parseMoney, toMoneyText } from './format';
import { HouseholdContext } from './household';
import { Field, Notice, Sheet, useConfirm, useBusy } from './ui';

const names = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** Whether the row's title is struck through: someone bought it (or everything wanted is bought). */
export const isBought = (g: Gift | undefined) => Boolean(g && (g.group ? g.group.state !== 'open' : g.claims.length > 0 && g.left === 0 && g.claims.every((c) => c.state !== 'claimed')));

/** What a group gift says, and all it says: whether it is enough, and your own share (never the total). */
export function groupWords(g: NonNullable<Gift['group']>, currency: string | null): { state: string; mine: string | null } {
  return {
    state: g.state === 'bought' ? 'Bought' : g.state === 'given' ? 'Given' : g.enough ? 'Enough' : 'Not enough yet',
    mine: g.myShareMinor !== null && currency ? `Your share ${money(g.myShareMinor, currency)}` : null,
  };
}

/**
 * `guest`: on the guest page (ADR 0009), where a guest claims through /guest/… and starts no group gift; the currency
 * then comes from `currency` (a guest has no household).
 */
export function GiftLine({ wish, onChanged, guest, currency }: { wish: Wish; onChanged: () => void; guest?: boolean; currency?: string | null }) {
  const g = wish.gift!;
  const open = wish.state === 'listed';
  const ctx = useContext(HouseholdContext);
  const cur = ctx?.household.currency ?? currency ?? null;
  const ask = useConfirm();
  const [busy, guard] = useBusy();
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'chip' | 'group' | null>(null);
  const call = async (path: string, method: string, body?: unknown) => {
    if (!guard.start()) return; setError(null);
    try { await api(`${guest ? '/guest' : ''}/wishes/${wish.id}${path}`, { method, body }); onChanged(); } catch (e) { setError(message(e)); } finally { guard.end(); }
  };
  const mine = g.claims.find((c) => c.mine);
  const others = g.claims.filter((c) => !c.mine);
  // A guest is marked as one, with their link's label (review M2); an imported reservation is nobody's.
  const who = (c: Gift['claims'][number]) => c.giver?.name
    ?? (c.guest ? `${c.guest.name} (guest${c.guest.label !== c.guest.name ? `: ${c.guest.label}` : ''})` : c.imported ? 'An imported reservation' : 'Someone');
  const admin = ctx?.household.me.role === 'admin';
  const lines: { text: string; mine: boolean }[] = [];
  if (mine) lines.push({ text: mine.state === 'claimed' ? 'You’re getting this' : mine.state === 'bought' ? 'You bought this' : 'You gave this', mine: true });
  const getting = others.filter((c) => c.state === 'claimed').map(who);
  const bought = others.filter((c) => c.state !== 'claimed').map(who);
  if (getting.length) lines.push({ text: `${names(getting)} ${getting.length > 1 ? 'are' : 'is'} getting this`, mine: false });
  if (bought.length) lines.push({ text: `${names(bought)} bought this`, mine: false });
  if (wish.quantity > 1 && !g.group && g.claimed > 0) lines.push({ text: `${g.claimed} of ${wish.quantity} claimed`, mine: false });

  const grp = g.group;
  const gw = grp ? groupWords(grp, cur) : null;
  const release = async () => {
    if (await ask({ title: 'Release the imported reservation?', body: 'It came with the sheet and is nobody’s here. Once released, anyone giving may get it.', confirm: 'Release it', dismiss: 'Keep it' })) void call('/imported-claim', 'DELETE');
  };

  return (
    <>
      {grp && gw ? (
        <span className="ks-group-state">
          <span className={`pill ${grp.enough || grp.state !== 'open' ? 'pill-green' : 'pill-orange'}`}>{gw.state}</span>
          {gw.mine && <span className="row-sub">{gw.mine}</span>}
        </span>
      ) : lines.map((l) => <span key={l.text} className={`ks-taken${l.mine ? '' : ' is-other'}`}>{l.text}</span>)}
      {error && <span className="row-error" role="alert">{error}</span>}
      {open && <span className="ks-wish-actions">
        {!grp && !mine && g.left > 0 && <Act primary disabled={busy} onClick={() => void call('/claim', 'PUT', { quantity: 1 })} label={wish.name}>I’ll get it</Act>}
        {!grp && mine && wish.quantity > 1 && mine.state !== 'given' && g.left > 0 && <Act disabled={busy} onClick={() => void call('/claim', 'PUT', { quantity: mine.quantity + 1 })}>One more</Act>}
        {mine && mine.state !== 'given' && (
          <Act pressed={mine.state === 'bought'} disabled={busy} label={wish.name}
            onClick={() => void call('/claim', 'PATCH', { state: mine.state === 'bought' ? 'claimed' : 'bought' })}>{mine.state === 'bought' ? 'Bought' : 'Mark bought'}</Act>
        )}
        {mine?.state === 'bought' && <Act disabled={busy} onClick={() => void call('/claim', 'PATCH', { state: 'given' })}>Given</Act>}
        {mine?.state === 'given' && !g.mine?.over && <Act disabled={busy} onClick={() => void call('/claim', 'PATCH', { state: 'bought' })}>Not given yet</Act>}
        {mine?.state === 'claimed' && <Act plain disabled={busy} onClick={() => void call('/claim', 'DELETE')}>Not me after all</Act>}
        {!guest && admin && g.claims.some((c) => c.imported) && <Act disabled={busy} label={wish.name} onClick={() => void release()}>Release the imported reservation</Act>}
        {!guest && !grp && g.claims.length === 0 && cur && <Act disabled={busy} onClick={() => setSheet('group')}>Make it a group gift</Act>}
        {!guest && grp?.state === 'open' && <Act primary={grp.myShareMinor === null} disabled={busy} onClick={() => setSheet('chip')} label={wish.name}>{grp.myShareMinor === null ? 'Chip in' : 'Change my share'}</Act>}
        {grp?.state === 'open' && grp.myShareMinor !== null && <Act plain disabled={busy} onClick={() => void call('/group/share', 'DELETE')}>Take my share back</Act>}
        {grp?.canManage && grp.state === 'open' && <Act disabled={busy} onClick={() => void call('/group', 'PATCH', { state: 'bought' })}>Mark bought</Act>}
        {grp?.canManage && grp.state === 'bought' && <Act disabled={busy} onClick={() => void call('/group', 'PATCH', { state: 'given' })}>Given</Act>}
        {grp?.canManage && grp.state !== 'open' && !g.mine?.over && <Act disabled={busy} onClick={() => void call('/group', 'PATCH', { state: 'open' })}>Open again</Act>}
        {grp?.canManage && grp.state === 'open' && grp.givers.every((x) => x.mine) && <Act plain disabled={busy} onClick={() => void call('/group', 'DELETE')}>Not a group gift</Act>}
      </span>}
      <Sheet title={sheet === 'chip' ? 'Chip in' : 'Make it a group gift'} sub={wish.name} open={sheet !== null} onClose={() => setSheet(null)}>
        {sheet && cur && <AmountForm currency={cur} wish={wish} kind={sheet} onDone={() => { setSheet(null); onChanged(); }} />}
      </Sheet>
    </>
  );
}

/** A giver's action on a wish ("I'll get it", "Mark bought", "Chip in"), named for its wish to a screen reader. */
function Act({ children, onClick, disabled, primary, plain, pressed, label }: {
  children: ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean; plain?: boolean; pressed?: boolean; label?: string;
}) {
  return (
    <button type="button" className={`btn btn-sm${primary ? ' btn-primary' : plain ? ' btn-plain' : ''}`} disabled={disabled} onClick={onClick} aria-pressed={pressed}>
      {children}{label && <span className="sr-only">: {label}</span>}
    </button>
  );
}

function AmountForm({ currency, wish, kind, onDone }: { currency: string; wish: Wish; kind: 'chip' | 'group'; onDone: () => void }) {
  const id = useId();
  const g = wish.gift!;
  const start = kind === 'chip' ? g.group?.myShareMinor ?? null : wish.priceMinor;
  const [text, setText] = useState(toMoneyText(start, currency));
  const [error, setError] = useState<string | null>(null);
  const [saving, guard] = useBusy();
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const minor = parseMoney(text, currency);
    if (!minor) return setError('An amount, like 30 or 30.50.');
    if (!guard.start()) return;
    try {
      if (kind === 'chip') await api(`/wishes/${wish.id}/group/share`, { method: 'PUT', body: { amountMinor: minor } });
      else await api(`/wishes/${wish.id}/group`, { method: 'POST', body: { targetMinor: minor } });
      onDone();
    } catch (err) { setError(message(err)); } finally { guard.end(); }
  };
  return (
    <form onSubmit={save} noValidate>
      <Notice>{kind === 'chip'
        ? 'The others giving see that you chipped in, never how much. Nobody sees the total, only whether it is enough.'
        : 'Everyone giving to them can chip in. They never see it.'}</Notice>
      <Field label={kind === 'chip' ? `Your share (${currency})` : `What it costs (${currency})`} id={`${id}-a`}>
        <input className="input" id={`${id}-a`} inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
      </Field>
      {error && <Notice kind="error">{error}</Notice>}
      <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={saving}>{kind === 'chip' ? 'Chip in' : 'Start the group gift'}</button>
    </form>
  );
}
