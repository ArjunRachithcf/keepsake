// Shared pieces on HomersLab's design system (UI round 4): page heads, inset grouped lists on glass, chips, notices,
// the app's sheets (never the browser's boxes), posters, fields, switches, the logo and the made-here link. Every
// control is a real button, link or form field; every sheet keeps the focus inside, closes on Escape and gives the
// focus back to what opened it.
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Poster as PosterName } from './api';
import { Icon, type IconName } from './icons';
import { still } from './motion';
import { takeMoved, useGo } from './router';
import lockup from './assets/horizontal.svg';
import lockupWhite from './assets/horizontal-white.svg';
import appIcon from './assets/symbol-app-icon.svg';

/** The browser tab's title: "My wishes · Keepsake", and only "Keepsake" for Keepsake's own pages. */
export const tabTitle = (title: string) => (title === 'Keepsake' || !title ? 'Keepsake' : `${title} · Keepsake`);

/**
 * A page's heading: names the browser tab, and after a move to this page takes the focus, so a screen reader says
 * where the person is now (the page itself keeps its scroll at the top).
 */
export function usePageTitle(title: string, heading: RefObject<HTMLHeadingElement | null>) {
  useEffect(() => {
    document.title = tabTitle(title);
    if (heading.current && takeMoved()) heading.current.focus({ preventScroll: true });
  }, [title, heading]);
}

/** The phone's top line: the small lockup (or the way back) and glass capsules for the page's actions. */
export function TopLine({ back, end, logo = !back }: { back?: { to: string; label: string }; end?: ReactNode; logo?: boolean }) {
  return (
    <div className="ks-top ks-narrow">
      {back && <Link to={back.to} className="topbar-back"><Icon name="chevronLeft" />{back.label}</Link>}
      {logo && <Logo size="sm" />}
      {end && <div className="ks-top-end">{end}</div>}
    </div>
  );
}

/** A row that adds something ("Add a wish for Christmas", "Ask Leo something"): the list's last row. */
export function AddRow({ label, onClick, icon = 'plus' }: { label: string; onClick: () => void; icon?: IconName }) {
  return (
    <li>
      <button type="button" className="row row-link row-action" onClick={onClick}>
        <span className="row-lead" style={{ color: 'var(--accent)' }}><Icon name={icon} className="icon icon-md" /></span>
        <span className="row-main"><span className="row-label">{label}</span></span>
      </button>
    </li>
  );
}

/** A glass capsule with an icon: a top line's action. */
export function IconButton({ icon, label, onClick, children }: { icon?: IconName; label: string; onClick: () => void; children?: ReactNode }) {
  return <button type="button" className="icon-btn" aria-label={label} onClick={onClick}>{children ?? (icon && <Icon name={icon} />)}</button>;
}

export function PageHead({ title, sub, eyebrow, actions, ident, wideSub }: {
  title: string; sub?: ReactNode; eyebrow?: ReactNode; actions?: ReactNode; ident?: ReactNode;
  /** The line under the title only from a tablet up (a phone's screen is short). */
  wideSub?: boolean;
}) {
  const h1 = useRef<HTMLHeadingElement>(null);
  usePageTitle(title, h1);
  const text = (
    <div>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1 ref={h1} tabIndex={-1}>{title}</h1>
      {sub && <p className={`page-sub${wideSub ? ' ks-wide' : ''}`}>{sub}</p>}
    </div>
  );
  return (
    <header className="ks-head">
      {ident ? <div className="page-ident">{ident}{text}</div> : text}
      {actions && <div className="page-actions ks-wide">{actions}</div>}
    </header>
  );
}

export function Group({ title, head, children, footer, label, lead }: {
  title?: string; head?: ReactNode; children: ReactNode; footer?: ReactNode; label?: string; lead?: 'sm' | 'md';
}) {
  const id = useId();
  return (
    <section className="ks-section" aria-labelledby={title ? id : undefined} aria-label={title ? undefined : label}>
      {title && <div className="group-head"><h2 id={id}>{title}</h2>{head}</div>}
      <ul className={`group glass${lead ? ` lead-${lead}` : ''}`}>{children}</ul>
      {footer && <p className="group-foot">{footer}</p>}
    </section>
  );
}

/** An in-app link that keeps the page (History API), still a real <a href>. */
export function Link({ to, className, children, ...rest }: { to: string; className?: string; children: ReactNode; 'aria-current'?: 'page' | undefined; 'aria-label'?: string }) {
  const go = useGo();
  return (
    <a href={to} className={className} {...rest} onClick={(e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      go(to);
    }}>{children}</a>
  );
}

