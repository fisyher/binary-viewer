/** Longest LEB128 accepted (enough for 64-bit values: ceil(64/7) = 10 bytes). */
export const LEB128_MAX_BYTES = 10;

export type Leb128Result =
  | { kind: 'ok'; value: bigint; length: number }
  | { kind: 'too-long' }
  | { kind: 'overflow' }
  | { kind: 'incomplete' };

/** Decode a LEB128 value at the start of `bytes`. */
export function decodeLeb128Value(bytes: Uint8Array, signed: boolean): Leb128Result {
  const limit = Math.min(bytes.length, LEB128_MAX_BYTES);
  let value = 0n;
  for (let i = 0; i < limit; i++) {
    const b = bytes[i]!;
    if (i === LEB128_MAX_BYTES - 1 && (b & 0x80) === 0) {
      // 10th byte: only bit 0 (unsigned) or a pure sign extension (signed) fits in 64 bits.
      const fits = signed ? b === 0x00 || b === 0x7f : (b & 0x7e) === 0;
      if (!fits) return { kind: 'overflow' };
    }
    value |= BigInt(b & 0x7f) << BigInt(7 * i);
    if ((b & 0x80) === 0) {
      const length = i + 1;
      if (signed && (b & 0x40) !== 0) value -= 1n << BigInt(7 * length); // sign-extend
      return { kind: 'ok', value, length };
    }
  }
  return bytes.length >= LEB128_MAX_BYTES ? { kind: 'too-long' } : { kind: 'incomplete' };
}

/** Display string, or null when there are no bytes. */
export function decodeLeb128(bytes: Uint8Array, signed: boolean): string | null {
  if (bytes.length < 1) return null;
  const r = decodeLeb128Value(bytes, signed);
  if (r.kind === 'too-long') return `invalid: too long (over ${LEB128_MAX_BYTES} bytes)`;
  if (r.kind === 'overflow') return 'invalid: overflow (does not fit in 64 bits)';
  if (r.kind === 'incomplete') return 'invalid: incomplete (no terminating byte)';
  return `${r.value} (${r.length} byte${r.length > 1 ? 's' : ''})`;
}
