import { describe, expect, it } from 'vitest';
import {
  byteToAscii,
  byteToHex,
  formatOffset,
  offsetWidth,
  rowCount,
  rowStartOffset,
} from './hex-format';

describe('hex-format', () => {
  it('chooses offset width from size (min 8)', () => {
    expect(offsetWidth(0)).toBe(8);
    expect(offsetWidth(1)).toBe(8);
    expect(offsetWidth(0x1_0000_0000)).toBe(8); // last offset 0xFFFFFFFF
    expect(offsetWidth(0x1_0000_0001)).toBe(9);
    expect(offsetWidth(2 ** 40 + 1)).toBe(11);
  });

  it('formats offsets as padded uppercase hex', () => {
    expect(formatOffset(0, 8)).toBe('00000000');
    expect(formatOffset(0xabcdef, 8)).toBe('00ABCDEF');
    expect(formatOffset(0x123456789, 9)).toBe('123456789');
  });

  it('formats bytes as 2-digit hex', () => {
    expect(byteToHex(0)).toBe('00');
    expect(byteToHex(0x0a)).toBe('0A');
    expect(byteToHex(0xff)).toBe('FF');
  });

  it('maps bytes to ASCII with dots for non-printables', () => {
    expect(byteToAscii(0x1f)).toBe('.');
    expect(byteToAscii(0x20)).toBe(' ');
    expect(byteToAscii(0x41)).toBe('A');
    expect(byteToAscii(0x7e)).toBe('~');
    expect(byteToAscii(0x7f)).toBe('.');
    expect(byteToAscii(0xff)).toBe('.');
  });

  it('does row math', () => {
    expect(rowCount(0)).toBe(0);
    expect(rowCount(1)).toBe(1);
    expect(rowCount(16)).toBe(1);
    expect(rowCount(17)).toBe(2);
    expect(rowCount(100, 8)).toBe(13);
    expect(rowStartOffset(0)).toBe(0);
    expect(rowStartOffset(3)).toBe(48);
    expect(rowStartOffset(3, 8)).toBe(24);
  });
});