export function Chips<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { id: T; label: string; poster?: PosterName }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="ks-chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" className="chip" aria-pressed={o.id === value} onClick={() => onChange(o.id)}>
          <Icon name="check" className="icon chip-check" />
          {o.poster && o.id !== value && <span className={`poster-small poster-${o.poster}`} aria-hidden="true" />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Notice({ kind = 'info', title, children }: { kind?: 'info' | 'error' | 'ok'; title?: string; children?: ReactNode }) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon name={kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info'} />
      <div className="notice-body">
        {title && <b>{title}</b>}
        {children}
      </div>
    </div>
  );
}

// ======================================================================== sheets

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** How long the kit's sheet takes to leave (its snappy spring); none under reduced motion. */
const LEAVE_MS = 420;

/**
 * The app's sheet: from the bottom on a phone, centred on a desktop, on a scrim that dims the page (the kit's .sheet
 * and .scrim, inside a native modal <dialog>, so the page behind is inert). It springs in when opened and out when
 * closed; Escape and the scrim ask to close (`onClose`); Tab stays inside; the focus goes back to what opened it.
 * `footer`: its named action buttons. While it leaves it keeps showing what it showed.
 */
export function Sheet({ title, sub, open, onClose, children, footer, icon, closable = true, wide }: {
  title: string; sub?: ReactNode; open: boolean; onClose: () => void; children?: ReactNode; footer?: ReactNode;
  icon?: ReactNode; closable?: boolean; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);
  const id = useId();
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const kept = useRef({ title, sub, children, footer, icon });
  if (open) kept.current = { title, sub, children, footer, icon };
  const k = kept.current;
  const close = useRef(onClose);
  close.current = onClose;

  if (open && !mounted) setMounted(true);

  useLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open) {
      if (!d.open) {
        opener.current = document.activeElement;
        if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
      }
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const done = () => {
      if (d.open) { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); }
      setMounted(false);
      const back = opener.current as HTMLElement | null;
      opener.current = null;
      if (back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
    };
    if (still()) { done(); return; }
    const t = setTimeout(done, LEAVE_MS);
    return () => clearTimeout(t);
  }, [open, mounted]);

  // Once it is shown (the kit's sheet is hidden until then, and hidden things take no focus): the first field, or the
  // sheet itself (never a destructive button by default).
  useEffect(() => {
    if (!shown || !panel.current) return;
    if (panel.current.contains(document.activeElement) && document.activeElement !== panel.current) return;
    const body = panel.current.querySelector('.sheet-body');
    const first = body?.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled])')
      ?? body?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current).focus({ preventScroll: true });
  }, [shown]);

  if (!mounted) return null;
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (open) close.current(); return; }
    if (e.key !== 'Tab' || !panel.current) return;
    const all = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!all.length) { e.preventDefault(); panel.current.focus(); return; }
    const first = all[0]!, last = all[all.length - 1]!;
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === panel.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (at === last || !panel.current.contains(at))) { e.preventDefault(); first.focus(); }
  };
  const body = k.children !== undefined && k.children !== null && k.children !== false;
  // In <body>, outside the page's markup: a sheet may be opened from inside a row.
  return createPortal(
    <dialog ref={ref} className="ks-dialog" aria-labelledby={`${id}-t`} aria-describedby={k.sub ? `${id}-s` : undefined}
      onCancel={(e) => { e.preventDefault(); if (open) close.current(); }} onKeyDown={onKey}>
      <div className={`scrim${shown ? ' is-open' : ''}`} onClick={() => { if (open) close.current(); }} aria-hidden="true" />
      <section ref={panel} className={`sheet${wide ? ' sheet-wide' : ''}${shown ? ' is-open' : ''}`} tabIndex={-1}>
        <span className="sheet-grab" aria-hidden="true" />
        <div className="sheet-head">
          <div className="sheet-head-text">
            {k.icon}
            <h2 className="sheet-title" id={`${id}-t`}>{k.title}</h2>
            {k.sub && <div className="sheet-sub" id={`${id}-s`}>{k.sub}</div>}
          </div>
          {closable && <button type="button" className="sheet-close" aria-label="Close" onClick={() => close.current()}><Icon name="x" /></button>}
        </div>
        {body && <div className="sheet-body">{k.children}</div>}
        {k.footer && <div className="sheet-foot">{k.footer}</div>}
      </section>
    </dialog>,
    document.body,
  );
}

/** A question the app asks before something that cannot be undone, in its own sheet. */
export interface Ask {
  title: string;
  body?: ReactNode;
  /** The action's own name: "Remove", "Revoke", "Import". */
  confirm: string;
  /** What leaving it is called: "Keep it", "Not yet"; "Cancel" only where something is cancelled. */
  dismiss: string;
  destructive?: boolean;
}
type Asker = (a: Ask) => Promise<boolean>;
const ConfirmContext = createContext<Asker>(async () => false);
export const useConfirm = () => useContext(ConfirmContext);

