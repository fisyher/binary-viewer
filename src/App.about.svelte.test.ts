// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import App from './App.svelte';
import { APP_VERSION } from './core/build-info';
import { loadBuiltinSpecs } from './formats';
import { SHORTCUTS, START_SHORTCUTS } from './ui/shortcuts';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function pick(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await fireEvent.change(input);
}

describe('document title', () => {
  it('is the app name with no file, names the file, and is prefixed while there are unsaved edits', async () => {
    const { container } = render(App);
    await waitFor(() => expect(document.title).toBe('Binary Viewer'));

    await pick(container, new File([new Uint8Array(16)], 'a.bin'));
    await waitFor(() => expect(document.title).toBe('a.bin — Binary Viewer'));

    await fireEvent.mouseDown(container.querySelector('.b[data-o="1"]')!);
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    for (const ch of '41') await fireEvent.keyDown(grid, { key: ch });
    await waitFor(() => expect(document.title).toBe('• a.bin — Binary Viewer'));
  });
});

describe('About dialog', () => {
  for (const name of ['About Binary Viewer', 'About']) {
    it(`opens from the "${name}" button, shows the version, closes with Escape or Close and restores focus`, async () => {
      const { container, getByRole, queryByRole } = render(App);
      const opener = getByRole('button', { name });
      opener.focus();

      for (const close of ['escape', 'button'] as const) {
        await fireEvent.click(opener);
        const dialog = getByRole('dialog');
        expect(dialog.textContent).toContain(`Version ${APP_VERSION}`);
        expect(dialog.textContent).toContain('Released under the MIT License.');
        await waitFor(() => expect(document.activeElement).toBe(getByRole('button', { name: 'Close' })));

        if (close === 'escape') await fireEvent.keyDown(window, { key: 'Escape' });
        else await fireEvent.click(getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(queryByRole('dialog')).toBeNull());
        expect(container.querySelector('.app')!.hasAttribute('inert')).toBe(false);
        await waitFor(() => expect(document.activeElement).toBe(opener));
      }
    });
  }

  it('lists the built-in formats and the shortcuts, and makes the app behind it inert', async () => {
    const { container, getByRole } = render(App);
    await fireEvent.click(getByRole('button', { name: 'About' }));
    const text = getByRole('dialog').textContent ?? '';
    for (const s of loadBuiltinSpecs().specs) expect(text).toContain(s.name);
    for (const s of SHORTCUTS) expect(text).toContain(s.keys);
    expect(container.querySelector('.app')!.hasAttribute('inert')).toBe(true);
  });
});

describe('About dialog and file drops', () => {
  it('a drop while About is open loads nothing and opens no confirm dialog', async () => {
    const { container, getByRole, queryByRole } = render(App);
    await fireEvent.click(getByRole('button', { name: 'About' }));
    const file = new File([new Uint8Array(4)], 'x.bin');
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file], items: [], types: ['Files'] } });
    window.dispatchEvent(drop);
    await new Promise((r) => setTimeout(r, 20));
    expect(drop.defaultPrevented).toBe(true);
    expect(container.querySelector('.b')).toBeNull();
    expect(document.title).toBe('Binary Viewer');
    expect(queryByRole('alertdialog')).toBeNull();
    expect(getByRole('dialog')).toBeTruthy();
  });
});

describe('start screen', () => {
  it('shows the tagline, privacy line, built-in formats and shortcuts', () => {
    const { container } = render(App);
    const text = container.querySelector('.empty')!.textContent ?? '';
    expect(text).toContain('Hex editor and binary format inspector');
    expect(text).toContain('Your files never leave this browser.');
    for (const s of loadBuiltinSpecs().specs) expect(text).toContain(s.name);
    for (const s of START_SHORTCUTS) expect(text).toContain(s.keys);
  });

  it('"Browse formats" switches to the Formats tab', async () => {
    const { getByRole } = render(App);
    expect(getByRole('button', { name: 'Formats' }).getAttribute('aria-pressed')).toBe('false');
    await fireEvent.click(getByRole('button', { name: 'Browse formats' }));
    expect(getByRole('button', { name: 'Formats' }).getAttribute('aria-pressed')).toBe('true');
  });
});
