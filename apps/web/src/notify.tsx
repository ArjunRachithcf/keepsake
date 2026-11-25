// What is new (ADR 0010): the notices on My wishes, push on this device (Family), "Remind me" (a person's page) and
// writing a thank-you. A push itself says only "Something new in Keepsake" (public/sw.js); what it was about is read
// here, through the API, as the person.
import { useCallback, useEffect, useId, useState } from 'react';
import { api, message, type Notice as NoticeT, type Notices, type PushInfo, type Thanks } from './api';
import { day } from './format';
import { b64uToBytes, freshSubscription, syncSubscription, type PushServer } from './push';
import { useHousehold } from './household';
import { Group, Link, Notice, Switch } from './ui';

function noticeText(n: NoticeT, you: (id: string | undefined) => string): { text: string; to: string | null } {
  const c = n.celebration;
  switch (n.kind) {
    case 'question': return { text: n.person && you(n.person.id) !== 'You' ? `A question reached ${n.person.name}` : 'A question reached you', to: '/' };
    case 'answered': return { text: `${n.person?.name ?? 'Someone'} answered your question`, to: n.person ? `/family/${n.person.id}` : null };
    case 'draw': return { text: c ? `Names are drawn for ${c.name}: open yours` : 'Names are drawn: open yours', to: c ? `/celebrations/${c.id}` : null };
    case 'remind': return { text: n.person ? `${n.person.name}’s ${c?.name ?? 'celebration'} is coming` : `${c?.name ?? 'A celebration'} is coming`, to: n.person ? `/family/${n.person.id}` : c ? `/celebrations/${c.id}` : null };
    case 'reveal': return { text: c ? `${c.name}: everyone’s draw is shown now` : 'A draw is shown now', to: c ? `/celebrations/${c.id}` : null };
    case 'say_thanks': return { text: c ? `Your ${c.name} gifts are here: say thank you` : 'Gifts are here: say thank you', to: null };
    case 'thanked': return { text: `${n.person?.name ?? 'Someone'} thanked you`, to: null };
  }
}

/** The notices at the top of My wishes, while any is unread; "Seen" marks them read. */
export function NoticesGroup({ refresh }: { refresh: number }) {
  const { name } = useHousehold();
  const [data, setData] = useState<Notices | null>(null);
  const [all, setAll] = useState(false);
  const load = useCallback(async () => { try { setData(await api<Notices>('/notices')); } catch { setData(null); } }, []);
  useEffect(() => { void load(); }, [load, refresh]);
  if (!data || (!data.unread && !all)) return data?.notices.length ? <p className="section"><button type="button" className="btn-text" onClick={() => setAll(true)}>Earlier news</button></p> : null;
  const shown = all ? data.notices : data.notices.filter((n) => !n.read);
  const seen = async () => { await api('/notices/read', { method: 'POST' }).catch(() => undefined); setAll(false); await load(); };
  return (
    <Group title={all ? 'News' : `New (${data.unread})`} footer={data.unread ? <button type="button" className="btn-text" onClick={seen}>Seen</button> : undefined}>
      {shown.map((n) => {
        const t = noticeText(n, (id) => (id ? name(id) : ''));
        return (
          <li key={n.id} className="row">
            {t.to ? <Link to={t.to} className="row-link"><span className="row-text"><span className="row-title">{t.text}</span><span className="row-sub">{day(n.on)}</span></span><span className="chevron" aria-hidden="true">›</span></Link>
              : <span className="row-text"><span className="row-title">{t.text}</span><span className="row-sub">{day(n.on)}</span></span>}
          </li>
        );
      })}
    </Group>
  );
}

const server: PushServer = {
  put: (subscription) => api('/push/subscription', { method: 'PUT', body: subscription }),
  drop: (endpoint) => api('/push/unsubscribe', { method: 'POST', body: { endpoint } }),
};

/** Sends this device's subscription again at the app's start and whenever it is shown (PR #12 review, M2, L7). */
export function useKeepSubscription(signedIn: boolean): void {
  useEffect(() => {
    if (!signedIn || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    let key: string | null | undefined;
    const sync = async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) return;
        key ??= (await api<PushInfo>('/push')).publicKey;
        await syncSubscription(reg.pushManager, key, server);
      } catch { /* the next start or showing tries again */ }
    };
    const shown = () => { if (document.visibilityState === 'visible') void sync(); };
    void sync();
    document.addEventListener('visibilitychange', shown);
    return () => document.removeEventListener('visibilitychange', shown);
  }, [signedIn]);
}

