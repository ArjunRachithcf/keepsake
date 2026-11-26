// The one-time import of the household's sheet (spec §5, ADR 0005), for admins: pick the "Gift List" tab saved as CSV,
// see the dry run (who each name is, which celebration each occasion is, the claims, the rows left out), map what is
// left, then import it all at once, after the app's own sheet says what it will make. The file stays in this page's
// memory only and is dropped once done.
import { useId, useRef, useState } from 'react';
import { api, message, type Celebration, type ImportDone, type ImportPlan } from './api';
import { useHousehold } from './household';
import { Icon } from './icons';
import { Notice, Sheet } from './ui';

const MAX = 512 * 1024;
const REASONS: Record<ImportPlan['skipped'][number]['reason'], string> = {
  no_person: 'no person', no_item: 'no item', bought: 'already bought', person_skipped: 'their person skipped', person_unmapped: 'whose name is not mapped yet',
  item_too_long: 'an item over 120 characters', list_full: 'a list already full (300)',
};
const WARNINGS: Record<ImportPlan['warnings'][number]['kind'], string> = {
  link_dropped: 'a link that is not a web address (left out)', price_dropped: 'a price that is not a number, or no currency yet (left out)',
  buyer_unknown: '“Bought by” is nobody who could claim it (no claim made)', not_in_celebration: 'a celebration the person is not part of (any time instead)', note_cut: 'a note cut to 500 characters',
};
const counted = <K extends string>(xs: K[], words: Record<K, string>) =>
  Object.entries(xs.reduce<Record<string, number>>((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {})).map(([k, n]) => `${n} with ${words[k as K]}`);

/** "1 row", "2 rows"; "1 wish", "6 wishes"; "1 claim", "3 claims". */
export const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const rowsLeftOut = (n: number) => `${count(n, 'row', 'rows')} left out`;
const listNames = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

export function ImportWizard({ celebrations }: { celebrations: Celebration[] }) {
  const { household } = useHousehold();
  const id = useId();
  const file = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [people, setPeople] = useState<Record<string, string | null>>({});
  const [occasions, setOccasions] = useState<Record<string, string | null>>({});
  const [done, setDone] = useState<ImportDone | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const check = async (text = csv, p = people, o = occasions) => {
    if (!text) return;
    setBusy(true); setError(null);
    try { setPlan(await api<ImportPlan>('/import/dry-run', { method: 'POST', body: { csv: text, people: p, occasions: o } })); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const pick = async (f: File | undefined) => {
    setPlan(null); setDone(null); setPeople({}); setOccasions({});
    if (!f) return;
    if (f.size > MAX) return setError('The file is over 512 KB: save only the “Gift List” tab as CSV.');
    const text = await f.text();
    setCsv(text); setFileName(f.name);
    await check(text, {}, {});
  };
  const apply = async () => {
    if (!csv) return;
    setAsking(false);
    setBusy(true); setError(null);
    try { setDone(await api<ImportDone>('/import', { method: 'POST', body: { csv, people, occasions } })); setCsv(null); setPlan(null); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const mapPerson = (name: string, v: string) => { const next = { ...people, [name]: v === 'skip' ? null : v }; setPeople(next); void check(csv, next, occasions); };
  const mapOccasion = (name: string, v: string) => { const next = { ...occasions, [name]: v || null }; setOccasions(next); void check(csv, people, next); };
  const whose = plan ? plan.people.filter((p) => p.status !== 'skipped' && p.personId).map((p) => household.people.find((x) => x.id === p.personId)?.name ?? p.name) : [];
  const skippedNames = plan ? plan.people.filter((p) => p.status === 'skipped').map((p) => `${p.name}’s`) : [];
  const what = plan ? `Import ${count(plan.wishes, 'wish', 'wishes')}${plan.claims ? ` and ${count(plan.claims, 'claim', 'claims')}` : ''}` : '';

  return (
    <div className="ks-stack">
      <input ref={file} className="sr-only" tabIndex={-1} aria-hidden="true" type="file" accept=".csv,text/csv" onChange={(e) => void pick(e.target.files?.[0])} />
      <ul className="group glass">
        <li className="row">
          <span className="row-lead"><Icon name="file" className="icon icon-md" /></span>
          <span className="row-main">
            <span className="row-title">{fileName || 'The “Gift List” tab, as CSV'}</span>
            <span className="row-sub wrap">{plan
              ? `${count(plan.rows, 'row', 'rows')}: ${count(plan.wishes, 'wish', 'wishes')}, ${count(plan.claims, 'claim', 'claims')}, ${rowsLeftOut(plan.skipped.length)}`
              : 'Person, Item, Link, Priority, Status, Bought by, Price, Occasion, Notes'}</span>
          </span>
          <span className="row-trail"><button type="button" className="btn btn-sm" onClick={() => file.current?.click()}>{csv ? 'Choose another' : 'Choose the CSV file'}</button></span>
        </li>
        {plan?.people.map((p) => (
          <li key={`p-${p.name}`} className="row">
            <span className="row-main"><span className="row-label">{p.name} · {count(p.rows, 'row', 'rows')}</span></span>
            <label className="sr-only" htmlFor={`${id}-p-${p.name}`}>Who {p.name} is</label>
            <select className="select" style={{ width: 180 }} id={`${id}-p-${p.name}`} value={p.status === 'skipped' ? 'skip' : p.personId ?? ''} onChange={(e) => mapPerson(p.name, e.target.value)}>
              {p.status === 'unmapped' && <option value="">Choose…</option>}
              {household.people.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              <option value="skip">Skip their rows</option>
            </select>
          </li>
        ))}
        {plan?.occasions.map((o) => (
          <li key={`o-${o.name}`} className="row">
            <span className="row-main"><span className="row-label">{o.name} · {count(o.rows, 'row', 'rows')}</span></span>
            <label className="sr-only" htmlFor={`${id}-o-${o.name}`}>What {o.name} is for</label>
            <select className="select" style={{ width: 180 }} id={`${id}-o-${o.name}`} value={o.celebrationId ?? ''} onChange={(e) => mapOccasion(o.name, e.target.value)}>
              {celebrations.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="">Any time</option>
            </select>
          </li>
        ))}
      </ul>
      {plan && (
        <>
          {plan.buyers.some((b) => !b.personId) && <p className="hint">“Bought by” names that match nobody make no claim: {plan.buyers.filter((b) => !b.personId).map((b) => b.name).join(', ')}.</p>}
          {plan.skipped.length > 0 && <p className="hint">Left out: {counted(plan.skipped.map((s) => s.reason), REASONS).join('; ')} ({plan.skipped.length === 1 ? 'row' : 'rows'} {plan.skipped.slice(0, 20).map((s) => s.row).join(', ')}{plan.skipped.length > 20 ? '…' : ''}).</p>}
          {plan.warnings.length > 0 && <p className="hint">Imported with a change: {counted(plan.warnings.map((w) => w.kind), WARNINGS).join('; ')}.</p>}
          {!plan.ready && <Notice>Choose who each name is, or skip their rows, to import.</Notice>}
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-primary" disabled={!plan.ready || busy || plan.wishes === 0} onClick={() => setAsking(true)}>{what}…</button>
          </div>
          <Sheet title={`${what}?`} sub="Do it once: there is no undo. Keepsake keeps nothing of the file but the wishes and claims it makes." open={asking} onClose={() => setAsking(false)}
            footer={<>
              <button type="button" className="btn" onClick={() => setAsking(false)}>Not yet</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void apply()}>Import</button>
            </>}>
            <ul className="group">
              <li className="row"><span className="row-lead"><Icon name="gift" className="icon icon-md" /></span><span className="row-main"><span className="row-title">{count(plan.wishes, 'wish', 'wishes')}</span>{whose.length > 0 && <span className="row-sub wrap">For {listNames(whose)}</span>}</span></li>
              {plan.claims > 0 && <li className="row"><span className="row-lead"><Icon name="check" className="icon icon-md" /></span><span className="row-main"><span className="row-title">{count(plan.claims, 'claim', 'claims')}</span><span className="row-sub wrap">From the Reserved and Bought rows; only the people giving see them</span></span></li>}
              {plan.skipped.length > 0 && <li className="row"><span className="row-lead"><Icon name="x" className="icon icon-md" /></span><span className="row-main"><span className="row-title">{rowsLeftOut(plan.skipped.length)}</span>{skippedNames.length > 0 && <span className="row-sub wrap">{listNames(skippedNames)}, as you chose</span>}</span></li>}
            </ul>
          </Sheet>
        </>
      )}
      {done && <Notice kind="ok" title="Imported">{count(done.wishes, 'wish', 'wishes')} and {count(done.claims, 'claim', 'claims')}; {rowsLeftOut(done.skipped)}. The sheet can be retired now.</Notice>}
      {!household.currency && <p className="hint">Set the currency first, or prices are left out.</p>}
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}
