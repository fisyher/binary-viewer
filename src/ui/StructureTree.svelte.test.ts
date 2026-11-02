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

const ROW = 24; // StructureTree's row height in px

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

describe('StructureTree colour groups and breadcrumb path', () => {
  const groupOf = (c: HTMLElement, name: string) => {
    const r = row(c, name);
    return { swatch: r.querySelector<HTMLElement>('.swatch')?.dataset.group ?? null, rule: r.querySelector<HTMLElement>('.grp-rule')?.dataset.group ?? null, r };
  };

  it('puts an 8x8 swatch before each top-level group node and a rule inside it, both hidden from assistive technology', async () => {
    const { root } = sample();
    const { container, findByText } = render(StructureTree, { root, loadPage: noLoad, onSelect: () => {} });
    await findByText('magic');
    expect(groupOf(container, 'file')).toMatchObject({ swatch: null, rule: null }); // the root
    expect(groupOf(container, 'file_header')).toMatchObject({ swatch: '0', rule: null });
    expect(groupOf(container, 'dib')).toMatchObject({ swatch: '1', rule: null });
    expect(groupOf(container, 'magic')).toMatchObject({ swatch: null, rule: '0' });
    expect(groupOf(container, 'size')).toMatchObject({ swatch: null, rule: '0' });
    expect(groupOf(container, 'w')).toMatchObject({ swatch: null, rule: '1' });
    for (const el of container.querySelectorAll('.swatch, .grp-rule')) expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('.swatch')).toHaveLength(2);
  });

  it('groups by the children of the only child of the root, like the hex view and the minimap', async () => {
    const x = n('x', 0, 4, { children: [n('x1', 0, 4)] });
    const y = n('y', 4, 4, { children: [n('y1', 4, 4)] });
    const wrap = n('wrap', 0, 8, { children: [x, y] });
    const root = n('file', 0, 8, { children: [wrap] });
    const { container, findByText } = render(StructureTree, { root, loadPage: noLoad, onSelect: () => {} });
    await findByText('x'); // the wrapper is open by default
    expect(groupOf(container, 'wrap')).toMatchObject({ swatch: null, rule: null });
    expect(groupOf(container, 'x')).toMatchObject({ swatch: '0', rule: null });
    expect(groupOf(container, 'y')).toMatchObject({ swatch: '1', rule: null });
  });

  it('reports the chain from the root with every selection', async () => {
    const { root, dib } = sample();
    const onPath = vi.fn();
    const { container, findByText } = render(StructureTree, { root, loadPage: noLoad, onSelect: () => {}, onPath });
    await findByText('w');
    await fireEvent.click(row(container, 'w'));
    expect(onPath).toHaveBeenLastCalledWith([root, dib, dib.children![0]]);
    await fireEvent.click(row(container, 'file'));
    expect(onPath).toHaveBeenLastCalledWith([root]);
  });

  it('reports the chain through the elements of a fixed-size lazy array', async () => {
    const elems = [n('t[0]', 6, 4, { children: [n('a', 6, 2)] }), n('t[1]', 10, 4, { children: [n('a', 10, 2)] })];
    const arr = n('t', 6, 8, { lazy: { start: 6, count: 2, elemType: 'rec', elemSize: 4, loaded: 0, resumeOffset: null } });
    const root = n('file', 0, 14, { children: [arr] });
    const loadPage = vi.fn(async () => ({ nodes: elems, lazy: arr.lazy ?? null }));
    const onPath = vi.fn();
    const { container, component } = render(StructureTree, { root, loadPage, onSelect: () => {}, onPath });
    await component.reveal([root.id, arr.id], 1, 11);
    await waitFor(() => expect(onPath).toHaveBeenCalled());
    const chain = onPath.mock.calls.at(-1)![0] as Node[];
    expect(chain.map((x) => x.name)).toEqual(['file', 't', 't[1]', 'a']);
    expect(container).toBeTruthy();
  });

  it('focus() moves keyboard focus to the tree', async () => {
    const { root } = sample();
    const { container, component, findByText } = render(StructureTree, { root, loadPage: noLoad, onSelect: () => {} });
    await findByText('magic');
    component.focus();
    expect(document.activeElement).toBe(container.querySelector('[role="tree"]'));
  });
});

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
    scroller.scrollTop = ROW * 50_000;
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
      scroller.scrollTop = ROW * 195;
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

