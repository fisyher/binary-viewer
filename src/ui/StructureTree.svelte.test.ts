// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Node } from '../core/engine';
import StructureTree from './StructureTree.svelte';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 440 }); // 20 rows
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

let nextId = 1;
const n = (name: string, offset: number, size: number, extra: Partial<Node> = {}): Node => ({ id: nextId++, name, typeName: 'u1', offset, size, ...extra });

function sample() {
  const magic = n('magic', 0, 2, { value: 'BM', typeName: 'str' });
  const zero = n('empty', 14, 0);
  const hdr = n('file_header', 0, 14, { children: [magic, n('size', 2, 4, { value: 58, enumLabel: 'FIVE_EIGHT' }), zero] });
  const dib = n('dib', 14, 40, { children: [n('w', 14, 4, { value: 1 })], error: 'truncated', validation: ['bad width'] });
  const root = n('file', 0, 58, { children: [hdr, dib] });
  return { root, hdr, dib, magic, zero };
}

const noLoad = async () => ({ nodes: [], lazy: null });
const rowsOf = (c: HTMLElement) => [...c.querySelectorAll('[role="treeitem"]')] as HTMLElement[];
const row = (c: HTMLElement, name: string) => rowsOf(c).find((r) => r.querySelector('.nm')?.textContent === name)!;

