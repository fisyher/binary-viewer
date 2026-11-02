// @vitest-environment jsdom
// UX refinement: the breadcrumb bar, the status bar's actions, and region navigation (F6).
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import App from './App.svelte';
import { le16, le32 } from './core/engine/test-helpers';
import { chooseFormat, formatShown } from './test/format-ui';
import { SpecLibrary } from './core/spec-library';
import { createMemoryStore } from './core/spec-store';
import { builtins, specText } from './test/spec-fixtures';
import type { EngineClient } from './worker/engine-client';
import { vi } from 'vitest';
import { createInlineClient } from './worker/inline-client';

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

/** 1x1 24-bit BMP: 14-byte file header, 40-byte DIB header, 4 pixel bytes. */
function makeBmp(): Uint8Array<ArrayBuffer> {
  const dib = [...le32(40), ...le32(1), ...le32(1), ...le16(1), ...le16(24), ...le32(0), ...le32(4), ...le32(2835), ...le32(2835), ...le32(0), ...le32(0)];
  return Uint8Array.from([0x42, 0x4d, ...le32(14 + 40 + 4), ...le16(0), ...le16(0), ...le32(54), ...dib, 0xab, 0xcd, 0xef, 0]);
}

async function pick(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]:not([multiple])') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await fireEvent.change(input);
}

async function mountBmp() {
  const r = render(App, { createClient: () => createInlineClient() });
  await pick(r.container, new File([makeBmp()], 'pic.bmp'));
  await waitFor(() => expect(r.container.querySelector('[role="treeitem"]')).not.toBeNull());
  return r;
}

const rowOf = (c: HTMLElement, name: string) => ([...c.querySelectorAll('[role="treeitem"]')] as HTMLElement[]).find((r) => r.querySelector('.nm')?.textContent === name);
const crumbNav = (c: HTMLElement) => c.querySelector<HTMLElement>('nav[aria-label="Structure path"]')!;
const crumbLabels = (c: HTMLElement) => [...crumbNav(c).querySelectorAll('button')].map((b) => b.textContent);
const status = (c: HTMLElement) => c.querySelector<HTMLElement>('footer.status')!;
const clickByte = async (c: HTMLElement, o: number) => {
  const byte = c.querySelector(`.b[data-o="${o}"]`)!;
  await fireEvent.mouseDown(byte);
  await fireEvent.mouseUp(byte);
};

