// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryByteSource } from '../core/byte-source';
import { EditBuffer } from '../core/edit-buffer';
import EditHarness from '../test/EditHarness.svelte';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const mk = (n: number) => new EditBuffer(new MemoryByteSource(Uint8Array.from({ length: n }, (_, i) => i)));
const hexCells = (c: HTMLElement) => [...c.querySelectorAll('.b')].map((e) => e.textContent);
const grid = (c: HTMLElement) => c.querySelector('[role="grid"]') as HTMLElement;
const bytes = async (ed: EditBuffer) => [...(await ed.read(0, ed.size))];
const click = async (c: HTMLElement, o: number, cls = '.b') => {
  const el = c.querySelector(`${cls}[data-o="${o}"]`)!;
  await fireEvent.mouseDown(el);
  await fireEvent.mouseUp(el);
};
const key = (c: HTMLElement, k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(grid(c), { key: k, ...init });
const type = async (c: HTMLElement, text: string) => {
  for (const ch of text) await key(c, ch);
};
const caret = (c: HTMLElement) => Number(c.querySelector('.b.caret')?.getAttribute('data-o'));
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe('HexView editing', () => {
  it('two hex digits edit a byte and advance the caret', async () => {
    const ed = mk(32);
    const { container } = render(EditHarness, { editor: ed });
    await waitFor(() => expect(hexCells(container)[0]).toBe('00'));
    await click(container, 2);
    await type(container, 'a');
    expect(caret(container)).toBe(2); // not advanced after the first digit
    await type(container, 'B');
    await waitFor(() => expect(hexCells(container)[2]).toBe('AB'));
    expect(caret(container)).toBe(3);
    expect((await bytes(ed)).slice(0, 5)).toEqual([0, 1, 0xab, 3, 4]);
    expect(container.querySelector('.b[data-o="2"]')!.classList.contains('mod')).toBe(true);
    expect(container.querySelector('.b[data-o="3"]')!.classList.contains('mod')).toBe(false);
    // typed nibbles coalesce into one undo step
    await type(container, '12');
    await tick();
    ed.undo();
    ed.undo();
    expect(ed.canUndo).toBe(false);
  });

  it('the first digit sets only the high nibble (low nibble kept)', async () => {
    const ed = mk(32);
    const { container } = render(EditHarness, { editor: ed });
    await click(container, 5);
    await type(container, 'f');
    await waitFor(() => expect(hexCells(container)[5]).toBe('F5'));
  });

  it('ignores non-hex characters in the hex column', async () => {
    const ed = mk(8);
    const { container } = render(EditHarness, { editor: ed });
    await click(container, 1);
    await type(container, 'zg ');
    await tick();
    expect(await bytes(ed)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('types printable ASCII in the ASCII column', async () => {
    const ed = mk(16);
    const { container } = render(EditHarness, { editor: ed });
    await click(container, 0, '.c');
    await type(container, 'Hi ');
    await key(container, 'é'); // not printable ASCII: ignored
    await waitFor(() => expect(ed.version).toBeGreaterThanOrEqual(3));
    expect((await bytes(ed)).slice(0, 4)).toEqual([0x48, 0x69, 0x20, 3]);
    expect(caret(container)).toBe(3);
  });

  it('insert mode inserts new bytes; Insert toggles and the status bar shows the mode', async () => {
    const ed = mk(8);
    const { container, getByText } = render(EditHarness, { editor: ed });
    getByText('Overwrite');
    await click(container, 2);
    await key(container, 'Insert');
    getByText('Insert');
    await type(container, 'ab');
    await waitFor(() => expect(ed.size).toBe(9));
    await waitFor(async () => expect((await bytes(ed)).slice(0, 5)).toEqual([0, 1, 0xab, 2, 3]));
    await key(container, 'Insert');
    getByText('Overwrite');
  });

  it('typing at offset == size appends (caret can sit one past the end)', async () => {
    const ed = mk(16); // exactly one full row: the append slot is on a new row
    const { container } = render(EditHarness, { editor: ed });
    await waitFor(() => expect(hexCells(container)[0]).toBe('00'));
    await click(container, 15);
    await key(container, 'ArrowRight');
    expect(caret(container)).toBe(16);
    await type(container, 'c3');
    await waitFor(() => expect(ed.size).toBe(17));
    expect((await bytes(ed))[16]).toBe(0xc3);
    await waitFor(() => expect(hexCells(container)[16]).toBe('C3'));
    expect(caret(container)).toBe(17);
  });

  it('Delete removes the selection or the byte at the caret (in either mode); Backspace the byte before', async () => {
    const ed = mk(10);
    const { container } = render(EditHarness, { editor: ed });
    await click(container, 3);
    await key(container, 'Delete');
    await waitFor(() => expect(ed.size).toBe(9));
    expect(await bytes(ed)).toEqual([0, 1, 2, 4, 5, 6, 7, 8, 9]);
    expect(caret(container)).toBe(3);
    await key(container, 'Backspace');
    await waitFor(() => expect(ed.size).toBe(8));
    expect(await bytes(ed)).toEqual([0, 1, 4, 5, 6, 7, 8, 9]);
    expect(caret(container)).toBe(2);
    // select bytes 1..3 with shift+arrows; Backspace removes the whole selection
    await click(container, 1);
    await key(container, 'ArrowRight', { shiftKey: true });
    await key(container, 'ArrowRight', { shiftKey: true });
    await key(container, 'Backspace');
    await waitFor(() => expect(ed.size).toBe(5));
    expect(await bytes(ed)).toEqual([0, 6, 7, 8, 9]);
    // Delete works in insert mode too
    await key(container, 'Insert');
    await key(container, 'Delete');
    await waitFor(() => expect(ed.size).toBe(4));
  });

  it('Backspace at offset 0 does nothing', async () => {
    const ed = mk(4);
    const { container } = render(EditHarness, { editor: ed });
    await click(container, 0);
    await key(container, 'Backspace');
    await tick();
    expect(ed.size).toBe(4);
  });

  it('Ctrl+Z undoes, Ctrl+Y and Ctrl+Shift+Z redo; the view follows', async () => {
    const ed = mk(8);
    const { container } = render(EditHarness, { editor: ed });
    await click(container, 4);
    await type(container, '9a');
    await waitFor(() => expect(hexCells(container)[4]).toBe('9A'));
    await key(container, 'z', { ctrlKey: true });
    await waitFor(() => expect(hexCells(container)[4]).toBe('04'));
    expect(caret(container)).toBe(4);
    await key(container, 'y', { ctrlKey: true });
    await waitFor(() => expect(hexCells(container)[4]).toBe('9A'));
    await key(container, 'z', { ctrlKey: true });
    await waitFor(() => expect(hexCells(container)[4]).toBe('04'));
    await key(container, 'Z', { ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(hexCells(container)[4]).toBe('9A'));
  });

  it('no stale bytes or marks after an edit is undone', async () => {
    const ed = mk(8);
    const { container } = render(EditHarness, { editor: ed });
    await click(container, 1);
    await type(container, 'ff');
    await waitFor(() => expect(container.querySelectorAll('.b.mod').length).toBe(1));
    await key(container, 'z', { ctrlKey: true });
    await waitFor(() => expect(container.querySelectorAll('.b.mod').length).toBe(0));
    await waitFor(() => expect(hexCells(container)[1]).toBe('01'));
  });

  describe('paste', () => {
    const paste = (c: HTMLElement, text: string) =>
      fireEvent.paste(grid(c), { clipboardData: { getData: () => text } });

    it('pastes valid hex text in the hex column', async () => {
      const ed = mk(16);
      const { container } = render(EditHarness, { editor: ed });
      await click(container, 2);
      await paste(container, 'DE AD BE EF');
      await waitFor(() => expect(hexCells(container).slice(2, 6)).toEqual(['DE', 'AD', 'BE', 'EF']));
      expect(caret(container)).toBe(6);
      await paste(container, 'cafe');
      await waitFor(() => expect(hexCells(container).slice(6, 8)).toEqual(['CA', 'FE']));
    });

    it('reports invalid hex without changing anything', async () => {
      const ed = mk(16);
      const { container, findByRole } = render(EditHarness, { editor: ed });
      await click(container, 2);
      await paste(container, 'DE AD B');
      expect((await findByRole('alert')).textContent).toMatch(/odd number/);
      await paste(container, 'xyz');
      await waitFor(() => expect(container.querySelector('[role="alert"]')!.textContent).toMatch(/unexpected "x"/));
      expect(ed.isDirty).toBe(false);
    });

    it('pastes plain text in the ASCII column, and rejects non-ASCII', async () => {
      const ed = mk(16);
      const { container, findByRole } = render(EditHarness, { editor: ed });
      await click(container, 0, '.c');
      await paste(container, 'AB');
      await waitFor(() => expect(hexCells(container).slice(0, 2)).toEqual(['41', '42']));
      await paste(container, 'café');
      expect((await findByRole('alert')).textContent).toMatch(/non-printable or non-ASCII/);
    });

    it('rejects an oversized paste with a clear error', async () => {
      const ed = mk(16);
      const { container, findByRole } = render(EditHarness, { editor: ed });
      await click(container, 0);
      await paste(container, 'AB'.repeat(16 * 1024 * 1024 + 1));
      expect((await findByRole('alert')).textContent).toMatch(/too large/);
      expect(ed.isDirty).toBe(false);
    });
  });

  it('Ctrl+C copies the selection as hex text; an oversized selection errors', async () => {
    const ed = mk(32);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { container } = render(EditHarness, { editor: ed });
    await click(container, 1);
    await key(container, 'ArrowRight', { shiftKey: true });
    await key(container, 'ArrowRight', { shiftKey: true });
    await key(container, 'c', { ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('01 02 03'));

    cleanup();
    const big = new EditBuffer({ size: 20 * 1024 * 1024, read: async (_o, l) => new Uint8Array(l) });
    const r = render(EditHarness, { editor: big });
    await click(r.container, 0);
    await key(r.container, 'End', { ctrlKey: true, shiftKey: true });
    await key(r.container, 'c', { ctrlKey: true });
    await waitFor(() => expect(r.container.querySelector('[role="alert"]')!.textContent).toMatch(/too large to copy/));
  });

  it('is read-only while locked (saving)', async () => {
    const ed = mk(8);
    const { container } = render(EditHarness, { editor: ed, locked: true });
    await click(container, 1);
    await type(container, 'ff');
    await key(container, 'Delete');
    await tick();
    expect(ed.isDirty).toBe(false);
  });

  it('arrow keys break typing groups', async () => {
    const ed = mk(8);
    const { container } = render(EditHarness, { editor: ed });
    await click(container, 2);
    await type(container, 'aa');
    await key(container, 'ArrowLeft');
    await key(container, 'ArrowRight');
    await type(container, 'bb');
    await waitFor(() => expect(hexCells(container)[3]).toBe('BB'));
    ed.undo();
    expect(ed.canUndo).toBe(true);
  });
});