describe('StructureTree view preservation across a re-parse', () => {
  it('keeps collapsed state and selection by node path when preserveFor is the new root', async () => {
    const a = sample();
    const { container, rerender } = render(StructureTree, { root: a.root, loadPage: noLoad, onSelect: () => {} });
    await waitFor(() => row(container, 'magic'));
    await fireEvent.click(row(container, 'file_header')); // select
    await fireEvent.keyDown(container.querySelector('[role="tree"]')!, { key: 'ArrowLeft' }); // collapse it
    await waitFor(() => expect(row(container, 'file_header').getAttribute('aria-expanded')).toBe('false'));

    const b = sample(); // same shape, fresh ids (a re-parse)
    await rerender({ root: b.root, preserveFor: b.root });
    await waitFor(() => expect(row(container, 'file_header')).toBeTruthy());
    expect(row(container, 'file_header').getAttribute('aria-expanded')).toBe('false');
    expect(row(container, 'file_header').getAttribute('aria-selected')).toBe('true');

    // a different root without preserveFor resets to the default view
    const c = sample();
    await rerender({ root: c.root, preserveFor: null });
    await waitFor(() => expect(row(container, 'file_header').getAttribute('aria-expanded')).toBe('true'));
    expect(row(container, 'file_header').getAttribute('aria-selected')).not.toBe('true');
  });
});

