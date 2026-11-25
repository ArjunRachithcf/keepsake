// Celebrations (spec §4): coming up (date, "2 to approve", the draw) and past ones; a celebration's page with its
// poster, the sealed draw and everyone's state, and everyone's list for it; a new celebration (the host: poster, date,
// place, people, and the draw's options).
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { POSTERS } from '@keepsake/contracts';
import { api, message, type Celebration, type CelebrationInput, type CelebrationPage, type Celebrations as List, type Wish } from '../api';
import { celebrationLine, day, inDays } from '../format';
import { useHousehold } from '../household';
import { useGo } from '../router';
import { Field, Group, Link, Loading, Notice, PageHead, POSTER_LABEL, Poster, Sheet, Switch, usePageTitle } from '../ui';
import { WishForm, WishRow } from '../wish';
import { DrawFields, DrawSection, defaultDrawOptions, drawInput, type DrawOptions } from '../draw';

/** A celebration's draw, in a few words, for its row. */
const drawLine = (c: Celebration) => {
  const d = c.draw;
  if (!d || !c.upcoming) return '';
  if (d.mine === 'ready') return ' · your draw is ready to open';
  if (d.drawn) return ` · ${d.opened} of ${d.total} opened their draw`;
  return ' · names to draw';
};

function CelebrationRow({ c }: { c: Celebration }) {
  return (
    <li className="row">
      <Link to={`/celebrations/${c.id}`} className="row-link">
        <Poster poster={c.poster} small />
        <span className="row-text">
          <span className="row-title">{c.name}</span>
          <span className="row-sub">{celebrationLine(c)}{c.upcoming ? ` · ${inDays(c.daysUntil)}` : ''}{c.toApprove ? ` · ${c.toApprove} to approve` : ''}{drawLine(c)}</span>
        </span>
        <span className="chevron" aria-hidden="true">›</span>
      </Link>
    </li>
  );
}

export function Celebrations() {
  const { me } = useHousehold();
  const [list, setList] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const go = useGo();
  const load = useCallback(() => api<List>('/celebrations').then(setList, (e) => setError(message(e))), []);
  useEffect(() => { void load(); }, [load]);
  return (
    <>
      <PageHead title="Celebrations" action={me.role !== 'kid' ? <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>New</button> : undefined} />
      {error && <Notice kind="error">{error}</Notice>}
      {!list && !error && <Loading />}
      {list && <>
        <Group title="Coming up">
          {list.upcoming.length === 0 && <li className="row"><span className="row-sub">Nothing planned yet.</span></li>}
          {list.upcoming.map((c) => <CelebrationRow key={c.id} c={c} />)}
        </Group>
        {list.past.length > 0 && <Group title="Past">{list.past.map((c) => <CelebrationRow key={c.id} c={c} />)}</Group>}
      </>}
      <Sheet title="New celebration" open={adding} onClose={() => setAdding(false)}>
        <CelebrationForm onDone={(c) => { setAdding(false); if (c) go(`/celebrations/${c.id}`); else void load(); }} />
      </Sheet>
    </>
  );
}

