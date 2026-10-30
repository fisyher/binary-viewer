import { describe, expect, it, vi } from 'vitest';
import type { Node } from './engine';
import {
  PAGE_SIZE,
  defaultExpanded,
  flattenTree,
  followPath,
  formatNodeValue,
  navigateRows,
  nodeByteRange,
  pathById,
  sanitizeText,
  throttleLatest,
  virtualWindow,
  type TreeState,
} from './tree-model';

let nextId = 1;
const n = (name: string, offset: number, size: number, extra: Partial<Node> = {}): Node => ({ id: nextId++, name, typeName: 't', offset, size, ...extra });

function sample() {
  const magic = n('magic', 0, 2, { value: 'BM' });
  const hdr = n('file_header', 0, 14, { children: [magic, n('size', 2, 4, { value: 58 })] });
  const dib = n('dib', 14, 40, { children: [n('w', 14, 4, { value: 1 })] });
  const root = n('file', 0, 58, { children: [hdr, dib] });
  return { root, hdr, dib, magic };
}
const state = (expanded: number[], extra: Partial<TreeState> = {}): TreeState => ({ expanded: new Set(expanded), pages: new Map(), ...extra });

describe('flattenTree', () => {
  it('shows only the root when collapsed, and children (pre-order, with depth) when expanded', () => {
    const { root, hdr } = sample();
    expect(flattenTree(root, state([])).map((r) => r.key)).toEqual([`n${root.id}`]);
    const rows = flattenTree(root, state([root.id, hdr.id]));
    expect(rows.map((r) => (r.kind === 'node' ? r.node.name : '?'))).toEqual(['file', 'file_header', 'magic', 'size', 'dib']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 2, 1]);
    expect(rows[2]!.parentKey).toBe(rows[1]!.key);
  });

  it('defaultExpanded opens the root and non-lazy top-level structs', () => {
    const { root, hdr, dib } = sample();
    expect([...defaultExpanded(root)].sort()).toEqual([root.id, hdr.id, dib.id].sort());
  });

  it('fixed-size lazy arrays show "load" rows until pages are cached, and cached pages are shown in order', () => {
    const lazy = n('table', 100, 1000 * 4, { lazy: { start: 100, count: 1000, elemType: 'u4', elemSize: 4, loaded: 0, resumeOffset: null } });
    const root = n('r', 0, 5000, { children: [lazy] });
    const open = [root.id, lazy.id];
    let rows = flattenTree(root, state(open));
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ kind: 'more', start: 0, remaining: 1000 });

    const el = (i: number) => n(`table[${i}]`, 100 + i * 4, 4);
    const page2 = Array.from({ length: PAGE_SIZE }, (_, i) => el(2 * PAGE_SIZE + i));
    const pages = new Map([[lazy.id, new Map([[2, page2]])]]);
    rows = flattenTree(root, state(open, { pages }));
    // gap(0..2) -> more row, 200 elements, gap(3..5) -> more row
    expect(rows.map((r) => r.kind)).toEqual(['node', 'node', 'more', ...Array(PAGE_SIZE).fill('node'), 'more']);
    expect(rows[2]).toMatchObject({ start: 0, remaining: 2 * PAGE_SIZE });
    expect(rows.at(-1)).toMatchObject({ start: 3 * PAGE_SIZE, remaining: 1000 - 3 * PAGE_SIZE });

    const all = new Map([[lazy.id, new Map([0, 1, 2, 3, 4].map((p) => [p, [el(p * PAGE_SIZE)]] as const))]]);
    rows = flattenTree(root, state(open, { pages: all }));
    expect(rows.some((r) => r.kind === 'more')).toBe(false);
  });

  it('variable-size lazy arrays offer a continuation row after the loaded children', () => {
    const kids = [n('a[0]', 0, 2), n('a[1]', 2, 2)];
    const arr = n('a', 0, 100, { children: kids, lazy: { start: 0, count: null, elemType: 'x', elemSize: null, loaded: 2, resumeOffset: 4 } });
    const root = n('r', 0, 100, { children: [arr] });
    const rows = flattenTree(root, state([root.id, arr.id], { loading: new Set([`${arr.id}:2`]) }));
    expect(rows.at(-1)).toMatchObject({ kind: 'more', start: 2, remaining: null, loading: true });
    arr.lazy!.resumeOffset = null;
    expect(flattenTree(root, state([root.id, arr.id])).some((r) => r.kind === 'more')).toBe(false);
  });

  it('copes with 100k nodes quickly', () => {
    const kids = Array.from({ length: 100_000 }, (_, i) => n(`k${i}`, i, 1));
    const root = n('r', 0, 100_000, { children: kids });
    const t0 = performance.now();
    const rows = flattenTree(root, state([root.id]));
    expect(rows).toHaveLength(100_001);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('virtualWindow', () => {
  it('covers the visible rows plus overscan, clamped to the row count', () => {
    expect(virtualWindow(1000, 0, 220, 22, 5)).toEqual({ start: 0, end: 15 });
    expect(virtualWindow(1000, 22 * 100, 220, 22, 5)).toEqual({ start: 95, end: 115 });
    expect(virtualWindow(1000, 22 * 995, 220, 22, 5)).toEqual({ start: 990, end: 1000 });
    expect(virtualWindow(0, 0, 220, 22)).toEqual({ start: 0, end: 0 });
    expect(virtualWindow(3, 1e9, 220, 22, 0)).toEqual({ start: 2, end: 3 });
    expect(virtualWindow(10, NaN, 100, 20, 0)).toEqual({ start: 0, end: 5 });
  });

  it('renders a bounded number of rows for huge trees', () => {
    const w = virtualWindow(1_000_000, 22 * 500_000, 440, 22);
    expect(w.end - w.start).toBeLessThan(40);
  });
});

describe('navigateRows', () => {
  const { root, hdr, dib } = sample();
  const rows = flattenTree(root, state([root.id, hdr.id]));
  // rows: file, file_header, magic, size, dib
  it('moves up/down/home/end within bounds', () => {
    expect(navigateRows(rows, 0, 'ArrowDown')).toEqual({ index: 1 });
    expect(navigateRows(rows, 0, 'ArrowUp')).toBeNull();
    expect(navigateRows(rows, 4, 'ArrowDown')).toBeNull();
    expect(navigateRows(rows, 2, 'Home')).toEqual({ index: 0 });
    expect(navigateRows(rows, 2, 'End')).toEqual({ index: 4 });
  });
  it('right expands a collapsed node, then enters its first child; left collapses, then goes to the parent', () => {
    expect(navigateRows(rows, 4, 'ArrowRight')).toEqual({ index: 4, toggle: { id: dib.id, expand: true } });
    expect(navigateRows(rows, 1, 'ArrowRight')).toEqual({ index: 2 });
    expect(navigateRows(rows, 2, 'ArrowRight')).toBeNull(); // leaf
    expect(navigateRows(rows, 1, 'ArrowLeft')).toEqual({ index: 1, toggle: { id: hdr.id, expand: false } });
    expect(navigateRows(rows, 2, 'ArrowLeft')).toEqual({ index: 1 });
    expect(navigateRows(rows, 0, 'ArrowLeft')).toEqual({ index: 0, toggle: { id: root.id, expand: false } });
    expect(navigateRows([], 0, 'ArrowDown')).toBeNull();
  });
});

describe('helpers', () => {
  it('nodeByteRange: inclusive range, null for zero-size/invalid', () => {
    expect(nodeByteRange(n('a', 10, 4))).toEqual({ start: 10, end: 13 });
    expect(nodeByteRange(n('a', 10, 0))).toBeNull();
    expect(nodeByteRange(n('a', -1, 4))).toBeNull();
    expect(nodeByteRange(n('a', 1.5, 4))).toBeNull();
  });

  it('pathById / followPath', () => {
    const { root, hdr, magic } = sample();
    expect(pathById(root, magic.id)?.map((x) => x.name)).toEqual(['file', 'file_header', 'magic']);
    expect(pathById(root, 99999)).toBeNull();
    expect(followPath(root, [root.id, hdr.id, magic.id]).at(-1)).toBe(magic);
    expect(followPath(root, [root.id, 424242])).toEqual([root]);
    expect(followPath(root, [424242])).toEqual([]);
  });

  it('formatNodeValue: lazy summary, enum label, strings, bytes, bigint; long values truncated', () => {
    const lazy = { start: 0, count: 12, elemType: 'u1', elemSize: 1, loaded: 0, resumeOffset: null };
    expect(formatNodeValue(n('a', 0, 12, { lazy }))).toBe('[12] items');
    expect(formatNodeValue(n('a', 0, 12, { lazy: { ...lazy, count: null, loaded: 5 } }))).toBe('[5+] items');
    expect(formatNodeValue(n('a', 0, 4, { value: 3, display: '3', enumLabel: 'BI_BITFIELDS' }))).toBe('BI_BITFIELDS (3)');
    expect(formatNodeValue(n('a', 0, 8, { value: 123456789012345678901n }))).toBe('123456789012345678901');
    expect(formatNodeValue(n('a', 0, 2, { value: 'BM' }))).toBe('"BM"');
    expect(formatNodeValue(n('a', 0, 3, { value: new Uint8Array([1, 0xab, 255]) }))).toBe('01 ab ff');
    expect(formatNodeValue(n('a', 0, 3, { value: 'x'.repeat(5000) })).length).toBeLessThanOrEqual(203);
  });

  it('sanitizeText escapes every invisible class, keeps real text, and truncates', () => {
    const cases: Array<[string, string]> = [
      ['\u0000', '\\u{0000}'], // Cc
      ['\u009f', '\\u{009F}'], // Cc (C1)
      ['‮', '\\u{202E}'], // bidi override (Cf)
      ['‏', '\\u{200F}'], // RLM
      ['‎', '\\u{200E}'], // LRM
      ['؜', '\\u{061C}'], // ALM
      ['​', '\\u{200B}'], // ZWSP
      ['‍', '\\u{200D}'], // ZWJ
      ['‌', '\\u{200C}'], // ZWNJ
      [' ', '\\u{2028}'], // line separator (Zl)
      [' ', '\\u{2029}'], // paragraph separator (Zp)
      ['﻿', '\\u{FEFF}'], // BOM
      ['\ud800', '\\u{D800}'], // lone high surrogate
      ['\udc00', '\\u{DC00}'], // lone low surrogate
    ];
    for (const [raw, shown] of cases) expect(sanitizeText(`a${raw}b`)).toBe(`a${shown}b`);
    expect(sanitizeText('é ü 中 😀')).toBe('é ü 中 😀'); // accents, CJK, emoji kept
    expect(sanitizeText('abcdef', 3)).toBe('abc…');
    expect(sanitizeText('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>'); // text, escaping is the renderer's job
  });

  it('quoted string values escape quote and backslash, so data cannot imitate our escapes', () => {
    const v = (value: string) => formatNodeValue({ id: 1, name: 'a', typeName: 'str', offset: 0, size: 1, value });
    expect(v('say "hi"')).toBe('"say \\"hi\\""');
    expect(v('\\u{202E}')).toBe('"\\\\u{202E}"'); // literal backslash in the data
    expect(v('‮')).toBe('"\\u{202E}"'); // a real U+202E shown as our escape: distinguishable from the line above
    const long = v('y'.repeat(5000));
    expect(long.startsWith('"yyy')).toBe(true);
    expect(long.endsWith('…"')).toBe(true); // closing quote survives truncation
    expect(long.length).toBeLessThanOrEqual(200);
    expect(v('"'.repeat(5000)).endsWith('"')).toBe(true);
  });

  it('sanitizeText never splits a surrogate pair when truncating', () => {
    const s = 'ab😀cd'; // emoji occupies units 2-3
    expect(sanitizeText(s, 3)).toBe('ab…'); // would have cut mid-pair
    expect(sanitizeText(s, 4)).toBe('ab😀…');
    expect(sanitizeText(s, 6)).toBe(s);
    expect(sanitizeText('‏'.repeat(100_000)).length).toBeLessThanOrEqual(201);
  });

});

describe('throttleLatest', () => {
  it('runs the first call at once and collapses a burst into one trailing call with the last args', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const t = throttleLatest(fn, 100);
    t(1);
    t(2);
    t(3);
    expect(fn.mock.calls).toEqual([[1]]);
    vi.advanceTimersByTime(100);
    expect(fn.mock.calls).toEqual([[1], [3]]);
    vi.advanceTimersByTime(500);
    t(4);
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('cancel drops the queued call', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const t = throttleLatest(fn, 100);
    t(1);
    t(2);
    t.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn.mock.calls).toEqual([[1]]);
    vi.useRealTimers();
  });
});

describe('matchNodeIds', () => {
  const nd = (id: number, name: string, children?: Node[]): Node => ({ id, name, typeName: 't', offset: 0, size: 1, children });
  it('maps nodes with the same name path, numbering duplicate siblings', async () => {
    const { matchNodeIds, nodePathKeys } = await import('./tree-model');
    const oldRoot = nd(1, 'f', [nd(2, 'a', [nd(3, 'x')]), nd(4, 'a'), nd(5, 'gone')]);
    const newRoot = nd(10, 'f', [nd(11, 'a', [nd(12, 'x')]), nd(13, 'a'), nd(14, 'new')]);
    expect(nodePathKeys(oldRoot).get(4)).toBe('/a#1');
    const m = matchNodeIds(oldRoot, newRoot);
    expect(m.get(1)).toBe(10);
    expect(m.get(3)).toBe(12);
    expect(m.get(4)).toBe(13);
    expect(m.has(5)).toBe(false);
  });
});
