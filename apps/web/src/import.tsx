// The one-time import of the household's sheet (spec §5, ADR 0005), for admins: pick the "Gift List" tab saved as CSV,
// see the dry run (who each name is, which celebration each occasion is, the claims, the rows left out), map what is
// left, then import it all at once. The file stays in this page's memory only and is dropped once done.
import { useId, useState } from 'react';
import { api, message, type Celebration, type ImportDone, type ImportPlan } from './api';
import { useHousehold } from './household';
import { Field, Notice } from './ui';

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

export function ImportWizard({ celebrations }: { celebrations: Celebration[] }) {
  const { household } = useHousehold();
  const id = useId();
  const [csv, setCsv] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [people, setPeople] = useState<Record<string, string | null>>({});
  const [occasions, setOccasions] = useState<Record<string, string | null>>({});
  const [done, setDone] = useState<ImportDone | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    setCsv(text);
    await check(text, {}, {});
  };
  const apply = async () => {
    if (!csv || !confirm(`Import ${plan?.wishes} wishes and ${plan?.claims} claims? Do it once: there is no undo.`)) return;
    setBusy(true); setError(null);
    try { setDone(await api<ImportDone>('/import', { method: 'POST', body: { csv, people, occasions } })); setCsv(null); setPlan(null); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const mapPerson = (name: string, v: string) => { const next = { ...people, [name]: v === 'skip' ? null : v }; setPeople(next); void check(csv, next, occasions); };
  const mapOccasion = (name: string, v: string) => { const next = { ...occasions, [name]: v || null }; setOccasions(next); void check(csv, people, next); };

  return (
    <div className="stack">
      <h3 className="sub-title">Import the sheet, once</h3>
      <p className="hint">The “Gift List” tab saved as CSV (Person, Item, Link, Priority, Status, Bought by, Price, Occasion, Notes). First a dry run: nothing is written until you import. Keepsake keeps nothing of the file but the wishes and claims it makes.{household.currency ? '' : ' Set the currency first, or prices are left out.'}</p>
      <Field label="The CSV file" id={`${id}-f`}>
        <input className="input" id={`${id}-f`} type="file" accept=".csv,text/csv" onChange={(e) => void pick(e.target.files?.[0])} />
      </Field>
      {plan && (
        <>
          <p>{plan.rows} rows: {plan.wishes} wishes, {plan.claims} claims (Reserved rows), {plan.skipped.length} left out.</p>
          <table className="import-table">
            <caption className="sr-only">Names in the file</caption>
            <thead><tr><th scope="col">Name in the file</th><th scope="col">Rows</th><th scope="col">Is</th></tr></thead>
            <tbody>{plan.people.map((p) => (
              <tr key={p.name}><td>{p.name}</td><td>{p.rows}</td><td>
                <select className="input" aria-label={`Who ${p.name} is`} value={p.status === 'skipped' ? 'skip' : p.personId ?? ''} onChange={(e) => mapPerson(p.name, e.target.value)}>
                  {p.status === 'unmapped' && <option value="">Choose…</option>}
                  {household.people.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  <option value="skip">Skip their rows</option>
                </select>
              </td></tr>
            ))}</tbody>
          </table>
          <table className="import-table">
            <caption className="sr-only">Occasions in the file</caption>
            <thead><tr><th scope="col">Occasion</th><th scope="col">Rows</th><th scope="col">For</th></tr></thead>
            <tbody>{plan.occasions.map((o) => (
              <tr key={o.name}><td>{o.name}</td><td>{o.rows}</td><td>
                <select className="input" aria-label={`What ${o.name} is for`} value={o.celebrationId ?? ''} onChange={(e) => mapOccasion(o.name, e.target.value)}>
                  {celebrations.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  <option value="">Any time</option>
                </select>
              </td></tr>
            ))}</tbody>
          </table>
          {plan.buyers.some((b) => !b.personId) && <p className="hint">“Bought by” names that match nobody make no claim: {plan.buyers.filter((b) => !b.personId).map((b) => b.name).join(', ')}.</p>}
          {plan.skipped.length > 0 && <p className="hint">Left out: {counted(plan.skipped.map((s) => s.reason), REASONS).join('; ')} (rows {plan.skipped.slice(0, 20).map((s) => s.row).join(', ')}{plan.skipped.length > 20 ? '…' : ''}).</p>}
          {plan.warnings.length > 0 && <p className="hint">Imported with a change: {counted(plan.warnings.map((w) => w.kind), WARNINGS).join('; ')}.</p>}
          {!plan.ready && <Notice>Choose who each name is, or skip their rows, to import.</Notice>}
          <button type="button" className="btn btn-primary btn-block" disabled={!plan.ready || busy || plan.wishes === 0} onClick={() => void apply()}>Import {plan.wishes} wishes</button>
        </>
      )}
      {done && <Notice title="Imported">{done.wishes} wishes and {done.claims} claims; {done.skipped} rows left out. The sheet can be retired now.</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}
