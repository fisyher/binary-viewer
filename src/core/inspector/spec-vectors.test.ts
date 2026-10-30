import { describe, expect, it } from 'vitest';
import { decodeDosDate, decodeDosTime, filetimeToIso } from './datetime';
import { decodeInspector } from './index';
import { decodeLeb128, decodeLeb128Value } from './leb128';
import { decodeFloat16, decodeFloat32 } from './numbers';
import { decodeLatin1, decodeUtf16, decodeUtf8, decodeUtf8Char } from './text';

const u8 = (...b: number[]) => Uint8Array.from(b);
const rep = (b: number, n: number) => new Array<number>(n).fill(b);
const val = (rows: ReturnType<typeof decodeInspector>, id: string) => rows.find((r) => r.id === id)!.value;

describe('LEB128 64-bit overflow', () => {
  it('unsigned values that do not fit 64 bits overflow', () => {
    expect(decodeLeb128Value(u8(...rep(0xff, 9), 0x7f), false)).toEqual({ kind: 'overflow' });
    expect(decodeLeb128Value(u8(...rep(0x80, 9), 0x02), false)).toEqual({ kind: 'overflow' });
    expect(decodeLeb128(u8(...rep(0x80, 9), 0x02), false)).toContain('overflow');
  });
  it('signed 10th byte must be 00 or 7F', () => {
    expect(decodeLeb128Value(u8(...rep(0x80, 9), 0x01), true)).toEqual({ kind: 'overflow' });
    expect(decodeLeb128Value(u8(...rep(0x80, 9), 0x7f), true)).toMatchObject({
      kind: 'ok',
      value: -9223372036854775808n,
    });
    expect(decodeLeb128Value(u8(...rep(0xff, 9), 0x7f), true)).toMatchObject({ kind: 'ok', value: -1n });
    expect(decodeLeb128Value(u8(...rep(0x80, 9), 0x00), true)).toMatchObject({ kind: 'ok', value: 0n });
  });
  it('padded zero is fine', () => {
    expect(decodeLeb128Value(u8(0x80, 0x80, 0x00), false)).toEqual({ kind: 'ok', value: 0n, length: 3 });
    expect(decodeLeb128(u8(0x80, 0x80, 0x00), false)).toBe('0 (3 bytes)');
  });
  it('a 10th byte with the continuation bit is too long, not overflow', () => {
    expect(decodeLeb128Value(u8(...rep(0x80, 10), 0x00), true)).toEqual({ kind: 'too-long' });
  });
});

describe('unsafe glyphs are never rendered raw', () => {
  const cases: Array<[string, number[], string]> = [
    ['RLO', [0xe2, 0x80, 0xae], 'U+202E'],
    ['ZWSP', [0xe2, 0x80, 0x8b], 'U+200B'],
    ['BOM', [0xef, 0xbb, 0xbf], 'U+FEFF'],
    ['combining acute', [0xcc, 0x81], 'U+0301'],
    ['soft hyphen', [0xc2, 0xad], 'U+00AD'],
    ['NBSP', [0xc2, 0xa0], 'U+00A0'],
    ['line separator', [0xe2, 0x80, 0xa8], 'U+2028'],
  ];
  it.each(cases)('UTF-8 %s shows only the label', (_n, bytes, label) => {
    const s = decodeUtf8(u8(...bytes))!;
    expect(s).toContain(label);
    expect(s).not.toContain("'");
    expect(s.replace(/ /g, '')).not.toMatch(/[\p{C}\p{Z}\p{M}]/u);
  });
  it('plain space keeps its glyph', () => expect(decodeUtf8(u8(0x20))).toContain("U+0020 ' '"));
  it('Latin-1 applies the same rule', () => {
    expect(decodeLatin1(u8(0xad))).toBe('\\xAD');
    expect(decodeLatin1(u8(0xa0))).toBe('\\xA0');
    expect(decodeLatin1(u8(0x20))).toBe(' ');
    expect(decodeLatin1(u8(0xe9))).toBe('é');
  });
  it('UTF-16 shows only the label for RLO (2E 20 LE, 20 2E BE)', () => {
    for (const s of [decodeUtf16(u8(0x2e, 0x20), true)!, decodeUtf16(u8(0x20, 0x2e), false)!]) {
      expect(s).toContain('U+202E');
      expect(s).not.toContain("'");
      expect(s.replace(/ /g, '')).not.toMatch(/[\p{C}\p{Z}\p{M}]/u);
    }
    // AE 20 (LE) is U+20AE, a plain currency sign, so it keeps its glyph
    expect(decodeUtf16(u8(0xae, 0x20), true)).toContain('U+20AE');
  });
});

