// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Node } from '../core/engine';
import { MAX_TITLE_CHARS } from '../core/tree-model';
import { TREE_COLUMNS, TREE_COLUMN_DEFAULT, TREE_COLUMN_DEFAULT_NARROW } from './prefs';
import StructureTree from './StructureTree.svelte';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 440 });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

let nextId = 1;
const n = (name: string, offset: number, size: number, extra: Partial<Node> = {}): Node => ({ id: nextId++, name, typeName: 'u1', offset, size, ...extra });
const noLoad = async () => ({ nodes: [], lazy: null });
const rowOf = (c: HTMLElement, name: string) => [...c.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((r) => r.querySelector('.nm')?.textContent === name)!;

describe('StructureTree value tooltip', () => {
  const LONG = 'abcdefghij'.repeat(60); // 600 chars

  it('a truncated value shows the whole value (to 512 chars) as its title, and announces it as the row description', async () => {
    const root = n('file', 0, 600, { children: [n('title', 0, 600, { value: LONG })] });
    const { container, findByText } = render(StructureTree, { root, loadPage: noLoad, onSelect: () => {} });
    await findByText('title');
    const r = rowOf(container, 'title');
    const shown = r.querySelector('.vt')!.textContent!;
    const title = r.querySelector('.val')!.getAttribute('title')!;
    expect(shown.length).toBeLessThanOrEqual(201); // the cell keeps its 200-char limit
    expect(title.length).toBeGreaterThan(shown.length);
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS + 2); // 512 plus the ellipsis (and the closing quote)
    expect(title.startsWith('"abcdefghij')).toBe(true);
    expect(title).toContain('…');
    expect(r.getAttribute('aria-description')).toBe(title);
  });

  it('is text only and sanitized like the cell: invisible and bidi characters become visible escapes', async () => {
    const root = n('file', 0, 8, { children: [n('evil', 0, 8, { value: 'a‮b\u0000c<b>x</b>' })] });
    const { container, findByText } = render(StructureTree, { root, loadPage: noLoad, onSelect: () => {} });
    await findByText('evil');
    const title = rowOf(container, 'evil').querySelector('.val')!.getAttribute('title')!;
    expect(title).toBe('"a\\u{202E}b\\u{0000}c<b>x</b>"'); // the markup stays characters; the control and bidi characters are escaped
    expect(title).not.toMatch(/[‮\u0000]/);
    expect(rowOf(container, 'evil').querySelector('.val b')).toBeNull();
  });

  it('a value that fits has the same title as the cell and needs no extra description', async () => {
    const root = n('file', 0, 2, { children: [n('magic', 0, 2, { value: 'BM' })] });
    const { container, findByText } = render(StructureTree, { root, loadPage: noLoad, onSelect: () => {} });
    await findByText('magic');
    const r = rowOf(container, 'magic');
    expect(r.querySelector('.val')!.getAttribute('title')).toBe('"BM"');
    expect(r.hasAttribute('aria-description')).toBe(false);
  });
});

