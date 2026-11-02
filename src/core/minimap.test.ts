import { describe, expect, it } from 'vitest';
import { bandsFromBuckets, offsetAtY, rangeToRows, regionAt, regionBoundaryRows, smallRegionRows } from './minimap';

describe('bandsFromBuckets', () => {
  it('merges equal neighbours and tiles the strip exactly', () => {
    const bands = bandsFromBuckets(Uint8Array.of(1, 1, 0, 0, 0, 2, 2, 2, 2, 1), 10);
    expect(bands).toEqual([
      { y0: 0, y1: 2, v: 1 },
      { y0: 2, y1: 5, v: 0 },
      { y0: 5, y1: 9, v: 2 },
      { y0: 9, y1: 10, v: 1 },
    ]);
  });

  it('maps buckets to rows with rounding when the counts differ', () => {
    // 4 buckets on 10 rows: boundaries at round(2.5)=3, 5, round(7.5)=8, 10
    expect(bandsFromBuckets(Uint8Array.of(1, 2, 3, 4), 10).map((b) => [b.y0, b.y1])).toEqual([[0, 3], [3, 5], [5, 8], [8, 10]]);
  });

  it('lets a later bucket win a row that several buckets share', () => {
    const bands = bandsFromBuckets(Uint8Array.of(1, 2, 3, 4), 2);
    expect(bands.at(-1)!.y1).toBe(2);
    expect(bands[0]!.y0).toBe(0);
    expect(bands.every((b, i) => i === 0 || b.y0 === bands[i - 1]!.y1)).toBe(true);
  });

  it('is empty for no buckets or no rows', () => {
    expect(bandsFromBuckets(new Uint8Array(0), 10)).toEqual([]);
    expect(bandsFromBuckets(Uint8Array.of(1), 0)).toEqual([]);
  });
});

describe('rangeToRows', () => {
  it('maps a byte range to rows, at least one row tall', () => {
    expect(rangeToRows(0, 500, 1000, 100)).toEqual({ y0: 0, y1: 50 });
    expect(rangeToRows(250, 251, 1000, 100)).toEqual({ y0: 25, y1: 26 });
  });

  it('keeps small ranges at their minimum height inside the strip', () => {
    expect(rangeToRows(990, 1000, 1000, 100, 3)).toEqual({ y0: 97, y1: 100 });
    expect(rangeToRows(0, 1, 1000, 100, 3)).toEqual({ y0: 0, y1: 3 });
  });

  it('clamps to the file; an empty file or strip gives the whole strip', () => {
    expect(rangeToRows(-5, 5000, 1000, 100)).toEqual({ y0: 0, y1: 100 });
    expect(rangeToRows(0, 0, 0, 100)).toEqual({ y0: 0, y1: 100 });
    expect(rangeToRows(0, 10, 100, 0)).toEqual({ y0: 0, y1: 0 });
  });
});

describe('offsetAtY', () => {
  it('maps the strip linearly onto the file', () => {
    expect(offsetAtY(0, 100, 1000)).toBe(0);
    expect(offsetAtY(50, 100, 1000)).toBe(500);
    expect(offsetAtY(99.9, 100, 1000)).toBe(999);
  });

  it('rounds down and ends on the first and the last byte', () => {
    expect(offsetAtY(-30, 100, 1000)).toBe(0);
    expect(offsetAtY(100, 100, 1000)).toBe(999);
    expect(offsetAtY(500, 100, 1000)).toBe(999);
    expect(offsetAtY(33, 100, 10)).toBe(3);
    expect(offsetAtY(5, 10, 1)).toBe(0);
  });

  it('is 0 for an empty file or a degenerate strip and exact for huge files', () => {
    expect(offsetAtY(5, 10, 0)).toBe(0);
    expect(offsetAtY(5, 0, 100)).toBe(0);
    expect(offsetAtY(NaN, 10, 100)).toBe(0);
    expect(offsetAtY(5, 10, 2 ** 40)).toBe(2 ** 39);
  });
});

describe('smallRegionRows', () => {
  it('returns only the regions under 2 CSS px, at exactly 2 px, in their own colour and place', () => {
    const regions = [
      { start: 0, end: 14, group: 0 }, // a header: far under a pixel
      { start: 14, end: 54, group: 1 },
      { start: 54, end: 20054, group: 3 }, // the bulk: tall, no mark
    ];
    expect(smallRegionRows(regions, 20054, 400, 1)).toEqual([
      { y0: 0, y1: 2, v: 1 },
      { y0: 2, y1: 4, v: 2 }, // 40 bytes of 20054 on 400 rows: 0.8 rows, stacked under the header
    ]);
    expect(smallRegionRows(regions, 20054, 800, 2)[0]).toEqual({ y0: 0, y1: 4, v: 1 }); // 2 CSS px at 2x
  });

  it('stacks marks that would overlap and pulls the tail back inside the strip', () => {
    const tail = [
      { start: 99900, end: 99950, group: 0 },
      { start: 99950, end: 99990, group: 1 },
      { start: 99990, end: 100000, group: 2 },
    ];
    const rows = smallRegionRows(tail, 100000, 400, 1);
    expect(rows.map((r) => [r.y0, r.y1, r.v])).toEqual([[394, 396, 1], [396, 398, 2], [398, 400, 3]]);
  });

  it('keeps marks inside the strip at the bottom edge and skips big regions', () => {
    expect(smallRegionRows([{ start: 99990, end: 100000, group: 2 }], 100000, 400, 1)).toEqual([{ y0: 398, y1: 400, v: 3 }]);
    expect(smallRegionRows([{ start: 0, end: 50000, group: 0 }], 100000, 400, 1)).toEqual([]);
    expect(smallRegionRows([{ start: 0, end: 10, group: 0 }], 0, 400, 1)).toEqual([]);
  });
});

describe('regionAt', () => {
  it('finds the region containing an offset (end exclusive)', () => {
    const regions = [
      { start: 0, end: 14, name: 'a' },
      { start: 14, end: 100, name: 'b' },
    ];
    expect(regionAt(regions, 0)?.name).toBe('a');
    expect(regionAt(regions, 13)?.name).toBe('a');
    expect(regionAt(regions, 14)?.name).toBe('b');
    expect(regionAt(regions, 100)).toBeNull();
    expect(regionAt([], 5)).toBeNull();
  });
});

describe('regionBoundaryRows', () => {
  const regions = [
    { start: 0, end: 100 },
    { start: 100, end: 200 },
    { start: 200, end: 1000 },
  ];
  it('puts a line at the top of each touching region that is at least 4 CSS px tall', () => {
    // 1000 bytes on 100 rows: 10 rows, 10 rows, 80 rows
    expect(regionBoundaryRows(regions, 1000, 100, 1)).toEqual([10, 20]);
  });

  it('skips regions under 4 CSS px (a device pixel ratio of 2 doubles the minimum), gaps and an empty strip', () => {
    expect(regionBoundaryRows(regions, 1000, 100, 3)).toEqual([]); // 4 CSS px = 12 device rows: the 10-row regions are too thin
    expect(regionBoundaryRows([{ start: 0, end: 100 }, { start: 100, end: 120 }, { start: 120, end: 1000 }], 1000, 100, 1)).toEqual([]);
    expect(regionBoundaryRows([{ start: 0, end: 400 }, { start: 500, end: 1000 }], 1000, 100, 1)).toEqual([]); // a gap between them
    expect(regionBoundaryRows(regions, 0, 100, 1)).toEqual([]);
    expect(regionBoundaryRows(regions, 1000, 0, 1)).toEqual([]);
  });
});
