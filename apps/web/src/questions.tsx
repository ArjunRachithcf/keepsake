// Anonymous questions (ADR 0008) and ideas (spec §3) on the screens: the Ask sheet (its promises, starter chips, then
// "Sent, anonymously" with Done), a person's answers, the questions waiting for you on My wishes, and the ideas kept
// for someone. The server never sends who asked; "yours" is all anyone learns, and only about their own.
import { useEffect, useId, useState } from 'react';
import { api, message, type AskedQuestion, type Celebration, type Celebrations, type Idea, type QuestionToAnswer } from './api';
import { day } from './format';
import { Icon } from './icons';
import { Chips, Field, Group, Notice, Sheet, useConfirm, useBusy } from './ui';
import { WishForm } from './wish';

const STARTERS = ['Which size?', 'Which colour?', 'Do you have one already?', 'Big or small?', 'Something to do, or something to keep?'];

/**
 * The Ask sheet: one question and its promises; once sent, "Sent, anonymously" says when it arrives, with "Take it
 * back" (a member's, while it waits) and "Done". `url`: where it goes (a person's, or a guest's).
 */
export function AskSheet({ name, url, open, onClose, onSent, canTakeBack = true }: {
  name: string; url: string; open: boolean; onClose: () => void; onSent: () => void; canTakeBack?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [sent, setSent] = useState<AskedQuestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, guard] = useBusy();
  useEffect(() => { if (open) { setText(''); setSent(null); setError(null); } }, [open]);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!guard.start()) return; setError(null);
    try { setSent(await api<AskedQuestion>(url, { method: 'POST', body: { text: text.trim() } })); onSent(); } catch (err) { setError(message(err)); } finally { guard.end(); }
  };
  const takeBack = async () => {
    if (!sent) return;
    if (!guard.start()) return; setError(null);
    try { await api(`/questions/${sent.id}`, { method: 'DELETE' }); onSent(); onClose(); } catch (err) { setError(message(err)); } finally { guard.end(); }
  };
  // One sheet throughout: once sent it turns into "Sent, anonymously", with Done.
  return (
    <Sheet open={open} onClose={onClose} closable={!sent}
      title={sent ? 'Sent, anonymously' : `Ask ${name}`}
      icon={sent ? <span className="sheet-icon" aria-hidden="true"><Icon name="check" /></span> : undefined}
      sub={sent ? `${name} gets it ${day(sent.on)} at 8:00, with the morning’s other questions. You’ll see the answer on ${name}’s page.` : 'Anonymously: nobody learns it was you.'}
      footer={sent ? <>
        {canTakeBack && sent.state === 'waiting' && <button type="button" className="btn" disabled={busy} onClick={() => void takeBack()}>Take it back</button>}
        <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>Done</button>
      </> : undefined}>
      {sent ? (
        <>
          <ul className="group"><li className="row is-top"><span className="row-main"><span className="row-sub">Your question</span><span className="row-title wrap">{sent.text}</span></span></li></ul>
          {error && <Notice kind="error">{error}</Notice>}
        </>
      ) : (
        <form onSubmit={send} noValidate>
          <ul className="ks-promises">
            <li><Icon name="shield" /><span><b>Anonymous.</b><small>{name} never learns it was you. Nobody else does either.</small></span></li>
            <li><Icon name="calendar" /><span><b>Tomorrow at 8:00.</b><small>Questions arrive together each morning, so the time gives nobody away.</small></span></li>
            <li><Icon name="ask" /><span><b>One answer.</b><small>No chat: everyone giving to {name} sees it.</small></span></li>
          </ul>
          <Chips label="Start from" value={'' as string} options={STARTERS.map((s) => ({ id: s, label: s }))} onChange={(v) => setText(v)} />
          <Field label={`Your question for ${name}`} id={`${id}-q`} hint="Up to 200 characters, about their wishes.">
            <textarea className="textarea" id={`${id}-q`} rows={3} maxLength={200} value={text} onChange={(e) => setText(e.target.value)} aria-describedby={`${id}-q-hint`} />
          </Field>
          {error && <Notice kind="error">{error}</Notice>}
          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy || !text.trim()} aria-busy={busy}>Send it anonymously</button>
        </form>
      )}
    </Sheet>
  );
}

