import { describe, expect, it } from 'vitest';
import { moveCaret, navigate, selectionRange } from './caret';

describe('selectionRange', () => {
  it('normalises direction and computes inclusive length', () => {
    expect(selectionRange({ anchor: 10, caret: 4 })).toEqual({ start: 4, end: 10, length: 7 });
    expect(selectionRange({ anchor: 3, caret: 3 })).toEqual({ start: 3, end: 3, length: 1 });
  });
});

describe('moveCaret', () => {
  const size = 100;
  it('moves by byte and row', () => {
    expect(moveCaret(5, 'right', size, 10)).toBe(6);
    expect(moveCaret(5, 'left', size, 10)).toBe(4);
    expect(moveCaret(20, 'up', size, 10)).toBe(4);
    expect(moveCaret(20, 'down', size, 10)).toBe(36);
  });
  it('pages', () => {
    expect(moveCaret(50, 'pageDown', size, 2)).toBe(82);
    expect(moveCaret(50, 'pageUp', size, 2)).toBe(18);
  });
  it('jumps to row and file edges', () => {
    expect(moveCaret(37, 'rowStart', size, 1)).toBe(32);
    expect(moveCaret(37, 'rowEnd', size, 1)).toBe(47);
    expect(moveCaret(97, 'rowEnd', size, 1)).toBe(99); // clamped in the short last row
    expect(moveCaret(37, 'fileStart', size, 1)).toBe(0);
    expect(moveCaret(37, 'fileEnd', size, 1)).toBe(99);
  });
  it('clamps at the bounds and handles empty sources', () => {
    expect(moveCaret(0, 'left', size, 1)).toBe(0);
    expect(moveCaret(99, 'right', size, 1)).toBe(99);
    expect(moveCaret(95, 'pageDown', size, 5)).toBe(99);
    expect(moveCaret(0, 'right', 0, 1)).toBe(0);
  });
});

describe('moveCaret edge cases', () => {
  it('clamps a caret at or past size', () => {
    expect(moveCaret(100, 'left', 100, 1)).toBe(99);
    expect(moveCaret(100, 'right', 100, 1)).toBe(99);
    expect(moveCaret(500, 'rowStart', 100, 1)).toBe(99);
  });
  it('handles a 1-byte file', () => {
    for (const m of ['left', 'right', 'up', 'down', 'pageUp', 'pageDown', 'rowStart', 'rowEnd', 'fileStart', 'fileEnd'] as const) {
      expect(moveCaret(0, m, 1, 3)).toBe(0);
    }
  });
  it('treats pageRows 0 (or negative) as one row', () => {
    expect(moveCaret(50, 'pageDown', 100, 0)).toBe(66);
    expect(moveCaret(50, 'pageUp', 100, -4)).toBe(34);
  });
});

describe('navigate', () => {
  it('starts from offset 0 when nothing is selected', () => {
    expect(navigate(null, 'rowEnd', 100, 5, false)).toEqual({ anchor: 15, caret: 15 });
    expect(navigate(null, 'fileEnd', 100, 5, false)).toEqual({ anchor: 99, caret: 99 });
    expect(navigate(null, 'left', 100, 5, false)).toEqual({ anchor: 0, caret: 0 });
  });
  it('extends from the anchor with shift, else collapses', () => {
    expect(navigate({ anchor: 10, caret: 12 }, 'right', 100, 5, true)).toEqual({ anchor: 10, caret: 13 });
    expect(navigate({ anchor: 10, caret: 12 }, 'right', 100, 5, false)).toEqual({ anchor: 13, caret: 13 });
    expect(navigate(null, 'rowEnd', 100, 5, true)).toEqual({ anchor: 0, caret: 15 });
  });
});
