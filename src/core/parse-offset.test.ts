import { describe, expect, it } from 'vitest';
import { parseOffset } from './parse-offset';

describe('parseOffset (hex, default)', () => {
  it('parses hex with or without 0x, ignoring surrounding whitespace', () => {
    expect(parseOffset('1F', 100)).toEqual({ ok: true, offset: 31 });
    expect(parseOffset(' 0x1f ', 100)).toEqual({ ok: true, offset: 31 });
    expect(parseOffset('\t0X00\n', 100)).toEqual({ ok: true, offset: 0 });
  });
  it('treats 2D / 7D as hex, not decimal', () => {
    expect(parseOffset('2D', 100)).toEqual({ ok: true, offset: 0x2d });
    expect(parseOffset('7d', 200)).toEqual({ ok: true, offset: 0x7d });
  });
  it('rejects invalid input', () => {
    for (const s of ['', '  ', 'xyz', '0x', '-1', '1.5', '31g', '0xG1', '1_000', '0x 1F', '+1']) {
      expect(parseOffset(s, 1000).ok).toBe(false);
    }
  });
});

describe('parseOffset (dec)', () => {
  it('parses digits only', () => {
    expect(parseOffset('99', 100, 'dec')).toEqual({ ok: true, offset: 99 });
    expect(parseOffset(' 31 ', 100, 'dec')).toEqual({ ok: true, offset: 31 });
  });
  it('rejects hex, prefixes, separators', () => {
    for (const s of ['1F', '0x10', '1_000', '1,000', '-1', '1.0', '']) {
      expect(parseOffset(s, 1000, 'dec').ok).toBe(false);
    }
  });
});

describe('parseOffset limits', () => {
  it('enforces range', () => {
    expect(parseOffset('100', 100, 'dec').ok).toBe(false);
    expect(parseOffset('64', 100).ok).toBe(false); // 0x64 == size
    expect(parseOffset('0', 0).ok).toBe(false);
  });
  it('size 1 only accepts offset 0', () => {
    expect(parseOffset('0', 1)).toEqual({ ok: true, offset: 0 });
    expect(parseOffset('1', 1).ok).toBe(false);
  });
  it('distinguishes 2^53-1 from 2^53', () => {
    const max = Number.MAX_SAFE_INTEGER;
    const at = parseOffset('9007199254740991', max, 'dec'); // safe, but == size - 0 -> out of range
    expect(at.ok).toBe(false);
    expect(at.ok === false && at.error).toMatch(/Out of range/);
    expect(parseOffset('9007199254740990', max, 'dec')).toEqual({ ok: true, offset: max - 1 });
    const over = parseOffset('9007199254740992', max, 'dec');
    expect(over.ok === false && over.error).toMatch(/too large/);
    expect(parseOffset('1FFFFFFFFFFFFE', max)).toEqual({ ok: true, offset: max - 1 });
    const hexOver = parseOffset('0x20000000000000', max);
    expect(hexOver.ok === false && hexOver.error).toMatch(/too large/);
  });
});
