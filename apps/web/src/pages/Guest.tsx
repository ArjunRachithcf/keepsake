// The guest page (spec §4, ADR 0009): what a share link or a personal draw link reaches, in a browser, without an
// account. The token is in the link's #fragment: it is taken out of the address bar before anything else happens and
// sent once in a POST for a short session, so no request line, log or history entry has it. Claims wait for the
// guest's name; a guest sees nobody's name on a gift, only their own.
import { useCallback, useEffect, useId, useState } from 'react';
import { api, ApiError, message, type AskedQuestion, type GuestPage, type Wish } from '../api';
import { day, host, money } from '../format';
import { GiftLine, isBought } from '../gift';
import { AskForm } from '../questions';
import { takeToken } from './SignIn';
import { Field, Group, Loading, Notice, PageHead, Poster, Sheet } from '../ui';

/** The token from the fragment, taken out of the address at once; kept for this page load (StrictMode asks twice). */
let taken: string | null | undefined;
const takeGuestToken = () => (taken === undefined ? (taken = takeToken()) : taken);

export function Guest() {
  const [token] = useState(takeGuestToken);
  const [page, setPage] = useState<GuestPage | null>(null);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);
  const load = useCallback(async (first = false) => {
    try {
      setPage(first && token ? await api<GuestPage>('/guest/session', { method: 'POST', body: { token } }) : await api<GuestPage>('/guest'));
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setEnded(true); else setError(message(e));
    }
  }, [token]);
  useEffect(() => { void load(true); }, [load]);

  if (ended) {
    return (
      <main className="screen" id="main"><PageHead title="Keepsake" />
        <Notice title="This link does not open anything (any more)">It may have been revoked, its celebration may be over, or it waits for a parent’s yes. Ask whoever sent it for a new one.</Notice>
      </main>
    );
  }
  if (error) return <main className="screen" id="main"><PageHead title="Keepsake" /><Notice kind="error">{error}</Notice></main>;
  if (!page) return <main className="screen" id="main"><Loading /></main>;

  const who = page.person?.name;
  const title = page.kind === 'share' ? `${who ?? 'Someone'}’s wishes` : page.celebration?.name ?? 'Your draw';
  const signOut = async () => { await api('/guest/sign-out', { method: 'POST' }).catch(() => undefined); setEnded(true); };
  return (
    <main className="screen" id="main">
      <PageHead title={title} eyebrow={page.name ? `Hello, ${page.name}` : 'By link'}
        sub={page.lastDay ? `This link works until ${day(page.lastDay)}.` : 'Shared with you by link.'} />
      {!page.name && <NameCard onDone={setPage} />}
      {page.kind === 'draw' && <GuestDraw page={page} onChanged={setPage} />}
      {page.person && (
        <>
          <Group title={page.kind === 'draw' ? `${who}’s list` : 'Their wishes'}
            footer={`Say you’ll get one and the others giving see it is taken, so nobody buys it twice. ${who} never sees who is getting what.`}>
            {page.wishes.length === 0 && <li className="row"><span className="row-sub">Nothing on the list yet.</span></li>}
            {page.wishes.map((w) => <GuestWish key={w.id} wish={w} currency={page.currency} named={Boolean(page.name)} onChanged={() => void load()} />)}
          </Group>
          <GuestQuestions questions={page.questions} name={who!} onAsk={() => setAsk(true)} />
        </>
      )}
      <p className="section"><button type="button" className="btn btn-block" onClick={() => void signOut()}>Leave this page</button></p>
      <Sheet title={`Ask ${who ?? ''}`} open={ask} onClose={() => setAsk(false)}>
        {who && <AskForm name={who} url="/guest/questions" onSent={() => void load()} />}
      </Sheet>
    </main>
  );
}