const asked = (q: AskedQuestion) => q.state === 'waiting' ? `${q.mine ? 'Arrives' : 'Gets it'} ${day(q.on)} at 8:00, with the morning’s other questions`
  : q.state === 'open' ? 'No answer yet'
    : q.state === 'declined' ? 'They’d rather not say'
      : q.wish ? `Answered with a wish: ${q.wish.name}` : `“${q.answer}”`;

/** A person's questions as a giver sees them: answers for everyone giving; yours marked, with when it arrives. */
export function QuestionsGroup({ name, questions, onAsk, onChanged }: { name: string; questions: AskedQuestion[]; onAsk?: () => void; onChanged: () => void }) {
  const ask = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const takeBack = async (q: AskedQuestion) => {
    if (!(await ask({ title: 'Take this question back?', body: `“${q.text}” never reaches ${name}.`, confirm: 'Take it back', dismiss: 'Leave it' }))) return;
    try { await api(`/questions/${q.id}`, { method: 'DELETE' }); onChanged(); } catch (e) { setError(message(e)); }
  };
  return (
    <Group title="Questions and answers" footer={`Asked anonymously: nobody learns who asked, ${name} included. Everyone giving to ${name} sees the answers.`}>
      {questions.length === 0 && <li className="row"><span className="row-sub">No questions yet.</span></li>}
      {questions.map((q) => (
        <li key={q.id} className="row is-top" data-row={q.id}>
          <span className="row-main">
            <span className="row-title wrap">{q.text}{q.mine && <span className="badge">Yours</span>}</span>
            <span className="row-sub wrap">{asked(q)}</span>
          </span>
          {q.mine && q.state === 'waiting' && <span className="row-trail"><button type="button" className="btn btn-plain btn-sm" onClick={() => void takeBack(q)}>Take it back</button></span>}
        </li>
      ))}
      {error && <li className="row"><p className="row-error" role="alert">{error}</p></li>}
      {onAsk && (
        <li>
          <button type="button" className="row row-link row-action" onClick={onAsk}>
            <span className="row-lead" style={{ color: 'var(--accent)' }}><Icon name="ask" className="icon icon-md" /></span>
            <span className="row-main"><span className="row-label">Ask {name} something</span></span>
            <Icon name="chevronRight" className="icon row-chev" />
          </button>
        </li>
      )}
    </Group>
  );
}

/** The questions waiting for you (and for your kids) on My wishes: answer, add a wish instead, or rather not. */
export function HomeQuestions({ questions, meId, celebrations, onChanged }: { questions: QuestionToAnswer[]; meId: string; celebrations: Celebration[]; onChanged: () => void }) {
  const [sheet, setSheet] = useState<{ q: QuestionToAnswer; kind: 'answer' | 'wish' } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!questions.length) return null;
  const decline = async (q: QuestionToAnswer) => {
    try { await api(`/questions/${q.id}/decline`, { method: 'POST' }); onChanged(); } catch (e) { setError(message(e)); }
  };
  return (
    <>
      <Group title="Questions for you" footer="Someone giving to you asked. You never learn who, and nobody else does. Everyone giving to you sees your answer.">
        {questions.map((q) => (
          <li key={q.id} className="row is-top" data-row={q.id}>
            <span className="row-main">
              <span className="row-title wrap">{q.text}</span>
              <span className="row-sub">{q.for.id === meId ? `Arrived ${day(q.on)}` : `For ${q.for.name} · arrived ${day(q.on)}`}</span>
              <span className="ks-wish-actions">
                <button type="button" className="btn btn-sm btn-primary" onClick={() => setSheet({ q, kind: 'answer' })}>Answer</button>
                <button type="button" className="btn btn-sm" onClick={() => setSheet({ q, kind: 'wish' })}>Add a wish instead</button>
                <button type="button" className="btn btn-sm btn-plain" onClick={() => void decline(q)}>Rather not say<span className="sr-only">: {q.text}</span></button>
              </span>
            </span>
          </li>
        ))}
      </Group>
      {error && <Notice kind="error">{error}</Notice>}
      <Sheet title={sheet?.kind === 'wish' ? 'Add a wish instead' : 'Answer'} sub={sheet ? `“${sheet.q.text}”` : undefined} open={sheet !== null} onClose={() => setSheet(null)}>
        {sheet?.kind === 'answer' && <AnswerForm q={sheet.q} onDone={() => { setSheet(null); onChanged(); }} />}
        {sheet?.kind === 'wish' && (sheet.q.for.id === meId
          ? <WishForm personId={meId} celebrations={celebrations} answering={sheet.q.id} onDone={() => { setSheet(null); onChanged(); }} />
          : <KidWish q={sheet.q} onDone={() => { setSheet(null); onChanged(); }} />)}
      </Sheet>
    </>
  );
}

