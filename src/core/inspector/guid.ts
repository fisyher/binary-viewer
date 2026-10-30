import { hex2 } from './bytes';

const VARIANTS = ['NCS', 'RFC 4122', 'Microsoft', 'reserved'];

function variantOf(b8: number): string {
  if ((b8 & 0x80) === 0) return VARIANTS[0]!;
  if ((b8 & 0xc0) === 0x80) return VARIANTS[1]!;
  if ((b8 & 0xe0) === 0xc0) return VARIANTS[2]!;
  return VARIANTS[3]!;
}

function group(b: Uint8Array, order: number[]): string {
  return order.map((i) => hex2(b[i]!)).join('');
}

/**
 * Microsoft layout: the first three fields (u32, u16, u16) are little-endian, the rest are
 * in byte order. Uses the first 16 bytes; null if fewer. Independent of the LE/BE toggle.
 */
export function decodeGuidMicrosoft(bytes: Uint8Array): string | null {
  if (bytes.length < 16) return null;
  const s =
    group(bytes, [3, 2, 1, 0]) + '-' + group(bytes, [5, 4]) + '-' + group(bytes, [7, 6]) + '-' +
    group(bytes, [8, 9]) + '-' + group(bytes, [10, 11, 12, 13, 14, 15]);
  const version = bytes[7]! >> 4; // time_hi_and_version is a little-endian u16 at bytes 6..7
  return `{${s}} (v${version}, ${variantOf(bytes[8]!)})`;
}

/** RFC 4122 layout: all fields big-endian, i.e. plain byte order. */
export function decodeGuidRfc(bytes: Uint8Array): string | null {
  if (bytes.length < 16) return null;
  const s =
    group(bytes, [0, 1, 2, 3]) + '-' + group(bytes, [4, 5]) + '-' + group(bytes, [6, 7]) + '-' +
    group(bytes, [8, 9]) + '-' + group(bytes, [10, 11, 12, 13, 14, 15]);
  return `${s.toLowerCase()} (v${bytes[6]! >> 4}, ${variantOf(bytes[8]!)})`;
}