describe('breadcrumb bar', () => {
  it('shows "No structure" with no parse, replaces the old format row, and sits next to Go to offset', async () => {
    const { container } = render(App, { createClient: () => createInlineClient() });
    await pick(container, new File([new Uint8Array(8)], 'a.bin'));
    await waitFor(() => expect(container.querySelector('.editor-head')).not.toBeNull());
    expect(crumbNav(container).textContent).toContain('No structure');
    expect(crumbNav(container).querySelector('button')).toBeNull();
    expect(container.querySelector('.formatbar')).toBeNull();
    expect(container.querySelector('select[aria-label="Format"]')).toBeNull();
    const head = container.querySelector('.editor-head')!;
    expect(head.contains(crumbNav(container))).toBe(true);
    expect(head.querySelector('input[aria-label="Go to offset"]')).not.toBeNull();
  });

  it('shows just the root segment once a format is parsed and nothing is located', async () => {
    const { container } = await mountBmp();
    expect(crumbLabels(container)).toEqual(['file']);
    expect(crumbNav(container).querySelector('button')!.getAttribute('aria-current')).toBe('location');
  });

  it('follows a tree selection, with a title per segment and the last one as the current location', async () => {
    const { container } = await mountBmp();
    await fireEvent.click(rowOf(container, 'magic')!);
    await waitFor(() => expect(crumbLabels(container)).toEqual(['file', 'file_header', 'magic']));
    const buttons = [...crumbNav(container).querySelectorAll('button')];
    expect(buttons.map((b) => b.getAttribute('aria-current'))).toEqual([null, null, 'location']);
    expect(buttons[2]!.title).toMatch(/^magic : .+ @ 0x0 \(size 2\)$/);
    expect([...crumbNav(container).querySelectorAll('.sep')].every((s) => s.getAttribute('aria-hidden') === 'true')).toBe(true);
  });

  it('follows a hex click (the located node), and a segment click selects that node in the tree and the hex view', async () => {
    const { container } = await mountBmp();
    await clickByte(container, 10); // off_bits, inside file_header
    await waitFor(() => expect(crumbLabels(container)).toEqual(['file', 'file_header', 'off_bits']));
    await fireEvent.click(within(crumbNav(container)).getByRole('button', { name: 'file_header' }));
    await waitFor(() => expect(rowOf(container, 'file_header')?.getAttribute('aria-selected')).toBe('true'));
    expect([...container.querySelectorAll('.b.sel')].map((e) => Number((e as HTMLElement).dataset.o))).toEqual(Array.from({ length: 14 }, (_, i) => i));
    await waitFor(() => expect(crumbLabels(container)).toEqual(['file', 'file_header']));
  });

  it('follows keyboard caret moves, after a short delay', async () => {
    const { container } = await mountBmp();
    await clickByte(container, 0);
    await waitFor(() => expect(crumbLabels(container).at(-1)).toBe('magic'));
    const grid = container.querySelector<HTMLElement>('[role="grid"]')!;
    grid.focus();
    await fireEvent.keyDown(grid, { key: 'ArrowDown' }); // 16 bytes on: inside the DIB header
    expect(crumbLabels(container).at(-1)).toBe('magic'); // not at once: the lookup is debounced
    await waitFor(() => expect(crumbLabels(container)).toContain('dib'), { timeout: 1500 });
    expect(crumbLabels(container).at(-1)).not.toBe('magic');
    // a tree selection after a key press wins over the pending lookup
    await fireEvent.keyDown(grid, { key: 'ArrowDown' });
    await fireEvent.click(rowOf(container, 'magic')!);
    await new Promise((r) => setTimeout(r, 300));
    expect(crumbLabels(container)).toEqual(['file', 'file_header', 'magic']);
  });

  it('is cleared when the format becomes None, and when another file is opened', async () => {
    const { container } = await mountBmp();
    await fireEvent.click(rowOf(container, 'magic')!);
    await waitFor(() => expect(crumbLabels(container)).toHaveLength(3));
    await chooseFormat(container, 'None (raw)');
    await waitFor(() => expect(crumbNav(container).textContent).toContain('No structure'));
    await chooseFormat(container, 'Windows Bitmap (magic + extension)');
    await waitFor(() => expect(rowOf(container, 'magic')).toBeTruthy());
    expect(crumbLabels(container)).toEqual(['file']); // back to just the root, not the old path
    await fireEvent.click(rowOf(container, 'magic')!);
    await waitFor(() => expect(crumbLabels(container)).toHaveLength(3));
    await pick(container, new File([makeBmp()], 'other.bmp'));
    await waitFor(() => expect(crumbLabels(container)).toEqual(['file']));
  });
});

describe('breadcrumb: stale paths and extra lookups', () => {
  it('follows the link button of the tree to its target', async () => {
    const { container } = await mountBmp();
    await fireEvent.click(rowOf(container, 'magic')!);
    await waitFor(() => expect(crumbLabels(container).at(-1)).toBe('magic'));
    await fireEvent.click(within(rowOf(container, 'off_bits')!).getByRole('button', { name: /Go to pixel data/ }));
    await waitFor(() => expect(crumbLabels(container).at(-1)).toBe('pixels'));
  });

  it('does not look up the node while a mouse button is held (no extra nodeAt for a slow click), and only once for the click', async () => {
    const client = createInlineClient();
    const nodeAt = vi.spyOn(client, 'nodeAt');
    const r = render(App, { createClient: () => client });
    await pick(r.container, new File([makeBmp()], 'pic.bmp'));
    await waitFor(() => expect(r.container.querySelector('[role="treeitem"]')).not.toBeNull());
    const byte = r.container.querySelector('.b[data-o="3"]')!;
    await fireEvent.mouseDown(byte);
    await new Promise((res) => setTimeout(res, 300)); // well past the 150 ms caret delay
    expect(nodeAt).not.toHaveBeenCalled();
    await fireEvent.mouseUp(byte);
    await waitFor(() => expect(nodeAt).toHaveBeenCalledTimes(1));
    await new Promise((res) => setTimeout(res, 300));
    expect(nodeAt).toHaveBeenCalledTimes(1);
    expect(crumbLabels(r.container).at(-1)).toBe('file_size');
  });

  it('shows a parse failure once when an engine error is shown beside it', async () => {
    const lib = new SpecLibrary({ store: createMemoryStore(), builtins: builtins() });
    await lib.init();
    await lib.create('mine');
    await lib.save('mine', specText('mine'));
    const client = {
      open: vi.fn(async (file: Blob | null) => ({ size: file?.size ?? 0, specs: [{ id: 'x', name: 'Format X' }], specErrors: [], detections: [{ specId: 'x', name: 'Format X', score: 1, reasons: ['magic'], magicMatched: true }] })),
      parse: vi.fn(async () => {
        throw new Error('boom');
      }),
      setSpecs: vi.fn(async () => ({ specs: [{ id: 'x', name: 'Format X' }], rejected: ['custom spec #1: bad'] })),
      expand: vi.fn(),
      cancel: vi.fn(),
      nodeAt: vi.fn(async () => ({ path: null, lazyIndex: null })),
      nodeById: vi.fn(async () => ({ path: null, lazyIndex: null })),
      ranges: vi.fn(async () => []),
      overview: vi.fn(),
      onFatal: vi.fn(),
      dispose: vi.fn(),
    } as unknown as EngineClient;
    const { container } = render(App, { createClient: () => client, createLibrary: () => lib });
    await pick(container, new File([new Uint8Array(4)], 'a.bin'));
    await waitFor(() => expect(within(status(container)).getByRole('alert').textContent).toContain('rejected by the engine'));
    await new Promise((res) => setTimeout(res, 50));
    expect(within(status(container)).getAllByRole('alert')).toHaveLength(1);
    expect(status(container).textContent).not.toContain('boom'); // the failure is announced by one item only
  });
});

