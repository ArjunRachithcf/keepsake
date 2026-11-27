// Celebrations (spec §4): coming up (date, "2 to approve", the draw) and past ones; a celebration's page with its
// poster, your draw (sealed, then a short reveal), the draw's state and the host's part, and everyone's list for it;
// a new celebration (the host: poster, date, place, for whom, and the draw's options). On a desktop the lists are the
// left column and the draw beside them.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { POSTERS } from '@keepsake/contracts';
import { api, message, type Celebration, type CelebrationInput, type CelebrationPage, type Celebrations as List } from '../api';
import { celebrationLine, inDays, weekdayDate } from '../format';
import { useHousehold } from '../household';
import { Icon } from '../icons';
import { useRows } from '../motion';
import { useGo } from '../router';
import { AccountButton } from '../account';
import { AddRow, Avatar, Check, Field, Group, IconButton, Link, Loading, Notice, PageHead, POSTER_LABEL, Poster, Sheet, Switch, TopLine, usePageTitle, useConfirm, useBusy } from '../ui';
import { WishForm } from '../wish';
import { DrawCard, DrawFields, DrawRest, defaultDrawOptions, drawInput, useDraw, useManagesDraw, type DrawOptions } from '../draw';

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
    <li data-row={c.id}>
      <Link to={`/celebrations/${c.id}`} className="row row-link">
        <span className="row-lead"><Poster poster={c.poster} small /></span>
        <span className="row-main">
          <span className="row-title">{c.name}</span>
          <span className="row-sub wrap">{celebrationLine(c)}{c.upcoming ? ` · ${inDays(c.daysUntil)}` : ''}{c.toApprove ? ` · ${c.toApprove} to approve` : ''}{drawLine(c)}</span>
        </span>
        <Icon name="chevronRight" className="icon row-chev" />
      </Link>
    </li>
  );
}

