// Anonymous questions (ADR 0008) and ideas (spec §3) on the screens: the Ask sheet (its promises, starter chips, the
// sent state), a person's answers, the questions waiting for you on My wishes, and the ideas kept for someone. The
// server never sends who asked; "yours" is all anyone learns, and only about their own.
import { useId, useState } from 'react';
import { api, message, type AskedQuestion, type Celebration, type Idea, type QuestionToAnswer } from './api';
import { day } from './format';
import { Chips, Field, Group, Notice, Sheet } from './ui';
import { WishForm } from './wish';

const STARTERS = ['Which size?', 'Which colour?', 'Do you have one already?', 'Big or small?', 'Something to do, or something to keep?'];

/** The Ask sheet's form: one question, its promises, then "sent". `url`: where it goes (a person's, or a guest's). */
export function AskForm({ name, url, onSent }: { name: string; url: string; onSent: () => void }) {
  const id = useId();
  const [text, setText] = useState('');
  const [sent, setSent] = useState<AskedQuestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { setSent(await api<AskedQuestion>(url, { method: 'POST', body: { text: text.trim() } })); onSent(); } catch (err) { setError(message(err)); } finally { setBusy(false); }
  };
  if (sent) {
    return (
      <div className="stack" role="status">
        <p className="sent-title">Sent</p>
        <p>{name} gets it tomorrow at 8:00, with the morning’s other questions. You’ll see the answer on {name}’s page.</p>
        <blockquote className="quote">{sent.text}</blockquote>
      </div>
    );
  }
  return (
    <form className="stack" onSubmit={send} noValidate>
      <ul className="promises">
        <li><strong>Anonymous.</strong> {name} never learns it was you. Nobody else does either.</li>
        <li><strong>Tomorrow at 8:00.</strong> Questions arrive together each morning, so the time gives nobody away.</li>
        <li><strong>One answer.</strong> No chat: everyone giving to {name} sees it.</li>
      </ul>
      <div className="section-tight"><Chips label="Start from" value={'' as string} options={STARTERS.map((s) => ({ id: s, label: s }))} onChange={(v) => setText(v)} /></div>
      <Field label={`Your question for ${name}`} id={`${id}-q`} hint="Up to 200 characters, about their wishes.">
        <textarea className="input" id={`${id}-q`} rows={3} maxLength={200} value={text} onChange={(e) => setText(e.target.value)} aria-describedby={`${id}-q-hint`} />
      </Field>
      {error && <Notice kind="error">{error}</Notice>}
      <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy || !text.trim()} aria-busy={busy}>Send it anonymously</button>
    </form>
  );
}

/** A person's questions as a giver sees them: answers for everyone giving; yours marked, with when it arrives. */
export function QuestionsGroup({ name, questions, onAsk, onChanged }: { name: string; questions: AskedQuestion[]; onAsk?: () => void; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const takeBack = async (q: AskedQuestion) => {
    if (!confirm('Take this question back?')) return;
    try { await api(`/questions/${q.id}`, { method: 'DELETE' }); onChanged(); } catch (e) { setError(message(e)); }
  };
  return (
    <Group title="Questions and answers" footer={`Asked anonymously: nobody learns who asked, ${name} included.`}>
      {questions.length === 0 && <li className="row"><span className="row-sub">No questions yet.</span></li>}
      {questions.map((q) => (
        <li key={q.id} className="row">
          <span className="row-title">{q.text}{q.mine && <span className="badge">Yours</span>}</span>
          <span className="row-sub">
            {q.state === 'waiting' && `Gets it ${day(q.on)} at 8:00`}
            {q.state === 'open' && 'No answer yet'}
            {q.state === 'declined' && 'They’d rather not say'}
            {q.state === 'answered' && (q.wish ? `Answered with a wish: ${q.wish.name}` : q.answer)}
          </span>
          {q.mine && q.state === 'waiting' && <button type="button" className="btn-text" onClick={() => void takeBack(q)}>Take it back</button>}
        </li>
      ))}
      {error && <li className="row"><p className="row-error" role="alert">{error}</p></li>}
      {onAsk && (
        <li className="row">
          <button type="button" className="row-button" onClick={onAsk}><span aria-hidden="true" className="plus">?</span> Ask {name} something</button>
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
          <li key={q.id} className="row">
            <span className="row-title">{q.text}</span>
            <span className="row-sub">{q.for.id === meId ? `Arrived ${day(q.on)}` : `For ${q.for.name} · arrived ${day(q.on)}`}</span>
            <div className="button-row">
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setSheet({ q, kind: 'answer' })}>Answer</button>
              <button type="button" className="btn btn-sm" onClick={() => setSheet({ q, kind: 'wish' })}>Add a wish instead</button>
              <button type="button" className="btn btn-sm" onClick={() => void decline(q)}>Rather not say<span className="sr-only">: {q.text}</span></button>
            </div>
          </li>
        ))}
      </Group>
      {error && <div className="section"><Notice kind="error">{error}</Notice></div>}
      <Sheet title={sheet?.kind === 'wish' ? 'Add a wish instead' : 'Answer'} open={sheet !== null} onClose={() => setSheet(null)}>
        {sheet?.kind === 'answer' && <AnswerForm q={sheet.q} onDone={() => { setSheet(null); onChanged(); }} />}
        {sheet?.kind === 'wish' && (
          <div className="stack">
            <blockquote className="quote">{sheet.q.text}</blockquote>
            <WishForm personId={sheet.q.for.id} celebrations={celebrations} answering={sheet.q.id} onDone={() => { setSheet(null); onChanged(); }} />
          </div>
        )}
      </Sheet>
    </>
  );
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
    <form className="stack" onSubmit={send} noValidate>
      <blockquote className="quote">{q.text}</blockquote>
      <Field label="Your answer" id={`${id}-a`} hint="One answer: everyone giving to you sees it.">
        <textarea className="input" id={`${id}-a`} rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} aria-describedby={`${id}-a-hint`} />
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
        <li key={i.id} className="row row-inline">
          <span className="row-text">
            <span className="row-title">{i.text}</span>
            <span className="row-sub">{i.mine ? 'Yours' : i.by ? `From ${i.by.name}` : 'From someone giving'}</span>
          </span>
          {i.mine && <button type="button" className="btn btn-sm" onClick={() => void run(() => api(`/ideas/${i.id}`, { method: 'DELETE' }))}>Remove<span className="sr-only"> {i.text}</span></button>}
        </li>
      ))}
      <li className="row">
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/people/${personId}/ideas`, { method: 'POST', body: { text: text.trim() } }); setText(''); }); }}>
          <label className="sr-only" htmlFor={`${id}-i`}>An idea for {name}</label>
          <input className="input" id={`${id}-i`} maxLength={200} placeholder={`An idea for ${name}`} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
          <button type="submit" className="btn" disabled={!text.trim()}>Keep it</button>
        </form>
        {error && <p className="row-error" role="alert">{error}</p>}
      </li>
    </Group>
  );
}
