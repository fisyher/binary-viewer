/** Explicit-endian integer readers. Nothing here depends on host byte order. */

/** Unsigned integer of `size` bytes at `offset`, or null if not fully available. */
export function readUint(bytes: Uint8Array, offset: number, size: number, le: boolean): bigint | null {
  if (!Number.isSafeInteger(offset) || offset < 0 || size < 1 || offset + size > bytes.length) return null;
  let v = 0n;
  for (let i = 0; i < size; i++) {
    const b = bytes[le ? offset + size - 1 - i : offset + i]!;
    v = (v << 8n) | BigInt(b);
  }
  return v;
}

/** Unsigned 16-bit value as a number, or null if not available. */
export function readU16(bytes: Uint8Array, offset: number, le: boolean): number | null {
  const v = readUint(bytes, offset, 2, le);
  return v === null ? null : Number(v);
}

export function hex2(b: number): string {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

export function hexBytes(bytes: Uint8Array): string {
  return Array.from(bytes, hex2).join(' ');
}

/** DataView over exactly the given bytes. Callers must pass an explicit endian flag to every get. */
export function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
