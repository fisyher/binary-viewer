// @vitest-environment jsdom
// UX refinement stage 2: zoom, hex banding, reset layout, tree columns, tab icons, inspector hint, title-bar search field.
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.svelte';
import { le16, le32 } from './core/engine/test-helpers';
import { SpecLibrary } from './core/spec-library';
import { createMemoryStore } from './core/spec-store';
import { formatShown } from './test/format-ui';
import { builtins } from './test/spec-fixtures';
import { createInlineClient } from './worker/inline-client';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
const resetDocument = () => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('style');
};
beforeEach(() => {
  localStorage.clear();
  resetDocument();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  resetDocument();
  vi.restoreAllMocks();
});

function makeBmp(): Uint8Array<ArrayBuffer> {
  const dib = [...le32(40), ...le32(1), ...le32(1), ...le16(1), ...le16(24), ...le32(0), ...le32(4), ...le32(2835), ...le32(2835), ...le32(0), ...le32(0)];
  return Uint8Array.from([0x42, 0x4d, ...le32(14 + 40 + 4), ...le16(0), ...le16(0), ...le32(54), ...dib, 0xab, 0xcd, 0xef, 0]);
}

async function mount() {
  const lib = new SpecLibrary({ store: createMemoryStore(), builtins: builtins() });
  await lib.init();
  return render(App, { createClient: () => createInlineClient(), createLibrary: () => lib });
}

async function pick(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]:not([multiple])') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await fireEvent.change(input);
}

const paletteInput = () => document.querySelector<HTMLInputElement>('input[role="combobox"]');
const optionNames = () => [...document.querySelectorAll('[role="option"] .label')].map((l) => l.textContent);
async function runCommand(query: string) {
  await fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  await waitFor(() => expect(paletteInput()).not.toBeNull());
  const input = paletteInput()!;
  await fireEvent.input(input, { target: { value: query } });
  await fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(paletteInput()).toBeNull());
}
const key = (init: KeyboardEventInit) => fireEvent.keyDown(window, init);
const root = () => document.documentElement;
const zoomButton = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('footer.status button.zoom');

