import { describe, expect, it } from 'vitest';
import type { Node } from '../../core/engine';
import { collapseLeading, crumbTitle, crumbsFromChain, crumbsFromLocation, keepDeeperCrumbs } from './breadcrumb';

let nextId = 1;
const node = (name: string, offset: number, size: number, children?: Node[], extra: Partial<Node> = {}): Node => ({
  id: nextId++,
  name,
  typeName: 'struct',
  offset,
  size,
  ...(children ? { children } : {}),
  ...extra,
});
const lazyArray = (name: string, start: number, count: number, elemSize: number): Node =>
  node(name, start, count * elemSize, undefined, { typeName: 'rec[]', lazy: { start, count, elemType: 'rec', elemSize, loaded: 0, resumeOffset: null } });

function sample() {
  const magic = node('magic', 0, 2);
  const w = node('w', 2, 4);
  const header = node('header', 0, 6, [magic, w]);
  const table = lazyArray('table', 6, 1000, 4);
  const root = node('bmp', 0, 4006, [header, table]);
  return { root, header, magic, w, table };
}

describe('crumbsFromLocation', () => {
  it('builds one segment per node on the path, with a snapshot of its data', () => {
    const { root, header, w } = sample();
    const c = crumbsFromLocation(root, [root.id, header.id, w.id], null, 3);
    expect(c.map((x) => x.label)).toEqual(['bmp', 'header', 'w']);
    expect(c[2]).toMatchObject({ id: w.id, name: 'w', typeName: 'struct', offset: 2, size: 4 });
    expect(c[1]!.reveal).toEqual({ path: [root.id, header.id], lazyIndex: null, offset: null });
    // a snapshot: later changes to the tree do not leak in
    w.name = 'renamed';
    expect(c[2]!.name).toBe('w');
  });

  it('shows a located element of a fixed-size lazy array as name[index] and reveals it with that index', () => {
    const { root, table } = sample();
    const c = crumbsFromLocation(root, [root.id, table.id], 450, 6 + 450 * 4 + 1);
    expect(c.map((x) => x.label)).toEqual(['bmp', 'table[450]']);
    expect(c[1]!.reveal).toEqual({ path: [root.id, table.id], lazyIndex: 450, offset: 6 + 450 * 4 + 1, sub: [] }); // the element itself, not the deepest node at the caret
    expect(c[1]!.name).toBe('table'); // the node's own name stays for the title
  });

  it('stops where a node is not attached, and gives nothing for a path from another tree', () => {
    const { root, header } = sample();
    expect(crumbsFromLocation(root, [root.id, header.id, 99999], null, 0).map((x) => x.label)).toEqual(['bmp', 'header']);
    expect(crumbsFromLocation(root, [12345], null, 0)).toEqual([]);
  });

  it('cleans untrusted names', () => {
    const evil = node('a\u0000b' + 'x'.repeat(200), 0, 1);
    const root = node('r', 0, 1, [evil]);
    const c = crumbsFromLocation(root, [root.id, evil.id], null, 0);
    expect(c[1]!.label).not.toContain('\u0000');
    expect(c[1]!.label.length).toBeLessThan(80);
  });
});

describe('crumbs inside a lazy array element reveal the exact node', () => {
  it('gives each segment its child-index path from the element', () => {
    const { root, table } = sample();
    const tag = node('tag', 6 + 12, 2);
    const header = node('header', 6 + 12, 4, [tag]);
    const val = node('val', 6 + 16, 4);
    const elem = node('entry', 6 + 12, 8, [header, val]);
    const c = crumbsFromChain([root, table, elem, header, tag]);
    expect(c.map((x) => x.label)).toEqual(['bmp', 'table[3]', 'header', 'tag']);
    expect(c.map((x) => x.reveal.sub)).toEqual([undefined, [], [0], [0, 0]]);
    expect(crumbsFromChain([root, table, elem, val]).at(-1)!.reveal.sub).toEqual([1]);
    // every segment of the caret-based path is the element itself
    expect(crumbsFromLocation(root, [root.id, table.id], 3, 6 + 12).at(-1)!.reveal.sub).toEqual([]);
  });

  it('leaves sub out when a node cannot be found among its parent children (offset resolution is the fallback)', () => {
    const { root, table } = sample();
    const inner = node('inner', 6 + 12, 2);
    const detached = node('detached', 6 + 12, 2, [inner]);
    const elem = node('entry', 6 + 12, 8, [node('other', 6 + 12, 2)]);
    const c = crumbsFromChain([root, table, elem, detached, inner]);
    expect(c[2]!.reveal.sub).toBeUndefined();
    expect(c[3]!.reveal.sub).toBeUndefined();
  });
});

