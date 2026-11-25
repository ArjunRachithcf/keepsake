// A celebration's draw (spec §4, ADR 0004): the sealed card ("Open your draw", the spring reveal, hide again), their
// wishes and "Ask" (from M4), everyone's state ("4 of 6 opened their draw"), every pair after the reveal; and for the
// host, the draw's options (who draws, kids draw too, budget, draw together, who shouldn't draw whom, not last year's
// person, the reveal date or never), drawing and drawing again.
//
// The server sends a giver's person only to that giver, once they opened theirs. Hiding it again is this page's: the
// name is then not in the page at all, and after a reload the card starts hidden.
import { useCallback, useEffect, useId, useState } from 'react';
import { api, message, ApiError, type Celebration, type Draw, type DrawInput } from './api';
import { day, fractionDigits, money, parseMoney, toMoneyText } from './format';
import { useHousehold } from './household';
import { Field, Group, Link, Notice, Sheet, Switch } from './ui';
import { AskForm } from './questions';
import { DrawGuests } from './links';

const dateTimeFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
/** An instant as the datetime-local field shows it (the browser's own time zone). */
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
const dayAfter = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Whether the viewer runs this celebration's draw (its host; an admin when it has none or its host is now a kid; never a kid). */
export function useManagesDraw(c: Celebration): boolean {
  const { me, person } = useHousehold();
  const host = c.host ? person(c.host.id) : undefined;
  return me.role !== 'kid' && (host && host.role !== 'kid' ? host.id === me.id : me.role === 'admin');
}

/** "4 of 6 opened their draw", with a bar. Counts only: never who. */
function DrawState({ d }: { d: Draw }) {
  const pct = d.total ? Math.round((d.opened / d.total) * 100) : 0;
  return (
    <li className="row">
      <span className="row-title">{d.drawn ? `${d.opened} of ${d.total} opened their draw` : `${d.total} drawing names`}</span>
      {d.drawn && <div className="gift-bar" role="progressbar" aria-label="Opened their draw" aria-valuemin={0} aria-valuemax={d.total} aria-valuenow={d.opened}><span style={{ width: `${pct}%` }} /></div>}
      <span className="row-sub">{[...d.people.map((p) => p.name), ...d.guests.map((g) => `${g} (by link)`)].join(', ')}</span>
    </li>
  );
}

