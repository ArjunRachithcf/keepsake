// Shared pieces in Keepsake's iOS look (spec §4): inset grouped lists, rows, chips, sheets, posters, notices. Every
// control is a real button, link or form field, at least 44 px tall.
import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { Poster as PosterName } from './api';
import { useGo } from './router';

export function PageHead({ title, sub, eyebrow, action }: { title: string; sub?: ReactNode; eyebrow?: string; action?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-head-row">
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1 className="large-title">{title}</h1>
        </div>
        {action}
      </div>
      {sub && <p className="page-sub">{sub}</p>}
    </header>
  );
}

export function Group({ title, children, footer, label }: { title?: string; children: ReactNode; footer?: ReactNode; label?: string }) {
  const id = useId();
  return (
    <section className="section" aria-labelledby={title ? id : undefined} aria-label={title ? undefined : label}>
      {title && <h2 className="group-header" id={id}>{title}</h2>}
      <ul className="group">{children}</ul>
      {footer && <p className="group-footer">{footer}</p>}
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

export function Chips<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" className="chip" aria-pressed={o.id === value} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Notice({ kind = 'info', title, children }: { kind?: 'info' | 'error'; title?: string; children?: ReactNode }) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {title && <p className="notice-title">{title}</p>}
      {children && <div className="notice-body">{children}</div>}
    </div>
  );
}

/** A sheet: the native modal <dialog> (focus kept inside, Escape closes, the page behind inert). */
export function Sheet({ title, open, onClose, children }: { title: string; open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="sheet" aria-labelledby={id} onClose={onClose} onCancel={onClose}>
      <div className="sheet-head">
        <button type="button" className="btn-text" onClick={onClose}>Cancel</button>
        <h2 className="sheet-title" id={id}>{title}</h2>
        <span className="sheet-spacer" aria-hidden="true" />
      </div>
      <div className="sheet-body">{open && children}</div>
    </dialog>
  );
}

export const POSTER_LABEL: Record<PosterName, string> = { pine: 'Pine', berry: 'Berry', night: 'Night', gold: 'Gold' };

/** A celebration's poster: its colour with two lights (decorative; the name is always text beside or on it). */
export function Poster({ poster, children, small }: { poster: PosterName; children?: ReactNode; small?: boolean }) {
  return <div className={`poster poster-${poster}${small ? ' poster-small' : ''}`} aria-hidden={children ? undefined : true}>{children}</div>;
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

export function Switch({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  const id = useId();
  return (
    <div className="switch-row">
      <label htmlFor={id} className="switch-label">{label}{hint && <span className="hint">{hint}</span>}</label>
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}

export function Loading() {
  return <p className="loading" role="status">Loading…</p>;
}
