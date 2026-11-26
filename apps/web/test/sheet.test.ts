// @vitest-environment happy-dom
// The app's sheet (it replaces the browser's confirm and alert boxes): the focus goes inside when it opens, Tab stays
// inside, Escape asks to close, and the focus comes back to what opened it. useConfirm resolves with the answer.
import { act, createElement as h, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfirmHost, Sheet, useBusy, useConfirm } from '../src/ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const key = (el: Element, k: string, shift = false) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true })); });
const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; });

function Harness({ log }: { log: string[] }) {
  const [open, setOpen] = useState(false);
  return h('div', null,
    h('button', { type: 'button', onClick: () => setOpen(true) }, 'Open it'),
    h(Sheet, { title: 'A sheet', open, onClose: () => { log.push('close'); setOpen(false); },
      footer: h('button', { type: 'button' }, 'Last') },
    h('label', { htmlFor: 'f' }, 'A field'), h('input', { id: 'f' })));
}

describe('the app\'s sheet', () => {
  it('takes the focus inside when it opens, keeps Tab inside, closes on Escape and gives the focus back', async () => {
    const log: string[] = [];
    act(() => root.render(h(Harness, { log })));
    const opener = button('Open it');
    opener.focus();
    act(() => opener.click());
    await wait(50);
    const dialog = document.querySelector('dialog.ks-dialog')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('A sheet');
    // the first field has the focus
    expect(document.activeElement?.id).toBe('f');
    // Tab from the last control wraps to the first; Shift+Tab from the first goes to the last
    button('Last').focus();
    key(button('Last'), 'Tab');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(button('Last'));
    const first = document.activeElement!;
    key(first, 'Tab', true);
    expect(document.activeElement).toBe(button('Last'));
    // Escape asks to close; once gone, the focus is back on the opener
    key(document.activeElement!, 'Escape');
    expect(log).toEqual(['close']);
    await wait(500);
    expect(document.querySelector('dialog.ks-dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('has a Close button that asks to close', async () => {
    const log: string[] = [];
    act(() => root.render(h(Harness, { log })));
    act(() => button('Open it').click());
    await wait(50);
    act(() => (document.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click());
    expect(log).toEqual(['close']);
  });
});

describe('useConfirm: a question in the app\'s own sheet', () => {
  function Asks({ answers }: { answers: boolean[] }) {
    const ask = useConfirm();
    return h('button', { type: 'button', onClick: async () => {
      answers.push(await ask({ title: 'Remove “Wool scarf”?', body: 'This cannot be undone.', confirm: 'Remove', dismiss: 'Keep it', destructive: true }));
    } }, 'Remove the wish');
  }

  it('names its two actions and resolves with the one chosen; Escape is the dismissal', async () => {
    const answers: boolean[] = [];
    act(() => root.render(h(ConfirmHost, null, h(Asks, { answers }))));
    act(() => button('Remove the wish').click());
    await wait(50);
    expect(document.querySelector('.sheet-title')?.textContent).toBe('Remove “Wool scarf”?');
    // named actions, no "OK", and no Cancel where nothing is cancelled
    const names = [...document.querySelectorAll('.sheet-foot button')].map((b) => b.textContent);
    expect(names).toEqual(['Keep it', 'Remove']);
    await act(async () => button('Remove').click());
    expect(answers).toEqual([true]);
    await wait(500);
    act(() => button('Remove the wish').click());
    await wait(50);
    key(document.querySelector('.sheet')!, 'Escape');
    await wait(10);
    expect(answers).toEqual([true, false]);
  });
});

describe('a sheet\'s action runs once (review of #16: a double click imported twice)', () => {
  // An action like Import or "Add the wish": a call to the server, then the sheet closes.
  function Acts({ calls, settle }: { calls: string[]; settle: Promise<void> }) {
    const [open, setOpen] = useState(true);
    const [busy, guard] = useBusy();
    const go = async () => {
      if (!guard.start()) return;
      try { calls.push('call'); await settle; setOpen(false); } finally { guard.end(); }
    };
    return h(Sheet, { title: 'Import 2 wishes?', open, onClose: () => setOpen(false),
      footer: h('button', { type: 'button', disabled: busy, onClick: () => void go() }, 'Import') });
  }

  it('a double click before the call settles runs it once', async () => {
    const calls: string[] = [];
    let settle!: () => void;
    act(() => root.render(h(Acts, { calls, settle: new Promise<void>((r) => { settle = r; }) })));
    await wait(50);
    const b = button('Import');
    // both clicks land before React re-renders the button disabled
    act(() => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); b.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(calls).toEqual(['call']);
    expect(button('Import').disabled).toBe(true);
    await act(async () => { settle(); });
  });

  it('a click while the sheet is leaving does nothing: the panel is inert and takes no pointer', async () => {
    const calls: string[] = [];
    act(() => root.render(h(Acts, { calls, settle: Promise.resolve() })));
    await wait(50);
    await act(async () => button('Import').click());
    expect(calls).toEqual(['call']);
    // closing: still there for its 420 ms, but inert and marked as leaving
    const panel = document.querySelector('.sheet')!;
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.classList.contains('is-leaving')).toBe(true);
    expect(document.querySelector('.scrim')!.classList.contains('is-leaving')).toBe(true);
    // the guard holds too, should anything still deliver a click
    await act(async () => button('Import').click());
    expect(calls).toEqual(['call']);
    await wait(500);
    expect(document.querySelector('dialog.ks-dialog')).toBeNull();
  });

  it('a confirm sheet answers once, whatever is clicked after', async () => {
    const answers: boolean[] = [];
    function Asks() {
      const ask = useConfirm();
      return h('button', { type: 'button', onClick: async () => { answers.push(await ask({ title: 'Import?', confirm: 'Import', dismiss: 'Not yet' })); } }, 'Go');
    }
    act(() => root.render(h(ConfirmHost, null, h(Asks))));
    act(() => button('Go').click());
    await wait(50);
    const yes = button('Import');
    await act(async () => { yes.click(); yes.click(); button('Not yet').click(); });
    expect(answers).toEqual([true]);
  });
});
