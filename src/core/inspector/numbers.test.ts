import { describe, expect, it } from 'vitest';
import {
  decodeBinary,
  decodeFloat16,
  decodeFloat32,
  decodeFloat64,
  decodeInt,
  decodeOctal,
} from './numbers';

const u8 = (...b: number[]) => Uint8Array.from(b);

describe('integers', () => {
  it('decodes LE and BE for every width', () => {
    const b = u8(0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08);
    expect(decodeInt(b, 16, false, true)).toBe('513'); // 0x0201
    expect(decodeInt(b, 16, false, false)).toBe('258'); // 0x0102
    expect(decodeInt(b, 24, false, true)).toBe(String(0x030201));
    expect(decodeInt(b, 24, false, false)).toBe(String(0x010203));
    expect(decodeInt(b, 32, false, true)).toBe(String(0x04030201));
    expect(decodeInt(b, 32, false, false)).toBe(String(0x01020304));
    expect(decodeInt(b, 64, false, true)).toBe('578437695752307201'); // 0x0807060504030201
    expect(decodeInt(b, 64, false, false)).toBe('72623859790382856'); // 0x0102030405060708
  });

  it('sign-extends signed values', () => {
    expect(decodeInt(u8(0xff), 8, true, true)).toBe('-1');
    expect(decodeInt(u8(0xff), 8, false, true)).toBe('255');
    expect(decodeInt(u8(0x00, 0x80), 16, true, true)).toBe('-32768');
    expect(decodeInt(u8(0x80, 0x00), 16, true, false)).toBe('-32768');
    expect(decodeInt(u8(0xff, 0xff, 0xff), 24, true, true)).toBe('-1');
    expect(decodeInt(u8(0x00, 0x00, 0x80), 24, true, true)).toBe('-8388608');
  });

  it('keeps full 64-bit precision', () => {
    const max = u8(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
    expect(decodeInt(max, 64, false, true)).toBe('18446744073709551615');
    expect(decodeInt(max, 64, true, false)).toBe('-1');
    const min = u8(0, 0, 0, 0, 0, 0, 0, 0x80);
    expect(decodeInt(min, 64, true, true)).toBe('-9223372036854775808');
  });

  it('is n/a with too few bytes', () => {
    expect(decodeInt(u8(), 8, true, true)).toBeNull();
    expect(decodeInt(u8(1), 16, true, true)).toBeNull();
    expect(decodeInt(u8(1, 2), 24, true, false)).toBeNull();
    expect(decodeInt(u8(1, 2, 3), 32, false, true)).toBeNull();
    expect(decodeInt(u8(1, 2, 3, 4, 5, 6, 7), 64, false, true)).toBeNull();
  });
});

describe('float16', () => {
  it('+Inf (00 7C LE)', () => expect(decodeFloat16(u8(0x00, 0x7c), true)).toBe('+Inf'));
  it('-Inf', () => expect(decodeFloat16(u8(0x00, 0xfc), true)).toBe('-Inf'));
  it('NaN (01 7E LE)', () => expect(decodeFloat16(u8(0x01, 0x7e), true)).toBe('NaN'));
  it('smallest subnormal (01 00 LE)', () =>
    expect(decodeFloat16(u8(0x01, 0x00), true)).toBe(String(2 ** -24)));
  it('-0 (00 80 LE)', () => expect(decodeFloat16(u8(0x00, 0x80), true)).toBe('-0'));
  it('+0', () => expect(decodeFloat16(u8(0, 0), true)).toBe('0'));
  it('normal values', () => {
    expect(decodeFloat16(u8(0x00, 0x3c), true)).toBe('1');
    expect(decodeFloat16(u8(0x3c, 0x00), false)).toBe('1'); // BE
    expect(decodeFloat16(u8(0x00, 0xc0), true)).toBe('-2');
    expect(decodeFloat16(u8(0xff, 0x7b), true)).toBe('65504'); // max finite
  });
  it('respects byte order', () => {
    expect(decodeFloat16(u8(0x00, 0x7c), false)).not.toBe('+Inf');
  });
  it('n/a with < 2 bytes', () => expect(decodeFloat16(u8(0), true)).toBeNull());
});

describe('float32 / float64', () => {
  it('decodes both byte orders', () => {
    expect(decodeFloat32(u8(0x00, 0x00, 0x80, 0x3f), true)).toBe('1');
    expect(decodeFloat32(u8(0x3f, 0x80, 0x00, 0x00), false)).toBe('1');
    expect(decodeFloat32(u8(0xdb, 0x0f, 0x49, 0x40), true)).toBe('3.1415927');
    expect(decodeFloat64(u8(0, 0, 0, 0, 0, 0, 0xf0, 0x3f), true)).toBe('1');
    expect(decodeFloat64(u8(0x3f, 0xf0, 0, 0, 0, 0, 0, 0), false)).toBe('1');
  });
  it('shows NaN, infinities and -0 explicitly', () => {
    expect(decodeFloat32(u8(0, 0, 0xc0, 0x7f), true)).toBe('NaN');
    expect(decodeFloat32(u8(0, 0, 0x80, 0x7f), true)).toBe('+Inf');
    expect(decodeFloat32(u8(0, 0, 0x80, 0xff), true)).toBe('-Inf');
    expect(decodeFloat32(u8(0, 0, 0, 0x80), true)).toBe('-0');
    expect(decodeFloat64(u8(0, 0, 0, 0, 0, 0, 0, 0x80), true)).toBe('-0');
    expect(decodeFloat64(u8(0, 0, 0, 0, 0, 0, 0xf8, 0x7f), true)).toBe('NaN');
  });
  it('n/a with too few bytes', () => {
    expect(decodeFloat32(u8(1, 2, 3), true)).toBeNull();
    expect(decodeFloat64(u8(1, 2, 3, 4, 5, 6, 7), true)).toBeNull();
  });
});

describe('binary / octal', () => {
  it('formats the first byte', () => {
    expect(decodeBinary(u8(0xa5))).toBe('10100101');
    expect(decodeBinary(u8(0x01))).toBe('00000001');
    expect(decodeOctal(u8(0xff))).toBe('377');
    expect(decodeOctal(u8(0x08))).toBe('010');
  });
  it('n/a when empty', () => {
    expect(decodeBinary(u8())).toBeNull();
    expect(decodeOctal(u8())).toBeNull();
  });
});
