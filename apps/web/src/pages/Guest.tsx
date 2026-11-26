// The guest page (spec §4, ADR 0009): what a share link or a personal draw link reaches, in a browser, without an
// account. The token is in the link's #fragment: nothing is sent until the guest taps Open (review L-1: a mail scanner
// that renders the page spends nothing); then it is taken out of the address bar and sent once in a POST, so no request
// line, log or history entry has it. A link opens on one device only (review N2, M-a): the first exchange spends it
// and records this browser, which can open its links again; the page's address then names the link (?link=), and every
// guest request carries it. Claims wait for the guest's name; a guest sees nobody's name on a gift, only their own.
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { api, ApiError, message, setGuestLink, type AskedQuestion, type GuestPage, type Wish } from '../api';
import { dateTime, day, host, money, numericDate, since, weekdayDate } from '../format';
import { GiftLine, isBought } from '../gift';
import { Icon, Star } from '../icons';
import { AskSheet } from '../questions';
import { Field, Loading, Logo, Notice, PageHead, tabTitle, useConfirm } from '../ui';

/** The link's token, still in the fragment until Open; null without one. */
const tokenInAddress = () => { const t = location.hash.slice(1); return /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null; };
/** The link this address names once opened. */
const linkInAddress = () => new URLSearchParams(location.search).get('link');
/** The one exchange of this page load: a link opens on one device, so it is never sent twice at once. */
let exchanged: Promise<GuestPage> | undefined;
const exchange = (token: string) => (exchanged ??= api<GuestPage>('/guest/session', { method: 'POST', body: { token } }));

