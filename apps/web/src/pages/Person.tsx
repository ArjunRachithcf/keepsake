// A person's page as a giver sees it (spec §4): their sizes and likes (dated), celebration chips, their list; the
// keeper (the person, a kid's parent) changes it, anyone else suggests. A giver claims and chips in on each wish
// (gift.tsx); the server sends the gifts to givers only. Givers also see the person's answers (and ask anonymously)
// and the ideas others keep for them; the person's keepers see the links that share the list outside the family. An
// admin removes someone here, on their own page. On a desktop: the list on the left, the rest beside it.
import { useCallback, useEffect, useId, useState } from 'react';
import { api, message, type Celebration, type PersonPage, type Profile, type Size, type Wish } from '../api';
import { since } from '../format';
import { roleLabel, useHousehold } from '../household';
import { Icon } from '../icons';
import { useRows } from '../motion';
import { useGo } from '../router';
import { AddRow, Avatar, Chips, Field, Group, IconButton, Loading, Notice, PageHead, Sheet, TopLine, useBusy, useConfirm } from '../ui';
import { WishForm, WishRow } from '../wish';
import { AskSheet, IdeasGroup, QuestionsGroup } from '../questions';
import { RemindMe } from '../notify';
import { ShareLinks } from '../links';

export function Person({ id }: { id: string }) {
  const { me, household, reload } = useHousehold();
  const ask = useConfirm();
  const go = useGo();
  const [chip, setChip] = useState('all');
  const [page, setPage] = useRows<PersonPage>();
  const [all, setAll] = useState<Celebration[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ wish?: Wish; for?: string | null } | 'profile' | null>(null);
  const [asking, setAsking] = useState(false);
  const load = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([
        api<PersonPage>(`/people/${id}${chip === 'all' ? '' : `?for=${encodeURIComponent(chip)}`}`),
        api<{ upcoming: Celebration[]; past: Celebration[] }>('/celebrations'),
      ]);
      setAll(c.upcoming);
      setPage(p);
      setError(null);
    } catch (e) { setError(message(e)); }
  }, [id, chip, setPage]);
  useEffect(() => { void load(); }, [load]);

  const back = { to: '/family', label: 'Family' };
  if (error && !page) return <><TopLine back={back} /><PageHead title="Family" /><Notice kind="error">{error}</Notice></>;
  if (!page) return <><TopLine back={back} /><Loading /></>;
  const p = page.person;
  const self = p.id === me.id;
  const current = page.celebrations.find((c) => c.id === chip);
  const chips = [{ id: 'all', label: 'All' }, ...page.celebrations.map((c) => ({ id: c.id, label: c.name, poster: c.poster })), { id: 'any', label: 'Any time' }];
  const pr = page.profile;
  const hasProfile = pr.sizes.length + pr.likes.length + pr.pleaseNo.length > 0;
  const canAsk = Boolean(page.questions) && !page.keeps;
  const suggest = () => setSheet({ for: current?.id ?? null });
  const addLabel = page.keeps ? `Add a wish for ${p.name}` : `Suggest a wish for ${p.name}`;
  const canRemove = me.role === 'admin' && household.mode === 'standalone' && !self;

  const signOutKid = async () => {
    if (!(await ask({ title: `Sign ${p.name} out on every device?`, body: 'Their passkeys stay: they sign in again with one.', confirm: 'Sign out', dismiss: 'Not now' }))) return;
    api(`/people/${p.id}/sessions/end`, { method: 'POST' }).catch((e) => setError(message(e)));
  };
  const remove = async () => {
    if (!(await ask({ title: `Remove ${p.name}?`, body: `${p.name} and all their wishes leave the household, and their devices are signed out. This cannot be undone.`, confirm: `Remove ${p.name}`, dismiss: 'Keep them', destructive: true }))) return;
    try { await api(`/people/${p.id}`, { method: 'DELETE' }); await reload(); go('/family'); } catch (e) { setError(message(e)); }
  };

  return (
    <>
      <TopLine back={back} end={canAsk ? <IconButton icon="ask" label={`Ask ${p.name} something`} onClick={() => setAsking(true)} /> : undefined} />
      <PageHead title={self ? `${p.name} (you)` : p.name} ident={<Avatar id={p.id} name={p.name} size="xl" />}
        sub={<>{roleLabel(p)}{!self && page.wishes.some((w) => w.gift) && <span className="ks-wide"> · only people giving to {p.name} see who’s getting what</span>}</>}
        actions={<>
          {canAsk && <button type="button" className="btn" onClick={() => setAsking(true)}><Icon name="ask" />Ask {p.name} something</button>}
          {!self && <button type="button" className="btn btn-primary" onClick={suggest}><Icon name="plus" />{page.keeps ? 'Add a wish' : 'Suggest a wish'}</button>}
          {page.keeps && <button type="button" className="btn" onClick={() => setSheet('profile')}>Sizes and likes</button>}
        </>} />
      {error && <Notice kind="error">{error}</Notice>}

      <div className="ks-two">
        <div>
          <Chips label={`Show ${p.name}’s wishes for`} value={chip} options={chips} onChange={setChip} />
          <Group title={`${current ? `${p.name}’s list for ${current.name}` : chip === 'any' ? 'Any time' : `${p.name}’s wishes`} · ${page.wishes.length}`}
            footer={[current ? 'Their wishes for it and their any-time wishes.' : null,
              page.wishes.some((w) => w.gift) ? `${p.name} never sees who’s getting what. A wish given once is gone from every list.` : null].filter(Boolean).join(' ') || undefined}>
            {page.wishes.length === 0 && <li className="row"><span className="row-sub">No wishes here yet.</span></li>}
            {page.wishes.map((w) => <WishRow key={w.id} wish={w} celebrations={all} onChanged={load} onEdit={(x) => setSheet({ wish: x })} showFor={!current} />)}
            {!self && <AddRow label={addLabel} onClick={suggest} />}
          </Group>
          {page.questions && <QuestionsGroup name={p.name} questions={page.questions} onAsk={canAsk ? () => setAsking(true) : undefined} onChanged={load} />}
        </div>
        <div>
          {hasProfile ? (
            <Group title="Sizes and likes" head={page.keeps ? <button type="button" className="btn btn-plain ks-narrow" onClick={() => setSheet('profile')}>Change</button> : undefined}>
              {pr.sizes.map((s) => <li key={`s-${s.label}`} className="row"><span className="row-main"><span className="row-label">{s.label}</span></span><span className="row-value">{s.value}</span></li>)}
              {pr.likes.length > 0 && <li className="row"><span className="row-main"><span className="row-label">Likes</span><span className="row-foot">{since(pr.likesUpdatedAt)}</span></span><span className="row-value" style={{ whiteSpace: 'normal' }}>{pr.likes.join(', ')}</span></li>}
              {pr.pleaseNo.length > 0 && <li className="row"><span className="row-main"><span className="row-label">Please no</span><span className="row-foot">{since(pr.pleaseNoUpdatedAt)}</span></span><span className="row-value" style={{ whiteSpace: 'normal' }}>{pr.pleaseNo.join(', ')}</span></li>}
              {pr.sizes.length > 0 && pr.sizesUpdatedAt && <li className="row"><span className="row-foot">Sizes {since(pr.sizesUpdatedAt)}</span></li>}
            </Group>
          ) : page.keeps && (
            <Group title="Sizes and likes"><AddRow label="Add sizes and likes" onClick={() => setSheet('profile')} /></Group>
          )}
          {page.ideas && <IdeasGroup personId={p.id} name={p.name} ideas={page.ideas} onChanged={load} />}
          {!self && <RemindMe personId={p.id} name={p.name} days={page.reminder} onChanged={load} />}
          {/* Another grown-up shares someone's wishes (a kid's: a parent, who keeps the kid's list); never the person. */}
          {!self && me.role !== 'kid' && (p.role !== 'kid' || page.keeps) ? <ShareLinks personId={p.id} name={p.name} /> : null}
          {((page.keeps && !self && p.role === 'kid' && p.signsIn) || canRemove) && (
            <div className="ks-buttons">
              {page.keeps && !self && p.role === 'kid' && p.signsIn && <button type="button" className="btn btn-block" onClick={() => void signOutKid()}>Sign {p.name} out on every device</button>}
              {canRemove && <button type="button" className="btn btn-destructive btn-block" onClick={() => void remove()}>Remove {p.name}<span className="sr-only"> from the household</span></button>}
            </div>
          )}
        </div>
      </div>

      {canAsk && <AskSheet name={p.name} url={`/people/${p.id}/questions`} open={asking} onClose={() => setAsking(false)} onSent={() => void load()} />}
      <Sheet title={sheet === 'profile' ? 'Sizes and likes' : sheet?.wish ? 'Change the wish' : page.keeps ? `A wish for ${p.name}` : `Suggest a wish for ${p.name}`} open={sheet !== null} onClose={() => setSheet(null)}>
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
  const [saving, guard] = useBusy();
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed: Size[] = [];
    for (const l of lines(sizes)) {
      const m = /^([^:]{1,40}):\s*(.{1,40})$/.exec(l);
      if (!m) return setError(`Sizes: one per line, like “Shoes: EU 38” (not “${l}”).`);
      parsed.push({ label: m[1]!.trim(), value: m[2]!.trim() });
    }
    if (!guard.start()) return;
    try { await api(`/people/${personId}/profile`, { method: 'PUT', body: { sizes: parsed, likes: lines(likes), pleaseNo: lines(pleaseNo) } }); onDone(); } catch (err) { setError(message(err)); } finally { guard.end(); }
  };
  return (
    <form onSubmit={save} noValidate>
      <Field label="Sizes" id={`${id}-s`} hint="One per line, like “Shoes: EU 38”. Each part shows the month it changed.">
        <textarea className="textarea" id={`${id}-s`} rows={4} value={sizes} onChange={(e) => setSizes(e.target.value)} aria-describedby={`${id}-s-hint`} />
      </Field>
      <Field label="Likes" id={`${id}-l`} hint="One per line.">
        <textarea className="textarea" id={`${id}-l`} rows={4} value={likes} onChange={(e) => setLikes(e.target.value)} aria-describedby={`${id}-l-hint`} />
      </Field>
      <Field label="Please no" id={`${id}-n`} hint="One per line: what not to give.">
        <textarea className="textarea" id={`${id}-n`} rows={3} value={pleaseNo} onChange={(e) => setPleaseNo(e.target.value)} aria-describedby={`${id}-n-hint`} />
      </Field>
      {error && <Notice kind="error">{error}</Notice>}
      <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={saving}>Save</button>
    </form>
  );
}