describe('StructureTree', () => {
  it('shows root and top-level fields expanded by default with columns', async () => {
    const { root } = sample();
    const { container } = render(StructureTree, { root, loadPage: noLoad, onSelect: () => {} });
    await waitFor(() => expect(rowsOf(container).length).toBe(7));
    const magic = row(container, 'magic');
    expect(magic.textContent).toContain('"BM"');
    expect(magic.textContent).toContain('str');
    expect(magic.textContent).toContain('0x0');
    expect(row(container, 'size').textContent).toContain('FIVE_EIGHT (58)');
    expect(row(container, 'file_header').getAttribute('aria-expanded')).toBe('true');
  });

  it('clicking a node calls onSelect with its inclusive byte range; zero-size gives null', async () => {
    const { root, magic, zero } = sample();
    const onSelect = vi.fn();
    const { container } = render(StructureTree, { root, loadPage: noLoad, onSelect });
    await waitFor(() => row(container, 'magic'));
    await fireEvent.click(row(container, 'magic'));
    expect(onSelect).toHaveBeenLastCalledWith(magic, { start: 0, end: 1 });
    expect(row(container, 'magic').getAttribute('aria-selected')).toBe('true');
    await fireEvent.click(row(container, 'size'));
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'size' }), { start: 2, end: 5 });
    await fireEvent.click(row(container, 'empty'));
    expect(onSelect).toHaveBeenLastCalledWith(zero, null);
  });

  it('keyboard: arrows move the selection, right/left expand and collapse', async () => {
    const { root, hdr } = sample();
    const onSelect = vi.fn();
    const { container } = render(StructureTree, { root, loadPage: noLoad, onSelect });
    await waitFor(() => row(container, 'magic'));
    const tree = container.querySelector('[role="tree"]')!;
    await fireEvent.click(row(container, 'file_header'));
    await fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'magic' }), { start: 0, end: 1 });
    await fireEvent.keyDown(tree, { key: 'ArrowLeft' }); // leaf -> parent
    expect(onSelect).toHaveBeenLastCalledWith(hdr, { start: 0, end: 13 });
    await fireEvent.keyDown(tree, { key: 'ArrowLeft' }); // collapse
    await waitFor(() => expect(row(container, 'file_header').getAttribute('aria-expanded')).toBe('false'));
    expect(container.textContent).not.toContain('magic');
    await fireEvent.keyDown(tree, { key: 'ArrowRight' }); // expand
    await waitFor(() => expect(row(container, 'magic')).toBeTruthy());
    await fireEvent.keyDown(tree, { key: 'ArrowRight' }); // into first child
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'magic' }), expect.anything());
    await fireEvent.keyDown(tree, { key: 'End' });
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'w' }), { start: 14, end: 17 });
    await fireEvent.keyDown(tree, { key: 'Home' });
    expect(onSelect).toHaveBeenLastCalledWith(root, { start: 0, end: 57 });
  });

  it('renders hostile names and values as literal text, never HTML', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const bad = n('x', 0, 3, { value: evil, display: evil, typeName: evil, error: evil });
    const root = n(evil, 0, 3, { children: [bad] });
    const { container } = render(StructureTree, { root, loadPage: noLoad, onSelect: () => {} });
    await waitFor(() => expect(rowsOf(container).length).toBe(2));
    expect(container.querySelector('img')).toBeNull();
    expect(rowsOf(container)[0]!.querySelector('.nm')!.textContent).toBe(evil);
    expect(rowsOf(container)[1]!.textContent).toContain(evil);
  });

  it('truncates very long values', async () => {
    const root = n('r', 0, 1, { children: [n('s', 0, 1, { value: 'y'.repeat(100_000) })] });
    const { container } = render(StructureTree, { root, loadPage: noLoad, onSelect: () => {} });
    await waitFor(() => expect(rowsOf(container).length).toBe(2));
    expect(row(container, 's').querySelector('.val')!.textContent!.length).toBeLessThan(250);
  });

  it('error/warning badge carries the messages in its tooltip', async () => {
    const { root } = sample();
    const { container } = render(StructureTree, {
      root,
      diagnostics: [{ severity: 'warning', code: 'validation', message: 'bad width', nodeId: root.children![1]!.id }],
      loadPage: noLoad,
      onSelect: () => {},
    });
    await waitFor(() => row(container, 'dib'));
    const badge = row(container, 'dib').querySelector('.badge')!;
    expect(badge.getAttribute('title')).toBe('truncated\nbad width');
    expect(badge.getAttribute('data-badge')).toBe('error'); // node.error wins
    expect(row(container, 'file_header').querySelector('.badge')).toBeNull();
  });

  it('is virtualized: 100k children render only a window of rows', async () => {
    const kids = Array.from({ length: 100_000 }, (_, i) => n(`k${i}`, i, 1));
    const root = n('r', 0, 100_000, { children: kids });
    const { container } = render(StructureTree, { root, loadPage: noLoad, onSelect: () => {} });
    await waitFor(() => expect(rowsOf(container).length).toBeGreaterThan(5));
    expect(rowsOf(container).length).toBeLessThan(40);
    const scroller = container.querySelector('.scroller') as HTMLElement;
    scroller.scrollTop = 22 * 50_000;
    await fireEvent.scroll(scroller);
    await waitFor(() => expect(row(container, 'k50000')).toBeTruthy());
    expect(rowsOf(container).length).toBeLessThan(40);
  });

  describe('lazy arrays', () => {
    const lazyRoot = () => {
      const table = n('table', 100, 1000, { typeName: 'u1[]', lazy: { start: 100, count: 1000, elemType: 'u1', elemSize: 1, loaded: 0, resumeOffset: null } });
      return { table, root: n('r', 0, 2000, { children: [table, n('tail', 1100, 1)] }) };
    };
    const page = (start: number, count: number) => Array.from({ length: count }, (_, i) => n(`table[${start + i}]`, 100 + start + i, 1, { value: i }));

    it('shows "[count] items", loads page 0 on expand, offers load more, and caches pages', async () => {
      const { table, root } = lazyRoot();
      const loadPage = vi.fn(async (_id: number, start: number, count: number) => ({ nodes: page(start, count), lazy: null }));
      const { container, findByText } = render(StructureTree, { root, loadPage, onSelect: () => {} });
      await waitFor(() => row(container, 'table'));
      expect(row(container, 'table').textContent).toContain('[1000] items');
      await fireEvent.dblClick(row(container, 'table'));
      await waitFor(() => expect(row(container, 'table[0]')).toBeTruthy());
      expect(loadPage).toHaveBeenCalledTimes(1);
      expect(loadPage).toHaveBeenCalledWith(table.id, 0, 200);
      // the "load more" row sits below 200 elements, so it only exists once scrolled into the window
      expect(container.querySelector('.more')).toBeNull();
      const scroller = container.querySelector('.scroller') as HTMLElement;
      scroller.scrollTop = 22 * 195;
      await fireEvent.scroll(scroller);
      await findByText(/Load more/);

      await fireEvent.click(container.querySelector('.more')!);
      await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(2));
      expect(loadPage).toHaveBeenLastCalledWith(table.id, 200, 200);

      // collapse + expand again: served from the page cache
      scroller.scrollTop = 0;
      await fireEvent.scroll(scroller);
      await fireEvent.dblClick(row(container, 'table'));
      await fireEvent.dblClick(row(container, 'table'));
      await waitFor(() => expect(row(container, 'table[0]')).toBeTruthy());
      expect(loadPage).toHaveBeenCalledTimes(2);
    });

    it('reveal(path, lazyIndex, offset) loads the right page, expands and selects the element', async () => {
      const { table, root } = lazyRoot();
      const loadPage = vi.fn(async (_id: number, start: number, count: number) => ({ nodes: page(start, count), lazy: null }));
      const onSelect = vi.fn();
      const { container, component } = render(StructureTree, { root, loadPage, onSelect });
      await waitFor(() => row(container, 'table'));
      await component.reveal([root.id, table.id], 450, 100 + 450);
      expect(loadPage).toHaveBeenCalledWith(table.id, 400, 200);
      expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'table[450]' }), { start: 550, end: 550 });
      await waitFor(() => expect(row(container, 'table[450]').getAttribute('aria-selected')).toBe('true'));
    });

    it('variable-size arrays append loaded elements and update the continuation', async () => {
      const kids = [n('a[0]', 0, 2), n('a[1]', 2, 2)];
      const arr = n('a', 0, 100, { children: kids, lazy: { start: 0, count: null, elemType: 'x', elemSize: null, loaded: 2, resumeOffset: 4 } });
      const root = n('r', 0, 100, { children: [arr] });
      const more = [n('a[2]', 4, 2)];
      const loadPage = vi.fn(async () => ({ nodes: more, lazy: { ...arr.lazy!, loaded: 3, resumeOffset: null } }));
      const { container } = render(StructureTree, { root, loadPage, onSelect: () => {} });
      await waitFor(() => row(container, 'a'));
      await fireEvent.click(row(container, 'a').querySelector('[data-twisty]')!);
      await waitFor(() => container.querySelector('.more'));
      await fireEvent.click(container.querySelector('.more')!);
      await waitFor(() => expect(row(container, 'a[2]')).toBeTruthy());
      expect(loadPage).toHaveBeenCalledWith(arr.id, 2, 200);
      expect(container.querySelector('.more')).toBeNull();
    });
  });
});
