import { describe, expect, it } from 'vitest';
import type { Node } from '../core/engine';
import { MAX_OVERVIEW_REGIONS, bucketStarts, clampBuckets, computeOverview, computeRegions } from './overview';

let nextId = 1;
const leaf = (offset: number, size: number, typeName = 'u1'): Node => ({ id: nextId++, name: `n${nextId}`, typeName, offset, size });
const group = (...children: Node[]): Node => ({ id: nextId++, name: 'g', typeName: 's', offset: children[0]?.offset ?? 0, size: 0, children });
const rootOf = (...tops: Node[]): Node => ({ id: 0, name: 'root', typeName: 'root', offset: 0, size: 0, children: tops });

describe('bucketStarts', () => {
  it('splits the file into floor(b*size/n) boundaries', () => {
    expect([...bucketStarts(100, 16)].slice(0, 5)).toEqual([0, 6, 12, 18, 25]);
    expect(bucketStarts(100, 16)[16]).toBe(100);
  });

  it('stays exact where b*size would exceed 2^53', () => {
    const size = 2 ** 52 + 12345;
    const s = bucketStarts(size, 4096);
    expect(s[4096]).toBe(size);
    expect(s[2048]).toBe(Number((2048n * BigInt(size)) / 4096n));
    expect(s[1]).toBe(Number(BigInt(size) / 4096n));
  });
});

describe('clampBuckets', () => {
  it('limits to 16..4096', () => {
    expect([clampBuckets(0), clampBuckets(15), clampBuckets(16), clampBuckets(300), clampBuckets(4096), clampBuckets(5000)]).toEqual([16, 16, 16, 300, 4096, 4096]);
  });
});

describe('computeOverview', () => {
  it('paints each top-level group with its colour and leaves gaps at 0', () => {
    // 100 bytes, 20 buckets of 5 bytes: A = [0,40) group 0, gap [40,60), B = [60,100) group 1
    const root = rootOf(group(leaf(0, 20), leaf(20, 20)), group(leaf(60, 40)));
    const b = computeOverview(root, 100, 20);
    expect([...b]).toEqual([...Array(8).fill(1), ...Array(4).fill(0), ...Array(8).fill(2)]);
  });

  it('colours by the root child index modulo 4', () => {
    const root = rootOf(...Array.from({ length: 6 }, (_, i) => group(leaf(i * 10, 10))));
    const b = computeOverview(root, 60, 60);
    expect([...b].filter((_, i) => i % 10 === 0)).toEqual([1, 2, 3, 4, 1, 2]);
  });

  it('a bucket takes the group covering most of its bytes; a tie goes to the lower group; any coverage counts', () => {
    // bucket 0 is 16 bytes: group 1 covers 7, group 2 covers 7 (tie -> group 1, colour 2), 2 bytes are a gap
    const tie = rootOf(group(), group(leaf(0, 7)), group(leaf(7, 7)));
    expect(computeOverview(tie, 256, 16)[0]).toBe(2);
    const wide = rootOf(group(leaf(0, 3)), group(leaf(3, 2)));
    expect(computeOverview(wide, 32, 16).slice(0, 2)).toEqual(Uint8Array.of(1, 1)); // 2-byte buckets: [0,2) g0, [2,4) g0 (1 vs 1 -> lower)
    expect(computeOverview(rootOf(group(leaf(0, 3)), group(leaf(3, 5))), 160, 16)[0]).toBe(2); // 10-byte bucket: 3 vs 5 -> group 1
    expect(computeOverview(rootOf(group(leaf(5, 1))), 1600, 16)[0]).toBe(1); // 1 byte of 100 still counts
  });

  it('weights leaves that cross bucket boundaries by the bytes inside each bucket', () => {
    // 16 buckets of 4 bytes. g1 covers [2,9), g0 covers [0,2) and [9,13)
    const root = rootOf(group(leaf(0, 2), leaf(9, 4)), group(leaf(2, 7)));
    const b = computeOverview(root, 64, 16);
    // [0,4) 2 vs 2 -> g0; [4,8) g1; [8,12) g0 has 3 bytes, g1 has 1; [12,16) g0
    expect([...b.slice(0, 5)]).toEqual([1, 2, 1, 1, 0]);
  });

  it('skips bits nodes and zero-size leaves, and clamps leaves to the file', () => {
    const root = rootOf(group(leaf(0, 4, 'bits'), leaf(4, 0), leaf(90, 50)));
    const b = computeOverview(root, 100, 20);
    expect([...b]).toEqual([...Array(18).fill(0), 1, 1]);
    expect([...computeOverview(rootOf(group(leaf(-20, 25))), 100, 20)]).toEqual([1, ...Array(19).fill(0)]);
  });

  it('descends into children; a node with children is not itself painted', () => {
    const parent: Node = { id: 500, name: 'p', typeName: 's', offset: 0, size: 100, children: [leaf(0, 10), leaf(90, 10)] };
    const b = computeOverview(rootOf(parent), 100, 20);
    expect(b.filter((v) => v === 1)).toHaveLength(4);
    expect(b[5]).toBe(0);
  });

  it('is all zeros for an empty file or an empty tree', () => {
    expect([...computeOverview(rootOf(group(leaf(0, 4))), 0, 16)]).toEqual(Array(16).fill(0));
    expect([...computeOverview(rootOf(), 100, 16)]).toEqual(Array(16).fill(0));
    expect([...computeOverview({ id: 0, name: 'r', typeName: 'r', offset: 0, size: 0 }, 100, 16)]).toEqual(Array(16).fill(0));
  });

  it('files smaller than the bucket count leave the surplus buckets empty', () => {
    const b = computeOverview(rootOf(group(leaf(0, 3))), 3, 16);
    expect(b.filter((v) => v !== 0)).toHaveLength(3);
    expect(computeOverview(rootOf(group(leaf(0, 1))), 1, 16).filter((v) => v !== 0)).toHaveLength(1);
  });

  it('handles a 1 TiB file and thousands of overlapping spans in time proportional to nodes + buckets, not bytes', () => {
    const size = 2 ** 40;
    const leaves = Array.from({ length: 20_000 }, (_, i) => leaf(i * 1000, size - i * 1000));
    const t = performance.now();
    const b = computeOverview(rootOf(group(...leaves)), size, 4096);
    expect(performance.now() - t).toBeLessThan(2000);
    expect(b.every((v) => v === 1)).toBe(true);
  });
});

