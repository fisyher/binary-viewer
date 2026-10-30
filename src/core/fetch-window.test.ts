import { describe, expect, it } from 'vitest';
import { computeFetchWindow, covers } from './fetch-window';

describe('computeFetchWindow', () => {
  it('adds a viewport of margin each side, aligned outward', () => {
    const w = computeFetchWindow({ start: 100, end: 130 }, 10_000);
    expect(w).toEqual({ start: 64, end: 160 }); // 70 -> 64, 160 stays
    expect(covers(w, { start: 100, end: 130 })).toBe(true);
  });
  it('clamps to the file', () => {
    expect(computeFetchWindow({ start: 0, end: 30 }, 40)).toEqual({ start: 0, end: 40 });
    expect(computeFetchWindow({ start: 5, end: 10 }, 10)).toEqual({ start: 0, end: 10 });
  });
  it('returns an empty window for empty input', () => {
    expect(computeFetchWindow({ start: 0, end: 0 }, 100)).toEqual({ start: 0, end: 0 });
    expect(computeFetchWindow({ start: 0, end: 10 }, 0)).toEqual({ start: 0, end: 0 });
  });
  it('caps oversized windows to the visible range', () => {
    const v = { start: 1000, end: 1100 };
    expect(computeFetchWindow(v, 1e9, 32, 150)).toEqual(v);
  });
});

describe('covers', () => {
  const loaded = { start: 64, end: 192 };
  it('detects containment', () => {
    expect(covers(loaded, { start: 64, end: 192 })).toBe(true);
    expect(covers(loaded, { start: 100, end: 130 })).toBe(true);
    expect(covers(loaded, { start: 60, end: 130 })).toBe(false);
    expect(covers(loaded, { start: 100, end: 193 })).toBe(false);
  });
  it('handles null and empty', () => {
    expect(covers(null, { start: 0, end: 5 })).toBe(false);
    expect(covers(null, { start: 0, end: 0 })).toBe(true);
  });
  it('scrolling a few rows stays covered (no refetch)', () => {
    let w = computeFetchWindow({ start: 0, end: 30 }, 10_000);
    for (let top = 0; top < 30; top++) {
      expect(covers(w, { start: top, end: top + 30 })).toBe(true);
    }
    expect(covers(w, { start: 200, end: 230 })).toBe(false);
    w = computeFetchWindow({ start: 200, end: 230 }, 10_000);
    expect(covers(w, { start: 200, end: 230 })).toBe(true);
  });
});
