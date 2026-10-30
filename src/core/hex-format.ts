export const BYTES_PER_ROW = 16;

const HEX = '0123456789ABCDEF';

/** Hex digits used for offsets in a file of `size` bytes (min 8). */
export function offsetWidth(size: number): number {
  const maxOffset = Math.max(0, size - 1);
  return Math.max(8, maxOffset.toString(16).length);
}

/** Uppercase hex offset, zero-padded to `width` digits. */
export function formatOffset(offset: number, width: number): string {
  return offset.toString(16).toUpperCase().padStart(width, '0');
}

/** Byte (0..255) as 2 uppercase hex digits. */
export function byteToHex(byte: number): string {
  const b = byte & 0xff;
  return HEX[b >> 4]! + HEX[b & 0xf]!;
}

/** Printable ASCII (0x20..0x7E) as itself; everything else as '.'. */
export function byteToAscii(byte: number): string {
  return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
}

export function rowCount(size: number, bytesPerRow = BYTES_PER_ROW): number {
  return Math.ceil(size / bytesPerRow);
}

/** Rows to render while editing: the caret slot at offset `size` may start one extra row. */
export function editRowCount(size: number, bytesPerRow = BYTES_PER_ROW): number {
  return Math.floor(size / bytesPerRow) + 1;
}

export function rowStartOffset(row: number, bytesPerRow = BYTES_PER_ROW): number {
  return row * bytesPerRow;
}