/** This device's push subscription, if the browser has one for Keepsake. */
async function currentSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Ends this device's subscription here and at the server (sign-out does this too). */
export async function unsubscribeThisDevice(): Promise<void> {
  const sub = await currentSubscription().catch(() => null);
  if (!sub) return;
  await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}

/** "Notifications on this device": a push says only "Something new in Keepsake", never what or who. */
export function PushSwitch() {
  const [info, setInfo] = useState<PushInfo | null>(null);
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  useEffect(() => {
    api<PushInfo>('/push').then(setInfo, () => setInfo(null));
    void currentSubscription().then((s) => setOn(Boolean(s)), () => setOn(false));
  }, []);
  if (!info) return null;
  const set = async (want: boolean) => {
    setError(null);
    try {
      if (!want) { await unsubscribeThisDevice(); setOn(false); return; }
      if (await Notification.requestPermission() !== 'granted') { setError('Notifications are blocked for Keepsake in this browser’s settings.'); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = await freshSubscription(reg.pushManager, b64uToBytes(info.publicKey!), server);
      await server.put(sub.toJSON());
      setOn(true);
    } catch (e) { setError(message(e)); }
  };
  return (
    <Group title="This device" footer={info.available
      ? 'A notification says only “Something new in Keepsake”: never a gift, a wish or a name. Open Keepsake to see what it is.'
      : 'This Keepsake does not send notifications. What is new shows on My wishes.'}>
      {info.available && supported && <li className="row"><Switch label="Notifications" checked={on} onChange={(v) => void set(v)} /></li>}
      {info.available && !supported && <li className="row"><span className="row-sub">This browser cannot show notifications from Keepsake (on an iPhone: add Keepsake to the Home Screen first).</span></li>}
      {error && <li className="row"><p className="row-error" role="alert">{error}</p></li>}
    </Group>
  );
}

const REMIND = [null, 1, 3, 7, 14, 30] as const;
/** "Remind me" before someone's celebrations: only you see it. */
export function RemindMe({ personId, name, days, onChanged }: { personId: string; name: string; days: number | null; onChanged: () => void }) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const set = async (v: string) => {
    setError(null);
    try { await api(`/people/${personId}/reminder`, { method: 'PUT', body: { days: v ? Number(v) : null } }); onChanged(); } catch (e) { setError(message(e)); }
  };
  return (
    <Group title="Remind me" footer={`A note on My wishes (and a notification, if this device has them) before each of ${name}’s celebrations, in the morning. Only you see it.`}>
      <li className="row row-inline">
        <label className="row-title" htmlFor={id}>Before {name}’s celebrations</label>
        <select className="input input-short" id={id} value={days ?? ''} onChange={(e) => void set(e.target.value)}>
          {REMIND.map((d) => <option key={String(d)} value={d ?? ''}>{d === null ? 'Off' : d === 1 ? 'A day before' : `${d} days before`}</option>)}
        </select>
      </li>
      {error && <li className="row"><p className="row-error" role="alert">{error}</p></li>}
    </Group>
  );
}

/** A received gift's thank-you: written once, it goes to everyone who gave it (named or not); you never learn who. */
export function ThankYou({ thanks, onChanged }: { thanks: Thanks; onChanged: () => void }) {
  const id = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (thanks.sent) return <p className="row-note">You said: “{thanks.sent.text}” ({day(thanks.sent.on)}{thanks.sent.by ? `, written by ${thanks.sent.by.name}` : ''})</p>;
  if (!open) return <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>Say thank you<span className="sr-only"> for {thanks.wish.name}</span></button>;
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api(`/wishes/${thanks.wish.id}/thanks`, { method: 'PUT', body: { text: text.trim() } }); onChanged(); } catch (err) { setError(message(err)); } finally { setBusy(false); }
  };
  return (
    <form className="stack" onSubmit={send}>
      <label className="field-label" htmlFor={id}>Your thank-you</label>
      <textarea className="input" id={id} rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} aria-describedby={`${id}-hint`} />
      <p className="hint" id={`${id}-hint`}>It goes to everyone who gave it, also those who kept it a surprise. You will not learn who they are. Once sent, it stays.</p>
      {error && <Notice kind="error">{error}</Notice>}
      <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()} aria-busy={busy}>Send</button>
    </form>
  );
}
