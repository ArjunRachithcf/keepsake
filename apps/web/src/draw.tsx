// A celebration's draw (spec §4, ADR 0004): the sealed card ("Open your draw", a short spring reveal, hide again),
// their wishes and "Ask", everyone's state ("4 of 6 opened their draw"), every pair after the reveal; and for the
// host, "You draw the names" / "You drew the names · 26 Nov", kids drawing too, and the draw's options (who draws,
// budget, draw together, who shouldn't draw whom, not last year's person, the reveal date or never), drawing again.
//
// The server sends a giver's person only to that giver, once they opened theirs. Hiding it again is this page's: the
// name is then not in the page at all, and after a reload the card starts hidden.
import { useCallback, useEffect, useId, useState } from 'react';
import { api, message, ApiError, type Celebration, type Draw, type DrawInput } from './api';
import { dateTime, day, fractionDigits, money, numericDate, parseMoney, toMoneyText } from './format';
import { useHousehold } from './household';
import { Check, Field, Group, Link, Notice, Sheet, Switch, useConfirm } from './ui';
import { AskSheet } from './questions';
import { DrawGuests } from './links';

/** An instant as the datetime-local field shows it (the browser's own time zone). */
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
const dayAfter = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const names = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
/** How long the reveal plays (the card's bouncy spring and the name's focus). */
const REVEAL_MS = 900;

/** "On: Mia draws a name as well." / "Off: only grown-ups draw names.": the line under "Kids draw too", as it is now. */
export function kidsDrawWords(on: boolean, kids: string[]): string {
  if (!on) return 'Off: only grown-ups draw names.';
  if (!kids.length) return 'On: kids in it draw a name as well.';
  return `On: ${names(kids)} ${kids.length > 1 ? 'draw' : 'draws'} a name as well.`;
}

/** Whether the viewer runs this celebration's draw (its host; an admin when it has none or its host is now a kid; never a kid). */
export function useManagesDraw(c: Celebration): boolean {
  const { me, person } = useHousehold();
  const host = c.host ? person(c.host.id) : undefined;
  return me.role !== 'kid' && (host && host.role !== 'kid' ? host.id === me.id : me.role === 'admin');
}

/** The draw of a celebration, loaded once for the card and the rest. */
export function useDraw(celebration: Celebration) {
  const [draw, setDraw] = useState<Draw | 'none' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = `/celebrations/${celebration.id}/draw`;
  const load = useCallback(async () => {
    try { setDraw(await api<Draw>(url)); setError(null); } catch (e) {
      if (e instanceof ApiError && e.status === 404) setDraw('none'); else setError(message(e));
    }
  }, [url]);
  useEffect(() => { void load(); }, [load, celebration]);
  return { draw, setDraw, error, setError, load, url };
}
type DrawState = ReturnType<typeof useDraw>;