describe('UI zoom', () => {
  it('Ctrl+= and Ctrl+- step through 90, 100, 115 and 130%, keep the browser out of it, and remember the choice', async () => {
    const { container } = await mount();
    expect(zoomButton(container)).toBeNull(); // 100%: nothing in the status bar
    expect(root().style.zoom).toBe('');

    expect(await key({ key: '=', ctrlKey: true })).toBe(false); // preventDefault: the browser does not zoom too
    expect(root().style.getPropertyValue('--ui-scale')).toBe('1.15');
    expect(root().style.zoom).toBe('1.15');
    expect(localStorage.getItem('binaryviewer.uiScale')).toBe('1.15');
    expect(zoomButton(container)!.textContent).toBe('115%');

    expect(await key({ key: '+', ctrlKey: true, shiftKey: true })).toBe(false);
    expect(zoomButton(container)!.textContent).toBe('130%');
    expect(await key({ key: '=', ctrlKey: true })).toBe(false); // at the top: still ours, nothing changes
    expect(zoomButton(container)!.textContent).toBe('130%');

    expect(await key({ key: '-', ctrlKey: true })).toBe(false);
    expect(zoomButton(container)!.textContent).toBe('115%');
    expect(await key({ key: '-', ctrlKey: true })).toBe(false);
    expect(zoomButton(container)).toBeNull();
    expect(await key({ key: '-', ctrlKey: true })).toBe(false);
    expect(zoomButton(container)!.textContent).toBe('90%');
    expect(localStorage.getItem('binaryviewer.uiScale')).toBe('0.9');
  });

  it('Ctrl+0 resets to 100% and removes the saved value; the status bar button does the same', async () => {
    const { container } = await mount();
    await key({ key: '=', ctrlKey: true });
    expect(await key({ key: '0', ctrlKey: true })).toBe(false);
    expect(zoomButton(container)).toBeNull();
    expect(root().style.zoom).toBe('');
    expect(localStorage.getItem('binaryviewer.uiScale')).toBeNull();

    await key({ key: '=', ctrlKey: true });
    await fireEvent.click(zoomButton(container)!);
    expect(zoomButton(container)).toBeNull();
    expect(root().style.getPropertyValue('--ui-scale')).toBe('');
  });

  it('leaves keys it does not own alone (a plain "=" or Ctrl+Shift+0)', async () => {
    const { container } = await mount();
    expect(await key({ key: '=' })).toBe(true);
    expect(await key({ key: '0', ctrlKey: true, shiftKey: true })).toBe(true);
    expect(zoomButton(container)).toBeNull();
  });

  it('the zoom keys also work (and are prevented) while the palette or the About dialog is open', async () => {
    const { container, getByRole } = await mount();
    await fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(paletteInput()).not.toBeNull());
    expect(await fireEvent.keyDown(paletteInput()!, { key: '=', ctrlKey: true })).toBe(false);
    expect(zoomButton(container)!.textContent).toBe('115%');
    expect(await fireEvent.keyDown(paletteInput()!, { key: '0', ctrlKey: true })).toBe(false);
    expect(zoomButton(container)).toBeNull();
    await fireEvent.keyDown(paletteInput()!, { key: 'Escape' });
    await waitFor(() => expect(paletteInput()).toBeNull());
    await fireEvent.click(getByRole('button', { name: 'About' }));
    await waitFor(() => expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull());
    expect(await fireEvent.keyDown(window, { key: '-', ctrlKey: true })).toBe(false);
    expect(root().style.zoom).toBe('0.9');
  });

  it('applies the saved zoom at start', async () => {
    localStorage.setItem('binaryviewer.uiScale', '1.3');
    const { container } = await mount();
    expect(root().style.zoom).toBe('1.3');
    expect(zoomButton(container)!.textContent).toBe('130%');
  });

  it('the palette has Zoom in, Zoom out and Reset zoom', async () => {
    const { container } = await mount();
    await runCommand('zoom in');
    expect(zoomButton(container)!.textContent).toBe('115%');
    await runCommand('zoom in');
    await runCommand('zoom out');
    expect(zoomButton(container)!.textContent).toBe('115%');
    await runCommand('reset zoom');
    expect(zoomButton(container)).toBeNull();
    expect(localStorage.getItem('binaryviewer.uiScale')).toBeNull();
  });

  it('the narrow breakpoint follows the zoom (screen pixels / zoom)', async () => {
    const queries: string[] = [];
    vi.stubGlobal('matchMedia', (q: string) => {
      queries.push(q);
      return { matches: false, media: q, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList;
    });
    try {
      await mount();
      await key({ key: '=', ctrlKey: true }); // 1.15
      await waitFor(() => expect(queries).toContain('(max-width: 1034px)')); // 900 * 1.15 - 1: narrow below 900 CSS px
      await key({ key: '=', ctrlKey: true }); // 1.3
      await waitFor(() => expect(queries).toContain('(max-width: 1169px)'));
      expect(queries).toContain('(max-width: 899px)');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('hex row banding', () => {
  it('is on by default; "Toggle hex row banding" switches it off and on and remembers it', async () => {
    const { container } = await mount();
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    await waitFor(() => expect(container.querySelector('.hex')).not.toBeNull());
    expect(container.querySelector('.hex.banded')).not.toBeNull();
    await runCommand('banding');
    expect(container.querySelector('.hex.banded')).toBeNull();
    expect(container.querySelector('.ascii.banded')).toBeNull();
    expect(localStorage.getItem('binaryviewer.layout.hexBanding')).toBe('0');
    await runCommand('banding');
    expect(container.querySelector('.hex.banded')).not.toBeNull();
    expect(localStorage.getItem('binaryviewer.layout.hexBanding')).toBe('1');
  });

  it('starts off when it was saved as off', async () => {
    localStorage.setItem('binaryviewer.layout.hexBanding', '0');
    const { container } = await mount();
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    await waitFor(() => expect(container.querySelector('.hex')).not.toBeNull());
    expect(container.querySelector('.banded')).toBeNull();
  });
});

describe('Reset layout', () => {
  const seed = () => {
    for (const [k, v] of Object.entries({
      sideWidth: '450',
      inspectorWidth: '400',
      problemsHeight: '300',
      sideOpen: '0',
      inspectorOpen: '0',
      problemsOpen: '0',
      showMinimap: '0',
      treeNameWidth: '300',
      treeValueWidth: '200',
    })) localStorage.setItem('binaryviewer.layout.' + k, v);
    localStorage.setItem('binaryviewer.theme', 'dark');
    localStorage.setItem('binaryviewer.uiScale', '1.15');
    localStorage.setItem('binaryviewer.recentCommands', JSON.stringify(['file.open']));
  };

  it('restores the default panel sizes, visibility, tree columns and minimap, and leaves the theme, the zoom and the recent commands', async () => {
    seed();
    const { container, getByRole } = await mount();
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    await waitFor(() => expect(container.querySelector('.hex')).not.toBeNull());
    expect(container.querySelector('[role="scrollbar"][aria-label="File overview"]')).toBeNull();
    expect(container.querySelector('aside[aria-label="Data inspector"]')).toBeNull();

    await runCommand('reset layout');

    const L = (k: string) => localStorage.getItem('binaryviewer.layout.' + k);
    for (const k of ['sideWidth', 'inspectorWidth', 'problemsHeight', 'treeNameWidth', 'treeValueWidth']) expect(L(k), k).toBeNull();
    for (const k of ['sideOpen', 'inspectorOpen', 'problemsOpen', 'showMinimap']) expect(L(k), k).toBe('1');
    expect(container.querySelector('aside[aria-label="Data inspector"]')).not.toBeNull();
    await waitFor(() => expect(container.querySelector('[role="scrollbar"][aria-label="File overview"]')).not.toBeNull());
    expect(getByRole('separator', { name: 'Resize side bar' }).getAttribute('aria-valuenow')).toBe('300');
    expect(getByRole('separator', { name: 'Resize inspector' }).getAttribute('aria-valuenow')).toBe('320');
    expect(getByRole('separator', { name: 'Resize problems panel' }).getAttribute('aria-valuenow')).toBe('180');
    // untouched
    expect(localStorage.getItem('binaryviewer.theme')).toBe('dark');
    expect(localStorage.getItem('binaryviewer.uiScale')).toBe('1.15');
    expect(root().style.zoom).toBe('1.15');
    expect(JSON.parse(localStorage.getItem('binaryviewer.recentCommands')!)).toEqual(['view.resetLayout', 'file.open']);
  });

  it('is offered with no file open', async () => {
    await mount();
    await fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(paletteInput()).not.toBeNull());
    await fireEvent.input(paletteInput()!, { target: { value: 'reset layout' } });
    expect(optionNames()).toEqual(['Reset layout']);
  });

  it('a resizer context menu item does the same', async () => {
    seed();
    localStorage.setItem('binaryviewer.layout.sideOpen', '1'); // the side bar's resizer needs it open
    const { getByRole } = await mount();
    const bar = getByRole('separator', { name: 'Resize side bar' });
    expect(bar.getAttribute('aria-valuenow')).toBe('450');
    await fireEvent.contextMenu(bar, { clientX: 4, clientY: 4 });
    await fireEvent.click(getByRole('menuitem', { name: 'Reset layout' }));
    await waitFor(() => expect(getByRole('separator', { name: 'Resize side bar' }).getAttribute('aria-valuenow')).toBe('300'));
    expect(localStorage.getItem('binaryviewer.layout.sideWidth')).toBeNull();
  });
});

describe('tree columns', () => {
  it('dragging a divider (arrow keys) saves the width; double-click goes back to the default; saved widths are used at start', async () => {
    const { container, findByRole } = await mount();
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    const name = await findByRole('separator', { name: 'Resize Name column' });
    await fireEvent.keyDown(name, { key: 'ArrowRight' });
    const saved = Number(localStorage.getItem('binaryviewer.layout.treeNameWidth'));
    expect(saved).toBeGreaterThanOrEqual(80);
    expect(container.querySelector<HTMLElement>('.tree')!.style.getPropertyValue('--c-name')).toBe(`${saved}px`);
    await fireEvent.dblClick(name);
    expect(localStorage.getItem('binaryviewer.layout.treeNameWidth')).toBeNull();
    expect(container.querySelector<HTMLElement>('.tree')!.style.getPropertyValue('--c-name')).toBe('');
  });

  it('starts with the saved widths', async () => {
    localStorage.setItem('binaryviewer.layout.treeNameWidth', '222');
    localStorage.setItem('binaryviewer.layout.treeValueWidth', '111');
    const { container } = await mount();
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    await waitFor(() => expect(container.querySelector('.tree')).not.toBeNull());
    const tree = container.querySelector<HTMLElement>('.tree')!;
    expect(tree.style.getPropertyValue('--c-name')).toBe('222px');
    expect(tree.style.getPropertyValue('--c-value')).toBe('111px');
  });
});

describe('editor tab icons', () => {
  const icon = (c: HTMLElement) => c.querySelector('[role="tab"] svg.icon')?.getAttribute('data-icon');

  it('the file tab has a binary file glyph, and a BMP image glyph once it is parsed as a BMP', async () => {
    const { container } = await mount();
    await pick(container, new File([new Uint8Array([1, 2, 3, 4])], 'plain.bin'));
    await waitFor(() => expect(container.querySelector('[role="tab"]')).not.toBeNull());
    expect(icon(container)).toBe('file');
    expect(container.querySelector('[role="tab"] svg.icon')!.getAttribute('aria-hidden')).toBe('true');
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    await waitFor(() => expect(formatShown(container)).toMatch(/Bitmap/i));
    expect(icon(container)).toBe('bmp');
  });
});

describe('inspector empty state', () => {
  it('asks for a file first, then says how to pick a byte, naming the palette key (there is no Go to key)', async () => {
    const { container, findByText } = await mount();
    await findByText('Open a file to inspect its bytes.');
    await pick(container, new File([new Uint8Array([1, 2, 3])], 'a.bin'));
    await findByText('Click a byte, or press Ctrl+K and choose Go to offset.');
    expect(document.body.textContent).not.toMatch(/Ctrl\+G/);
  });
});

describe('inspector with an empty file', () => {
  it('says the file is empty (New file)', async () => {
    const { getByRole, findByText } = await mount();
    await fireEvent.click(getByRole('button', { name: 'New' }));
    await findByText('The file is empty.');
  });
});

describe('title bar search field', () => {
  it('looks like a search field (hint text and key) and opens the palette', async () => {
    const { getByRole } = await mount();
    const field = getByRole('button', { name: 'Search commands (Ctrl+K)' });
    expect(field.textContent).toContain('Search commands…');
    expect(field.querySelector('kbd')!.textContent).toBe('Ctrl K');
    await fireEvent.click(field);
    await waitFor(() => expect(paletteInput()).not.toBeNull());
  });
});