describe('crumbsFromChain', () => {
  it('reveals plain nodes by their id path', () => {
    const { root, header, magic } = sample();
    const c = crumbsFromChain([root, header, magic]);
    expect(c.map((x) => x.label)).toEqual(['bmp', 'header', 'magic']);
    expect(c[2]!.reveal).toEqual({ path: [root.id, header.id, magic.id], lazyIndex: null, offset: null });
  });

  it('shows a lazy array element as the array name[index] segment, revealed through the array by index and offset', () => {
    const { root, table } = sample();
    const elem = node('table[3]', 6 + 12, 4, [node('a', 6 + 14, 2)]);
    const field = elem.children![0]!;
    const element = crumbsFromChain([root, table, elem]);
    expect(element.map((x) => x.label)).toEqual(['bmp', 'table[3]']); // the same as crumbsFromLocation gives for a hex click
    expect(element[1]).toMatchObject({ id: table.id, name: 'table' });
    expect(element[1]!.reveal).toEqual({ path: [root.id, table.id], lazyIndex: 3, offset: 18, sub: [] });
    const c = crumbsFromChain([root, table, elem, field]);
    expect(c.map((x) => x.label)).toEqual(['bmp', 'table[3]', 'a']);
    expect(c[2]!.reveal).toEqual({ path: [root.id, table.id], lazyIndex: 3, offset: 20, sub: [0] });
  });

  it('keeps the array segment when it is selected itself', () => {
    const { root, table } = sample();
    const c = crumbsFromChain([root, table]);
    expect(c.map((x) => x.label)).toEqual(['bmp', 'table']);
    expect(c[1]!.reveal).toEqual({ path: [root.id, table.id], lazyIndex: null, offset: null });
  });
});

describe('keepDeeperCrumbs', () => {
  it('keeps a deeper tree path when a lookup at a caret inside its deepest node only reaches the array', () => {
    const { root, table } = sample();
    const elem = node('table[3]', 18, 4, [node('a', 20, 2)]);
    const current = crumbsFromChain([root, table, elem, elem.children![0]!]);
    const looked = crumbsFromLocation(root, [root.id, table.id], 3, 21); // the worker only knows down to the array
    expect(looked.map((c) => c.label)).toEqual(['bmp', 'table[3]']);
    expect(keepDeeperCrumbs(current, looked, 21)).toBe(true);
    expect(keepDeeperCrumbs(current, looked, 18)).toBe(false); // caret left the deepest node: the lookup is the truth
    expect(keepDeeperCrumbs(current, looked, 22)).toBe(false);
  });

  it('does not keep when the lookup is not a prefix, is as long, or is empty', () => {
    const { root, header, magic, w } = sample();
    const current = crumbsFromChain([root, header, magic]);
    expect(keepDeeperCrumbs(current, crumbsFromChain([root, header, w]), 0)).toBe(false);
    expect(keepDeeperCrumbs(current, crumbsFromChain([root, header]), 99)).toBe(false); // caret outside magic
    expect(keepDeeperCrumbs(current, [], 0)).toBe(false);
    expect(keepDeeperCrumbs(current, current, 0)).toBe(false);
    expect(keepDeeperCrumbs(crumbsFromChain([root, header]), crumbsFromChain([root, header, magic]), 0)).toBe(false);
  });
});

describe('crumbTitle', () => {
  it('reads "name : typeName @ 0xOFFSET (size N)"', () => {
    const { root, header, w } = sample();
    const c = crumbsFromLocation(root, [root.id, header.id, w.id], null, 2);
    expect(crumbTitle(c[2]!)).toBe('w : struct @ 0x2 (size 4)');
    expect(crumbTitle({ ...c[2]!, offset: 255, size: 0 })).toBe('w : struct @ 0xFF (size 0)');
    expect(crumbTitle({ ...c[2]!, offset: -1 })).toContain('@ 0x?');
  });
});

describe('collapseLeading', () => {
  const labels = ['bmp', 'header', 'fields', 'width'];
  it('keeps everything when it fits or the width is unknown', () => {
    expect(collapseLeading(labels, 100)).toBe(0);
    expect(collapseLeading(labels, 0)).toBe(0);
    expect(collapseLeading(labels, Infinity)).toBe(0);
    expect(collapseLeading(labels, NaN)).toBe(0);
    expect(collapseLeading([], 5)).toBe(0);
  });

  it('collapses leading segments until the rest (plus the ellipsis) fits, and always keeps the last', () => {
    // widths 6 + 9 + 9 + 8 = 32
    expect(collapseLeading(labels, 31)).toBe(1); // 26 + 3 <= 31
    expect(collapseLeading(labels, 20)).toBe(2); // 17 + 3 <= 20
    expect(collapseLeading(labels, 11)).toBe(3);
    expect(collapseLeading(labels, 1)).toBe(3); // the last one stays however narrow
  });
});