/** A kid's question answered with a wish: the wish is the kid's, so it offers the kid's own celebrations. */
function KidWish({ q, onDone }: { q: QuestionToAnswer; onDone: () => void }) {
  const [cs, setCs] = useState<Celebration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<Celebrations>('/celebrations').then((r) => { if (live) setCs(r.upcoming.filter((c) => c.people.includes(q.for.id))); }, (e) => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [q.for.id]);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!cs) return <p className="hint">Loading…</p>;
  return <WishForm personId={q.for.id} celebrations={cs} answering={q.id} onDone={onDone} />;
}

function AnswerForm({ q, onDone }: { q: QuestionToAnswer; onDone: () => void }) {
  const id = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api(`/questions/${q.id}/answer`, { method: 'POST', body: { text: text.trim() } }); onDone(); } catch (err) { setError(message(err)); }
  };
  return (
    <form onSubmit={send} noValidate>
      <Field label="Your answer" id={`${id}-a`} hint="One answer: everyone giving to you sees it.">
        <textarea className="textarea" id={`${id}-a`} rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} aria-describedby={`${id}-a-hint`} />
      </Field>
      {error && <Notice kind="error">{error}</Notice>}
      <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={!text.trim()}>Send the answer</button>
    </form>
  );
}

/** Ideas kept for someone: the other grown-ups see them; the person and kids never do. */
export function IdeasGroup({ personId, name, ideas, onChanged }: { personId: string; name: string; ideas: Idea[]; onChanged: () => void }) {
  const id = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = async (f: () => Promise<unknown>) => { setError(null); try { await f(); onChanged(); } catch (e) { setError(message(e)); } };
  return (
    <Group title="Ideas" footer={`For the grown-ups giving to ${name}. ${name} never sees them, and neither do the kids.`}>
      {ideas.map((i) => (
        <li key={i.id} className="row" data-row={i.id}>
          <span className="row-main">
            <span className="row-title wrap">{i.text}</span>
            <span className="row-sub">{i.mine ? 'Yours' : i.by ? `From ${i.by.name}` : 'From someone giving'}</span>
          </span>
          {i.mine && <span className="row-trail"><button type="button" className="btn btn-plain btn-sm" onClick={() => void run(() => api(`/ideas/${i.id}`, { method: 'DELETE' }))}>Remove<span className="sr-only"> {i.text}</span></button></span>}
        </li>
      ))}
      <li className="row">
        <form className="row-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/people/${personId}/ideas`, { method: 'POST', body: { text: text.trim() } }); setText(''); }); }}>
          <label className="sr-only" htmlFor={`${id}-i`}>An idea for {name}</label>
          <input className="input" id={`${id}-i`} maxLength={200} placeholder={`An idea for ${name}`} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
          <button type="submit" className="btn btn-sm" disabled={!text.trim()}>Keep it</button>
        </form>
      </li>
      {error && <li className="row"><p className="row-error" role="alert">{error}</p></li>}
    </Group>
  );
}