export function DrawSection({ celebration, onChanged }: { celebration: Celebration; onChanged: () => void }) {
  const { household } = useHousehold();
  const manages = useManagesDraw(celebration);
  const [d, setD] = useState<Draw | null | 'none'>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [ask, setAsk] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const url = `/celebrations/${celebration.id}/draw`;
  const load = useCallback(async () => {
    try { setD(await api<Draw>(url)); setError(null); } catch (e) {
      if (e instanceof ApiError && e.status === 404) setD('none'); else setError(message(e));
    }
  }, [url]);
  useEffect(() => { void load(); }, [load, celebration]);

  const act = async (f: () => Promise<Draw | undefined>) => {
    setBusy(true); setError(null);
    try { const next = await f(); if (next) setD(next); else await load(); onChanged(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const open = () => act(async () => {
    const next = await api<Draw>(`${url}/open`, { method: 'POST' });
    setRevealing(true); setShown(true);
    return next;
  });
  const run = (again: boolean) => {
    if (again && d && d !== 'none' && d.opened > 0 && !confirm('Draw the names again? Everyone’s person changes, and everyone opens theirs again.')) return;
    void act(() => api<Draw>(`${url}/run`, { method: 'POST' }));
  };
  const remove = () => {
    if (!confirm('Remove the draw? Whoever drew someone loses their person.')) return;
    void act(async () => { await api(url, { method: 'DELETE' }); setD('none'); return undefined; });
  };

  if (d === null && !error) return null;
  if (d === 'none' || d === null) {
    if (!manages || !celebration.upcoming) return error ? <div className="section"><Notice kind="error">{error}</Notice></div> : null;
    return (
      <div className="section">
        {error && <Notice kind="error">{error}</Notice>}
        <button type="button" className="btn btn-block" onClick={() => setSheet(true)}>Draw names for {celebration.name}</button>
        <Sheet title="Draw names" open={sheet} onClose={() => setSheet(false)}>
          <DrawForm celebration={celebration} onDone={() => { setSheet(false); void load(); onChanged(); }} />
        </Sheet>
      </div>
    );
  }

  const cur = household.currency;
  const mine = d.mine;
  const receiver = mine?.receiver ?? null;
  return (
    <>
      {mine && (
        <div className="section">
          {d.redrawnAt && !mine.opened && <Notice title="The names were drawn again">Your person may have changed: open yours again.</Notice>}
          <div className={`draw-card${shown && receiver ? ' draw-card-open' : ''}${revealing ? ' draw-card-reveal' : ''}`} onAnimationEnd={() => setRevealing(false)}>
            {!d.drawn && <><p className="draw-eyebrow">Your draw</p><p className="draw-title">Not drawn yet</p><p className="draw-sub">{celebration.host ? `${celebration.host.name} draws the names.` : 'The names are drawn soon.'}</p></>}
            {d.drawn && !mine.opened && !mine.canOpen && (
              <><p className="draw-eyebrow">Your draw is sealed</p><p className="draw-title">Opens together</p>
                <p className="draw-sub">{d.drawTogetherAt ? `Everyone opens theirs at once: ${dateTimeFmt.format(new Date(d.drawTogetherAt))}.` : 'Soon.'}</p></>
            )}
            {d.drawn && !mine.opened && mine.canOpen && (
              <><p className="draw-eyebrow">Your draw is ready</p><p className="draw-title">Who will it be?</p>
                <button type="button" className="btn btn-on-poster btn-lg" disabled={busy} onClick={open}>Open your draw</button></>
            )}
            {mine.opened && receiver && !shown && (
              <><p className="draw-eyebrow">Your draw</p><p className="draw-title">Sealed again</p>
                <button type="button" className="btn btn-on-poster btn-lg" onClick={() => { setShown(true); setRevealing(true); }}>Show your draw</button></>
            )}
            {mine.opened && receiver && shown && (
              <><p className="draw-eyebrow">You give to</p><p className="draw-title" aria-live="polite">{receiver.name}</p>
                {d.budgetMinor !== null && cur && <p className="draw-sub">Budget {money(d.budgetMinor, cur)}</p>}
                <button type="button" className="btn-text btn-text-on-poster" onClick={() => setShown(false)}>Hide again</button></>
            )}
            {mine.opened && !receiver && mine.unreadable && <><p className="draw-eyebrow">Your draw</p><p className="draw-title">It does not open</p><p className="draw-sub">Its key is not on the server any more. {celebration.host ? `${celebration.host.name} can draw the names again.` : 'The host can draw the names again.'}</p></>}
            {mine.opened && !receiver && !mine.unreadable && <><p className="draw-eyebrow">Your draw</p><p className="draw-title">They have left</p><p className="draw-sub">The person you drew is no longer in the household.</p></>}
          </div>
          {mine.opened && receiver && shown && !mine.receiverGuest && (
            <div className="button-row draw-actions">
              <Link to={`/family/${receiver.id}`} className="btn">{receiver.name}’s wishes</Link>
              <button type="button" className="btn" onClick={() => setAsk(true)}>Ask {receiver.name}</button>
            </div>
          )}
          {mine.opened && receiver && shown && mine.receiverGuest && <p className="hint">{receiver.name} joined by link: they keep no list in Keepsake.</p>}
          <Sheet title={receiver ? `Ask ${receiver.name}` : 'Ask'} open={ask} onClose={() => setAsk(false)}>
            {receiver && !mine.receiverGuest && <AskForm name={receiver.name} url={`/people/${receiver.id}/questions`} onSent={() => undefined} />}
          </Sheet>
        </div>
      )}
      {error && <div className="section"><Notice kind="error">{error}</Notice></div>}
      <Group title="The draw" footer={[
        d.budgetMinor !== null && cur ? `Budget ${money(d.budgetMinor, cur)}.` : null,
        d.revealed ? 'Everyone can see who drew whom.' : d.revealOn ? `Who drew whom is shown on ${day(d.revealOn)}.` : 'Who drew whom stays secret for good.',
        d.kidsDraw ? 'Kids draw too.' : null,
      ].filter(Boolean).join(' ')}>
        <DrawState d={d} />
        {manages && d.exclusions && d.exclusions.length > 0 && (
          <li className="row"><span className="row-title">Who shouldn’t draw whom</span>
            <span className="row-sub">{d.exclusions.map((x) => `${x[0]?.name} and ${x[1]?.name}`).join('; ')}</span>
            <span className="row-foot">Only you see this.</span></li>
        )}
      </Group>
      {d.pairs && (
        <Group title="Who drew whom">
          {d.pairs.map((p, i) => <li key={i} className="row"><span className="row-title">{p.giver?.name ?? 'Someone who left'} → {p.receiver?.name ?? 'someone who left'}</span></li>)}
        </Group>
      )}
      {manages && !d.over && <DrawGuests celebrationId={celebration.id} />}
      {manages && !d.over && (
        <div className="section button-row">
          {!d.drawn && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(false)}>Draw the names</button>}
          {d.drawn && d.canRedraw && <button type="button" className="btn" disabled={busy} onClick={() => run(true)}>Draw again</button>}
          <button type="button" className="btn" onClick={() => setSheet(true)}>Draw options</button>
          {d.canRedraw && <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>Remove the draw</button>}
        </div>
      )}
      {manages && d.over && (
        <div className="section button-row"><button type="button" className="btn" onClick={() => setSheet(true)}>When to show who drew whom</button></div>
      )}
      <Sheet title="Draw options" open={sheet} onClose={() => setSheet(false)}>
        <DrawForm celebration={celebration} draw={d} onDone={(next) => { setSheet(false); if (next) setD(next); onChanged(); }} />
      </Sheet>
    </>
  );
}

/** The draw's options as the form holds them. */
export interface DrawOptions {
  people: string[]; kidsDraw: boolean; notLastYear: boolean; budget: string; together: string;
  reveal: boolean; revealOn: string; exclusions: [string, string][];
}
export const defaultDrawOptions = (people: string[], kids: Set<string>, date: string): DrawOptions => ({
  people: people.filter((p) => !kids.has(p)), kidsDraw: false, notLastYear: false, budget: '', together: '', reveal: false,
  revealOn: date ? dayAfter(date) : '', exclusions: [],
});
const optionsOf = (d: Draw): DrawOptions => ({
  people: d.people.map((p) => p.id), kidsDraw: d.kidsDraw, notLastYear: d.notLastYear,
  budget: '', together: toLocalInput(d.drawTogetherAt), reveal: d.revealOn !== null, revealOn: d.revealOn ?? dayAfter(d.on),
  exclusions: (d.exclusions ?? []).map((x) => [x[0]!.id, x[1]!.id] as [string, string]),
});

/** The input the API takes, or a message for the person. */
export function drawInput(o: DrawOptions, currency: string | null): DrawInput | string {
  const budgetMinor = o.budget.trim() && currency ? parseMoney(o.budget, currency) : null;
  if (budgetMinor === undefined) return 'The budget is not an amount.';
  return {
    people: o.people, kidsDraw: o.kidsDraw, notLastYear: o.notLastYear, budgetMinor: budgetMinor || null,
    drawTogetherAt: fromLocalInput(o.together), revealOn: o.reveal ? o.revealOn || null : null, exclusions: o.exclusions,
  };
}

/** The draw's options, for a new celebration's form and for the draw's own sheet. */
export function DrawFields({ value, onChange, people, yearly, locked }: {
  value: DrawOptions; onChange: (v: DrawOptions) => void; people: string[]; yearly: boolean; locked?: boolean;
}) {
  const { household, me } = useHousehold();
  const id = useId();
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const set = (patch: Partial<DrawOptions>) => onChange({ ...value, ...patch });
  const inCelebration = household.people.filter((p) => people.includes(p.id));
  const shownPeople = inCelebration.filter((p) => p.role !== 'kid' || value.kidsDraw);
  const name = (pid: string) => household.people.find((p) => p.id === pid)?.name ?? 'Someone';
  const cur = household.currency;
  const inDraw = shownPeople.filter((p) => value.people.includes(p.id));
  return (
    <>
      {locked && <Notice>Its day has come: only when to show who drew whom can change.</Notice>}
      <fieldset className="people-pick" disabled={locked}>
        <legend className="field-label">Who draws</legend>
        <Switch label="Kids draw too" hint="Off: only grown-ups draw names." checked={value.kidsDraw} onChange={(v) => {
          const kids = new Set(inCelebration.filter((p) => p.role === 'kid').map((p) => p.id));
          set({ kidsDraw: v, people: v ? [...new Set([...value.people, ...kids])] : value.people.filter((p) => !kids.has(p)),
            exclusions: v ? value.exclusions : value.exclusions.filter(([x, y]) => !kids.has(x) && !kids.has(y)) });
        }} />
        {shownPeople.map((p) => (
          <label key={p.id} className="check">
            <input type="checkbox" checked={value.people.includes(p.id)} onChange={(e) => set({
              people: e.target.checked ? [...value.people, p.id] : value.people.filter((x) => x !== p.id),
              exclusions: e.target.checked ? value.exclusions : value.exclusions.filter(([x, y]) => x !== p.id && y !== p.id),
            })} />
            {p.id === me.id ? `${p.name} (you)` : p.name}
          </label>
        ))}
        <p className="hint">At least four (five with “Not last year’s person”). Nobody draws themselves, and the rules must leave nobody able to work out someone else’s person.</p>
      </fieldset>
      {!locked && cur && (
        <Field label={`Budget (${cur})`} id={`${id}-b`} hint="Optional: what each gift should cost about.">
          <input className="input input-short" id={`${id}-b`} inputMode="decimal" value={value.budget} placeholder={fractionDigits(cur) ? '30.00' : '30'} onChange={(e) => set({ budget: e.target.value })} />
        </Field>
      )}
      {!locked && (
        <Field label="Draw together" id={`${id}-t`} hint="Optional: nobody opens theirs before this time, so everyone opens at once.">
          <input className="input" id={`${id}-t`} type="datetime-local" value={value.together} onChange={(e) => set({ together: e.target.value })} />
        </Field>
      )}
      {!locked && (
        <fieldset>
          <legend className="field-label">Who shouldn’t draw whom</legend>
          <p className="hint">Couples, or whoever lives together: they never draw each other, either way. Only you see this.</p>
          <ul className="group exclusions">
            {value.exclusions.map(([x, y]) => (
              <li key={`${x}-${y}`} className="row row-inline"><span className="row-title">{name(x)} and {name(y)}</span>
                <button type="button" className="btn btn-sm" onClick={() => set({ exclusions: value.exclusions.filter((e) => !(e[0] === x && e[1] === y)) })}>Remove</button></li>
            ))}
          </ul>
          <div className="pair-pick">
            <label className="sr-only" htmlFor={`${id}-a`}>One person</label>
            <select className="input" id={`${id}-a`} value={a} onChange={(e) => setA(e.target.value)}>
              <option value="">Someone</option>{inDraw.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <span aria-hidden="true">and</span>
            <label className="sr-only" htmlFor={`${id}-c`}>The other</label>
            <select className="input" id={`${id}-c`} value={b} onChange={(e) => setB(e.target.value)}>
              <option value="">someone else</option>{inDraw.filter((p) => p.id !== a).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button type="button" className="btn btn-sm" disabled={!a || !b || a === b} onClick={() => {
              if (!value.exclusions.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) set({ exclusions: [...value.exclusions, [a, b]] });
              setA(''); setB('');
            }}>Add</button>
          </div>
        </fieldset>
      )}
      {!locked && yearly && <Switch label="Not last year’s person" hint="Nobody draws the person they drew last year." checked={value.notLastYear} onChange={(v) => set({ notLastYear: v })} />}
      <Switch label="Show who drew whom" hint="Off: it stays secret for good. On: everyone in the draw sees every pair from this day (after the celebration)." checked={value.reveal} onChange={(v) => set({ reveal: v })} />
      {value.reveal && (
        <Field label="From" id={`${id}-r`}><input className="input" id={`${id}-r`} type="date" value={value.revealOn} onChange={(e) => set({ revealOn: e.target.value })} /></Field>
      )}
    </>
  );
}

/** The draw's own sheet: a new draw for the celebration, or its options. */
function DrawForm({ celebration, draw, onDone }: { celebration: Celebration; draw?: Draw; onDone: (d?: Draw) => void }) {
  const { household } = useHousehold();
  const kids = new Set(household.people.filter((p) => p.role === 'kid').map((p) => p.id));
  const [o, setO] = useState<DrawOptions>(() => {
    if (!draw) return defaultDrawOptions(celebration.people, kids, celebration.nextDate);
    const v = optionsOf(draw);
    return { ...v, budget: toMoneyText(draw.budgetMinor, household.currency) };
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const input = drawInput(o, household.currency);
    if (typeof input === 'string') { setError(input); return; }
    const before = draw ? optionsOf(draw) : null;
    const key = (x: DrawOptions) => JSON.stringify([[...x.people].sort(), x.kidsDraw, x.notLastYear, x.exclusions.map((p) => [...p].sort().join()).sort()]);
    if (draw?.drawn && before && key(before) !== key(o) && !confirm('Saving these draws the names again: everyone’s person may change.')) return;
    setBusy(true); setError(null);
    try {
      const url = `/celebrations/${celebration.id}/draw`;
      const body = draw?.over ? { revealOn: input.revealOn } : input;
      onDone(await api<Draw>(url, { method: draw ? 'PATCH' : 'POST', body }));
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  };
  return (
    <form className="stack" onSubmit={save} noValidate>
      <DrawFields value={o} onChange={setO} people={celebration.people} yearly={celebration.recurrence === 'yearly'} locked={draw?.over} />
      {error && <Notice kind="error">{error}</Notice>}
      <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>{draw ? 'Save' : 'Set up the draw'}</button>
      {!draw && <p className="hint">The names are drawn when you say so, on the celebration’s page.</p>}
    </form>
  );
}