describe('status bar actions', () => {
  it('the parse summary is a button that opens and focuses the Problems panel; the status element keeps the full sentence', async () => {
    const { container, getByRole } = await mountBmp();
    const st = status(container);
    await waitFor(() => expect(within(st).getByRole('status').textContent).toMatch(/^Parsed: \d+ nodes, 0 errors, 0 warnings$/));
    const summary = within(st).getByRole('button', { name: /^Show problems/ });
    expect(summary.textContent).toMatch(/^\d+ nodes\s*·\s*0 errors\s*·\s*0 warnings$/);
    await fireEvent.click(getByRole('button', { name: 'Hide problems panel' }));
    expect(container.querySelector('.diag')).toBeNull();
    summary.focus();
    await fireEvent.click(summary);
    await waitFor(() => expect(getByRole('button', { name: 'Problems' }).getAttribute('aria-expanded')).toBe('true'));
    await waitFor(() => expect(document.activeElement).toBe(getByRole('button', { name: 'Problems' })));
  });

  it('shows "No selection" until bytes are selected; the item is a button that opens Go to offset', async () => {
    const { container } = await mountBmp();
    const item = within(status(container)).getByRole('button', { name: /No selection/ });
    expect(item.title).toBe('Go to offset');
    await clickByte(container, 3);
    await waitFor(() => expect(within(status(container)).getByRole('button', { name: /Start: 0x3 \(3\)/ })).toBeTruthy());
  });

  it('the Insert / Overwrite item toggles the edit mode like the Insert key', async () => {
    const { container } = await mountBmp();
    const mode = () => within(status(container)).getByRole('button', { name: /^Edit mode: / });
    expect(mode().getAttribute('aria-label')).toBe('Edit mode: Overwrite. Switch to insert');
    expect(mode().hasAttribute('aria-pressed')).toBe(false);
    expect(mode().textContent).toBe('Overwrite');
    await fireEvent.click(mode());
    expect(mode().getAttribute('aria-label')).toBe('Edit mode: Insert. Switch to overwrite');
    expect(mode().textContent).toBe('Insert');
    const grid = container.querySelector<HTMLElement>('[role="grid"]')!;
    grid.focus();
    await fireEvent.keyDown(grid, { key: 'Insert' });
    expect(mode().textContent).toBe('Overwrite');
  });

  it('shows the format as a button, and an engine error as an alert in the bar', async () => {
    const { container } = render(App, {
      createClient: () => createInlineClient({ specs: [], specErrors: ['bad.json: oops'] }),
    });
    await pick(container, new File([new Uint8Array(4)], 'x.bin'));
    await waitFor(() => expect(within(status(container)).getByRole('alert').textContent).toContain('Built-in format spec invalid: bad.json: oops'));
    expect(within(status(container)).getByRole('alert').getAttribute('title')).toContain('bad.json');
    expect(formatShown(container)).toBe('No format');
  });
});