describe('StructureTree pointer interaction', () => {
  const flat = () => {
    const kids = Array.from({ length: 60 }, (_, i) => n(`k${i}`, i, 1, i % 2 === 0 ? { children: [n(`c${i}`, i, 1)] } : {}));
    return n('r', 0, 60, { children: kids });
  };
  const renderFlat = async () => {
    const onSelect = vi.fn();
    const r = render(StructureTree, { root: flat(), loadPage: noLoad, onSelect });
    await waitFor(() => row(r.container, 'k0'));
    return { ...r, onSelect, scroller: r.container.querySelector('.scroller') as HTMLElement };
  };

  it('clicking a partly clipped row selects it without scrolling', async () => {
    const { container, scroller, onSelect } = await renderFlat();
    scroller.scrollTop = ROW * 5 + 11;
    await fireEvent.scroll(scroller);
    await waitFor(() => row(container, 'c2')); // rows: r, k0, c0, k1, k2, c2 (index 5, half clipped at the top), ...
    await fireEvent.click(row(container, 'c2'), { detail: 1 });
    expect(scroller.scrollTop).toBe(ROW * 5 + 11);
    expect(row(container, 'c2').getAttribute('aria-selected')).toBe('true');
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'c2' }), expect.anything());
  });

  it('keyboard navigation past the bottom still scrolls the active row into view', async () => {
    const { container, scroller } = await renderFlat();
    const tree = container.querySelector('[role="tree"]')!;
    await fireEvent.click(row(container, 'k0'), { detail: 1 });
    for (let i = 0; i < 30; i++) await fireEvent.keyDown(tree, { key: 'ArrowDown' });
    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0));
    const selected = container.querySelector('.row.selected');
    expect(selected).not.toBeNull(); // the selected row is rendered, i.e. inside the scrolled window
    expect(selected!.querySelector('.nm')!.textContent).not.toBe('k0');
  });

  it('a double-click acts on the row of the first click, even when the second click lands on another row', async () => {
    const { container, onSelect } = await renderFlat();
    await fireEvent.click(row(container, 'k0'), { detail: 1 });
    expect(row(container, 'k0').getAttribute('aria-expanded')).toBe('true'); // top-level fields start expanded
    await fireEvent.click(row(container, 'k2'), { detail: 2 }); // the rows moved under the pointer
    await fireEvent.dblClick(row(container, 'k2'), { detail: 2 });
    expect(row(container, 'k0').getAttribute('aria-expanded')).toBe('false'); // toggled
    expect(row(container, 'k2').getAttribute('aria-expanded')).toBe('true'); // untouched
    expect(row(container, 'k0').getAttribute('aria-selected')).toBe('true');
    expect(row(container, 'k2').getAttribute('aria-selected')).toBe('false');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('a double-click on a twisty toggles once', async () => {
    const { container } = await renderFlat();
    const twisty = row(container, 'k0').querySelector('[data-twisty]')!;
    await fireEvent.click(twisty, { detail: 1 });
    await fireEvent.click(twisty, { detail: 2 });
    expect(row(container, 'k0').getAttribute('aria-expanded')).toBe('false'); // the second click of a double-click is ignored
    await fireEvent.dblClick(twisty, { detail: 2 }); // must not reach the row (which would toggle it again)
    expect(row(container, 'k0').getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(twisty, { detail: 1 }); // and a later single click still toggles
    expect(row(container, 'k0').getAttribute('aria-expanded')).toBe('true');
  });

  it('a double-click on a link button runs the jump once', async () => {
    const root = n('r', 0, 10, { children: [n('ptr', 0, 4, { value: 8, link: { offset: 8, size: 2 } })] });
    const onJump = vi.fn();
    const { container } = render(StructureTree, { root, loadPage: noLoad, onSelect: () => {}, onJump });
    await waitFor(() => row(container, 'ptr'));
    const btn = row(container, 'ptr').querySelector('[data-link]')!;
    await fireEvent.click(btn, { detail: 1 });
    await fireEvent.click(btn, { detail: 2 });
    await fireEvent.dblClick(btn, { detail: 2 });
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(8, 2);
  });

  it('a double-click on a reference jump button selects the target once', async () => {
    const inner = n('data', 20, 4);
    const target = n('hdr', 20, 4, { children: [inner], fromRef: true });
    const ref = n('lh', 0, 0, { ref: { typeName: 'hdr', offset: 20, loaded: true, jumps: [{ label: 'data', path: 'data' }] }, children: [target] });
    const root = n('r', 0, 30, { children: [ref] });
    const onSelect = vi.fn();
    const { container } = render(StructureTree, { root, loadPage: noLoad, onSelect });
    await waitFor(() => row(container, 'lh'));
    const btn = row(container, 'lh').querySelector('[data-jump]')!;
    await fireEvent.click(btn, { detail: 1 });
    await fireEvent.click(btn, { detail: 2 });
    await fireEvent.dblClick(btn, { detail: 2 });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(inner, expect.anything());
  });

  it('a double-click after a twisty click never acts on an earlier clicked row', async () => {
    const { container } = await renderFlat();
    await fireEvent.click(row(container, 'k0'), { detail: 1 });
    await fireEvent.click(row(container, 'k2').querySelector('[data-twisty]')!, { detail: 1 }); // collapses k2, forgets k0
    await fireEvent.click(row(container, 'k2'), { detail: 2 });
    await fireEvent.dblClick(row(container, 'k2'), { detail: 2 });
    expect(row(container, 'k0').getAttribute('aria-expanded')).toBe('true'); // untouched
    expect(row(container, 'k2').getAttribute('aria-expanded')).toBe('true'); // twisty collapsed it, the dblclick expanded it again
  });

  it('aria-activedescendant names the active row after a click and after ArrowDown, and is omitted when it is not rendered', async () => {
    const { container, scroller } = await renderFlat();
    const tree = container.querySelector('[role="tree"]')!;
    await fireEvent.click(row(container, 'k1'), { detail: 1 });
    expect(tree.getAttribute('aria-activedescendant')).toBe(row(container, 'k1').id);
    await fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(tree.getAttribute('aria-activedescendant')).toBe(row(container, 'k2').id);
    const ids = rowsOf(container).map((r) => r.id);
    expect(ids.every((i) => i !== '')).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    scroller.scrollTop = ROW * 40; // the active row leaves the rendered window
    await fireEvent.scroll(scroller);
    await waitFor(() => expect(row(container, 'k2')).toBeUndefined());
    expect(tree.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('two trees never share row ids', async () => {
    const a = render(StructureTree, { root: sample().root, loadPage: noLoad, onSelect: () => {} });
    const b = render(StructureTree, { root: sample().root, loadPage: noLoad, onSelect: () => {} });
    await waitFor(() => row(a.container, 'magic'));
    const ids = [...rowsOf(a.container), ...rowsOf(b.container)].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