describe('StructureTree column dividers', () => {
  const tree = () => n('file', 0, 4, { children: [n('a', 0, 4, { value: 1 })] });

  it('are absent without onColumnWidth (the Formats preview tree), and the header keeps its decorative titles', async () => {
    const { container, queryAllByRole, findByText } = render(StructureTree, { root: tree(), loadPage: noLoad, onSelect: () => {} });
    await findByText('a');
    expect(queryAllByRole('separator')).toHaveLength(0);
    expect(container.querySelector('.head')!.textContent).toContain('Name');
  });

  it('Name and Value are focusable separators with the limits (Name 80, Value 60) and the current width', async () => {
    const { getByRole, findByText } = render(StructureTree, { root: tree(), loadPage: noLoad, onSelect: () => {}, onColumnWidth: () => {}, widths: { name: 200, value: 120 } });
    await findByText('a');
    const name = getByRole('separator', { name: 'Resize Name column' });
    const value = getByRole('separator', { name: 'Resize Value column' });
    expect(name.tabIndex).toBe(0);
    expect(name.getAttribute('aria-valuenow')).toBe('200');
    expect(name.getAttribute('aria-valuemin')).toBe('80');
    expect(value.getAttribute('aria-valuenow')).toBe('120');
    expect(value.getAttribute('aria-valuemin')).toBe('60');
    expect(name.closest('[aria-hidden="true"]')).toBeNull(); // a focusable control must not sit in a hidden subtree
  });

  it('arrow keys on a divider report a new width (and never below the minimum), Home goes to the minimum, double-click resets', async () => {
    const onColumnWidth = vi.fn();
    const { getByRole, findByText } = render(StructureTree, { root: tree(), loadPage: noLoad, onSelect: () => {}, onColumnWidth, widths: { name: 100, value: 70 } });
    await findByText('a');
    const name = getByRole('separator', { name: 'Resize Name column' });
    const value = getByRole('separator', { name: 'Resize Value column' });
    await fireEvent.keyDown(name, { key: 'ArrowRight' });
    expect(onColumnWidth).toHaveBeenLastCalledWith('name', 116);
    await fireEvent.keyDown(name, { key: 'ArrowLeft' });
    expect(onColumnWidth).toHaveBeenLastCalledWith('name', 84);
    await fireEvent.keyDown(value, { key: 'ArrowLeft' });
    expect(onColumnWidth).toHaveBeenLastCalledWith('value', 60); // 70 - 16 = 54, held at the minimum
    await fireEvent.keyDown(name, { key: 'Home' });
    expect(onColumnWidth).toHaveBeenLastCalledWith('name', 80);
    await fireEvent.dblClick(value);
    expect(onColumnWidth).toHaveBeenLastCalledWith('value', null);
  });

  it('a dragged width becomes the grid column (px); without one the columns stay flexible', async () => {
    const { container, findByText, rerender } = render(StructureTree, { root: tree(), loadPage: noLoad, onSelect: () => {}, onColumnWidth: () => {} });
    await findByText('a');
    const t = container.querySelector<HTMLElement>('.tree')!;
    expect(t.style.getPropertyValue('--c-name')).toBe('');
    expect(t.style.getPropertyValue('--c-value')).toBe('');
    await rerender({ widths: { name: 240, value: 130 } });
    expect(t.style.getPropertyValue('--c-name')).toBe('240px');
    expect(t.style.getPropertyValue('--c-value')).toBe('130px');
    // the row is as wide as its columns: 240 + 130 + 70 + 80 + 50 + 22 + 5 gaps of 6px
    expect(t.style.getPropertyValue('--min-wide')).toBe(`${240 + 130 + 70 + 80 + 50 + 22 + 30}px`);
  });

  it('every data column has a divider: Type, Offset and Size too, each with its own minimum and its width as the grid column', async () => {
    const onColumnWidth = vi.fn();
    const { container, getByRole, findByText } = render(StructureTree, { root: tree(), loadPage: noLoad, onSelect: () => {}, onColumnWidth, widths: { type: 90, offset: 100, size: 60 } });
    await findByText('a');
    const mins = { Type: 40, Offset: 50, Size: 36 };
    const now = { Type: 90, Offset: 100, Size: 60 };
    for (const label of ['Type', 'Offset', 'Size'] as const) {
      const sep = getByRole('separator', { name: `Resize ${label} column` });
      expect(sep.tabIndex).toBe(0);
      expect(sep.getAttribute('aria-valuenow')).toBe(String(now[label]));
      expect(sep.getAttribute('aria-valuemin')).toBe(String(mins[label]));
      await fireEvent.keyDown(sep, { key: 'ArrowLeft' });
      expect(onColumnWidth).toHaveBeenLastCalledWith(label.toLowerCase(), Math.max(mins[label], now[label] - 16));
      await fireEvent.keyDown(sep, { key: 'Home' });
      expect(onColumnWidth).toHaveBeenLastCalledWith(label.toLowerCase(), mins[label]);
      await fireEvent.dblClick(sep);
      expect(onColumnWidth).toHaveBeenLastCalledWith(label.toLowerCase(), null);
    }
    expect(container.querySelectorAll('.head [role="separator"]')).toHaveLength(5);
    const t = container.querySelector<HTMLElement>('.tree')!;
    expect(t.style.getPropertyValue('--c-type')).toBe('90px');
    expect(t.style.getPropertyValue('--c-offset')).toBe('100px');
    expect(t.style.getPropertyValue('--c-size')).toBe('60px');
    expect(t.style.getPropertyValue('--c-name')).toBe('');
    // The flexible columns' minimums + 90 + 100 + 60 + 22 + 5 gaps of 6px
    expect(t.style.getPropertyValue('--min-wide')).toBe(`${TREE_COLUMN_DEFAULT.name + TREE_COLUMN_DEFAULT.value + 90 + 100 + 60 + 22 + 30}px`);
    // The CSS fallbacks for columns without a width come from prefs.ts through these variables
    for (const c of TREE_COLUMNS) expect(t.style.getPropertyValue(`--dw-${c}`)).toBe(`${TREE_COLUMN_DEFAULT[c]}px`);
    for (const [c, px] of Object.entries(TREE_COLUMN_DEFAULT_NARROW)) expect(t.style.getPropertyValue(`--dn-${c}`)).toBe(`${px}px`);
  });

  it('every cell truncates with an ellipsis and keeps the full text as its title (Name, Type, Offset, Size)', async () => {
    const long = 'a_very_long_field_name_'.repeat(4);
    const root = n('file', 0, 4, { children: [n(long, 0x12345678, 4, { typeName: 'some.long.Type.Name', value: 1 })] });
    const { container, findByText } = render(StructureTree, { root, loadPage: noLoad, onSelect: () => {}, widths: { name: 80, type: 40, offset: 50, size: 36 } });
    await findByText(long);
    const r = rowOf(container, long);
    expect(r.querySelector('.nm')!.getAttribute('title')).toBe(long);
    expect(r.querySelector('.type')!.getAttribute('title')).toBe('some.long.Type.Name');
    expect(r.querySelector('.off')!.getAttribute('title')).toBe('0x12345678');
    expect(r.querySelector('.num')!.getAttribute('title')).toBe('4');
  });

  it('their context menu offers Reset layout when the tree is given the action', async () => {
    const onResetLayout = vi.fn();
    const { getByRole, findByText } = render(StructureTree, { root: tree(), loadPage: noLoad, onSelect: () => {}, onColumnWidth: () => {}, onResetLayout });
    await findByText('a');
    const name = getByRole('separator', { name: 'Resize Name column' });
    await fireEvent.contextMenu(name, { clientX: 5, clientY: 5 });
    await fireEvent.click(getByRole('menuitem', { name: 'Reset layout' }));
    expect(onResetLayout).toHaveBeenCalledOnce();
  });
});
