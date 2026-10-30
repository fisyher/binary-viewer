import { describe, expect, it } from 'vitest';
import { decodeLeb128, decodeLeb128Value } from './leb128';

const u8 = (...b: number[]) => Uint8Array.from(b);

describe('LEB128', () => {
  it('unsigned E5 8E 26 = 624485', () => {
    expect(decodeLeb128Value(u8(0xe5, 0x8e, 0x26), false)).toEqual({ kind: 'ok', value: 624485n, length: 3 });
    expect(decodeLeb128(u8(0xe5, 0x8e, 0x26, 0xff), false)).toBe('624485 (3 bytes)');
  });
  it('signed C0 BB 78 = -123456', () => {
    expect(decodeLeb128Value(u8(0xc0, 0xbb, 0x78), true)).toEqual({ kind: 'ok', value: -123456n, length: 3 });
  });
  it('single bytes, signed and unsigned', () => {
    expect(decodeLeb128Value(u8(0x7f), false)).toMatchObject({ value: 127n, length: 1 });
    expect(decodeLeb128Value(u8(0x7f), true)).toMatchObject({ value: -1n });
    expect(decodeLeb128Value(u8(0x40), true)).toMatchObject({ value: -64n });
    expect(decodeLeb128Value(u8(0x3f), true)).toMatchObject({ value: 63n });
    expect(decodeLeb128(u8(0x00), false)).toBe('0 (1 byte)');
  });
  it('10-byte maximum decodes', () => {
    const max = u8(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01);
    expect(decodeLeb128Value(max, false)).toEqual({ kind: 'ok', value: 18446744073709551615n, length: 10 });
  });
  it('11 bytes with an 11th terminator is too long', () => {
    const b = u8(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00);
    expect(decodeLeb128Value(b, false)).toEqual({ kind: 'too-long' });
    expect(decodeLeb128(b, false)).toContain('too long');
  });
  it('no terminator within the available bytes is incomplete', () => {
    expect(decodeLeb128Value(u8(0x80), false)).toEqual({ kind: 'incomplete' });
    expect(decodeLeb128(u8(0x80, 0x80), true)).toContain('incomplete');
  });
  it('n/a when empty', () => expect(decodeLeb128(u8(), false)).toBeNull());
});
