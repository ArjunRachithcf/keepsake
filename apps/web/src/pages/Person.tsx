// A person's page as a giver sees it (spec §4): their sizes and likes (dated), celebration chips, their list; the
// keeper (the person, a kid's parent) changes it, anyone else suggests. Claims, ideas and questions come later.
import { useCallback, useEffect, useId, useState } from 'react';
import { api, message, type Celebration, type PersonPage, type Profile, type Size, type Wish } from '../api';
import { since } from '../format';
import { roleLabel, useHousehold } from '../household';
import { Chips, Field, Group, Link, Loading, Notice, PageHead, Sheet } from '../ui';
import { WishForm, WishRow } from '../wish';

export function Person({ id }: { id: string }) {
  const { me } = useHousehold();
  const [chip, setChip] = useState('all');
  const [page, setPage] = useState<PersonPage | null>(null);
  const [all, setAll] = useState<Celebration[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ wish?: Wish; for?: string | null } | 'profile' | null>(null);
  const load = useCallback(async () => {
    try {
      setPage(await api<PersonPage>(`/people/${id}${chip === 'all' ? '' : `?for=${encodeURIComponent(chip)}`}`));
      setAll((await api<{ upcoming: Celebration[]; past: Celebration[] }>('/celebrations')).upcoming);
      setError(null);
    } catch (e) { setError(message(e)); }
  }, [id, chip]);
  useEffect(() => { void load(); }, [load]);

  const back = <Link to="/family" className="back">‹ Family</Link>;
  if (error) return <>{back}<Notice kind="error">{error}</Notice></>;
  if (!page) return <>{back}<Loading /></>;
  const p = page.person;
  const self = p.id === me.id;
  const current = page.celebrations.find((c) => c.id === chip);
  const chips = [{ id: 'all', label: 'All' }, ...page.celebrations.map((c) => ({ id: c.id, label: c.name })), { id: 'any', label: 'Any time' }];
  const pr = page.profile;
  const hasProfile = pr.sizes.length + pr.likes.length + pr.pleaseNo.length > 0;

  return (
    <>
      {back}
      <PageHead title={self ? `${p.name} (you)` : p.name} sub={roleLabel(p)} action={page.keeps ? <button type="button" className="btn" onClick={() => setSheet('profile')}>Sizes and likes</button> : undefined} />
      {hasProfile ? (
        <Group title="Sizes and likes">
          {pr.sizes.length > 0 && <li className="row"><span className="row-title">Sizes</span><span className="row-sub">{pr.sizes.map((s) => `${s.label} ${s.value}`).join(' · ')}</span><span className="row-foot">{since(pr.sizesUpdatedAt)}</span></li>}
          {pr.likes.length > 0 && <li className="row"><span className="row-title">Likes</span><span className="row-sub">{pr.likes.join(' · ')}</span><span className="row-foot">{since(pr.likesUpdatedAt)}</span></li>}
          {pr.pleaseNo.length > 0 && <li className="row"><span className="row-title">Please no</span><span className="row-sub">{pr.pleaseNo.join(' · ')}</span><span className="row-foot">{since(pr.pleaseNoUpdatedAt)}</span></li>}
        </Group>
      ) : page.keeps && <p className="section hint">No sizes or likes yet.</p>}

      <div className="section"><Chips label={`Show ${p.name}’s wishes for`} value={chip} options={chips} onChange={setChip} /></div>
      <Group title={current ? `${p.name}’s list for ${current.name}` : chip === 'any' ? 'Any time' : `${p.name}’s wishes`}
        footer={current ? 'Their wishes for it and their any-time wishes.' : undefined}>
        {page.wishes.length === 0 && <li className="row"><span className="row-sub">No wishes here yet.</span></li>}
        {page.wishes.map((w) => <WishRow key={w.id} wish={w} celebrations={all} onChanged={load} onEdit={(x) => setSheet({ wish: x })} showFor={!current} />)}
        {!self && (
          <li className="row">
            <button type="button" className="row-button" onClick={() => setSheet({ for: current?.id ?? null })}>
              <span aria-hidden="true" className="plus">+</span> {page.keeps ? `Add a wish for ${p.name}` : `Suggest a wish for ${p.name}`}
            </button>
          </li>
        )}
      </Group>

      {page.keeps && !self && p.role === 'kid' && p.signsIn && (
        <p className="section">
          <button type="button" className="btn" onClick={() => { if (confirm(`Sign ${p.name} out on every device? Their passkeys stay.`)) api(`/people/${p.id}/sessions/end`, { method: 'POST' }).catch((e) => setError(message(e))); }}>
            Sign {p.name} out on every device
          </button>
        </p>
      )}

      <Sheet title={sheet === 'profile' ? 'Sizes and likes' : sheet?.wish ? 'Change the wish' : page.keeps ? 'New wish' : 'Suggest a wish'} open={sheet !== null} onClose={() => setSheet(null)}>
        {sheet === 'profile' && <ProfileForm personId={p.id} profile={pr} onDone={() => { setSheet(null); void load(); }} />}
        {sheet && sheet !== 'profile' && <WishForm personId={p.id} wish={sheet.wish} celebrations={all} initialFor={sheet.for} onDone={() => { setSheet(null); void load(); }} />}
      </Sheet>
    </>
  );
}

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

function ProfileForm({ personId, profile, onDone }: { personId: string; profile: Profile; onDone: () => void }) {
  const id = useId();
  const [sizes, setSizes] = useState(profile.sizes.map((s) => `${s.label}: ${s.value}`).join('\n'));
  const [likes, setLikes] = useState(profile.likes.join('\n'));
  const [pleaseNo, setPleaseNo] = useState(profile.pleaseNo.join('\n'));
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed: Size[] = [];
    for (const l of lines(sizes)) {
      const m = /^([^:]{1,40}):\s*(.{1,40})$/.exec(l);
      if (!m) return setError(`Sizes: one per line, like “Shoes: EU 38” (not “${l}”).`);
      parsed.push({ label: m[1]!.trim(), value: m[2]!.trim() });
    }
    try { await api(`/people/${personId}/profile`, { method: 'PUT', body: { sizes: parsed, likes: lines(likes), pleaseNo: lines(pleaseNo) } }); onDone(); } catch (err) { setError(message(err)); }
  };
  return (
    <form className="stack" onSubmit={save} noValidate>
      <Field label="Sizes" id={`${id}-s`} hint="One per line, like “Shoes: EU 38”. Each part shows the month it changed.">
        <textarea className="input" id={`${id}-s`} rows={4} value={sizes} onChange={(e) => setSizes(e.target.value)} aria-describedby={`${id}-s-hint`} />
      </Field>
      <Field label="Likes" id={`${id}-l`} hint="One per line.">
        <textarea className="input" id={`${id}-l`} rows={4} value={likes} onChange={(e) => setLikes(e.target.value)} aria-describedby={`${id}-l-hint`} />
      </Field>
      <Field label="Please no" id={`${id}-n`} hint="One per line: what not to give.">
        <textarea className="input" id={`${id}-n`} rows={3} value={pleaseNo} onChange={(e) => setPleaseNo(e.target.value)} aria-describedby={`${id}-n-hint`} />
      </Field>
      {error && <Notice kind="error">{error}</Notice>}
      <button type="submit" className="btn btn-primary btn-lg btn-block">Save</button>
    </form>
  );
}
