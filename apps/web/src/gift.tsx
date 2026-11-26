// What a giver sees and does on someone's wish (spec §4, the person's page on the design canvas): "I'll get it",
// "Mark bought", "Anna is getting this", bought struck through, "Chip in" with a progress bar. Only a wish that comes
// with `gift` shows any of it, and the server sends `gift` to givers only, never to the wish's person or a kid.
import { useContext, useId, useState, type ReactNode } from 'react';
import { api, message, type Gift, type Wish } from './api';
import { money, parseMoney, toMoneyText } from './format';
import { HouseholdContext } from './household';
import { Field, Notice, Sheet } from './ui';

const names = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** Whether the row's title is struck through: someone bought it (or everything wanted is bought). */
export const isBought = (g: Gift | undefined) => Boolean(g && (g.group ? g.group.state !== 'open' : g.claims.length > 0 && g.left === 0 && g.claims.every((c) => c.state !== 'claimed')));

/**
 * `guest`: on the guest page (ADR 0009), where a guest claims through /guest/… and starts no group gift; the currency
 * then comes from `currency` (a guest has no household).
 */
export function GiftLine({ wish, onChanged, guest, currency }: { wish: Wish; onChanged: () => void; guest?: boolean; currency?: string | null }) {
  const g = wish.gift!;
  const open = wish.state === 'listed';
  const household = { currency: useContext(HouseholdContext)?.household.currency ?? currency ?? null };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'chip' | 'group' | null>(null);
  const cur = household.currency;
  const call = async (path: string, method: string, body?: unknown) => {
    setBusy(true); setError(null);
    try { await api(`${guest ? '/guest' : ''}/wishes/${wish.id}${path}`, { method, body }); onChanged(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const mine = g.claims.find((c) => c.mine);
  const others = g.claims.filter((c) => !c.mine);
  // A guest is marked as one, with their link's label (review M2); an imported reservation is nobody's.
  const who = (c: Gift['claims'][number]) => c.giver?.name
    ?? (c.guest ? `${c.guest.name} (guest${c.guest.label !== c.guest.name ? `: ${c.guest.label}` : ''})` : c.imported ? 'An imported reservation' : 'Someone');
  const admin = useContext(HouseholdContext)?.household.me.role === 'admin';
  const lines: string[] = [];
  if (mine) lines.push(mine.state === 'claimed' ? 'You’re getting this' : mine.state === 'bought' ? 'You bought this' : 'You gave this');
  const getting = others.filter((c) => c.state === 'claimed').map(who);
  const bought = others.filter((c) => c.state !== 'claimed').map(who);
  if (getting.length) lines.push(`${names(getting)} ${getting.length > 1 ? 'are' : 'is'} getting this`);
  if (bought.length) lines.push(`${names(bought)} bought this`);
  if (wish.quantity > 1 && !g.group && g.claimed > 0) lines.push(`${g.claimed} of ${wish.quantity} claimed`);

  const grp = g.group;
  // Enough or not, never a total (ADR 0003: with two sharers it would give the other's amount).
  const pct = !grp ? 0 : grp.enough ? 100 : Math.min(100, Math.round(((grp.myShareMinor ?? 0) / grp.targetMinor) * 100));
  const who2 = grp ? grp.givers.map((x) => (x.mine ? 'you' : x.giver?.name ?? 'someone')) : [];
  const grpText = grp && cur ? `${grp.enough ? 'Enough' : 'Not enough yet'} for ${money(grp.targetMinor, cur)}${who2.length ? ` · ${who2.some((x) => x === 'you') ? names(who2) : `${names(who2)} chipped in`}` : ''}` : '';

  return (
    <div className="gift">
      {grp ? (
        <>
          <div className="gift-bar" role="progressbar" aria-label={`${wish.name}: chipped in`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span style={{ width: `${pct}%` }} />
          </div>
          <p className="gift-note">{grpText}{grp.state !== 'open' ? ` · ${grp.state === 'bought' ? 'bought' : 'given'}` : ''}</p>
          {grp.myShareMinor !== null && cur && <p className="gift-note gift-mine">Your share: {money(grp.myShareMinor, cur)}</p>}
        </>
      ) : lines.map((l) => <p key={l} className={`gift-note${l.startsWith('You') ? ' gift-mine' : ''}`}>{l}</p>)}
      {error && <p className="row-error" role="alert">{error}</p>}
      {open && <div className="gift-actions">
        {!grp && !mine && g.left > 0 && <Pill accent disabled={busy} onClick={() => call('/claim', 'PUT', { quantity: 1 })} label={wish.name}>I’ll get it</Pill>}
        {!grp && mine && wish.quantity > 1 && mine.state !== 'given' && g.left > 0 && <Pill disabled={busy} onClick={() => call('/claim', 'PUT', { quantity: mine.quantity + 1 })}>One more</Pill>}
        {mine && mine.state !== 'given' && (
          <Pill done={mine.state === 'bought'} pressed={mine.state === 'bought'} disabled={busy} label={wish.name}
            onClick={() => call('/claim', 'PATCH', { state: mine.state === 'bought' ? 'claimed' : 'bought' })}>{mine.state === 'bought' ? 'Bought' : 'Mark bought'}</Pill>
        )}
        {mine?.state === 'bought' && <Pill disabled={busy} onClick={() => call('/claim', 'PATCH', { state: 'given' })}>Given</Pill>}
        {mine?.state === 'given' && !g.mine?.over && <Pill disabled={busy} onClick={() => call('/claim', 'PATCH', { state: 'bought' })}>Not given yet</Pill>}
        {mine?.state === 'claimed' && <Pill disabled={busy} onClick={() => call('/claim', 'DELETE')}>Not me after all</Pill>}
        {!guest && admin && g.claims.some((c) => c.imported) && (
          <Pill disabled={busy} label={wish.name} onClick={() => { if (confirm('Release the reservation that came with the sheet? Anyone may then get it.')) void call('/imported-claim', 'DELETE'); }}>Release the imported reservation</Pill>
        )}
        {!guest && !grp && g.claims.length === 0 && cur && <Pill disabled={busy} onClick={() => setSheet('group')}>Make it a group gift</Pill>}
        {!guest && grp?.state === 'open' && <Pill accent disabled={busy} onClick={() => setSheet('chip')} label={wish.name}>{grp.myShareMinor === null ? 'Chip in' : 'Change my share'}</Pill>}
        {grp?.state === 'open' && grp.myShareMinor !== null && <Pill disabled={busy} onClick={() => call('/group/share', 'DELETE')}>Take my share back</Pill>}
        {grp?.canManage && grp.state === 'open' && <Pill disabled={busy} onClick={() => call('/group', 'PATCH', { state: 'bought' })}>Mark bought</Pill>}
        {grp?.canManage && grp.state === 'bought' && <Pill disabled={busy} onClick={() => call('/group', 'PATCH', { state: 'given' })}>Given</Pill>}
        {grp?.canManage && grp.state !== 'open' && !g.mine?.over && <Pill disabled={busy} onClick={() => call('/group', 'PATCH', { state: 'open' })}>Open again</Pill>}
        {grp?.canManage && grp.state === 'open' && grp.givers.every((x) => x.mine) && <Pill disabled={busy} onClick={() => call('/group', 'DELETE')}>Not a group gift</Pill>}
      </div>}
      <Sheet title={sheet === 'chip' ? 'Chip in' : 'A group gift'} open={sheet !== null} onClose={() => setSheet(null)}>
        {sheet && cur && <AmountForm currency={cur} wish={wish} kind={sheet} onDone={() => { setSheet(null); onChanged(); }} />}
      </Sheet>
    </div>
  );
}

/** A 44 px button around a 32 px pill (the design canvas's "I'll get it", "Mark bought", "Chip in"). */
function Pill({ children, onClick, disabled, accent, done, pressed, label }: {
  children: ReactNode; onClick: () => void; disabled?: boolean; accent?: boolean; done?: boolean; pressed?: boolean; label?: string;
}) {
  return (
    <button type="button" className="pill" disabled={disabled} onClick={onClick} aria-pressed={pressed}>
      <span className={accent ? 'pill-accent' : done ? 'pill-done' : undefined}>{children}{label && <span className="sr-only">: {label}</span>}</span>
    </button>
  );
}

function AmountForm({ currency, wish, kind, onDone }: { currency: string; wish: Wish; kind: 'chip' | 'group'; onDone: () => void }) {
  const id = useId();
  const g = wish.gift!;
  const start = kind === 'chip' ? g.group?.myShareMinor ?? null : wish.priceMinor;
  const [text, setText] = useState(toMoneyText(start, currency));
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const minor = parseMoney(text, currency);
    if (!minor) return setError('An amount, like 30 or 30.50.');
    try {
      if (kind === 'chip') await api(`/wishes/${wish.id}/group/share`, { method: 'PUT', body: { amountMinor: minor } });
      else await api(`/wishes/${wish.id}/group`, { method: 'POST', body: { targetMinor: minor } });
      onDone();
    } catch (err) { setError(message(err)); }
  };
  return (
    <form className="stack" onSubmit={save} noValidate>
      <Notice>{kind === 'chip'
        ? 'The others giving see that you chipped in and the total, not how much you gave.'
        : `Everyone giving to them can chip in. They never see it.`}</Notice>
      <Field label={kind === 'chip' ? `Your share (${currency})` : `Target (${currency})`} id={`${id}-a`}>
        <input className="input" id={`${id}-a`} inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
      </Field>
      {error && <Notice kind="error">{error}</Notice>}
      <button type="submit" className="btn btn-primary btn-lg btn-block">{kind === 'chip' ? 'Chip in' : 'Start the group gift'}</button>
    </form>
  );
}
