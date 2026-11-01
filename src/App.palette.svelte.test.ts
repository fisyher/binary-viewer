// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.svelte';
import { le16, le32 } from './core/engine/test-helpers';
import { SpecLibrary } from './core/spec-library';
import { createMemoryStore } from './core/spec-store';
import { builtins, specText } from './test/spec-fixtures';
import { createInlineClient } from './worker/inline-client';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  vi.restoreAllMocks();
});

/** 1x1 24-bit BMP: 14-byte file header, 40-byte DIB header, 4 pixel bytes. */
function makeBmp(): Uint8Array<ArrayBuffer> {
  const dib = [...le32(40), ...le32(1), ...le32(1), ...le16(1), ...le16(24), ...le32(0), ...le32(4), ...le32(2835), ...le32(2835), ...le32(0), ...le32(0)];
  return Uint8Array.from([0x42, 0x4d, ...le32(14 + 40 + 4), ...le16(0), ...le16(0), ...le32(54), ...dib, 0xab, 0xcd, 0xef, 0]);
}

async function mount(seed: Array<[string, string]> = []) {
  const lib = new SpecLibrary({ store: createMemoryStore(), builtins: builtins() });
  await lib.init();
  for (const [id, text] of seed) {
    await lib.create(id);
    await lib.save(id, text);
  }
  return render(App, { createClient: () => createInlineClient(), createLibrary: () => lib });
}

async function pick(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]:not([multiple])') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await fireEvent.change(input);
}

const grid = (c: HTMLElement) => c.querySelector<HTMLElement>('[role="grid"]')!;
const statusBar = (c: HTMLElement) => c.querySelector('footer.status')!.textContent ?? '';
const palette = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label]:not([aria-modal="false"])');
const paletteInput = () => document.querySelector<HTMLInputElement>('input[role="combobox"]');
const optionNames = () => [...document.querySelectorAll('[role="option"] .label')].map((l) => l.textContent);
const isOpen = () => paletteInput() !== null;
const ctrlK = (target: Element | Window = window) => fireEvent.keyDown(target, { key: 'k', ctrlKey: true });

async function open(via: 'ctrl' | 'f1' | 'meta' = 'ctrl') {
  if (via === 'ctrl') await ctrlK();
  else if (via === 'f1') await fireEvent.keyDown(window, { key: 'F1' });
  else await fireEvent.keyDown(window, { key: 'k', metaKey: true });
  await waitFor(() => expect(paletteInput()).not.toBeNull());
  return paletteInput()!;
}

async function run(query: string) {
  const input = await open();
  await fireEvent.input(input, { target: { value: query } });
  await fireEvent.keyDown(input, { key: 'Enter' });
}