describe('utf8 rejection classes and boundaries', () => {
  const reasons: Array<[number[], string]> = [
    [[0xc0, 0x80], 'overlong encoding'],
    [[0xc1, 0xbf], 'overlong encoding'],
    [[0xe0, 0x80, 0x80], 'overlong encoding'],
    [[0xe0, 0x9f, 0xbf], 'overlong encoding'],
    [[0xed, 0xa0, 0x80], 'surrogate code point'],
    [[0xed, 0xbf, 0xbf], 'surrogate code point'],
    [[0xf0, 0x80, 0x80, 0x80], 'overlong encoding'],
    [[0xf0, 0x8f, 0xbf, 0xbf], 'overlong encoding'],
    [[0xf4, 0x90, 0x80, 0x80], 'beyond U+10FFFF'],
    [[0xf5, 0x80, 0x80, 0x80], 'invalid lead byte'],
    [[0xff], 'invalid lead byte'],
    [[0x80], 'unexpected continuation byte'],
    [[0xe2, 0x82], 'truncated sequence'],
    [[0xf0, 0x9f, 0x98], 'truncated sequence'],
    [[0xe2, 0x28, 0xa1], 'invalid continuation byte'],
    // a visible second byte that is already out of range is invalid, not merely "truncated"
    [[0xe0, 0x80], 'overlong encoding'],
    [[0xed, 0xa0], 'surrogate code point'],
    [[0xf4, 0x90], 'beyond U+10FFFF'],
  ];
  it.each(reasons)('%j is rejected: %s', (bytes, reason) => {
    expect(decodeUtf8Char(u8(...bytes))).toMatchObject({ ok: false, reason });
  });
  const valid: Array<[number[], number]> = [
    [[0xe0, 0xa0, 0x80], 0x800],
    [[0xed, 0x9f, 0xbf], 0xd7ff],
    [[0xee, 0x80, 0x80], 0xe000],
    [[0xf0, 0x90, 0x80, 0x80], 0x10000],
    [[0xf4, 0x8f, 0xbf, 0xbf], 0x10ffff],
  ];
  it.each(valid)('%j is valid', (bytes, cp) => {
    expect(decodeUtf8Char(u8(...bytes))).toEqual({ ok: true, codePoint: cp, length: bytes.length });
  });
});

describe('utf16 spec cases', () => {
  it('lone surrogates', () => {
    expect(decodeUtf16(u8(0x00, 0xd8), true)).toContain('lone high surrogate');
    expect(decodeUtf16(u8(0x00, 0xd8, 0x41, 0x00), true)).toContain('lone high surrogate');
    expect(decodeUtf16(u8(0x00, 0xdc), true)).toContain('lone low surrogate');
  });
  it('pairs in both orders', () => {
    expect(decodeUtf16(u8(0x3d, 0xd8, 0x00, 0xde), true)).toContain('U+1F600');
    expect(decodeUtf16(u8(0xd8, 0x3d, 0xde, 0x00), false)).toContain('U+1F600');
  });
});

describe('float16 boundaries (both byte orders)', () => {
  const both = (bits: number) => [
    decodeFloat16(u8(bits & 0xff, bits >> 8), true),
    decodeFloat16(u8(bits >> 8, bits & 0xff), false),
  ];
  it.each([
    [0x0001, 5.960464477539063e-8],
    [0x03ff, 1023 * 2 ** -24],
    [0x0400, 6.103515625e-5],
    [0x7bff, 65504],
    [0xfc00, -Infinity],
    [0x7c01, NaN],
  ])('0x%i', (bits, expected) => {
    for (const out of both(bits)) {
      if (Number.isNaN(expected)) expect(out).toBe('NaN');
      else if (!Number.isFinite(expected)) expect(out).toBe('-Inf');
      else expect(Number(out)).toBe(expected);
    }
  });
});

describe('float32 shortest round-trip', () => {
  const f = (x: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, x, true);
    return decodeFloat32(b, true);
  };
  it('prints 0.1f and 1/3f compactly', () => {
    expect(f(0.1)).toBe('0.1');
    expect(f(1 / 3)).toBe('0.33333334');
    expect(f(16777216)).toBe('16777216');
    expect(f(-2.5)).toBe('-2.5');
  });
});

describe('date/time boundary vectors', () => {
  const dateWord = (y: number, m: number, d: number) => ((y - 1980) << 9) | (m << 5) | d;
  const leWord = (w: number) => u8(w & 0xff, w >> 8);
  it('FILETIME floors to milliseconds', () => {
    expect(filetimeToIso(116444735999999999n)).toBe('1969-12-31T23:59:59.999Z');
    expect(filetimeToIso(116444736000009999n)).toBe('1970-01-01T00:00:00.000Z');
  });
  it('DOS extremes', () => {
    expect(decodeDosTime(u8(0x7d, 0xbf), true)).toBe('23:59:58'); // 0xBF7D
    expect(decodeDosDate(u8(0x9f, 0xff), true)).toBe('2107-12-31'); // 0xFF9F
  });
  it('century leap rule', () => {
    expect(decodeDosDate(leWord(dateWord(2100, 2, 29)), true)).toBe('invalid');
    expect(decodeDosDate(leWord(dateWord(2000, 2, 29)), true)).toBe('2000-02-29');
  });
});

describe('bounds: subarray views with a non-zero byteOffset', () => {
  it('decodes identically to a standalone copy and never reads neighbouring bytes', () => {
    const content = Uint8Array.from({ length: 16 }, (_, i) => (i * 29 + 7) & 0xff);
    const backing = new Uint8Array(40).fill(0xee);
    backing.set(content, 5);
    const view = backing.subarray(5, 21);
    expect(view.byteOffset).toBe(5);
    for (const le of [true, false]) {
      expect(decodeInspector(view, le)).toEqual(decodeInspector(content.slice(), le));
    }
    const short = backing.subarray(5, 7);
    expect(val(decodeInspector(short, true), 'uint16')).not.toBe('n/a');
    expect(val(decodeInspector(short, true), 'uint32')).toBe('n/a');
    expect(val(decodeInspector(short, true), 'float32')).toBe('n/a');
  });
  it('DOS rows carry the little-endian hint', () => {
    const rows = decodeInspector(new Uint8Array(4), true);
    expect(rows.find((r) => r.id === 'dosdate')!.hint).toMatch(/little-endian/);
    expect(rows.find((r) => r.id === 'uint16')!.hint).toBeUndefined();
  });
});
