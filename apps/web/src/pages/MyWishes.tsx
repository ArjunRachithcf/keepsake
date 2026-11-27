// My wishes (spec §4, home): the next celebration, what is new, questions waiting for my answer (Answer, Add a wish
// instead), suggestions for me and kids' wishes waiting for me; celebration chips filtering my list, "Add a wish for …"
// rows; after a celebration, my thank-yous (the givers who chose to be named) and the gifts I gave, where I choose to
// put my name on each (off by default). On a desktop the list is the left column, the rest beside it.
import { useCallback, useEffect, useState } from 'react';
import { api, message, type Home, type Wish } from '../api';
import { celebrationLine, day, inDays } from '../format';
import { useHousehold } from '../household';
import { Icon } from '../icons';
import { useRows } from '../motion';
import { AccountButton } from '../account';
import { AddRow, Chips, Group, IconButton, Link, Loading, Notice, PageHead, Poster, Sheet, Switch, TopLine } from '../ui';
import { WishForm, WishRow } from '../wish';
import { HomeQuestions } from '../questions';
import { NoticesGroup, ThankYou } from '../notify';

export function MyWishes() {
  const { me, name } = useHousehold();
  const [chip, setChip] = useState<string>('all');
  const [home, setHome] = useRows<Home>();
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ wish?: Wish; for?: string | null } | null>(null);
  const [reorder, setReorder] = useState(false);

  const [loaded, setLoaded] = useState(0);
  const load = useCallback(async () => {
    setLoaded((n) => n + 1);
    try { setHome(await api<Home>(`/home${chip === 'all' ? '' : `?for=${encodeURIComponent(chip)}`}`)); setError(null); } catch (e) { setError(message(e)); }
  }, [chip, setHome]);
  useEffect(() => { void load(); }, [load]);

  const newWish = () => setSheet({ for: home ? (home.celebrations.find((c) => c.id === chip)?.id ?? (chip === 'any' ? null : home.next?.id ?? null)) : null });
  const top = <TopLine end={<><IconButton icon="plus" label="New wish" onClick={newWish} /><AccountButton /></>} />;
  if (error && !home) return <>{top}<PageHead title="My wishes" /><Notice kind="error" title="Keepsake did not answer.">{error}</Notice></>;
  if (!home) return <>{top}<PageHead title="My wishes" /><Loading /></>;

  const chips = [{ id: 'all', label: 'All' }, ...home.celebrations.map((c) => ({ id: c.id, label: c.name, poster: c.poster })), { id: 'any', label: 'Any time' }];
  const current = home.celebrations.find((c) => c.id === chip);
  const addFor = chip === 'all' ? home.next : current;
  const move = async (from: number, to: number) => {
    const ids = home.wishes.map((w) => w.id);
    const [x] = ids.splice(from, 1);
    ids.splice(to, 0, x!);
    try { await api(`/people/${me.id}/wish-order`, { method: 'PUT', body: { wishIds: ids } }); await load(); } catch (e) { setError(message(e)); }
  };
  const all = [...home.celebrations];
  const n = home.wishes.length;

  return (
    <>
      {top}
      <PageHead title="My wishes" wideSub sub="What others get you stays a surprise: Keepsake never tells you who is getting what."
        actions={<button type="button" className="btn btn-primary" onClick={newWish}><Icon name="plus" />New wish</button>} />
      {error && <Notice kind="error">{error}</Notice>}

      <div className="ks-two">
        <div>
          <Chips label="Show my wishes for" value={chip} options={chips} onChange={(v) => { setChip(v); setReorder(false); }} />
          <Group title={`${current ? `For ${current.name}` : chip === 'any' ? 'Any time' : 'All my wishes'} · ${n}`}
            head={chip === 'all' && n > 1 ? <button type="button" className="btn btn-plain" aria-pressed={reorder} onClick={() => setReorder(!reorder)}>{reorder ? 'Done' : 'Change the order'}</button> : undefined}
            footer={current ? `Your ${current.name} list: these and your any-time wishes.` : 'A wish for a celebration shows on that list; an any-time wish shows on every list.'}>
            {n === 0 && <li className="row"><span className="row-sub">No wishes here yet.</span></li>}
            {home.wishes.map((w, i) => (
              <WishRow key={w.id} wish={w} celebrations={all} onChanged={load} onEdit={(x) => setSheet({ wish: x })} showFor={!current}
                move={reorder ? { up: i > 0 ? () => void move(i, i - 1) : undefined, down: i < n - 1 ? () => void move(i, i + 1) : undefined } : undefined} />
            ))}
            {addFor && <AddRow label={`Add a wish for ${addFor.name}`} onClick={() => setSheet({ for: addFor.id })} />}
            {chip === 'any' && <AddRow label="Add a wish for any time" onClick={() => setSheet({ for: null })} />}
          </Group>

          {home.thanks.length > 0 && (
            <Group title="Thank-yous" footer="Gifts you received (and your kids’). Givers who chose to put their name on one are here so you can thank them; the others stay a surprise.">
              {home.thanks.map((x) => (
                <li key={x.wish.id} className="row is-top" data-row={`t-${x.wish.id}`}>
                  <span className="row-main">
                    <span className="row-title wrap">{x.wish.name}</span>
                    <span className="row-sub wrap">{[x.wish.personId === me.id ? null : `For ${name(x.wish.personId)}`, x.celebration?.name, day(x.on)].filter(Boolean).join(' · ')}</span>
                    <span className="row-note">{x.from.length ? `From ${x.from.map((p) => p.name).join(', ')}` : 'From someone who kept it a surprise'}</span>
                    <ThankYou thanks={x} onChanged={load} />
                  </span>
                </li>
              ))}
            </Group>
          )}
          {home.thanked.length > 0 && (
            <Group title="Thanked by" footer="Thank-yous for gifts you gave.">
              {home.thanked.map((x) => (
                <li key={x.id} className="row is-top">
                  <span className="row-main">
                    <span className="row-title wrap">{x.from?.name ?? 'Someone'}: “{x.text}”</span>
                    <span className="row-sub wrap">{[x.wish.name, day(x.on), x.by ? `written by ${x.by.name}` : null].filter(Boolean).join(' · ')}</span>
                  </span>
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
        </div>

        <div className="is-first-on-phone">
          {home.next && (
            <Link to={`/celebrations/${home.next.id}`} className="next-card" aria-label={`${home.next.name} ${inDays(home.next.daysUntil)}, ${celebrationLine(home.next)}${home.next.draw?.mine === 'ready' ? ', your draw is ready to open' : ''}`}>
              <Poster poster={home.next.poster}>
                <p className="poster-eyebrow">Next</p>
                <p className="next-title">{home.next.name} {inDays(home.next.daysUntil)}</p>
                <p className="poster-sub">{celebrationLine(home.next)}{home.next.draw?.mine === 'ready' ? ' · your draw is ready to open' : ''}</p>
              </Poster>
            </Link>
          )}
          <NoticesGroup refresh={loaded} />
          <HomeQuestions questions={home.questions} meId={me.id} celebrations={home.celebrations} onChanged={load} />
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
        </div>
      </div>

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
    <li className="row is-top" data-row={`g-${wishId}`}>
      <span className="row-main">
        <span className="row-title wrap">{name}</span>
        <span className="row-sub">{line}</span>
        <span style={{ marginTop: 8 }}><Switch label="Put my name on it" hint={named ? 'On: they see it was you.' : 'Off: it stays a surprise who gave it.'} checked={named} onChange={(v) => void set(v)} /></span>
        {error && <span className="row-error" role="alert">{error}</span>}
      </span>
    </li>
  );
}
