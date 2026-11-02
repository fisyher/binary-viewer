import { describe, expect, it } from 'vitest';
import type { Node } from './engine';
import { GROUP_COUNT, groupIdMap, groupOfIndex, rowGroups, topGroupNodes } from './groups';

let nextId = 1;
const node = (name: string, children?: Node[]): Node => ({ id: nextId++, name, typeName: 't', offset: 0, size: 1, ...(children ? { children } : {}) });

describe('topGroupNodes', () => {
  it('is the root\'s children', () => {
    const a = node('a');
    const b = node('b');
    expect(topGroupNodes(node('r', [a, b]))).toEqual([a, b]);
  });

  it('descends one level when the root has a single child that has children', () => {
    const x = node('x');
    const y = node('y');
    const wrap = node('wrap', [x, y]);
    expect(topGroupNodes(node('r', [wrap]))).toEqual([x, y]);
    // only one level: a single grandchild is not unwrapped again
    const deep = node('deep', [node('only', [node('z')])]);
    expect(topGroupNodes(node('r', [deep])).map((n) => n.name)).toEqual(['only']);
  });

  it('keeps a single childless child, and copes with no children', () => {
    const leaf = node('leaf');
    expect(topGroupNodes(node('r', [leaf]))).toEqual([leaf]);
    expect(topGroupNodes(node('r', [node('empty', [])])).map((n) => n.name)).toEqual(['empty']);
    expect(topGroupNodes(node('r'))).toEqual([]);
  });
});

describe('groupOfIndex / groupIdMap', () => {
  it('colours by index modulo 4', () => {
    expect(GROUP_COUNT).toBe(4);
    expect([0, 1, 2, 3, 4, 5, 9].map(groupOfIndex)).toEqual([0, 1, 2, 3, 0, 1, 1]);
    const kids = Array.from({ length: 6 }, (_, i) => node(`k${i}`));
    const m = groupIdMap(node('r', kids));
    expect(kids.map((k) => m.get(k.id))).toEqual([0, 1, 2, 3, 0, 1]);
  });
});

describe('rowGroups', () => {
  it('marks group nodes and the deeper rows after them, until the next row at their depth', () => {
    const groups = new Map([
      [10, 0],
      [20, 1],
    ]);
    const rows = [
      { depth: 0, id: 1 }, // root
      { depth: 1, id: 10 }, // group 0
      { depth: 2, id: 11 },
      { depth: 3, id: 12 },
      { depth: 2, id: null }, // "load more" under group 0
      { depth: 1, id: 20 }, // group 1
      { depth: 2, id: 21 },
      { depth: 1, id: 30 }, // not a group node, back at the group depth
      { depth: 2, id: 31 },
    ];
    expect(rowGroups(rows, groups)).toEqual([
      null,
      { kind: 'self', group: 0 },
      { kind: 'inside', group: 0 },
      { kind: 'inside', group: 0 },
      { kind: 'inside', group: 0 },
      { kind: 'self', group: 1 },
      { kind: 'inside', group: 1 },
      null,
      null,
    ]);
  });

  it('is empty for no rows and all null for no groups', () => {
    expect(rowGroups([], new Map())).toEqual([]);
    expect(rowGroups([{ depth: 0, id: 1 }, { depth: 1, id: 2 }], new Map())).toEqual([null, null]);
  });
});
