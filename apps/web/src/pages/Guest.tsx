// The guest page (spec §4, ADR 0009): what a share link or a personal draw link reaches, in a browser, without an
// account. The token is in the link's #fragment: nothing is sent until the guest taps Open (review L-1: a mail scanner
// that renders the page spends nothing); then it is taken out of the address bar and sent once in a POST, so no request
// line, log or history entry has it. A link opens on one device only (review N2, M-a): the first exchange spends it
// and records this browser, which can open its links again; the page's address then names the link (?link=), and every
// guest request carries it. Claims wait for the guest's name; a guest sees nobody's name on a gift, only their own.
import { useCallback, useEffect, useId, useState } from 'react';
import { api, ApiError, message, setGuestLink, type AskedQuestion, type GuestPage, type Wish } from '../api';
import { day, host, money, since } from '../format';
import { GiftLine, isBought } from '../gift';
import { AskForm } from '../questions';
import { Field, Group, Loading, Notice, PageHead, Poster, Sheet } from '../ui';

/** The link's token, still in the fragment until Open; null without one. */
const tokenInAddress = () => { const t = location.hash.slice(1); return /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null; };
/** The link this address names once opened. */
const linkInAddress = () => new URLSearchParams(location.search).get('link');
/** The one exchange of this page load: a link opens on one device, so it is never sent twice at once. */
let exchanged: Promise<GuestPage> | undefined;
const exchange = (token: string) => (exchanged ??= api<GuestPage>('/guest/session', { method: 'POST', body: { token } }));

export function Guest() {
  const [token] = useState(tokenInAddress);
  const [page, setPage] = useState<GuestPage | null>(null);
  const [ended, setEnded] = useState<'ended' | 'elsewhere' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);
  const failed = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) setEnded('ended');
    else if (e instanceof ApiError && e.status === 409) setEnded('elsewhere');
    else setError(message(e));
  };
  const load = useCallback(async () => {
    try { setPage(await api<GuestPage>('/guest')); setError(null); } catch (e) { failed(e); }
  }, []);
  // An address that names its link (opened here before): its page. One with a token waits for Open.
  useEffect(() => {
    const link = linkInAddress();
    if (token) return;
    if (!link) { setEnded('ended'); return; }
    setGuestLink(link);
    void load();
  }, [token, load]);
  const open = async () => {
    try {
      const p = await exchange(token!);
      setGuestLink(p.link);
      history.replaceState(null, '', `${location.pathname}?link=${encodeURIComponent(p.link)}`);
      setPage(p);
    } catch (e) {
      history.replaceState(null, '', location.pathname);
      failed(e);
    }
  };

  if (ended) {
    return (
      <main className="screen" id="main"><PageHead title="Keepsake" />
        {ended === 'elsewhere'
          ? <Notice title="This link was opened on another device">A link opens on one device only, and it was opened on another one before. If that wasn’t you, tell whoever sent it: they can give the same link a new address, and you keep everything you did with it.</Notice>
          : <Notice title="This link does not open anything (any more)">It may have been revoked, given a new address, or its celebration may be over. Ask whoever sent it for a new address.</Notice>}
      </main>
    );
  }
  if (error) return <main className="screen" id="main"><PageHead title="Keepsake" /><Notice kind="error">{error}</Notice></main>;
  if (!page && token) {
    return (
      <main className="screen" id="main"><PageHead title="Keepsake" eyebrow="By link" sub="Someone shared a wish list with you." />
        <Notice title="This link opens on one device">Open it on the phone or computer you’ll use for it: after that it opens only there.</Notice>
        <p className="section"><button type="button" className="btn btn-block btn-lg" onClick={() => void open()}>Open</button></p>
      </main>
    );
  }
  if (!page) return <main className="screen" id="main"><Loading /></main>;

  const who = page.person?.name;
  const title = page.kind === 'share' ? `${who ?? 'Someone'}’s wishes` : page.celebration?.name ?? 'Your draw';
  const signOut = async () => {
    if (!confirm('Forget it for good? The link opens on one device only: after this it opens nowhere, until whoever sent it gives it a new address.')) return;
    await api('/guest/sign-out', { method: 'POST' }).catch(() => undefined);
    setEnded('ended');
  };
  return (
    <main className="screen" id="main">
      <PageHead title={title} eyebrow={page.name ? `Hello, ${page.name}` : 'By link'}
        sub={page.lastDay ? `This link works until ${day(page.lastDay)}.` : 'Shared with you by link.'} />
      {page.reissued && (
        <Notice title={`This link got a new address on ${day(page.reissued.on)}`}>
          {page.reissued.count > 1 ? `It has had ${page.reissued.count} new addresses. ` : ''}
          {page.reissued.earlierLastUsedOn
            ? `The earlier one was last opened on ${day(page.reissued.earlierLastUsedOn)}. If that wasn’t you, tell whoever sent it.`
            : 'The earlier one was never opened.'}
        </Notice>
      )}
      {!page.name && <NameCard onDone={setPage} />}
      {page.kind === 'draw' && <GuestDraw page={page} onChanged={setPage} />}
      {page.person && (
        <>
          <Group title={page.kind === 'draw' ? `${who}’s list` : 'Their wishes'}
            footer={`Say you’ll get one and the others giving see it is taken, so nobody buys it twice. ${who} never sees who is getting what.`}>
            {page.wishes.length === 0 && <li className="row"><span className="row-sub">Nothing on the list yet.</span></li>}
            {page.wishes.map((w) => <GuestWish key={w.id} wish={w} currency={page.currency} named={Boolean(page.name)} onChanged={() => void load()} />)}
          </Group>
          <GuestProfile page={page} name={who!} />
          <GuestQuestions questions={page.questions} name={who!} onAsk={() => setAsk(true)} />
        </>
      )}
      <p className="section"><button type="button" className="btn btn-block" onClick={() => void signOut()}>Forget this link on this device</button></p>
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

/** The person's sizes, likes and "please no", read-only: what a giver buying clothes needs. */
function GuestProfile({ page, name }: { page: GuestPage; name: string }) {
  const pr = page.profile;
  if (!pr || pr.sizes.length + pr.likes.length + pr.pleaseNo.length === 0) return null;
  return (
    <Group title="Sizes and likes" footer={`Kept by ${name}'s family.`}>
      {pr.sizes.length > 0 && <li className="row"><span className="row-title">Sizes</span><span className="row-sub">{pr.sizes.map((s) => `${s.label} ${s.value}`).join(' · ')}</span><span className="row-foot">{since(pr.sizesUpdatedAt)}</span></li>}
      {pr.likes.length > 0 && <li className="row"><span className="row-title">Likes</span><span className="row-sub">{pr.likes.join(' · ')}</span><span className="row-foot">{since(pr.likesUpdatedAt)}</span></li>}
      {pr.pleaseNo.length > 0 && <li className="row"><span className="row-title">Please no</span><span className="row-sub">{pr.pleaseNo.join(' · ')}</span><span className="row-foot">{since(pr.pleaseNoUpdatedAt)}</span></li>}
    </Group>
  );
}
