// Icons: HomersLab's outline set (the vendored icons.js, window.HL_ICONS: fixed path data shipped with the app), plus
// the two Keepsake has and Homeward does not, the gift and the most-wanted star. Always decorative: the words beside an
// icon (or an aria-label on its button) say what it is.

const OWN: Record<string, string> = {
  gift: '<path d="M2.75 6.25h10.5v2H2.75zM3.75 8.25v5h8.5v-5M8 6.25v7"/><path d="M8 6.25C6.6 6.25 5 5.7 5 4.4c0-.75.6-1.15 1.15-1.15C7.2 3.25 8 6.25 8 6.25s.8-3 1.85-3c.55 0 1.15.4 1.15 1.15 0 1.3-1.6 1.85-3 1.85"/>',
  file: '<path d="M4 1.75h5.25L12.5 5v9.25H4z"/><path d="M9 1.75V5.25h3.5"/>',
};
const STAR = 'M8 1.6l1.95 4.1 4.45.55-3.3 3.05.85 4.4L8 11.5l-3.95 2.2.85-4.4L1.6 6.25l4.45-.55z';

export type IconName =
  | 'gift' | 'file' | 'people' | 'calendar' | 'ask' | 'key' | 'shield' | 'link' | 'copy' | 'check' | 'x' | 'plus'
  | 'chevronRight' | 'chevronLeft' | 'home' | 'more' | 'settings' | 'user' | 'signout' | 'bell' | 'info' | 'alert' | 'trash' | 'external' | 'sparkle' | 'lock';

const markup = (name: IconName) => OWN[name] ?? (typeof window !== 'undefined' ? window.HL_ICONS?.[name] : undefined) ?? '';

export function Icon({ name, className = 'icon' }: { name: IconName; className?: string }) {
  // The kit's own static path data, never anything a person typed.
  return <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false" dangerouslySetInnerHTML={{ __html: markup(name) }} />;
}

/** The most-wanted star, with its words for a screen reader. */
export function Star() {
  return <svg className="ks-star" viewBox="0 0 16 16" fill="currentColor" role="img" aria-label="Most wanted"><path d={STAR} /></svg>;
}
