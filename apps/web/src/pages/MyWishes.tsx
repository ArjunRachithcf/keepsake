// My wishes (spec §4, home): the next celebration, celebration chips filtering my list, "Add a wish for …" rows,
// suggestions for me, and kids' wishes waiting for me; after a celebration, my thank-yous (the givers who chose to be
// named) and the gifts I gave, where I choose to put my name on each (off by default).
import { useCallback, useEffect, useState } from 'react';
import { api, message, type Home, type Wish } from '../api';
import { celebrationLine, day, inDays } from '../format';
import { useHousehold } from '../household';
import { Chips, Group, Link, Loading, Notice, PageHead, Poster, Sheet, Switch } from '../ui';
import { WishForm, WishRow } from '../wish';

export function MyWishes() {
  const { me } = useHousehold();
  const [chip, setChip] = useState<string>('all');
  const [home, setHome] = useState<Home | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ wish?: Wish; for?: string | null } | null>(null);
  const [reorder, setReorder] = useState(false);

  const load = useCallback(async () => {
    try { setHome(await api<Home>(`/home${chip === 'all' ? '' : `?for=${encodeURIComponent(chip)}`}`)); setError(null); } catch (e) { setError(message(e)); }
  }, [chip]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <><PageHead title="My wishes" /><Notice kind="error" title="Keepsake did not answer.">{error}</Notice></>;
  if (!home) return <><PageHead title="My wishes" /><Loading /></>;

  const chips = [{ id: 'all', label: 'All' }, ...home.celebrations.map((c) => ({ id: c.id, label: c.name })), { id: 'any', label: 'Any time' }];
  const current = home.celebrations.find((c) => c.id === chip);
  const addFor = chip === 'all' ? home.next : current;
  const move = async (from: number, to: number) => {
    const ids = home.wishes.map((w) => w.id);
    const [x] = ids.splice(from, 1);
    ids.splice(to, 0, x!);
    try { await api(`/people/${me.id}/wish-order`, { method: 'PUT', body: { wishIds: ids } }); await load(); } catch (e) { setError(message(e)); }
  };
  const all = [...home.celebrations];

  return (
    <>
      <PageHead title="My wishes" action={
        <button type="button" className="btn btn-primary" onClick={() => setSheet({ for: current?.id ?? (chip === 'any' ? null : home.next?.id ?? null) })}>New wish</button>
      } />

      {home.next && (
        <Link to={`/celebrations/${home.next.id}`} className="next-card" aria-label={`${home.next.name} ${inDays(home.next.daysUntil)}, ${celebrationLine(home.next)}`}>
          <Poster poster={home.next.poster}>
            <p className="next-eyebrow">Next</p>
            <p className="next-title">{home.next.name} {inDays(home.next.daysUntil)}</p>
            <p className="next-sub">{celebrationLine(home.next)}</p>
          </Poster>
        </Link>
      )}

      {home.suggestions.length > 0 && (
        <Group title="Suggested for you" footer="Someone thought you might like these. Say yes and they join your list.">
          {home.suggestions.map((w) => <WishRow key={w.id} wish={w} celebrations={all} onChanged={load} />)}
        </Group>
      )}
      {home.toApprove.length > 0 && (
        <Group title="Waiting for you" footer="Kids’ wishes and suggestions for them, until you say yes. Nobody else sees them yet.">
          {home.toApprove.map((w) => <WishRow key={w.id} wish={w} celebrations={all} onChanged={load} onEdit={(x) => setSheet({ wish: x })} />)}
        </Group>
      )}

      <div className="section">
        <Chips label="Show wishes for" value={chip} options={chips} onChange={(v) => { setChip(v); setReorder(false); }} />
      </div>

      <Group title={current ? `For ${current.name}` : chip === 'any' ? 'Any time' : 'All my wishes'}
        footer={current ? `Your ${current.name} list: these and your any-time wishes.` : 'What others get you stays a surprise: Keepsake never tells you who is getting what.'}>
        {home.wishes.length === 0 && <li className="row"><span className="row-sub">No wishes here yet.</span></li>}
        {home.wishes.map((w, i) => (
          <WishRow key={w.id} wish={w} celebrations={all} onChanged={load} onEdit={(x) => setSheet({ wish: x })} showFor={!current}
            move={reorder ? { up: i > 0 ? () => move(i, i - 1) : undefined, down: i < home.wishes.length - 1 ? () => move(i, i + 1) : undefined } : undefined} />
        ))}
        {addFor && (
          <li className="row">
            <button type="button" className="row-button" onClick={() => setSheet({ for: addFor.id })}>
              <span aria-hidden="true" className="plus">+</span> Add a wish for {addFor.name}
            </button>
          </li>
        )}
        {chip === 'any' && (
          <li className="row">
            <button type="button" className="row-button" onClick={() => setSheet({ for: null })}><span aria-hidden="true" className="plus">+</span> Add a wish for any time</button>
          </li>
        )}
      </Group>
      {chip === 'all' && home.wishes.length > 1 && (
        <p className="section"><button type="button" className="btn-text" aria-pressed={reorder} onClick={() => setReorder(!reorder)}>{reorder ? 'Done ordering' : 'Change the order'}</button></p>
      )}

      {home.thanks.length > 0 && (
        <Group title="Thank-yous" footer="Gifts you received. Givers who chose to put their name on one are here so you can thank them; the others stay a surprise.">
          {home.thanks.map((x) => (
            <li key={x.wish.id} className="row">
              <span className="row-title">{x.wish.name}</span>
              <span className="row-sub">{[x.celebration?.name, day(x.on)].filter(Boolean).join(' · ')}</span>
              <span className="row-foot">{x.from.length ? `From ${x.from.map((p) => p.name).join(', ')}` : 'From someone who kept it a surprise'}</span>
            </li>
          ))}
        </Group>
      )}
      {home.gave.length > 0 && (
        <Group title="Gifts you gave" footer="Put your name on a gift and its person sees it was you, to thank you. Off unless you turn it on.">
          {home.gave.map((x) => <GaveRow key={x.wish.id} wishId={x.wish.id} name={x.wish.name} line={[x.celebration?.name, day(x.on)].filter(Boolean).join(' · ')} named={x.named} onChanged={load} />)}
        </Group>
      )}

      {home.suggested.length > 0 && (
        <Group title="Your suggestions" footer="Waiting for a yes. You can change or take back a suggestion until then.">
          {home.suggested.map((w) => <WishRow key={w.id} wish={w} celebrations={all} onChanged={load} onEdit={(x) => setSheet({ wish: x })} />)}
        </Group>
      )}

      <Sheet title={sheet?.wish ? 'Change the wish' : 'New wish'} open={sheet !== null} onClose={() => setSheet(null)}>
        {sheet && <WishForm personId={sheet.wish?.personId ?? me.id} wish={sheet.wish} celebrations={all} initialFor={sheet.for}
          onDone={() => { setSheet(null); void load(); }} />}
      </Sheet>
    </>
  );
}

function GaveRow({ wishId, name, line, named, onChanged }: { wishId: string; name: string; line: string; named: boolean; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const set = async (v: boolean) => {
    setError(null);
    try { await api(`/wishes/${wishId}/named`, { method: 'PUT', body: { named: v } }); onChanged(); } catch (e) { setError(message(e)); }
  };
  return (
    <li className="row">
      <span className="row-title">{name}</span>
      <span className="row-sub">{line}</span>
      <Switch label="Put my name on it" checked={named} onChange={set} />
      {error && <p className="row-error" role="alert">{error}</p>}
    </li>
  );
}