describe('region navigation', () => {
  const focusedRegion = () => document.activeElement?.closest('[data-region]')?.getAttribute('data-region');
  const f6 = (shift = false) => fireEvent.keyDown(window, { key: 'F6', shiftKey: shift });

  it('F6 cycles forward through the visible regions in visual order and wraps; Shift+F6 goes back', async () => {
    const { container } = await mountBmp();
    const grid = container.querySelector<HTMLElement>('[role="grid"]')!;
    grid.focus();
    const order: Array<string | null | undefined> = [];
    for (let i = 0; i < 6; i++) {
      await f6();
      order.push(focusedRegion());
    }
    expect(order).toEqual(['bottom', 'inspector', 'status', 'activity', 'side', 'editor']);
    expect(document.activeElement).toBe(grid);
    await f6(true);
    expect(focusedRegion()).toBe('side');
    await f6(true);
    expect(focusedRegion()).toBe('activity');
    await f6(true);
    expect(focusedRegion()).toBe('status');
  });

  it('lands on the main control of each region', async () => {
    const { container, getByRole } = await mountBmp();
    await f6(); // nothing focused: the editor, which is the hex grid
    expect(document.activeElement).toBe(container.querySelector('[role="grid"]'));
    await f6(); // bottom panel: its title button
    expect(document.activeElement).toBe(getByRole('button', { name: 'Problems' }));
    await f6(); // inspector
    expect(document.activeElement?.closest('aside')?.getAttribute('aria-label')).toBe('Data inspector');
    await f6(); // status bar: its first button
    expect(document.activeElement).toBe(status(container).querySelector('button'));
    await f6(); // activity bar: the active item
    expect(document.activeElement).toBe(getByRole('button', { name: 'Structure' }));
    await f6(); // side bar: the tree
    expect(document.activeElement).toBe(container.querySelector('[role="tree"]'));
  });

  it('skips collapsed regions and starts at the editor when focus is in none of them', async () => {
    const { container, getByRole } = await mountBmp();
    await fireEvent.click(getByRole('button', { name: 'Hide side bar' }));
    await fireEvent.click(getByRole('button', { name: 'Hide data inspector' }));
    (document.activeElement as HTMLElement | null)?.blur();
    await f6();
    expect(focusedRegion()).toBe('editor'); // nothing was focused: start at the editor
    await f6();
    expect(focusedRegion()).toBe('bottom');
    await f6();
    expect(focusedRegion()).toBe('status'); // the inspector is collapsed
    await f6();
    expect(focusedRegion()).toBe('activity');
    await f6();
    expect(focusedRegion()).toBe('editor'); // the side bar is collapsed
    expect(container.querySelector('[data-region="side"]')?.hasAttribute('inert')).toBe(true);
  });

  it('prevents the browser default, and does nothing while the palette is open', async () => {
    const { container } = await mountBmp();
    container.querySelector<HTMLElement>('[role="grid"]')!.focus();
    const ev = new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(focusedRegion()).toBe('bottom');
    await fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(document.querySelector('input[role="combobox"]')).not.toBeNull());
    const input = document.activeElement;
    await f6();
    expect(document.activeElement).toBe(input);
    expect(document.querySelector('input[role="combobox"]')).not.toBeNull();
  });

  it('the Focus commands open a collapsed region and focus it', async () => {
    const { container, getByRole } = await mountBmp();
    await fireEvent.click(getByRole('button', { name: 'Hide side bar' }));
    await fireEvent.click(getByRole('button', { name: 'Hide data inspector' }));
    await fireEvent.click(getByRole('button', { name: 'Hide problems panel' }));
    const run = async (query: string) => {
      await fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
      await waitFor(() => expect(document.querySelector('input[role="combobox"]')).not.toBeNull());
      const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
      await fireEvent.input(input, { target: { value: query } });
      await fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(document.querySelector('input[role="combobox"]')).toBeNull());
    };
    await run('focus side bar');
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('[role="tree"]')));
    await run('focus inspector');
    await waitFor(() => expect(focusedRegion()).toBe('inspector'));
    await run('focus problems');
    await waitFor(() => expect(document.activeElement).toBe(getByRole('button', { name: 'Problems' })));
    expect(getByRole('button', { name: 'Problems' }).getAttribute('aria-expanded')).toBe('true');
    await run('focus editor');
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('[role="grid"]')));
  });
});
