import { describe, expect, it } from 'vitest';
import { MAX_CLIPBOARD_BYTES, bytesToHexText, parseAsciiText, parseHexText } from './clipboard-text';

describe('clipboard text', () => {
  it('formats hex', () => {
    expect(bytesToHexText(Uint8Array.from([0xde, 0xad, 0, 0x0f]))).toBe('DE AD 00 0F');
    expect(bytesToHexText(new Uint8Array(0))).toBe('');
    expect(() => bytesToHexText(new Uint8Array(MAX_CLIPBOARD_BYTES + 1))).toThrow(RangeError);
  });
  it('parses hex in several spellings', () => {
    for (const t of ['DE AD BE EF', 'deadbeef', ' de\nad\tbe,ef ', '0xDE 0xAD 0xBE 0xEF']) {
      expect(parseHexText(t)).toEqual({ ok: true, bytes: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]) });
    }
  });
  it('rejects bad hex', () => {
    expect(parseHexText('')).toMatchObject({ ok: false });
    expect(parseHexText('DE A')).toMatchObject({ ok: false, error: expect.stringContaining('odd') });
    expect(parseHexText('GG')).toMatchObject({ ok: false, error: expect.stringContaining('"G"') });
    expect(parseHexText('x'.repeat(MAX_CLIPBOARD_BYTES * 4 + 1))).toMatchObject({ ok: false, error: expect.stringContaining('too large') });
    expect(parseHexText('AB'.repeat(MAX_CLIPBOARD_BYTES + 1))).toMatchObject({ ok: false, error: expect.stringContaining('too large') });
  });
  it('parses printable ASCII only', () => {
    expect(parseAsciiText('Hi ~')).toEqual({ ok: true, bytes: Uint8Array.from([72, 105, 32, 126]) });
    expect(parseAsciiText('a\nb')).toMatchObject({ ok: false });
    expect(parseAsciiText('é')).toMatchObject({ ok: false });
    expect(parseAsciiText('')).toMatchObject({ ok: false });
  });
});