function NameCard({ onDone }: { onDone: (p: GuestPage) => void }) {
  const id = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try { onDone(await api<GuestPage>('/guest/name', { method: 'PUT', body: { name: name.trim() } })); } catch (err) { setError(message(err)); }
  };
  return (
    <form className="section notice notice-info guest-name" onSubmit={save} noValidate>
      <p className="notice-title">First, your name</p>
      <p>The family sees it on what you say you’ll get, never the person it’s for. Before you give it, you can look but not claim.</p>
      <Field label="Your name" id={`${id}-n`}><input className="input" id={`${id}-n`} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
      {error && <Notice kind="error">{error}</Notice>}
      <button type="submit" className="btn btn-primary" disabled={!name.trim()}>That’s me</button>
    </form>
  );
}

function GuestDraw({ page, onChanged }: { page: GuestPage; onChanged: (p: GuestPage) => void }) {
  const [error, setError] = useState<string | null>(null);
  const c = page.celebration;
  const d = page.draw;
  if (!c || !d) return null;
  const open = async () => { try { onChanged(await api<GuestPage>('/guest/draw/open', { method: 'POST' })); } catch (e) { setError(message(e)); } };
  return (
    <div className="section">
      <Poster poster={c.poster}>
        <p className="next-eyebrow">{[day(c.date), c.place].filter(Boolean).join(' · ')}</p>
        {!d.drawn && <p className="next-title">The names are not drawn yet</p>}
        {d.drawn && !d.opened && !d.canOpen && <p className="next-title">Everyone opens theirs together{d.drawTogetherAt ? `: ${new Date(d.drawTogetherAt).toLocaleString()}` : ''}</p>}
        {d.drawn && !d.opened && d.canOpen && <><p className="next-title">Your draw is ready</p><button type="button" className="btn btn-on-poster btn-lg" onClick={() => void open()}>Open your draw</button></>}
        {d.opened && <p className="next-title">You give to {page.person?.name ?? d.receiverGuest ?? 'someone'}</p>}
        <p className="next-sub">{d.drawn ? `${d.openedCount} of ${d.total} opened theirs` : `${d.total} drawing names`}{d.budgetMinor !== null && page.currency ? ` · budget ${money(d.budgetMinor, page.currency)}` : ''}</p>
      </Poster>
      {d.opened && d.receiverGuest && <p className="hint">{d.receiverGuest} joined by link too: they keep no list here.</p>}
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}

function GuestWish({ wish, currency, named, onChanged }: { wish: Wish; currency: string | null; named: boolean; onChanged: () => void }) {
  const meta = [wish.priceMinor !== null && currency ? money(wish.priceMinor, currency) : null, wish.quantity > 1 ? `${wish.quantity} wanted` : null, wish.link ? host(wish.link) : null].filter(Boolean).join(' · ');
  return (
    <li className="row wish-row">
      <div className="wish-main">
        <p className={`row-title${isBought(wish.gift) ? ' row-title-done' : ''}`}>{wish.mostWanted && <span className="star" aria-label="Most wanted" role="img">★</span>}{wish.name}</p>
        {meta && <p className="row-sub">{meta}</p>}
        {wish.note && <p className="row-note">{wish.note}</p>}
        {wish.link && <a className="row-sub" href={wish.link} target="_blank" rel="noopener noreferrer nofollow">Open the link</a>}
        {wish.gift && (named ? <GiftLine wish={wish} onChanged={onChanged} guest currency={currency} /> : wish.gift.left === 0 && <p className="gift-note">Someone is getting this</p>)}
      </div>
    </li>
  );
}

function GuestQuestions({ questions, name, onAsk }: { questions: AskedQuestion[]; name: string; onAsk: () => void }) {
  return (
    <Group title="Questions and answers" footer={`Anonymous: ${name} never learns who asked.`}>
      {questions.map((q) => (
        <li key={q.id} className="row">
          <span className="row-title">{q.text}{q.mine && <span className="badge">Yours</span>}</span>
          <span className="row-sub">{q.state === 'waiting' ? `Gets it ${day(q.on)} at 8:00` : q.state === 'answered' ? (q.wish ? `Answered with a wish: ${q.wish.name}` : q.answer) : q.state === 'declined' ? 'They’d rather not say' : 'No answer yet'}</span>
        </li>
      ))}
      <li className="row"><button type="button" className="row-button" onClick={onAsk}><span aria-hidden="true" className="plus">?</span> Ask {name} something</button></li>
    </Group>
  );
}
