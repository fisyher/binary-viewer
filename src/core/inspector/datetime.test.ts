import { describe, expect, it } from 'vitest';
import {
  decodeDosDate,
  decodeDosDateTime,
  decodeDosTime,
  decodeFiletime,
  decodeUnixTime,
  filetimeToIso,
  unixSecondsToIso,
} from './datetime';

const u8 = (...b: number[]) => Uint8Array.from(b);
const le64 = (v: bigint) => Uint8Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));

const dateWord = (y: number, m: number, d: number) => ((y - 1980) << 9) | (m << 5) | d;
const timeWord = (h: number, mi: number, s2: number) => (h << 11) | (mi << 5) | s2;
const leWord = (w: number) => u8(w & 0xff, w >> 8);

describe('DOS date/time', () => {
  it('0x0000 date is invalid (month 0)', () => expect(decodeDosDate(u8(0, 0), true)).toBe('invalid'));
  it('decodes a known date: 2025-01-01 = 0x5A21', () => {
    expect(decodeDosDate(u8(0x21, 0x5a), true)).toBe('2025-01-01');
    expect(decodeDosDate(u8(0x5a, 0x21), false)).toBe('2025-01-01');
  });
  it('rejects bad months and days', () => {
    expect(decodeDosDate(leWord(dateWord(2025, 13, 1)), true)).toBe('invalid');
    expect(decodeDosDate(leWord(dateWord(2025, 0, 1)), true)).toBe('invalid');
    expect(decodeDosDate(leWord(dateWord(2025, 1, 0)), true)).toBe('invalid');
    expect(decodeDosDate(leWord(dateWord(2025, 2, 31)), true)).toBe('invalid');
    expect(decodeDosDate(leWord(dateWord(2025, 4, 31)), true)).toBe('invalid');
    expect(decodeDosDate(leWord(dateWord(2025, 12, 31)), true)).toBe('2025-12-31');
  });
  it('accepts Feb 29 only in leap years', () => {
    // 2024-02-29: year 44<<9 | 2<<5 | 29
    const leap = (44 << 9) | (2 << 5) | 29;
    const non = (45 << 9) | (2 << 5) | 29;
    expect(decodeDosDate(u8(leap & 0xff, leap >> 8), true)).toBe('2024-02-29');
    expect(decodeDosDate(u8(non & 0xff, non >> 8), true)).toBe('invalid');
  });
  it('decodes a known time: 12:34:56 = 0x645C', () => {
    expect(decodeDosTime(u8(0x5c, 0x64), true)).toBe('12:34:56');
  });
  it('rejects hour >= 24, minute >= 60, seconds field >= 30', () => {
    expect(decodeDosTime(leWord(timeWord(24, 0, 0)), true)).toBe('invalid');
    expect(decodeDosTime(leWord(timeWord(31, 0, 0)), true)).toBe('invalid');
    expect(decodeDosTime(leWord(timeWord(12, 60, 0)), true)).toBe('invalid');
    expect(decodeDosTime(leWord(timeWord(12, 0, 30)), true)).toBe('invalid');
    expect(decodeDosTime(leWord(timeWord(23, 59, 29)), true)).toBe('23:59:58');
    expect(decodeDosTime(u8(0, 0), true)).toBe('00:00:00');
  });
  it('datetime is time word then date word', () => {
    expect(decodeDosDateTime(u8(0x5c, 0x64, 0x21, 0x5a), true)).toBe('2025-01-01 12:34:56');
    expect(decodeDosDateTime(u8(0x64, 0x5c, 0x5a, 0x21), false)).toBe('2025-01-01 12:34:56');
    expect(decodeDosDateTime(u8(0, 0, 0, 0), true)).toBe('invalid');
  });
  it('n/a with too few bytes', () => {
    expect(decodeDosDate(u8(1), true)).toBeNull();
    expect(decodeDosTime(u8(), true)).toBeNull();
    expect(decodeDosDateTime(u8(1, 2, 3), true)).toBeNull();
  });
});

describe('FILETIME', () => {
  it('0 is 1601-01-01', () => expect(decodeFiletime(le64(0n), true)).toBe('1601-01-01T00:00:00.000Z'));
  it('Unix epoch: 116444736000000000', () => {
    expect(decodeFiletime(le64(116444736000000000n), true)).toBe('1970-01-01T00:00:00.000Z');
    expect(filetimeToIso(116444736000000000n + 10_000_000n)).toBe('1970-01-01T00:00:01.000Z');
  });
  it('respects byte order', () => {
    const be = le64(116444736000000000n).reverse();
    expect(decodeFiletime(be, false)).toBe('1970-01-01T00:00:00.000Z');
  });
  it('max u64 is representable by Date (year ~60056) and does not throw', () => {
    const s = decodeFiletime(le64(0xffffffffffffffffn), true)!;
    expect(s).toMatch(/^\+0\d{5}-\d\d-\d\dT/);
  });
  it('n/a with < 8 bytes', () => expect(decodeFiletime(u8(1, 2, 3, 4, 5, 6, 7), true)).toBeNull());
});

describe('time_t', () => {
  it('32-bit signed vs unsigned', () => {
    const b = u8(0xff, 0xff, 0xff, 0xff);
    expect(decodeUnixTime(b, 32, true, true)).toBe('1969-12-31T23:59:59.000Z');
    expect(decodeUnixTime(b, 32, false, true)).toBe('2106-02-07T06:28:15.000Z');
  });
  it('64-bit signed, both byte orders', () => {
    expect(decodeUnixTime(le64(86400n), 64, true, true)).toBe('1970-01-02T00:00:00.000Z');
    expect(decodeUnixTime(le64(86400n).reverse(), 64, true, false)).toBe('1970-01-02T00:00:00.000Z');
  });
  it('reports out of range instead of throwing', () => {
    expect(decodeUnixTime(le64(1n << 62n), 64, true, true)).toBe('out of range');
    expect(decodeUnixTime(le64(-(1n << 62n)), 64, true, true)).toBe('out of range');
    expect(unixSecondsToIso(8_640_000_000_000n)).toBe('+275760-09-13T00:00:00.000Z');
    expect(unixSecondsToIso(8_640_000_000_001n)).toBe('out of range');
  });
  it('n/a with too few bytes', () => {
    expect(decodeUnixTime(u8(1, 2, 3), 32, true, true)).toBeNull();
    expect(decodeUnixTime(u8(1, 2, 3, 4), 64, true, true)).toBeNull();
  });
});