describe('computeOverview with hostile numbers', () => {
  it('fractional offsets and sizes never produce negative coverage', () => {
    const root = rootOf(group(leaf(0.4, 0.3), leaf(3.5, 0.2), leaf(10.2, 30.6), leaf(99.5, 5.2), leaf(-0.5, 1.2)));
    const b = computeOverview(root, 100, 16);
    expect(b).toHaveLength(16);
    expect([...b].every((v) => v >= 0 && v <= 4)).toBe(true);
    expect(b[2]).toBe(1); // [10.2, 40.8) -> bytes [11, 40); the fractions of a byte at the start cover nothing
    expect(computeOverview(rootOf(group(leaf(2.5, 0.2))), 64, 16).every((v) => v === 0)).toBe(true);
  });
});

describe('computeRegions', () => {
  it('lists non-empty root children in file order with their groups', () => {
    const root = rootOf(group(leaf(50, 10)), group(leaf(0, 14)), { ...leaf(14, 0), typeName: 'value' }, { ...leaf(20, 4), typeName: 'bits' }, group(leaf(60, 500)));
    // group() sizes are 0; give the nodes their own extents
    root.children![0]!.size = 10;
    root.children![0]!.offset = 50;
    root.children![1]!.size = 14;
    root.children![1]!.offset = 0;
    root.children![4]!.size = 500;
    root.children![4]!.offset = 60;
    const r = computeRegions(root, 100);
    // group = index among the root's children modulo 4: the last one is child 4
    expect(r.regions).toEqual([
      { start: 0, end: 14, group: 1 },
      { start: 50, end: 60, group: 0 },
      { start: 60, end: 100, group: 0 },
    ]);
    expect(r.truncated).toBe(false);
  });

  it('descends one level when the root has a single child', () => {
    const inner = [leaf(0, 14), leaf(14, 40), leaf(54, 20)];
    const root = rootOf({ id: 99, name: 'file', typeName: 'file', offset: 0, size: 74, children: inner });
    expect(computeRegions(root, 74).regions.map((r) => [r.start, r.end, r.group])).toEqual([[0, 14, 0], [14, 54, 1], [54, 74, 2]]);
    const single = rootOf(leaf(0, 10));
    expect(computeRegions(single, 10).regions).toEqual([{ start: 0, end: 10, group: 0 }]);
  });

  it('clamps to the file, skips fractional slivers and caps the list', () => {
    expect(computeRegions(rootOf(leaf(90, 50), leaf(500, 5), leaf(1.2, 0.5)), 100).regions).toEqual([{ start: 90, end: 100, group: 0 }]);
    const many = rootOf(...Array.from({ length: MAX_OVERVIEW_REGIONS + 5 }, (_, i) => leaf(i, 1)));
    const r = computeRegions(many, 5000);
    expect(r.regions).toHaveLength(MAX_OVERVIEW_REGIONS);
    expect(r.truncated).toBe(true);
  });
});