export function Celebrations() {
  const { me } = useHousehold();
  const [list, setList] = useRows<List>();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const go = useGo();
  const load = useCallback(() => api<List>('/celebrations').then(setList, (e) => setError(message(e))), [setList]);
  useEffect(() => { void load(); }, [load]);
  const canAdd = me.role !== 'kid';
  return (
    <>
      <TopLine end={<>{canAdd && <IconButton icon="plus" label="New celebration" onClick={() => setAdding(true)} />}<AccountButton /></>} />
      <PageHead title="Celebrations" wideSub sub="Birthdays, Christmas and the rest: their dates, their lists and their draws."
        actions={canAdd ? <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" />New celebration</button> : undefined} />
      {error && <Notice kind="error">{error}</Notice>}
      {!list && !error && <Loading />}
      {list && <>
        <Group title="Coming up" lead="md">
          {list.upcoming.length === 0 && <li className="row"><span className="row-sub">Nothing planned yet.</span></li>}
          {list.upcoming.map((c) => <CelebrationRow key={c.id} c={c} />)}
          {canAdd && <AddRow label="New celebration" onClick={() => setAdding(true)} />}
        </Group>
        {list.past.length > 0 && <Group title="Past" lead="md">{list.past.map((c) => <CelebrationRow key={c.id} c={c} />)}</Group>}
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
  const ask = useConfirm();
  const [page, setPage] = useRows<CelebrationPage>();
  const [all, setAll] = useState<Celebration[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'wish' | 'edit' | null>(null);
  const h1 = useRef<HTMLHeadingElement>(null);
  usePageTitle(page?.celebration.name ?? 'Celebration', h1);
  const load = useCallback(async () => {
    try {
      const [p, l] = await Promise.all([api<CelebrationPage>(`/celebrations/${id}`), api<List>('/celebrations')]);
      setAll(l.upcoming);
      setPage(p);
      setError(null);
    } catch (e) { setError(message(e)); }
  }, [id, setPage]);
  useEffect(() => { void load(); }, [load]);
  const back = { to: '/celebrations', label: 'Celebrations' };
  if (error && !page) return <><TopLine back={back} /><Notice kind="error">{error}</Notice></>;
  if (!page) return <><TopLine back={back} /><Loading /></>;
  return <CelebrationBody page={page} all={all} error={error} setError={setError} load={load} sheet={sheet} setSheet={setSheet} h1={h1}
    remove={async () => {
      const c = page.celebration;
      if (!(await ask({ title: `Remove ${c.name}?`, body: 'Its wishes stay, for any time. Its draw goes with it.', confirm: `Remove ${c.name}`, dismiss: 'Keep it', destructive: true }))) return;
      try { await api(`/celebrations/${c.id}`, { method: 'DELETE' }); go('/celebrations'); } catch (e) { setError(message(e)); }
    }}
    meId={me.id} known={(pid) => Boolean(person(pid))} />;
}

function CelebrationBody({ page, all, error, setError, load, sheet, setSheet, h1, remove, meId, known }: {
  page: CelebrationPage; all: Celebration[]; error: string | null; setError: (e: string | null) => void; load: () => Promise<void>;
  sheet: 'wish' | 'edit' | null; setSheet: (s: 'wish' | 'edit' | null) => void; h1: React.RefObject<HTMLHeadingElement | null>;
  remove: () => Promise<void>; meId: string; known: (id: string) => boolean;
}) {
  const c = page.celebration;
  const draw = useDraw(c);
  const inIt = c.people.includes(meId);
  const eyebrow = [c.recurrence === 'yearly' ? 'Every year' : 'Once', c.host ? (c.host.id === meId ? 'you host' : `${c.host.name} hosts`) : null].filter(Boolean).join(' · ');
  const when = [weekdayDate(c.nextDate), c.upcoming ? inDays(c.daysUntil) : null, c.place].filter(Boolean).join(' · ');
  const back = { to: '/celebrations', label: 'Celebrations' };
  const manages = useManagesDraw(c);
  // the rail only when there is a draw to show (or to set up, for its host)
  const hasDraw = draw.error !== null || (draw.draw !== null && (draw.draw !== 'none' || (manages && c.upcoming)));
  return (
    <>
      <TopLine back={back} end={c.canEdit ? <IconButton icon="more" label={`Change or remove ${c.name}`} onClick={() => setSheet('edit')} /> : undefined} />
      <Poster poster={c.poster} className="poster-hero">
        <p className="poster-eyebrow">{eyebrow}</p>
        <h1 className="poster-title" ref={h1} tabIndex={-1}>{c.name}</h1>
        <p className="poster-sub">{when}</p>
        {(c.canEdit || inIt) && (
          <div className="btn-row ks-wide" style={{ marginTop: 14 }}>
            {c.canEdit && <button type="button" className="btn btn-sm is-soft" onClick={() => setSheet('edit')}>Change</button>}
            {inIt && <button type="button" className="btn btn-sm" onClick={() => setSheet('wish')}><Icon name="plus" />Add a wish for {c.name}</button>}
          </div>
        )}
      </Poster>
      {error && <Notice kind="error">{error}</Notice>}
      <div className={hasDraw ? 'ks-two is-wide-rail' : 'ks-stack'}>
        <div>
          <Group title={`${c.name} lists`} lead="md" footer="Each list has their wishes for it and their any-time ones.">
            {page.lists.length === 0 && <li className="row"><span className="row-sub">Nobody’s list yet.</span></li>}
            {page.lists.map((l) => {
              const mine = l.person.id === meId;
              const forIt = l.wishes.filter((w) => w.celebrationId === c.id).length;
              const any = l.wishes.length - forIt;
              const counts = l.wishes.length === 0 ? 'No wishes for it yet' : [forIt ? `${forIt} for ${c.name}` : `Nothing for ${c.name} yet`, any ? `${any} any time` : null].filter(Boolean).join(' · ');
              const body = <>
                <span className="row-lead"><Avatar id={l.person.id} name={l.person.name} /></span>
                <span className="row-main">
                  <span className="row-title">{mine ? 'Your list' : l.person.name}</span>
                  <span className="row-sub ks-narrow">{counts}</span>
                  <span className="row-sub ks-wide">{l.wishes.length ? l.wishes.map((w) => w.name).join(', ') : counts}</span>
                </span>
                {l.wishes.length > 0 && <span className="row-value ks-wide">{l.wishes.length}</span>}
              </>;
              const to = mine ? '/' : known(l.person.id) ? `/family/${l.person.id}` : null;
              return (
                <li key={l.person.id} data-row={l.person.id}>
                  {to ? <Link to={to} className="row row-link">{body}<Icon name="chevronRight" className="icon row-chev" /></Link> : <div className="row">{body}</div>}
                </li>
              );
            })}
            {inIt && <AddRow label={`Add a wish for ${c.name}`} onClick={() => setSheet('wish')} />}
          </Group>
        </div>
        {hasDraw && (
          <div className="is-first-on-phone">
            <DrawCard {...draw} celebration={c} onChanged={() => void load()} />
            <DrawRest {...draw} celebration={c} onChanged={() => void load()} />
          </div>
        )}
      </div>
      <Sheet title={sheet === 'edit' ? `Change ${c.name}` : `A wish for ${c.name}`} open={sheet !== null} onClose={() => setSheet(null)}>
        {sheet === 'edit' && <>
          <CelebrationForm celebration={c} onDone={() => { setSheet(null); void load(); }} />
          <button type="button" className="btn btn-destructive btn-block" onClick={() => { setSheet(null); void remove(); }}>Remove {c.name}</button>
        </>}
        {sheet === 'wish' && <WishForm personId={meId} celebrations={all.some((x) => x.id === c.id) ? all : [...all, c]} initialFor={c.id}
          onDone={() => { setSheet(null); setError(null); void load(); }} />}
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
  const [busy, guard] = useBusy();
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
    if (!guard.start()) return; setError(null);
    try {
      const c = celebration ? await api<Celebration>(`/celebrations/${celebration.id}`, { method: 'PATCH', body })
        : await api<Celebration>('/celebrations', { method: 'POST', body });
      // The celebration is made; if its draw is refused, the form says why and the host sets it up on its page.
      if (!celebration && drawBody) {
        try { await api(`/celebrations/${c.id}/draw`, { method: 'POST', body: drawBody }); } catch (err) { setMade({ c, why: message(err) }); return; }
      }
      onDone(celebration ? undefined : c);
    } catch (err) { setError(message(err)); } finally { guard.end(); }
  };
  if (made) {
    return (
      <>
        <Notice kind="error" title={`${made.c.name} is added, without its draw`}>{made.why}</Notice>
        <p className="hint">Set up the draw on the celebration’s page with other options.</p>
        <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => onDone(made.c)}>Open {made.c.name}</button>
      </>
    );
  }
  return (
    <form onSubmit={save} noValidate>
      <fieldset className="ks-posters">
        <legend className="field-label">Poster</legend>
        {POSTERS.map((p) => (
          <label key={p} className="ks-poster-option">
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
      <div className="fields fields-2">
        <Field label="Date" id={`${id}-d`}><input className="input" id={`${id}-d`} type="date" value={date} required onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Place" id={`${id}-p`} hint="Optional."><input className="input" id={`${id}-p`} value={place} maxLength={80} onChange={(e) => setPlace(e.target.value)} aria-describedby={`${id}-p-hint`} /></Field>
      </div>
      <Switch label="Every year" hint={yearly ? 'On: it comes back each year, and its wishes follow.' : 'Off: once, on this day.'} checked={yearly} onChange={(v) => { setYearly(v); setTouchedYearly(true); }} />
      <fieldset className="ks-checks">
        <legend className="field-label">For whom</legend>
        <p className="hint">Whose wishes it has: the birthday person, or everyone at Christmas.</p>
        <span className="ks-checks-row">
          {household.people.map((p) => (
            <Check key={p.id} label={p.id === me.id ? `${p.name} (you)` : p.name} checked={people.includes(p.id)} onChange={(on) => {
              setPeople(on ? [...people, p.id] : people.filter((x) => x !== p.id));
              if (on && (p.role !== 'kid' || draw.kidsDraw)) setDraw({ ...draw, people: [...draw.people, p.id] });
            }} />
          ))}
        </span>
      </fieldset>
      {!celebration && (
        <>
          <Switch label="Draw names" hint={drawing ? 'On: each person draws someone to give to; only they learn who.' : 'Off: no draw (you can set one up later).'} checked={drawing} onChange={(v) => {
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
