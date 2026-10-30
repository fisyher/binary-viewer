import { describe, expect, it } from 'vitest';
import type { Node } from './engine';
import { flattenTree, isExpandable, navigateRows, refLoadKey } from './tree-model';

let id = 1;
const n = (name: string, offset: number, size: number, extra: Partial<Node> = {}): Node => ({ id: id++, name, typeName: 'u1', offset, size, ...extra });

describe('tree rows for references', () => {
  it('a node with an unopened ref is expandable and shows an "open" row when expanded', () => {
    const ptr = n('ptr', 0, 1, { ref: { typeName: 'blob', offset: 6 } });
    const root = n('root', 0, 1, { children: [ptr] });
    expect(isExpandable(ptr)).toBe(true);
    const collapsed = flattenTree(root, { expanded: new Set([root.id]), pages: new Map() });
    expect(collapsed.map((r) => r.kind)).toEqual(['node', 'node']);
    const open = flattenTree(root, { expanded: new Set([root.id, ptr.id]), pages: new Map(), loading: new Set([refLoadKey(ptr.id)]) });
    const row = open[2]!;
    expect(row).toMatchObject({ kind: 'ref', depth: 2, parentKey: `n${ptr.id}`, loading: true });
  });

  it('once opened, the target is an ordinary child and the open row is gone', () => {
    const target = n('blob', 6, 2, { typeName: 'blob', children: [n('b0', 6, 1)] });
    const ptr = n('ptr', 0, 1, { ref: { typeName: 'blob', offset: 6, loaded: true }, children: [target] });
    const root = n('root', 0, 1, { children: [ptr] });
    const rows = flattenTree(root, { expanded: new Set([root.id, ptr.id, target.id]), pages: new Map() });
    expect(rows.map((r) => r.kind)).toEqual(['node', 'node', 'node', 'node']);
    expect(rows.map((r) => (r.kind === 'node' ? r.node.name : ''))).toEqual(['root', 'ptr', 'blob', 'b0']);
  });

  it('keyboard: the ref row is reachable with ArrowDown and left returns to its node', () => {
    const ptr = n('ptr', 0, 1, { ref: { typeName: 'blob', offset: 6 } });
    const root = n('root', 0, 1, { children: [ptr] });
    const rows = flattenTree(root, { expanded: new Set([root.id, ptr.id]), pages: new Map() });
    expect(navigateRows(rows, 1, 'ArrowDown')).toEqual({ index: 2 });
    expect(navigateRows(rows, 2, 'ArrowLeft')).toEqual({ index: 1 });
  });
});
