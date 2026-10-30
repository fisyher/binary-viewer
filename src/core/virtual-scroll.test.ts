import { describe, expect, it } from 'vitest';
import {
  isCompressed,
  MAX_SPACER_HEIGHT,
  rowPixelOffset,
  rowToScrollTop,
  scrollTopToRow,
  spacerHeight,
  maxTopRow,
  visibleRange,
  visibleRangeFromTop,
  type ScrollGeometry,
} from './virtual-scroll';

const normal: ScrollGeometry = { totalRows: 1000, rowHeight: 20, viewportHeight: 400 };
const huge: ScrollGeometry = { totalRows: 2 ** 40, rowHeight: 20, viewportHeight: 400 };

describe('virtual-scroll (normal)', () => {
  it('is not compressed and uses exact height', () => {
    expect(isCompressed(normal)).toBe(false);
    expect(spacerHeight(normal)).toBe(20_000);
  });

  it('computes the visible range with overscan, clamped at both ends', () => {
    expect(visibleRange(0, normal, 3)).toEqual({ start: 0, end: 24 }); // 20 visible + 1 + 3
    expect(visibleRange(2000, normal, 3)).toEqual({ start: 97, end: 124 });
    const bottom = 20_000 - 400;
    expect(visibleRange(bottom, normal, 3).end).toBe(1000);
    expect(scrollTopToRow(bottom, normal)).toBe(980);
  });

  it('returns an empty range for empty input or zero viewport', () => {
    expect(visibleRange(0, { ...normal, totalRows: 0 })).toEqual({ start: 0, end: 0 });
    expect(visibleRange(0, { ...normal, viewportHeight: 0 })).toEqual({ start: 0, end: 0 });
  });

  it('round-trips row <-> scrollTop and clamps', () => {
    for (const r of [0, 1, 500, 980]) {
      expect(scrollTopToRow(rowToScrollTop(r, normal), normal)).toBe(r);
    }
    expect(rowToScrollTop(999, normal)).toBe(20_000 - 400); // cannot scroll past bottom
    expect(rowToScrollTop(-5, normal)).toBe(0);
    expect(scrollTopToRow(-100, normal)).toBe(0);
  });

  it('reports sub-row pixel offset', () => {
    expect(rowPixelOffset(105, normal)).toBe(5);
    expect(rowPixelOffset(100, normal)).toBe(0);
  });

  it('handles content shorter than the viewport', () => {
    const g = { totalRows: 5, rowHeight: 20, viewportHeight: 400 };
    expect(rowToScrollTop(4, g)).toBe(0);
    expect(scrollTopToRow(0, g)).toBe(0);
    expect(visibleRange(0, g)).toEqual({ start: 0, end: 5 });
  });
});

