import { describe, expect, it } from 'vitest';
import { decodeLatin1, decodeUtf16, decodeUtf8, decodeUtf8Char } from './text';

const u8 = (...b: number[]) => Uint8Array.from(b);

describe('latin1', () => {
  it('shows printable characters and escapes the rest', () => {
    expect(decodeLatin1(u8(0x41))).toBe('A');
    expect(decodeLatin1(u8(0xe9))).toBe('é');
    expect(decodeLatin1(u8(0x00))).toBe('\\x00');
    expect(decodeLatin1(u8(0x0a))).toBe('\\x0A');
    expect(decodeLatin1(u8(0x7f))).toBe('\\x7F');
    expect(decodeLatin1(u8(0x85))).toBe('\\x85');
    expect(decodeLatin1(u8(0xa0))).toBe('\\xA0');
  });
  it('n/a when empty', () => expect(decodeLatin1(u8())).toBeNull());
});

describe('utf8', () => {
  it('decodes 1-4 byte sequences', () => {
    expect(decodeUtf8Char(u8(0x41))).toEqual({ ok: true, codePoint: 0x41, length: 1 });
    expect(decodeUtf8Char(u8(0xc3, 0xa9))).toEqual({ ok: true, codePoint: 0xe9, length: 2 });
    expect(decodeUtf8Char(u8(0xe2, 0x82, 0xac))).toEqual({ ok: true, codePoint: 0x20ac, length: 3 });
    expect(decodeUtf8Char(u8(0xf0, 0x9f, 0x98, 0x80))).toEqual({ ok: true, codePoint: 0x1f600, length: 4 });
  });
  it('formats a valid emoji with the bytes consumed', () => {
    const s = decodeUtf8(u8(0xf0, 0x9f, 0x98, 0x80, 0x41))!;
    expect(s).toContain('U+1F600');
    expect(s).toContain('😀');
    expect(s).toContain('4 bytes');
    expect(s).toContain('F0 9F 98 80');
  });
  it('flags overlong C0 80', () => {
    expect(decodeUtf8Char(u8(0xc0, 0x80))).toMatchObject({ ok: false, reason: 'overlong encoding', length: 2 });
    expect(decodeUtf8(u8(0xc0, 0x80))).toContain('overlong');
  });
  it('flags other overlongs', () => {
    expect(decodeUtf8Char(u8(0xe0, 0x80, 0x80))).toMatchObject({ ok: false, reason: 'overlong encoding' });
    expect(decodeUtf8Char(u8(0xf0, 0x80, 0x80, 0x80))).toMatchObject({ ok: false, reason: 'overlong encoding' });
  });
  it('flags surrogates ED A0 80', () => {
    expect(decodeUtf8Char(u8(0xed, 0xa0, 0x80))).toMatchObject({ ok: false, reason: 'surrogate code point' });
  });
  it('flags values over U+10FFFF (F4 90 80 80)', () => {
    expect(decodeUtf8Char(u8(0xf4, 0x90, 0x80, 0x80))).toMatchObject({ ok: false, reason: 'beyond U+10FFFF' });
    expect(decodeUtf8Char(u8(0xf4, 0x8f, 0xbf, 0xbf))).toMatchObject({ ok: true, codePoint: 0x10ffff });
    expect(decodeUtf8Char(u8(0xf5, 0x80, 0x80, 0x80))).toMatchObject({ ok: false });
  });
  it('flags truncated sequences', () => {
    expect(decodeUtf8Char(u8(0xe2, 0x82))).toMatchObject({ ok: false, reason: 'truncated sequence', length: 2 });
    expect(decodeUtf8Char(u8(0xf0))).toMatchObject({ ok: false, reason: 'truncated sequence', length: 1 });
  });
  it('flags stray and bad continuation bytes', () => {
    expect(decodeUtf8Char(u8(0x80))).toMatchObject({ ok: false, length: 1 });
    expect(decodeUtf8Char(u8(0xc3, 0x28))).toMatchObject({ ok: false, reason: 'invalid continuation byte' });
  });
  it('n/a when empty', () => expect(decodeUtf8(u8())).toBeNull());
});

describe('utf16', () => {
  it('flags a lone high surrogate (00 D8 LE)', () => {
    expect(decodeUtf16(u8(0x00, 0xd8), true)).toContain('lone high surrogate');
  });
  it('flags a high surrogate followed by a non-low unit', () => {
    expect(decodeUtf16(u8(0x00, 0xd8, 0x41, 0x00), true)).toContain('lone high surrogate');
  });
  it('flags a lone low surrogate', () => {
    expect(decodeUtf16(u8(0x00, 0xdc), true)).toContain('lone low surrogate');
  });
  it('decodes a surrogate pair in both byte orders', () => {
    const le = decodeUtf16(u8(0x3d, 0xd8, 0x00, 0xde), true)!;
    const be = decodeUtf16(u8(0xd8, 0x3d, 0xde, 0x00), false)!;
    for (const s of [le, be]) {
      expect(s).toContain('U+1F600');
      expect(s).toContain('surrogate pair');
    }
  });
  it('decodes BMP characters and respects byte order', () => {
    expect(decodeUtf16(u8(0x41, 0x00), true)).toContain("U+0041 'A'");
    expect(decodeUtf16(u8(0x41, 0x00), false)).toContain('U+4100');
  });
  it('n/a with < 2 bytes', () => expect(decodeUtf16(u8(0x41), true)).toBeNull());
});
