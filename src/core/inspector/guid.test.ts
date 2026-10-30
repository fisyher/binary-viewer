import { describe, expect, it } from 'vitest';
import { decodeGuidMicrosoft, decodeGuidRfc } from './guid';

const u8 = (...b: number[]) => Uint8Array.from(b);
const bytes = u8(0x33, 0x22, 0x11, 0x00, 0x55, 0x44, 0x77, 0x66, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff);

describe('GUID', () => {
  it('Microsoft mixed-endian layout', () => {
    expect(decodeGuidMicrosoft(bytes)).toMatch(/^\{00112233-4455-6677-8899-AABBCCDDEEFF\}/);
  });
  it('RFC 4122 big-endian layout', () => {
    expect(decodeGuidRfc(bytes)).toMatch(/^33221100-5544-7766-8899-aabbccddeeff/);
  });
  it('reports version and variant per layout', () => {
    expect(decodeGuidMicrosoft(bytes)).toContain('v6, RFC 4122'); // byte 7 = 0x66, byte 8 = 0x88
    expect(decodeGuidRfc(bytes)).toContain('v7, RFC 4122'); // byte 6 = 0x77
    // v4 random UUID 123e4567-e89b-42d3-a456-426614174000 in RFC byte order
    const v4 = u8(0x12, 0x3e, 0x45, 0x67, 0xe8, 0x9b, 0x42, 0xd3, 0xa4, 0x56, 0x42, 0x66, 0x14, 0x17, 0x40, 0x00);
    expect(decodeGuidRfc(v4)).toBe('123e4567-e89b-42d3-a456-426614174000 (v4, RFC 4122)');
  });
  it('decodes variants', () => {
    const v = (b8: number) => decodeGuidRfc(u8(0, 0, 0, 0, 0, 0, 0x10, 0, b8, 0, 0, 0, 0, 0, 0, 0));
    expect(v(0x00)).toContain('NCS');
    expect(v(0x80)).toContain('RFC 4122');
    expect(v(0xc0)).toContain('Microsoft');
    expect(v(0xe0)).toContain('reserved');
  });
  it('n/a with fewer than 16 bytes', () => {
    expect(decodeGuidMicrosoft(bytes.subarray(0, 15))).toBeNull();
    expect(decodeGuidRfc(bytes.subarray(0, 15))).toBeNull();
  });
});