/** The guest's frame: the lockup and "Shared by link", then the page. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="ks-auth" id="main">
      <div className="ks-guest">
        <div className="ks-auth-bar">
          <span className="ks-narrow"><Logo size="sm" /></span>
          <span className="ks-wide"><Logo size="side" /></span>
          <span className="pill"><Icon name="link" />Shared by link<span className="ks-wide">&nbsp;· opens on this device only</span></span>
        </div>
        {children}
      </div>
    </main>
  );
}

export function Guest() {
  const ask = useConfirm();
  const [token] = useState(tokenInAddress);
  const [page, setPage] = useState<GuestPage | null>(null);
  const [ended, setEnded] = useState<'ended' | 'elsewhere' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
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
  useEffect(() => { if (!page) document.title = tabTitle('Keepsake'); }, [page]);
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
      <Frame>
        <PageHead title={ended === 'elsewhere' ? 'Opened on another device' : 'This link does not open'} />
        {ended === 'elsewhere'
          ? <Notice title="A link opens on one device only">It was opened on another one before. If that wasn’t you, tell whoever sent it: they can give the same link a new address, and you keep everything you did with it.</Notice>
          : <Notice title="It opens nothing (any more)">It may have been revoked, given a new address, or its celebration may be over. Ask whoever sent it for a new address.</Notice>}
      </Frame>
    );
  }
  if (error) return <Frame><PageHead title="Keepsake" /><Notice kind="error">{error}</Notice></Frame>;
  if (!page && token) {
    return (
      <Frame>
        <PageHead title="Someone shared a wish list with you" eyebrow="By link" />
        <section className="glass-thick ks-auth-card" style={{ maxWidth: 520 }} aria-label="Open the link">
          <Notice title="This link opens on one device">Open it on the phone or computer you’ll use for it: after that it opens only there.</Notice>
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => void open()}>Open</button>
        </section>
      </Frame>
    );
  }
  if (!page) return <Frame><Loading /></Frame>;

  const who = page.person?.name;
  const title = page.kind === 'share' ? `${who ?? 'Someone'}’s wishes` : page.celebration?.name ?? 'Your draw';
  const forget = async () => {
    if (!(await ask({ title: 'Forget this link on this device?', body: 'It opens on one device only: after this it opens nowhere, until whoever sent it gives it a new address.', confirm: 'Forget it', dismiss: 'Keep it', destructive: true }))) return;
    await api('/guest/sign-out', { method: 'POST' }).catch(() => undefined);
    setEnded('ended');
  };
  const named = Boolean(page.name);
  return (
    <Frame>
      <PageHead title={title} eyebrow={page.name ? `Hello, ${page.name}` : 'By link'}
        sub={`${who ? `Say you’ll get one and the others giving see it is taken, so nobody buys it twice. ${who} never sees who is getting what.` : ''}${page.lastDay ? ` This link works until ${numericDate(page.lastDay)}.` : ''}`} />
      {page.reissued && (
        <Notice title={`This link got a new address on ${day(page.reissued.on)}`}>
          {page.reissued.count > 1 ? `It has had ${page.reissued.count} new addresses. ` : ''}
          {page.reissued.earlierLastUsedOn
            ? `The earlier one was last opened on ${day(page.reissued.earlierLastUsedOn)}. If that wasn’t you, tell whoever sent it.`
            : 'The earlier one was never opened.'}
        </Notice>
      )}
      <div className="ks-two is-wide-rail is-guest">
        <div>
          {page.kind === 'draw' && <GuestDraw page={page} onChanged={setPage} />}
          {page.person && (
            <section className="ks-section" aria-labelledby="g-wishes">
              <h2 className="group-head" id="g-wishes">{page.kind === 'draw' ? `${who}’s list` : 'Wishes'} · {page.wishes.length}</h2>
              <ul className="group glass">
                {page.wishes.length === 0 && <li className="row"><span className="row-sub">Nothing on the list yet.</span></li>}
                {page.wishes.map((w) => <GuestWish key={w.id} wish={w} currency={page.currency} named={named} onChanged={() => void load()} />)}
              </ul>
              <p className="group-foot">A wish given once is gone from every list.</p>
            </section>
          )}
        </div>
        <div>
          {!named && <NameCard onDone={setPage} />}
          {page.person && <GuestProfile page={page} name={who!} />}
          {page.person && <GuestQuestions questions={page.questions} name={who!} onAsk={() => setAsking(true)} />}
          <button type="button" className="btn btn-block" style={{ height: 44, background: 'var(--mat-thick)' }} onClick={() => void forget()}>Forget this link on this device</button>
        </div>
      </div>
      {who && <AskSheet name={who} url="/guest/questions" open={asking} onClose={() => setAsking(false)} onSent={() => void load()} canTakeBack={false} />}
    </Frame>
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
    <form className="glass-thick ks-auth-card ks-name-first" style={{ padding: 20, gap: 12, borderRadius: 'var(--radius-card)' }} onSubmit={save} noValidate aria-labelledby={`${id}-h`}>
      <h2 className="headline" id={`${id}-h`}>First, your name</h2>
      <p id="name-first" style={{ color: 'var(--text-2)' }}>The family sees it on what you say you’ll get, never on the person it’s for. Until you give your name, you can look but not claim.</p>
      <Field label="Your name" id={`${id}-n`}><input className="input" id={`${id}-n`} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
      {error && <Notice kind="error">{error}</Notice>}
      <button type="submit" className="btn btn-primary btn-block" disabled={!name.trim()}>That’s me</button>
    </form>
  );
}

function GuestDraw({ page, onChanged }: { page: GuestPage; onChanged: (p: GuestPage) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  useEffect(() => { if (!revealing) return; const t = setTimeout(() => setRevealing(false), 900); return () => clearTimeout(t); }, [revealing]);
  const c = page.celebration;
  const d = page.draw;
  if (!c || !d) return null;
  const open = async () => { try { onChanged(await api<GuestPage>('/guest/draw/open', { method: 'POST' })); setRevealing(true); } catch (e) { setError(message(e)); } };
  const budget = d.budgetMinor !== null && page.currency ? ` Budget about ${money(d.budgetMinor, page.currency)}.` : '';
  return (
    <div className="ks-stack">
      <div className={`draw-card${d.opened ? ' is-open' : ''}${revealing ? ' is-revealing' : ''}`}>
        <p className="poster-eyebrow">{[weekdayDate(c.date), c.place].filter(Boolean).join(' · ')}</p>
        {!d.drawn && <p className="draw-title">Not drawn yet</p>}
        {d.drawn && !d.opened && !d.canOpen && <p className="draw-title">Opens together</p>}
        {d.drawn && !d.opened && d.canOpen && <p className="draw-title">Who will it be?</p>}
        {d.opened && <><p className="poster-eyebrow" style={{ marginTop: 8 }}>You give to</p><p className="draw-title" aria-live="polite">{page.person?.name ?? d.receiverGuest ?? 'someone'}</p></>}
        <p className="poster-sub">
          {d.drawn && !d.opened && !d.canOpen && d.drawTogetherAt ? `Everyone opens theirs at once: ${dateTime(d.drawTogetherAt)}. ` : ''}
          {d.drawn ? `${d.openedCount} of ${d.total} opened theirs.` : `${d.total} drawing names.`}{budget}
        </p>
        {d.drawn && !d.opened && d.canOpen && <button type="button" className="btn btn-lg" onClick={() => void open()}>Open your draw</button>}
      </div>
      {d.opened && d.receiverGuest && <p className="hint">{d.receiverGuest} joined by link too: they keep no list here.</p>}
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}

function GuestWish({ wish, currency, named, onChanged }: { wish: Wish; currency: string | null; named: boolean; onChanged: () => void }) {
  const meta = [wish.priceMinor !== null && currency ? money(wish.priceMinor, currency) : null, wish.quantity > 1 ? `${wish.quantity} wanted` : null, wish.link ? host(wish.link) : null].filter(Boolean).join(' · ');
  return (
    <li className="row ks-wish" data-row={wish.id}>
      <span className="row-main">
        <span className={`row-title${isBought(wish.gift) ? ' is-done' : ''}`}>{wish.mostWanted && <Star />}{wish.name}</span>
        {meta && <span className="row-sub">{meta}</span>}
        {wish.note && <span className="row-note">{wish.note}</span>}
        {wish.gift && (named
          ? <GiftLine wish={wish} onChanged={onChanged} guest currency={currency} />
          : wish.gift.left === 0
            ? <span className="ks-taken is-other">Someone is getting this</span>
            : <span className="ks-wish-actions"><button type="button" className="btn btn-sm" disabled aria-describedby="name-first">I’ll get it</button></span>)}
        {wish.link && <span className="ks-wish-actions"><a className="btn btn-sm btn-plain" href={wish.link} target="_blank" rel="noopener noreferrer nofollow">Open the link<span className="sr-only"> for {wish.name} (another site)</span></a></span>}
      </span>
    </li>
  );
}

function GuestQuestions({ questions, name, onAsk }: { questions: AskedQuestion[]; name: string; onAsk: () => void }) {
  return (
    <section className="ks-section" aria-labelledby="g-q">
      <h2 className="group-head" id="g-q">Questions and answers</h2>
      <ul className="group glass">
        {questions.map((q) => (
          <li key={q.id} className="row is-top">
            <span className="row-main">
              <span className="row-title wrap">{q.text}{q.mine && <span className="badge">Yours</span>}</span>
              <span className="row-sub wrap">{q.state === 'waiting' ? `${name} gets it ${day(q.on)} at 8:00` : q.state === 'answered' ? (q.wish ? `Answered with a wish: ${q.wish.name}` : `“${q.answer}”`) : q.state === 'declined' ? 'They’d rather not say' : 'No answer yet'}</span>
            </span>
          </li>
        ))}
        <li>
          <button type="button" className="row row-link row-action" onClick={onAsk}>
            <span className="row-lead" style={{ color: 'var(--accent)' }}><Icon name="ask" className="icon icon-md" /></span>
            <span className="row-main"><span className="row-label">Ask {name} something</span></span>
            <Icon name="chevronRight" className="icon row-chev" />
          </button>
        </li>
      </ul>
      <p className="group-foot">Anonymous: {name} never learns who asked. Questions arrive with the next morning’s batch at 8:00.</p>
    </section>
  );
}

/** The person's sizes, likes and "please no", read-only: what a giver buying clothes needs. */
function GuestProfile({ page, name }: { page: GuestPage; name: string }) {
  const pr = page.profile;
  if (!pr || pr.sizes.length + pr.likes.length + pr.pleaseNo.length === 0) return null;
  return (
    <section className="ks-section" aria-labelledby="g-s">
      <h2 className="group-head" id="g-s">Sizes and likes</h2>
      <ul className="group glass">
        {pr.sizes.map((s) => <li key={s.label} className="row"><span className="row-main"><span className="row-label">{s.label}</span></span><span className="row-value">{s.value}</span></li>)}
        {pr.likes.length > 0 && <li className="row"><span className="row-main"><span className="row-label">Likes</span></span><span className="row-value" style={{ whiteSpace: 'normal' }}>{pr.likes.join(', ')}</span></li>}
        {pr.pleaseNo.length > 0 && <li className="row"><span className="row-main"><span className="row-label">Please no</span></span><span className="row-value" style={{ whiteSpace: 'normal' }}>{pr.pleaseNo.join(', ')}</span></li>}
      </ul>
      <p className="group-foot">Kept by {name}’s family{pr.sizesUpdatedAt ? `; sizes ${since(pr.sizesUpdatedAt)}` : ''}.</p>
    </section>
  );
}