describe('command palette: opening and closing', () => {
  it('Ctrl+K, F1 and Cmd+K open it and the browser default is prevented', async () => {
    await mount();
    for (const via of ['ctrl', 'f1', 'meta'] as const) {
      const notPrevented =
        via === 'ctrl'
          ? await fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
          : via === 'f1'
            ? await fireEvent.keyDown(window, { key: 'F1' })
            : await fireEvent.keyDown(window, { key: 'k', metaKey: true });
      expect(notPrevented, via).toBe(false);
      await waitFor(() => expect(isOpen(), via).toBe(true));
      expect(document.activeElement).toBe(paletteInput());
      await fireEvent.keyDown(paletteInput()!, { key: 'Escape' });
      await waitFor(() => expect(isOpen()).toBe(false));
    }
  });

  it('does not take Ctrl+Shift+P (Firefox keeps it) or plain letters', async () => {
    await mount();
    expect(await fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true })).toBe(true);
    await fireEvent.keyDown(window, { key: 'k' });
    expect(isOpen()).toBe(false);
  });

  it('opens from the Commands button in the title bar (title shows the shortcut) and gives focus back there', async () => {
    const { getByRole } = await mount();
    const button = getByRole('button', { name: 'Commands' });
    expect(button.getAttribute('title')).toContain('Ctrl+K');
    button.focus();
    await fireEvent.click(button);
    await waitFor(() => expect(isOpen()).toBe(true));
    await fireEvent.keyDown(paletteInput()!, { key: 'Escape' });
    await waitFor(() => expect(isOpen()).toBe(false));
    expect(document.activeElement).toBe(button);
  });

  it('makes the app inert while open and live again after; Escape returns focus to where it was', async () => {
    const { container } = await mount();
    await pick(container, new File([new Uint8Array(64)], 'a.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    grid(container).focus();
    await ctrlK(grid(container));
    await waitFor(() => expect(isOpen()).toBe(true));
    expect(container.querySelector('.app')!.hasAttribute('inert')).toBe(true);
    await fireEvent.keyDown(paletteInput()!, { key: 'Escape' });
    await waitFor(() => expect(isOpen()).toBe(false));
    expect(container.querySelector('.app')!.hasAttribute('inert')).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(grid(container)));
  });

  it('Ctrl+K again closes it; a press outside closes it', async () => {
    await mount();
    const input = await open();
    await fireEvent.keyDown(input, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(isOpen()).toBe(false));
    await open();
    await fireEvent.mouseDown(document.querySelector('.backdrop')!);
    await waitFor(() => expect(isOpen()).toBe(false));
  });

  it('is ignored while the About dialog or a confirmation is open', async () => {
    const { container, getByRole, queryByRole } = await mount();
    await fireEvent.click(getByRole('button', { name: 'About Binary Viewer' }));
    await waitFor(() => expect(getByRole('dialog')).toBeTruthy());
    await ctrlK();
    await fireEvent.keyDown(window, { key: 'F1' });
    expect(isOpen()).toBe(false);
    await fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(queryByRole('dialog')).toBeNull());

    // A confirmation: New over unsaved edits.
    await pick(container, new File([new Uint8Array([1, 2, 3])], 'a.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    await fireEvent.mouseDown(container.querySelector('.b[data-o="0"]')!);
    for (const ch of '7f') await fireEvent.keyDown(grid(container), { key: ch });
    await waitFor(() => expect(document.title.startsWith('•')).toBe(true));
    await fireEvent.click(within(container).getByRole('button', { name: 'New' }));
    await waitFor(() => expect(getByRole('alertdialog')).toBeTruthy());
    await ctrlK();
    expect(isOpen()).toBe(false);
  });

  it('does not run twice or let the page react while it is open (a key meant for the palette stays in it)', async () => {
    const { container } = await mount();
    await pick(container, new File([new Uint8Array(64)], 'a.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    const input = await open();
    const before = statusBar(container);
    await fireEvent.keyDown(input, { key: 's', ctrlKey: true });
    expect(statusBar(container)).toBe(before);
    expect(isOpen()).toBe(true);
  });
});

describe('command palette: global keys and the hex view', () => {
  it('Ctrl+K inside the hex grid opens the palette and types nothing; plain typing still edits', async () => {
    const { container } = await mount();
    await pick(container, new File([new Uint8Array([1, 2, 3])], 'a.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    await fireEvent.mouseDown(container.querySelector('.b[data-o="0"]')!);
    expect(await ctrlK(grid(container))).toBe(false);
    await waitFor(() => expect(isOpen()).toBe(true));
    await fireEvent.keyDown(paletteInput()!, { key: 'Escape' });
    await waitFor(() => expect(isOpen()).toBe(false));
    expect(document.title).toBe('a.bin — Binary Viewer'); // nothing was edited

    for (const ch of '7f') await fireEvent.keyDown(grid(container), { key: ch });
    await waitFor(() => expect(document.title).toBe('• a.bin — Binary Viewer'));
    expect(isOpen()).toBe(false);
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')!.textContent).toBe('7F'));
  });

  it('F1 in the grid while editing opens the palette (it is not a printable key)', async () => {
    const { container } = await mount();
    await pick(container, new File([new Uint8Array([1, 2, 3])], 'a.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    await fireEvent.mouseDown(container.querySelector('.b[data-o="0"]')!);
    expect(await fireEvent.keyDown(grid(container), { key: 'F1' })).toBe(false);
    await waitFor(() => expect(isOpen()).toBe(true));
  });

  it('a key the grid already handled (Ctrl+Z) is left alone', async () => {
    const { container } = await mount();
    await pick(container, new File([new Uint8Array([1, 2, 3])], 'a.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    await fireEvent.mouseDown(container.querySelector('.b[data-o="0"]')!);
    await fireEvent.keyDown(grid(container), { key: 'z', ctrlKey: true });
    expect(isOpen()).toBe(false);
  });
});

describe('command palette: Ctrl+S', () => {
  function stubDownload() {
    const created: Blob[] = [];
    URL.createObjectURL = (b: Blob | MediaSource) => (created.push(b as Blob), 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    return { click, created };
  }

  it('saves the open file in the file tab and keeps the browser from opening Save page', async () => {
    const { click } = stubDownload();
    const { container, getByRole } = await mount();
    await fireEvent.click(getByRole('button', { name: 'New' }));
    await waitFor(() => expect(grid(container)).not.toBeNull());
    for (const ch of 'ab') await fireEvent.keyDown(grid(container), { key: ch });
    await waitFor(() => expect(document.title.startsWith('•')).toBe(true));
    expect(await fireEvent.keyDown(grid(container), { key: 's', ctrlKey: true })).toBe(false);
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.title.startsWith('•')).toBe(false));
  });

  it('does nothing without a file (but still keeps Save page away)', async () => {
    const { click } = stubDownload();
    await mount();
    expect(await fireEvent.keyDown(window, { key: 's', ctrlKey: true })).toBe(false);
    expect(click).not.toHaveBeenCalled();
  });

  it('does not save the file while a spec tab is shown', async () => {
    const { click } = stubDownload();
    const { container, getByRole } = await mount([['draft', specText('draft')]]);
    await fireEvent.click(getByRole('button', { name: 'New' }));
    await waitFor(() => expect(grid(container)).not.toBeNull());
    await run('open spec fmt draft');
    await waitFor(() => expect(container.querySelector('[role="tab"][id="editor-tab-spec_draft"]')).not.toBeNull());
    expect(await fireEvent.keyDown(document.body, { key: 's', ctrlKey: true })).toBe(true); // nothing claimed it
    expect(click).not.toHaveBeenCalled();
  });

  it('the Save command is disabled without a file and Enter does not run it', async () => {
    const { click } = stubDownload();
    await mount();
    const input = await open();
    await fireEvent.input(input, { target: { value: 'save' } });
    const save = [...document.querySelectorAll('[role="option"]')].find((o) => o.querySelector('.label')?.textContent === 'Save')!;
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(save.textContent).toContain('Open a file first');
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(isOpen()).toBe(true);
    expect(click).not.toHaveBeenCalled();
  });

  it('the Save command saves the file', async () => {
    const { click } = stubDownload();
    const { container, getByRole } = await mount();
    await fireEvent.click(getByRole('button', { name: 'New' }));
    await waitFor(() => expect(grid(container)).not.toBeNull());
    for (const ch of 'ab') await fireEvent.keyDown(grid(container), { key: ch });
    await run('save');
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(isOpen()).toBe(false));
  });
});

describe('command palette: view commands', () => {
  it('Hide minimap / Show minimap toggles the strip and remembers it', async () => {
    const { container } = await mount();
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    const strip = () => container.querySelector('[role="scrollbar"][aria-label="File overview"]');
    await waitFor(() => expect(strip()).not.toBeNull());
    await run('minimap');
    await waitFor(() => expect(strip()).toBeNull());
    expect(isOpen()).toBe(false);
    expect(localStorage.getItem('binaryviewer.layout.showMinimap')).toBe('0');
    const input = await open();
    await fireEvent.input(input, { target: { value: 'minimap' } });
    expect(optionNames()).toEqual(['Show minimap']);
    await fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(strip()).not.toBeNull());
    expect(localStorage.getItem('binaryviewer.layout.showMinimap')).toBe('1');
  });

  it('toggles the side bar, the data inspector and the Problems panel', async () => {
    const { container, queryByRole } = await mount();
    await pick(container, new File([new Uint8Array(32)], 'a.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    const slot = () => container.querySelector('.side-slot')!;
    expect(slot().hasAttribute('inert')).toBe(false);
    await run('hide side bar');
    await waitFor(() => expect(slot().hasAttribute('inert')).toBe(true));
    await run('show side bar');
    await waitFor(() => expect(slot().hasAttribute('inert')).toBe(false));

    expect(container.querySelector('[aria-label="Data inspector"]')).not.toBeNull();
    await run('hide data inspector');
    await waitFor(() => expect(queryByRole('button', { name: 'Show data inspector' })).not.toBeNull());
    await run('show data inspector');
    await waitFor(() => expect(queryByRole('button', { name: 'Show data inspector' })).toBeNull());

    expect(localStorage.getItem('binaryviewer.layout.problemsOpen')).toBeNull();
    await run('hide problems');
    await waitFor(() => expect(localStorage.getItem('binaryviewer.layout.problemsOpen')).toBe('0'));
    await run('show problems');
    await waitFor(() => expect(localStorage.getItem('binaryviewer.layout.problemsOpen')).toBe('1'));
  });

  it('Show Formats and Show Structure switch the side bar view', async () => {
    const { getByRole } = await mount();
    await run('show formats');
    await waitFor(() => expect(getByRole('button', { name: 'Formats' }).getAttribute('aria-pressed')).toBe('true'));
    await run('show structure');
    await waitFor(() => expect(getByRole('button', { name: 'Structure' }).getAttribute('aria-pressed')).toBe('true'));
    expect(getByRole('button', { name: 'Formats' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('sets the theme and the byte order', async () => {
    const { getByRole } = await mount();
    await run('theme: dark');
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
    expect(localStorage.getItem('binaryviewer.theme')).toBe('dark');
    expect(getByRole('button', { name: 'Theme: Dark' })).toBeTruthy();
    await run('theme: system');
    await waitFor(() => expect(document.documentElement.hasAttribute('data-theme')).toBe(false));

    await run('big-endian');
    await waitFor(() => expect(getByRole('button', { name: 'Value byte order: big-endian' })).toBeTruthy());
    await run('little-endian');
    await waitFor(() => expect(getByRole('button', { name: 'Value byte order: little-endian' })).toBeTruthy());
  });

  it('marks the current theme with a hint', async () => {
    await mount();
    const input = await open();
    await fireEvent.input(input, { target: { value: 'theme' } });
    const rows = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(rows.find((r) => r?.includes('Theme: System'))).toContain('Current');
    expect(rows.find((r) => r?.includes('Theme: Dark'))).not.toContain('Current');
  });
});

describe('command palette: Go to offset', () => {
  it('Go to offset… takes hex, jumps, selects that byte and puts focus in the hex view', async () => {
    const { container } = await mount();
    await pick(container, new File([Uint8Array.from({ length: 1024 }, (_, i) => i & 0xff)], 'a.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    await run('go to');
    await waitFor(() => expect(palette()?.getAttribute('aria-label')).toBe('Go to offset'));
    const input = paletteInput()!;
    await fireEvent.input(input, { target: { value: '1F4' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(statusBar(container)).toContain('Start: 0x1F4 (500)'));
    expect(isOpen()).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(grid(container)));
    await waitFor(() => expect(container.querySelector('.b[data-o="500"]')).not.toBeNull());
  });

  it('shows the parser error inline and stays open on a bad offset', async () => {
    const { container } = await mount();
    await pick(container, new File([new Uint8Array(16)], 'a.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    await run('go to');
    await waitFor(() => expect(palette()?.getAttribute('aria-label')).toBe('Go to offset'));
    const input = paletteInput()!;
    await fireEvent.input(input, { target: { value: '9999' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(within(palette()!).getByRole('alert').textContent).toBe('Out of range (last offset is 0xF)'));
    expect(isOpen()).toBe(true);
    await fireEvent.input(input, { target: { value: 'xyz' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(within(palette()!).getByRole('alert').textContent).toContain('Invalid hex offset'));
    expect(statusBar(container)).toContain('No selection');
  });

  it('is disabled without a file', async () => {
    await mount();
    const input = await open();
    await fireEvent.input(input, { target: { value: 'go to' } });
    expect(document.querySelector('[role="option"]')!.getAttribute('aria-disabled')).toBe('true');
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(palette()!.getAttribute('aria-label')).toBe('Command palette');
  });

  it('works from a spec tab: the file tab comes back', async () => {
    const { container, getByRole } = await mount([['draft', specText('draft')]]);
    await pick(container, new File([new Uint8Array(64)], 'a.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    await run('open spec fmt draft');
    await waitFor(() => expect(container.querySelector('#editor-tab-spec_draft')?.getAttribute('aria-selected')).toBe('true'));
    await run('go to');
    await waitFor(() => expect(palette()?.getAttribute('aria-label')).toBe('Go to offset'));
    await fireEvent.input(paletteInput()!, { target: { value: '20' } });
    await fireEvent.keyDown(paletteInput()!, { key: 'Enter' });
    await waitFor(() => expect(statusBar(container)).toContain('Start: 0x20 (32)'));
    expect(getByRole('tab', { name: /a\.bin/ }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('command palette: formats and tabs', () => {
  it('Choose format… changes the parse: None (raw) clears it, a format parses again', async () => {
    const { container } = await mount();
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    const select = () => container.querySelector<HTMLSelectElement>('select[aria-label="Format"]')!;
    await waitFor(() => expect(select().value).toBe('bmp'));
    await waitFor(() => expect(container.textContent).toContain('Parsed:'));

    await run('choose format');
    await waitFor(() => expect(palette()?.getAttribute('aria-label')).toBe('Choose format'));
    expect(optionNames()[0]).toBe('None (raw)');
    expect(optionNames()).toContain('Windows Bitmap (magic + extension)');
    const input = paletteInput()!;
    await fireEvent.keyDown(input, { key: 'Enter' }); // the first row: None
    await waitFor(() => expect(select().value).toBe(''));
    await waitFor(() => expect(container.textContent).not.toContain('Parsed:'));

    await run('choose format');
    await waitFor(() => expect(palette()?.getAttribute('aria-label')).toBe('Choose format'));
    await fireEvent.input(paletteInput()!, { target: { value: 'bitmap' } });
    await fireEvent.keyDown(paletteInput()!, { key: 'Enter' });
    await waitFor(() => expect(select().value).toBe('bmp'));
    await waitFor(() => expect(container.textContent).toContain('Parsed:'));
  });

  it('Cancel parsing is disabled when nothing is parsing', async () => {
    const { container } = await mount();
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    await waitFor(() => expect(container.textContent).toContain('Parsed:'));
    const input = await open();
    await fireEvent.input(input, { target: { value: 'cancel parsing' } });
    const row = document.querySelector('[role="option"]')!;
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.textContent).toContain('Nothing is being parsed');
  });

  it('Open format spec… lists the library with fuzzy match and opens the spec in a tab; Switch to and Close spec tab work', async () => {
    const { container, getByRole } = await mount([['draft', specText('draft')]]);
    await pick(container, new File([new Uint8Array(8)], 'a.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    await run('open format spec');
    await waitFor(() => expect(palette()?.getAttribute('aria-label')).toBe('Open format spec'));
    expect(optionNames()).toEqual(expect.arrayContaining(['Windows Bitmap', 'Fmt draft']));
    await fireEvent.input(paletteInput()!, { target: { value: 'fdr' } });
    expect(optionNames()).toEqual(['Fmt draft']);
    await fireEvent.keyDown(paletteInput()!, { key: 'Enter' });
    await waitFor(() => expect(container.querySelector('#editor-tab-spec_draft')?.getAttribute('aria-selected')).toBe('true'));

    await run('switch to a.bin');
    await waitFor(() => expect(container.querySelector('#editor-tab-file')?.getAttribute('aria-selected')).toBe('true'));

    await run('close spec tab'); // not available while the file tab is shown
    expect(isOpen()).toBe(true);
    await fireEvent.keyDown(paletteInput()!, { key: 'Escape' });
    await waitFor(() => expect(isOpen()).toBe(false));

    await run('switch to fmt draft');
    await waitFor(() => expect(container.querySelector('#editor-tab-spec_draft')?.getAttribute('aria-selected')).toBe('true'));
    await run('close spec tab');
    await waitFor(() => expect(container.querySelector('#editor-tab-spec_draft')).toBeNull());
    expect(getByRole('tab', { name: /a\.bin/ }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('command palette: help and recent commands', () => {
  it('About Binary Viewer opens the About dialog; closing it returns focus to the element that had it', async () => {
    const { container, getByRole, queryByRole } = await mount();
    await pick(container, new File([new Uint8Array(8)], 'a.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    grid(container).focus();
    await ctrlK(grid(container));
    await waitFor(() => expect(isOpen()).toBe(true));
    await fireEvent.input(paletteInput()!, { target: { value: 'about' } });
    await fireEvent.keyDown(paletteInput()!, { key: 'Enter' });
    await waitFor(() => expect(getByRole('dialog').textContent).toContain('Version'));
    expect(isOpen()).toBe(false);
    await fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(grid(container)));
  });

  it('Keyboard shortcuts shows the list, including the palette keys', async () => {
    await mount();
    await run('keyboard shortcuts');
    await waitFor(() => expect(palette()?.getAttribute('aria-label')).toBe('Keyboard shortcuts'));
    const keys = [...document.querySelectorAll('[role="option"] kbd')].map((k) => k.textContent);
    expect(keys).toContain('Ctrl+K / F1');
    expect(keys).toContain('Ctrl+S');
    await fireEvent.keyDown(paletteInput()!, { key: 'Enter' });
    expect(isOpen()).toBe(true); // read-only
  });

  it('remembers the commands that were used, newest first, at most five, across a restart', async () => {
    await mount();
    for (const q of ['theme: dark', 'theme: light', 'big-endian', 'little-endian', 'hide minimap', 'show minimap']) {
      await run(q);
      await waitFor(() => expect(isOpen()).toBe(false));
    }
    const saved = JSON.parse(localStorage.getItem('binaryviewer.recentCommands')!) as string[];
    expect(saved).toEqual(['view.minimap', 'view.endian.le', 'view.endian.be', 'view.theme.light', 'view.theme.dark']);

    cleanup();
    await mount();
    await open();
    const groups = [...document.querySelectorAll('.group')].map((g) => g.textContent);
    expect(groups[0]).toBe('Recent');
    expect(optionNames()).toHaveLength(new Set(optionNames()).size);
    expect(optionNames()[0]).toMatch(/minimap/);
  });

  it('a command that was used while disabled never gets remembered', async () => {
    await mount();
    const input = await open();
    await fireEvent.input(input, { target: { value: 'save' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(localStorage.getItem('binaryviewer.recentCommands')).toBeNull();
  });
});

describe('command palette: review fixes', () => {
  it('a held Ctrl+K or F1 opens it once, never flickers it closed, and the browser default stays prevented', async () => {
    await mount();
    expect(await fireEvent.keyDown(window, { key: 'k', ctrlKey: true, repeat: true })).toBe(false);
    expect(isOpen()).toBe(false); // a repeat never opens
    await open();
    for (let i = 0; i < 3; i++) {
      expect(await fireEvent.keyDown(paletteInput()!, { key: 'k', ctrlKey: true, repeat: true })).toBe(false);
      expect(await fireEvent.keyDown(paletteInput()!, { key: 'F1', repeat: true })).toBe(false);
    }
    expect(isOpen()).toBe(true);
  });

  it('Ctrl+S while the palette is open does not reach the browser and saves nothing', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { container, getByRole } = await mount();
    await fireEvent.click(getByRole('button', { name: 'New' }));
    await waitFor(() => expect(grid(container)).not.toBeNull());
    for (const ch of 'ab') await fireEvent.keyDown(grid(container), { key: ch });
    const input = await open();
    expect(await fireEvent.keyDown(input, { key: 's', ctrlKey: true })).toBe(false);
    expect(click).not.toHaveBeenCalled();
    expect(isOpen()).toBe(true);
  });

  it('in a spec tab the palette offers "Save file" without the Ctrl+S hint (Ctrl+S there saves the spec)', async () => {
    const { container } = await mount([['draft', specText('draft')]]);
    await pick(container, new File([new Uint8Array(8)], 'a.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    await run('open spec fmt draft');
    await waitFor(() => expect(container.querySelector('#editor-tab-spec_draft')?.getAttribute('aria-selected')).toBe('true'));
    const input = await open();
    await fireEvent.input(input, { target: { value: 'save' } });
    const row = [...document.querySelectorAll('[role="option"]')].find((o) => o.querySelector('.label')?.textContent === 'Save file')!;
    expect(row).toBeTruthy();
    expect(row.querySelector('kbd')).toBeNull();
    expect(row.getAttribute('aria-disabled')).toBeNull();
  });

  it('focus lands on the file tab when Close spec tab removes the element that had focus', async () => {
    const { container } = await mount([['draft', specText('draft')]]);
    await pick(container, new File([new Uint8Array(8)], 'a.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    await run('open spec fmt draft');
    await waitFor(() => expect(container.querySelector('#editor-tab-spec_draft')?.getAttribute('aria-selected')).toBe('true'));
    const editor = container.querySelector<HTMLElement>('textarea[aria-label="Spec JSON"]')!;
    editor.focus();
    expect(document.activeElement).toBe(editor);
    await run('close spec tab');
    await waitFor(() => expect(container.querySelector('#editor-tab-spec_draft')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('#editor-tab-file')));
  });

  it('focus falls back to the active editor tab when the command makes the opener inert', async () => {
    const { container } = await mount();
    await pick(container, new File([new Uint8Array(8)], 'a.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    const inSide = container.querySelector<HTMLElement>('.side-slot button')!;
    inSide.focus();
    expect(document.activeElement).toBe(inSide);
    await run('hide side bar');
    await waitFor(() => expect(container.querySelector('.side-slot')!.hasAttribute('inert')).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('#editor-tab-file')));
  });
});

describe('start screen', () => {
  it('mentions the command palette shortcut', async () => {
    const { container } = await mount();
    const text = container.querySelector('.welcome')!.textContent ?? '';
    expect(text).toContain('Ctrl+K');
    expect(text).toContain('F1');
  });
});
