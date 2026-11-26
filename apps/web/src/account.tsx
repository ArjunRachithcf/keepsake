// The account (the avatar in a phone's top line, the account row at the sidebar's foot): who you are, the glass level
// on this device, notifications on this device, and standalone your passkeys, another device and signing out. The
// passkeys and signing out show on Family too (the design's board 5a).
import { createContext, useContext, useEffect, useState } from 'react';
import { api, message, type OneTimeLink, type Passkeys } from './api';
import { day, weekdayDate } from './format';
import { roleLabel, useHousehold } from './household';
import { GLASS_LEVELS, savedGlass, setGlass, type GlassLevel } from './motion';
import { PushSwitch } from './notify';
import { Avatar, Group, MadeLink, Notice, Sheet, useConfirm } from './ui';

/** Opens the account sheet. */
export const AccountContext = createContext<() => void>(() => undefined);
export const useAccount = () => useContext(AccountContext);

export function AccountSheet({ open, onClose, onSignOut }: { open: boolean; onClose: () => void; onSignOut?: () => void }) {
  const { me } = useHousehold();
  return (
    <Sheet title={me.name} sub={roleLabel(me)} open={open} onClose={onClose} icon={<Avatar id={me.id} name={me.name} size="xl" />}>
      <GlassLevel />
      <PushSwitch />
      {onSignOut && <You onSignOut={onSignOut} />}
    </Sheet>
  );
}

/** The glass level of this device: Clear, Balanced, Frosted or Solid (kept in this browser only). */
export function GlassLevel() {
  const [level, setLevel] = useState<GlassLevel>(savedGlass);
  const pick = (v: GlassLevel) => { setLevel(v); setGlass(v); };
  const pos = GLASS_LEVELS.findIndex((l) => l.id === level);
  return (
    <section className="ks-section ks-glass-pick" aria-labelledby="glass-level">
      <div className="group-head"><h2 id="glass-level">Glass level</h2></div>
      <div className="segmented" role="radiogroup" aria-labelledby="glass-level" style={{ '--n': 4, '--pos': pos } as React.CSSProperties}>
        <span className="segmented-thumb" aria-hidden="true" />
        {GLASS_LEVELS.map((l) => (
          <button key={l.id} type="button" role="radio" aria-checked={l.id === level} onClick={() => pick(l.id)}>{l.label}</button>
        ))}
      </div>
      <p className="group-foot">How much the bars and sheets let through on this device. Words stay readable at every level; Solid has no glass at all.</p>
    </section>
  );
}

/** Standalone: your passkeys (remove one: its sessions end; the last stays), another device, sign out, everywhere. */
export function You({ onSignOut }: { onSignOut: () => void }) {
  const ask = useConfirm();
  const [link, setLink] = useState<OneTimeLink | null>(null);
  const [keys, setKeys] = useState<Passkeys['passkeys']>([]);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<Passkeys>('/me/passkeys').then((p) => setKeys(p.passkeys), (e) => setError(message(e)));
  useEffect(() => { void load(); }, []);
  const run = async (f: () => Promise<unknown>) => { setError(null); try { await f(); } catch (e) { setError(message(e)); } };
  const remove = async (k: Passkeys['passkeys'][number]) => {
    if (!(await ask({ title: `Remove the passkey “${k.label}”?`, body: 'The devices it signed in are signed out. You keep your other passkeys.', confirm: 'Remove', dismiss: 'Keep it', destructive: true }))) return;
    void run(async () => { await api(`/me/passkeys/${encodeURIComponent(k.id)}`, { method: 'DELETE' }); await load(); });
  };
  const everywhere = async () => {
    if (!(await ask({ title: 'Sign out everywhere?', body: 'Every device you are signed in on, this one too. Your passkeys stay: sign in again with one.', confirm: 'Sign out everywhere', dismiss: 'Stay signed in', destructive: true }))) return;
    void run(async () => { await api('/me/sessions/end', { method: 'POST' }); onSignOut(); });
  };
  return (
    <>
      <Group title="Your passkeys" footer="Removing one signs out the devices it signed in. Your last one stays.">
        {keys.map((k) => (
          <li className="row" key={k.id} data-row={k.id}>
            <span className="row-main">
              <span className="row-title">{k.label}</span>
              <span className="row-sub">{[k.lastUsedAt ? `Used ${day(k.lastUsedAt)}` : 'Not used yet', k.invitedBy ? `from ${k.invitedBy}’s invite` : null].filter(Boolean).join(' · ')}</span>
            </span>
            {keys.length > 1 && (
              <span className="row-trail"><button type="button" className="btn btn-plain btn-sm" onClick={() => void remove(k)}>Remove<span className="sr-only"> {k.label}</span></button></span>
            )}
          </li>
        ))}
      </Group>
      <section className="ks-buttons" aria-label="Your devices">
        <button type="button" className="btn btn-block" onClick={() => void run(async () => setLink(await api<OneTimeLink>('/me/passkeys/invite', { method: 'POST' })))}>Sign in on another device</button>
        {link && (
          <ul className="group glass">
            <MadeLink title="A one-time link for your other device" url={link.url}>
              <p>Open it there, until {weekdayDate(link.expiresAt)}. It works once.</p>
            </MadeLink>
          </ul>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        <button type="button" className="btn btn-block" onClick={onSignOut}>Sign out</button>
        <button type="button" className="btn btn-destructive btn-block" onClick={() => void everywhere()}>Sign out everywhere</button>
      </section>
    </>
  );
}

/** The avatar in a phone's top line: opens the account sheet. */
export function AccountButton() {
  const { me } = useHousehold();
  const open = useAccount();
  return <button type="button" className="icon-btn" aria-label={`${me.name}, your account`} onClick={open}><Avatar id={me.id} name={me.name} /></button>;
}