/** The person's own card: sealed, ready ("Open your draw"), or their person, with a short reveal. */
export function DrawCard({ draw: d, setDraw, setError, celebration, onChanged, url }: DrawState & { celebration: Celebration; onChanged: () => void }) {
  const { household } = useHousehold();
  const [shown, setShown] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!revealing) return; const t = setTimeout(() => setRevealing(false), REVEAL_MS); return () => clearTimeout(t); }, [revealing]);
  if (!d || d === 'none' || !d.mine) return null;
  const cur = household.currency;
  const mine = d.mine;
  const receiver = mine.receiver;
  const budget = d.budgetMinor !== null && cur ? `Budget about ${money(d.budgetMinor, cur)}.` : '';
  const open = async () => {
    setBusy(true); setError(null);
    try { setDraw(await api<Draw>(`${url}/open`, { method: 'POST' })); setShown(true); setRevealing(true); onChanged(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const isOpen = shown && Boolean(receiver);
  return (
    <div className="ks-stack">
      {d.redrawnAt && !mine.opened && <Notice title="The names were drawn again">Your person may have changed: open yours again.</Notice>}
      <div className={`draw-card${isOpen ? ' is-open' : ''}${revealing ? ' is-revealing' : ''}`}>
        {!d.drawn && <><p className="poster-eyebrow">Your draw</p><p className="draw-title">Not drawn yet</p><p className="poster-sub">{celebration.host ? `${celebration.host.name} draws the names.` : 'The names are drawn soon.'}</p></>}
        {d.drawn && !mine.opened && !mine.canOpen && (
          <><p className="poster-eyebrow">Your draw is sealed</p><p className="draw-title">Opens together</p>
            <p className="poster-sub">{d.drawTogetherAt ? `Everyone opens theirs at once: ${dateTime(d.drawTogetherAt)}.` : mine.sealed ? 'It opens once you confirm your new sign-in.' : 'Soon.'}</p></>
        )}
        {d.drawn && !mine.opened && mine.canOpen && (
          <><p className="poster-eyebrow">Your draw is ready</p><p className="draw-title">Who will it be?</p>
            <p className="poster-sub">Only you will know.{budget ? ` ${budget}` : ''}</p>
            <button type="button" className="btn btn-lg" disabled={busy} onClick={() => void open()}>Open your draw</button></>
        )}
        {mine.opened && receiver && !shown && (
          <><p className="poster-eyebrow">Your draw</p><p className="draw-title">Sealed again</p>
            <p className="poster-sub">Only you know who it is.</p>
            <button type="button" className="btn btn-lg" onClick={() => { setShown(true); setRevealing(true); }}>Show your draw</button></>
        )}
        {mine.opened && receiver && shown && (
          <><p className="poster-eyebrow">You give to</p><p className="draw-title" aria-live="polite">{receiver.name}</p>
            <p className="poster-sub">{budget ? `${budget} ` : ''}Only you know.</p>
            <button type="button" className="btn-text" onClick={() => setShown(false)}>Hide again</button></>
        )}
        {mine.opened && !receiver && mine.unreadable && <><p className="poster-eyebrow">Your draw</p><p className="draw-title">It does not open</p><p className="poster-sub">Its key is not on the server any more. {celebration.host ? `${celebration.host.name} can draw the names again.` : 'The host can draw the names again.'}</p></>}
        {mine.opened && !receiver && !mine.unreadable && <><p className="poster-eyebrow">Your draw</p><p className="draw-title">They have left</p><p className="poster-sub">The person you drew is no longer in the household.</p></>}
      </div>
      {isOpen && receiver && !mine.receiverGuest && (
        <div className="btn-row">
          <Link to={`/family/${receiver.id}`} className="btn">{receiver.name}’s wishes</Link>
          <button type="button" className="btn" onClick={() => setAsk(true)}>Ask {receiver.name}</button>
        </div>
      )}
      {isOpen && receiver && mine.receiverGuest && <p className="hint">{receiver.name} joined by link: they keep no list in Keepsake.</p>}
      {receiver && !mine.receiverGuest && <AskSheet name={receiver.name} url={`/people/${receiver.id}/questions`} open={ask} onClose={() => setAsk(false)} onSent={() => undefined} />}
    </div>
  );
}

/** Everyone's state, the host's part ("You draw the names"), who drew whom after the reveal, and the guests. */
export function DrawRest({ draw: d, setDraw, error, setError, load, url, celebration, onChanged }: DrawState & { celebration: Celebration; onChanged: () => void }) {
  const { household } = useHousehold();
  const manages = useManagesDraw(celebration);
  const ask = useConfirm();
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = async (f: () => Promise<Draw | undefined>) => {
    setBusy(true); setError(null);
    try { const next = await f(); if (next) setDraw(next); else await load(); onChanged(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const kidsOf = (ids: string[]) => household.people.filter((p) => p.role === 'kid' && ids.includes(p.id));

  if (d === null && !error) return null;
  if (d === 'none' || d === null) {
    if (!manages || !celebration.upcoming) return error ? <Notice kind="error">{error}</Notice> : null;
    return (
      <Group title="The draw" footer="Each person draws someone to give to; only they learn who.">
        {error && <li className="row"><p className="row-error" role="alert">{error}</p></li>}
        <li className="row">
          <span className="row-main"><span className="row-title">You draw the names</span><span className="row-sub wrap">Set up who draws, then draw them here.</span></span>
          <span className="row-trail"><button type="button" className="btn btn-primary btn-sm" onClick={() => setSheet(true)}>Set up the draw</button></span>
        </li>
        <Sheet title={`Draw names for ${celebration.name}`} open={sheet} onClose={() => setSheet(false)}>
          <DrawForm celebration={celebration} onDone={() => { setSheet(false); void load(); onChanged(); }} />
        </Sheet>
      </Group>
    );
  }

  const run = async (again: boolean) => {
    if (again && !(await ask({ title: 'Draw the names again?', body: d.opened > 0 ? 'Everyone’s person changes, and everyone opens theirs again.' : 'Everyone’s person may change.', confirm: 'Draw again', dismiss: 'Not now' }))) return;
    setSheet(false);
    void act(() => api<Draw>(`${url}/run`, { method: 'POST' }));
  };
  const remove = async () => {
    if (!(await ask({ title: 'Remove the draw?', body: 'Whoever drew someone loses their person. The celebration and its wishes stay.', confirm: 'Remove the draw', dismiss: 'Keep it', destructive: true }))) return;
    setSheet(false);
    void act(async () => { await api(url, { method: 'DELETE' }); setDraw('none'); return undefined; });
  };
  const kidsInIt = kidsOf(celebration.people);
  const kidsDrawing = kidsOf(d.people.map((p) => p.id)).map((p) => p.name);
  const setKids = async (v: boolean) => {
    if (d.drawn && !(await ask({ title: v ? 'Kids draw too?' : 'Only grown-ups draw?', body: 'Saving this draws the names again: everyone’s person may change.', confirm: 'Save and draw again', dismiss: 'Not now' }))) return;
    const kids = new Set(kidsInIt.map((p) => p.id));
    const people = v ? [...new Set([...d.people.map((p) => p.id), ...kids])] : d.people.map((p) => p.id).filter((p) => !kids.has(p));
    const exclusions = (d.exclusions ?? []).map((x) => [x[0]!.id, x[1]!.id] as [string, string]).filter(([a, b]) => v || (!kids.has(a) && !kids.has(b)));
    void act(() => api<Draw>(url, { method: 'PATCH', body: { kidsDraw: v, people, exclusions } }));
  };
  const host = celebration.host;
  const drawers = [...d.people.map((p) => p.name), ...d.guests.map((g) => `${g} by link`)];
  return (
    <>
      <Group title="The draw" footer={[
        d.revealed ? 'Everyone in the draw can see who drew whom.' : d.revealOn ? `Who drew whom is shown on ${numericDate(d.revealOn)}.` : 'Who drew whom stays secret for good.',
      ].join(' ')}>
        <li className="row" style={{ display: 'grid', gap: 6 }}>
          <span className="row-title">{d.drawn ? `${d.opened} of ${d.total} opened their draw` : `${d.total} drawing names`}</span>
          {d.drawn && <span className="draw-progress" role="progressbar" aria-label="Opened their draw" aria-valuemin={0} aria-valuemax={d.total} aria-valuenow={d.opened}>
            <span style={{ '--value': `${d.total ? Math.round((d.opened / d.total) * 100) : 0}%` } as React.CSSProperties} /></span>}
          <span className="row-sub wrap">{names(drawers)}</span>
        </li>
        {kidsInIt.length > 0 && (manages && !d.over
          ? <Switch row label="Kids draw too" checked={d.kidsDraw} disabled={busy || (d.drawn && !d.canRedraw)} onChange={(v) => void setKids(v)} hint={kidsDrawWords(d.kidsDraw, kidsDrawing)} />
          : <li className="row"><span className="row-main"><span className="row-title">Kids draw too</span><span className="row-sub wrap">{kidsDrawWords(d.kidsDraw, kidsDrawing)}</span></span></li>)}
        {manages ? (
          <li className="row">
            <span className="row-main">
              <span className="row-title">{d.drawn ? 'You drew the names' : 'You draw the names'}</span>
              <span className="row-sub wrap">{d.drawn
                ? `${d.drawnAt ? `${day(d.drawnAt)}. ` : ''}${d.canRedraw ? 'Drawing again changes everyone’s person.' : 'Who drew whom stays as it is now.'}`
                : 'When everyone who draws is in, draw them here.'}</span>
            </span>
            <span className="row-trail">
              {!d.drawn && !d.over && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run(false)}>Draw the names</button>}
              <button type="button" className="btn btn-sm" onClick={() => setSheet(true)}>Options</button>
            </span>
          </li>
        ) : (
          <li className="row"><span className="row-main"><span className="row-title">{d.drawn ? `${host ? host.name : 'The host'} drew the names` : `${host ? host.name : 'The host'} draws the names`}</span></span></li>
        )}
        {manages && d.exclusions && d.exclusions.length > 0 && (
          <li className="row"><span className="row-main"><span className="row-title">Who shouldn’t draw whom</span>
            <span className="row-sub wrap">{d.exclusions.map((x) => `${x[0]?.name} and ${x[1]?.name}`).join('; ')} · only you see this</span></span></li>
        )}
        {error && <li className="row"><p className="row-error" role="alert">{error}</p></li>}
      </Group>
      {d.pairs && (
        <Group title="Who drew whom">
          {d.pairs.map((p, i) => <li key={i} className="row"><span className="row-title">{p.giver?.name ?? 'Someone who left'} → {p.receiver?.name ?? 'someone who left'}</span></li>)}
        </Group>
      )}
      {manages && !d.over && <DrawGuests celebrationId={celebration.id} />}
      <Sheet title={d.over ? 'When to show who drew whom' : 'Draw options'} open={sheet} onClose={() => setSheet(false)}>
        <DrawForm celebration={celebration} draw={d} onDone={(next) => { setSheet(false); if (next) setDraw(next); onChanged(); }} />
        {!d.over && d.canRedraw && (
          <div className="btn-row">
            {d.drawn && <button type="button" className="btn" disabled={busy} onClick={() => void run(true)}>Draw again</button>}
            <button type="button" className="btn btn-destructive" disabled={busy} onClick={() => void remove()}>Remove the draw</button>
          </div>
        )}
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
  const kids = inCelebration.filter((p) => p.role === 'kid');
  return (
    <>
      {locked && <Notice>Its day has come: only when to show who drew whom can change.</Notice>}
      {!locked && (
        <fieldset className="ks-checks">
          <legend className="field-label">Who draws</legend>
          {kids.length > 0 && (
            <Switch label="Kids draw too" hint={kidsDrawWords(value.kidsDraw, kids.map((k) => k.name))} checked={value.kidsDraw} onChange={(v) => {
              const ks = new Set(kids.map((p) => p.id));
              set({ kidsDraw: v, people: v ? [...new Set([...value.people, ...ks])] : value.people.filter((p) => !ks.has(p)),
                exclusions: v ? value.exclusions : value.exclusions.filter(([x, y]) => !ks.has(x) && !ks.has(y)) });
            }} />
          )}
          <span className="ks-checks-row">
            {shownPeople.map((p) => (
              <Check key={p.id} label={p.id === me.id ? `${p.name} (you)` : p.name} checked={value.people.includes(p.id)} onChange={(on) => set({
                people: on ? [...value.people, p.id] : value.people.filter((x) => x !== p.id),
                exclusions: on ? value.exclusions : value.exclusions.filter(([x, y]) => x !== p.id && y !== p.id),
              })} />
            ))}
          </span>
          <p className="hint">At least four (five with “Not last year’s person”). Nobody draws themselves, and the rules must leave nobody able to work out someone else’s person.</p>
        </fieldset>
      )}
      {!locked && cur && (
        <Field label={`Budget (${cur})`} id={`${id}-b`} hint="Optional: what each gift should cost about.">
          <input className="input input-short" id={`${id}-b`} inputMode="decimal" value={value.budget} placeholder={fractionDigits(cur) ? '30.00' : '30'} onChange={(e) => set({ budget: e.target.value })} aria-describedby={`${id}-b-hint`} />
        </Field>
      )}
      {!locked && (
        <Field label="Draw together" id={`${id}-t`} hint="Optional: nobody opens theirs before this time, so everyone opens at once.">
          <input className="input" id={`${id}-t`} type="datetime-local" value={value.together} onChange={(e) => set({ together: e.target.value })} aria-describedby={`${id}-t-hint`} />
        </Field>
      )}
      {!locked && (
        <fieldset className="ks-checks">
          <legend className="field-label">Who shouldn’t draw whom</legend>
          <p className="hint">Couples, or whoever lives together: they never draw each other, either way. Only you see this.</p>
          {value.exclusions.length > 0 && (
            <ul className="group">
              {value.exclusions.map(([x, y]) => (
                <li key={`${x}-${y}`} className="row"><span className="row-main"><span className="row-title">{name(x)} and {name(y)}</span></span>
                  <span className="row-trail"><button type="button" className="btn btn-plain btn-sm" onClick={() => set({ exclusions: value.exclusions.filter((e) => !(e[0] === x && e[1] === y)) })}>Remove<span className="sr-only"> {name(x)} and {name(y)}</span></button></span></li>
              ))}
            </ul>
          )}
          <div className="ks-pair">
            <label className="sr-only" htmlFor={`${id}-a`}>One person</label>
            <select className="select" id={`${id}-a`} value={a} onChange={(e) => setA(e.target.value)}>
              <option value="">Someone</option>{inDraw.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <span aria-hidden="true">and</span>
            <label className="sr-only" htmlFor={`${id}-c`}>The other</label>
            <select className="select" id={`${id}-c`} value={b} onChange={(e) => setB(e.target.value)}>
              <option value="">someone else</option>{inDraw.filter((p) => p.id !== a).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button type="button" className="btn btn-sm" disabled={!a || !b || a === b} onClick={() => {
              if (!value.exclusions.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) set({ exclusions: [...value.exclusions, [a, b]] });
              setA(''); setB('');
            }}>Add</button>
          </div>
        </fieldset>
      )}
      {!locked && yearly && <Switch label="Not last year’s person" hint={value.notLastYear ? 'On: nobody draws the person they drew last year.' : 'Off: anyone may draw last year’s person again.'} checked={value.notLastYear} onChange={(v) => set({ notLastYear: v })} />}
      <Switch label="Show who drew whom" hint={value.reveal ? 'On: everyone in the draw sees every pair from this day (after the celebration).' : 'Off: it stays secret for good.'} checked={value.reveal} onChange={(v) => set({ reveal: v })} />
      {value.reveal && (
        <Field label="From" id={`${id}-r`}><input className="input" id={`${id}-r`} type="date" value={value.revealOn} onChange={(e) => set({ revealOn: e.target.value })} /></Field>
      )}
    </>
  );
}

/** The draw's own sheet: a new draw for the celebration, or its options. */
function DrawForm({ celebration, draw, onDone }: { celebration: Celebration; draw?: Draw; onDone: (d?: Draw) => void }) {
  const { household } = useHousehold();
  const ask = useConfirm();
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
    if (draw?.drawn && before && key(before) !== key(o)
      && !(await ask({ title: 'Save and draw again?', body: 'Saving these draws the names again: everyone’s person may change.', confirm: 'Save and draw again', dismiss: 'Not yet' }))) return;
    setBusy(true); setError(null);
    try {
      const url = `/celebrations/${celebration.id}/draw`;
      const body = draw?.over ? { revealOn: input.revealOn } : input;
      onDone(await api<Draw>(url, { method: draw ? 'PATCH' : 'POST', body }));
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={save} noValidate>
      <DrawFields value={o} onChange={setO} people={celebration.people} yearly={celebration.recurrence === 'yearly'} locked={draw?.over} />
      {error && <Notice kind="error">{error}</Notice>}
      <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>{draw ? 'Save' : 'Set up the draw'}</button>
      {!draw && <p className="hint">The names are drawn when you say so, on the celebration’s page.</p>}
    </form>
  );
}