describe('virtual-scroll (huge files)', () => {
  it('caps the spacer height', () => {
    expect(isCompressed(huge)).toBe(true);
    expect(spacerHeight(huge)).toBe(MAX_SPACER_HEIGHT);
  });

  it('is exact at the top and bottom', () => {
    expect(scrollTopToRow(0, huge)).toBe(0);
    const max = MAX_SPACER_HEIGHT - huge.viewportHeight;
    const lastTop = huge.totalRows - 20;
    expect(scrollTopToRow(max, huge)).toBe(lastTop);
    expect(scrollTopToRow(max + 1000, huge)).toBe(lastTop);
    expect(visibleRange(max, huge, 4).end).toBe(huge.totalRows);
    expect(visibleRange(0, huge, 4).start).toBe(0);
    expect(rowToScrollTop(0, huge)).toBe(0);
    expect(rowToScrollTop(huge.totalRows - 1, huge)).toBe(max);
  });

  it('maps proportionally in the middle', () => {
    const max = MAX_SPACER_HEIGHT - huge.viewportHeight;
    const mid = scrollTopToRow(max / 2, huge);
    expect(mid / huge.totalRows).toBeCloseTo(0.5, 5);
  });

  it('is monotonic and never exceeds bounds', () => {
    let prev = -1;
    for (let s = 0; s <= MAX_SPACER_HEIGHT; s += 99_991) {
      const r = scrollTopToRow(s, huge);
      expect(r).toBeGreaterThanOrEqual(prev);
      expect(r).toBeLessThan(huge.totalRows);
      prev = r;
    }
  });

  it('inverse lands on the requested row when resolution allows', () => {
    // Moderately huge: ~13M rows, ~1.3 rows per px, so every row is reachable? Not quite, but
    // the inverse must never land beyond the requested row by more than the px resolution.
    const g: ScrollGeometry = { totalRows: 600_000, rowHeight: 20, viewportHeight: 400 };
    expect(isCompressed(g)).toBe(true);
    for (const r of [0, 1, 1234, 300_000, 599_000]) {
      const back = scrollTopToRow(rowToScrollTop(r, g), g);
      expect(back).toBeGreaterThanOrEqual(r);
      expect(back - r).toBeLessThanOrEqual(Math.ceil(g.totalRows / (MAX_SPACER_HEIGHT - 400)));
    }
    // Resolution is finer than 1 row/px here, so round trip is exact.
    const fine: ScrollGeometry = { totalRows: 600_000, rowHeight: 20, viewportHeight: 400, maxSpacerHeight: 5_000_000 };
    for (const r of [0, 1, 1234, 300_000]) {
      expect(scrollTopToRow(rowToScrollTop(r, fine), fine)).toBe(r);
    }
  });

  it('has no pixel offset when compressed', () => {
    expect(rowPixelOffset(12345, huge)).toBe(0);
  });
});

describe('virtual-scroll edge cases', () => {
  it('copes with rows-per-pixel far above viewport rows', () => {
    // ~2^40 rows over 10M px: ~100k rows per pixel, 20 rows per viewport.
    const target = 123_456_789_012;
    const s = rowToScrollTop(target, huge);
    const approx = scrollTopToRow(s, huge);
    expect(approx).toBeGreaterThanOrEqual(target);
    expect(approx - target).toBeLessThan(huge.totalRows / (MAX_SPACER_HEIGHT - huge.viewportHeight) + 1);
    // Rendering from the exact top row (what the UI tracks) always shows the target.
    const r = visibleRangeFromTop(target, huge, 0);
    expect(r.start).toBe(target);
    expect(r.end).toBeGreaterThan(target + 19);
  });

  it('clamps the top row to the last page and keeps the last row visible', () => {
    const top = maxTopRow(huge);
    expect(top).toBe(huge.totalRows - 20);
    expect(visibleRangeFromTop(top, huge, 0).end).toBe(huge.totalRows);
    expect(visibleRangeFromTop(huge.totalRows * 2, huge, 0).start).toBe(huge.totalRows - 1);
  });

  it('handles a viewport taller than the content, compressed or not', () => {
    const small: ScrollGeometry = { totalRows: 5, rowHeight: 20, viewportHeight: 400 };
    expect(maxTopRow(small)).toBe(0);
    expect(scrollTopToRow(1e9, small)).toBe(4); // uncompressed floors; UI clamps via maxTopRow
    const tinyCap: ScrollGeometry = { ...small, maxSpacerHeight: 50 };
    expect(isCompressed(tinyCap)).toBe(true);
    expect(scrollTopToRow(0, tinyCap)).toBe(0);
    expect(scrollTopToRow(1e9, tinyCap)).toBe(0);
    expect(rowToScrollTop(4, tinyCap)).toBe(0);
  });

  it('floors fractional scrollTop values', () => {
    expect(scrollTopToRow(99.9, normal)).toBe(4);
    expect(scrollTopToRow(100.0001, normal)).toBe(5);
    expect(rowPixelOffset(105.5, normal)).toBeCloseTo(5.5);
    const max = MAX_SPACER_HEIGHT - huge.viewportHeight;
    expect(scrollTopToRow(max - 0.5, huge)).toBeLessThanOrEqual(maxTopRow(huge));
    expect(scrollTopToRow(0, huge)).toBe(0);
  });
});