/** Holds the app's one question sheet; `useConfirm()` asks it and resolves with the answer. */
export function ConfirmHost({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<{ a: Ask; done: (v: boolean) => void } | null>(null);
  const asker = useCallback<Asker>((a) => new Promise<boolean>((resolve) => setAsk({ a, done: resolve })), []);
  const answer = (v: boolean) => { ask?.done(v); setAsk(null); };
  return (
    <ConfirmContext.Provider value={asker}>
      {children}
      <Sheet title={ask?.a.title ?? ''} open={ask !== null} onClose={() => answer(false)} closable={false}
        icon={ask?.a.destructive ? <span className="sheet-icon is-red" aria-hidden="true"><Icon name="alert" /></span> : undefined}
        sub={ask?.a.body}
        footer={ask && <>
          <button type="button" className="btn" onClick={() => answer(false)}>{ask.a.dismiss}</button>
          <button type="button" className={`btn ${ask.a.destructive ? 'btn-danger' : 'btn-primary'}`} onClick={() => answer(true)}>{ask.a.confirm}</button>
        </>} />
    </ConfirmContext.Provider>
  );
}

// ======================================================================== the rest

export const POSTER_LABEL: Record<PosterName, string> = { pine: 'Pine', berry: 'Berry', night: 'Night', gold: 'Gold' };

/** A celebration's poster: its colour with two lights (decorative; the name is always text beside or on it). */
export function Poster({ poster, children, small, className = '' }: { poster: PosterName; children?: ReactNode; small?: boolean; className?: string }) {
  return <div className={`poster${small ? ' poster-small' : ''} poster-${poster} ${className}`.trim()} aria-hidden={children ? undefined : true}>{children}</div>;
}

export function Field({ label, hint, children, id }: { label: string; hint?: ReactNode; children: ReactNode; id: string }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      {children}
      {hint && <p className="hint" id={`${id}-hint`}>{hint}</p>}
    </div>
  );
}

/** A switch with its label and, when it has one, a line saying what its state means. */
export function Switch({ label, checked, onChange, hint, row, disabled }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode; row?: boolean; disabled?: boolean;
}) {
  const id = useId();
  const body = (
    <>
      <span>
        <label htmlFor={id}>{label}</label>
        {hint && <span className="hint" id={`${id}-hint`}>{hint}</span>}
      </span>
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)}
        aria-describedby={hint ? `${id}-hint` : undefined} />
    </>
  );
  return row ? <li className="row ks-switch-row">{body}</li> : <div className="ks-switch-row">{body}</div>;
}

/** A labelled checkbox (tied to its name by id, so it is never read out as "on"). */
export function Check({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <span className="ks-check">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}>{label}</label>
    </span>
  );
}

export function Loading() {
  return <p className="loading" role="status">Loading…</p>;
}

/** The lockup from the logo kit: the teal one, and the white cut in dark mode. */
export function Logo({ size }: { size: 'sm' | 'side' | 'lg' }) {
  return (
    <span className={`ks-logo ks-logo-${size}`}>
      <img className="logo-l" src={lockup} alt="Keepsake" width="290" height="80" />
      <img className="logo-d" src={lockupWhite} alt="Keepsake" width="290" height="80" />
    </span>
  );
}

export function AppIcon({ small }: { small?: boolean }) {
  return <img className={`ks-app-icon${small ? ' is-sm' : ''}`} src={appIcon} alt="" width="96" height="96" />;
}

/** A person's avatar: their initial on their own hue (an identity, never data). */
export function Avatar({ id, name, size }: { id: string; name: string; size?: 'sm' | 'xl' }) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return <span className={`avatar${size ? ` avatar-${size}` : ''}`} style={{ '--h': h } as React.CSSProperties} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>;
}

/**
 * A link made here (a sign-in link, a guest link), shown right under what made it: what to do with it, the address,
 * and Copy. It is shown only now; the server keeps no copy.
 */
export function MadeLink({ title, url, children, indented }: { title: string; url: string; children?: ReactNode; indented?: boolean }) {
  const [copied, setCopied] = useState(false);
  const canCopy = typeof navigator !== 'undefined' && 'clipboard' in navigator;
  return (
    <li className={`ks-made${indented ? ' is-indented' : ''}`} role="status">
      <b>{title}</b>
      {children}
      <div className="cmd">
        <code>{url}</code>
        {canCopy && (
          <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true), () => undefined)}>
            <Icon name={copied ? 'check' : 'copy'} />{copied ? 'Copied' : 'Copy'}<span className="sr-only"> the address</span>
          </button>
        )}
      </div>
    </li>
  );
}