export function CelebrationView({ id }: { id: string }) {
  const { me, person } = useHousehold();
  const go = useGo();
  const [page, setPage] = useState<CelebrationPage | null>(null);
  const [all, setAll] = useState<Celebration[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ wish?: Wish; personId: string } | 'edit' | null>(null);
  const h1 = useRef<HTMLHeadingElement>(null);
  usePageTitle(page?.celebration.name ?? 'Celebration', h1);
  const load = useCallback(async () => {
    try {
      setPage(await api<CelebrationPage>(`/celebrations/${id}`));
      setAll((await api<List>('/celebrations')).upcoming);
      setError(null);
    } catch (e) { setError(message(e)); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const back = <Link to="/celebrations" className="back">‹ Celebrations</Link>;
  if (error) return <>{back}<Notice kind="error">{error}</Notice></>;
  if (!page) return <>{back}<Loading /></>;
  const c = page.celebration;
  const inIt = c.people.includes(me.id);
  const remove = async () => {
    if (!confirm(`Remove ${c.name}? Its wishes stay, for any time.`)) return;
    try { await api(`/celebrations/${c.id}`, { method: 'DELETE' }); go('/celebrations'); } catch (e) { setError(message(e)); }
  };
  return (
    <>
      {back}
      <Poster poster={c.poster}>
        <h1 className="poster-title" ref={h1} tabIndex={-1}>{c.name}</h1>
        <p className="poster-sub">{c.upcoming ? `${day(c.nextDate)}, ${inDays(c.daysUntil)}` : day(c.nextDate)}</p>
        {c.place && <p className="poster-sub">{c.place}</p>}
        <p className="poster-sub">{c.recurrence === 'yearly' ? 'Every year' : 'Once'}{c.host ? ` · hosted by ${c.host.id === me.id ? 'you' : c.host.name}` : ''}</p>
      </Poster>
      {c.canEdit && (
        <div className="section button-row">
          <button type="button" className="btn" onClick={() => setSheet('edit')}>Change</button>
          <button type="button" className="btn btn-danger" onClick={remove}>Remove</button>
        </div>
      )}
      <DrawSection celebration={c} onChanged={load} />
      {inIt && (
        <div className="section">
          <button type="button" className="btn btn-primary btn-block" onClick={() => setSheet({ personId: me.id })}>Add a wish for {c.name}</button>
        </div>
      )}
      {page.lists.map((l) => (
        <Group key={l.person.id} title={l.person.id === me.id ? 'Your list' : `${l.person.name}’s list`}>
          {l.wishes.length === 0 && <li className="row"><span className="row-sub">No wishes for it yet.</span></li>}
          {l.wishes.map((w) => <WishRow key={w.id} wish={w} celebrations={all} onChanged={load} onEdit={(x) => setSheet({ wish: x, personId: x.personId })} />)}
          {l.person.id !== me.id && person(l.person.id) && (
            <li className="row"><Link to={`/family/${l.person.id}`} className="row-link"><span className="row-text"><span className="row-title">{l.person.name}’s page</span></span><span className="chevron" aria-hidden="true">›</span></Link></li>
          )}
        </Group>
      ))}
      <Sheet title={sheet === 'edit' ? 'Change the celebration' : sheet?.wish ? 'Change the wish' : 'New wish'} open={sheet !== null} onClose={() => setSheet(null)}>
        {sheet === 'edit' && <CelebrationForm celebration={c} onDone={() => { setSheet(null); void load(); }} />}
        {sheet && sheet !== 'edit' && <WishForm personId={sheet.personId} wish={sheet.wish} celebrations={all.some((x) => x.id === c.id) ? all : [...all, c]} initialFor={c.id}
          onDone={() => { setSheet(null); void load(); }} />}
      </Sheet>
    </>
  );
}

const YEARLY = /birthday|christmas|xmas|anniversary|name day|hanukkah|diwali|eid/i;

function CelebrationForm({ celebration, onDone }: { celebration?: Celebration; onDone: (c?: Celebration) => void }) {
  const { household, me } = useHousehold();
  const id = useId();
  const [name, setName] = useState(celebration?.name ?? '');
  const [date, setDate] = useState(celebration?.date ?? '');
  const [place, setPlace] = useState(celebration?.place ?? '');
  const [poster, setPoster] = useState<Celebration['poster']>(celebration?.poster ?? 'pine');
  const [yearly, setYearly] = useState(celebration ? celebration.recurrence === 'yearly' : true);
  const [touchedYearly, setTouchedYearly] = useState(Boolean(celebration));
  const [people, setPeople] = useState<string[]>(celebration?.people ?? [me.id]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The celebration was made but its draw was refused: why, and the way to its page.
  const [made, setMade] = useState<{ c: Celebration; why: string } | null>(null);
  const kids = new Set(household.people.filter((p) => p.role === 'kid').map((p) => p.id));
  const [drawing, setDrawing] = useState(false);
  const [draw, setDraw] = useState<DrawOptions>(() => defaultDrawOptions([], kids, ''));
  // The draw's people follow the celebration's until the host picks them.
  const drawOpts: DrawOptions = { ...draw, people: draw.people.filter((p) => people.includes(p)), revealOn: draw.revealOn || (date ? defaultDrawOptions([], kids, date).revealOn : '') };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const body: CelebrationInput = { name: name.trim(), date, place: place.trim() || null, poster, recurrence: yearly ? 'yearly' : 'none', people };
    const drawBody = drawing ? drawInput(drawOpts, household.currency) : null;
    if (typeof drawBody === 'string') { setError(drawBody); return; }
    setBusy(true); setError(null);
    try {
      const c = celebration ? await api<Celebration>(`/celebrations/${celebration.id}`, { method: 'PATCH', body })
        : await api<Celebration>('/celebrations', { method: 'POST', body });
      // The celebration is made; if its draw is refused, the form says why and the host sets it up on its page.
      if (!celebration && drawBody) {
        try { await api(`/celebrations/${c.id}/draw`, { method: 'POST', body: drawBody }); } catch (err) { setMade({ c, why: message(err) }); return; }
      }
      onDone(celebration ? undefined : c);
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  };
  if (made) {
    return (
      <div className="stack">
        <Notice kind="error" title={`${made.c.name} is added, without its draw`}>{made.why}</Notice>
        <p className="hint">Set up the draw on the celebration’s page with other options.</p>
        <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => onDone(made.c)}>Open {made.c.name}</button>
      </div>
    );
  }
  return (
    <form className="stack" onSubmit={save} noValidate>
      <fieldset className="poster-pick">
        <legend className="field-label">Poster</legend>
        {POSTERS.map((p) => (
          <label key={p} className="poster-option">
            <input type="radio" name={`${id}-poster`} value={p} checked={poster === p} onChange={() => setPoster(p)} />
            <Poster poster={p} small /><span>{POSTER_LABEL[p]}</span>
          </label>
        ))}
      </fieldset>
      <Field label="Name" id={`${id}-n`}>
        <input className="input" id={`${id}-n`} value={name} maxLength={60} required onChange={(e) => {
          setName(e.target.value);
          if (!touchedYearly) setYearly(YEARLY.test(e.target.value) || e.target.value.trim() === '');
        }} />
      </Field>
      <Field label="Date" id={`${id}-d`}><input className="input" id={`${id}-d`} type="date" value={date} required onChange={(e) => setDate(e.target.value)} /></Field>
      <Switch label="Every year" hint="Birthdays and Christmas come back; their wishes follow." checked={yearly} onChange={(v) => { setYearly(v); setTouchedYearly(true); }} />
      <Field label="Place" id={`${id}-p`} hint="Optional."><input className="input" id={`${id}-p`} value={place} maxLength={80} onChange={(e) => setPlace(e.target.value)} /></Field>
      <fieldset className="people-pick">
        <legend className="field-label">For whom</legend>
        <p className="hint">Whose wishes it has: the birthday person, or everyone at Christmas.</p>
        {household.people.map((p) => (
          <label key={p.id} className="check">
            <input type="checkbox" checked={people.includes(p.id)} onChange={(e) => {
              setPeople(e.target.checked ? [...people, p.id] : people.filter((x) => x !== p.id));
              if (e.target.checked && (p.role !== 'kid' || draw.kidsDraw)) setDraw({ ...draw, people: [...draw.people, p.id] });
            }} />
            {p.id === me.id ? `${p.name} (you)` : p.name}
          </label>
        ))}
      </fieldset>
      {!celebration && (
        <>
          <Switch label="Draw names" hint="Each person draws someone to give to; only they learn who." checked={drawing} onChange={(v) => {
            setDrawing(v);
            if (v) setDraw({ ...draw, people: people.filter((p) => !kids.has(p) || draw.kidsDraw) });
          }} />
          {drawing && <DrawFields value={drawOpts} onChange={setDraw} people={people} yearly={yearly} />}
        </>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy || !name.trim() || !date || people.length === 0}>{celebration ? 'Save' : 'Add the celebration'}</button>
    </form>
  );
}
