import { readUint, readU16, viewOf } from './bytes';

/** Integer of `bits` width (8..64, multiple of 8) at the start of `bytes`; null if too short. */
export function decodeInt(bytes: Uint8Array, bits: number, signed: boolean, le: boolean): string | null {
  const v = readUint(bytes, 0, bits / 8, le);
  if (v === null) return null;
  return (signed ? BigInt.asIntN(bits, v) : v).toString();
}

/** Format a float, making NaN, infinities and negative zero explicit. */
export function formatFloat(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (Object.is(n, -0)) return '-0';
  if (n === Infinity) return '+Inf';
  if (n === -Infinity) return '-Inf';
  return String(n);
}

/** IEEE 754 binary16 from its 16-bit pattern: subnormals, infinities, NaN and -0 handled. */
export function float16FromBits(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24; // zero (keeps sign) and subnormals
  if (exp === 0x1f) return frac === 0 ? sign * Infinity : NaN;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

export function decodeFloat16(bytes: Uint8Array, le: boolean): string | null {
  const bits = readU16(bytes, 0, le);
  return bits === null ? null : formatFloat(float16FromBits(bits));
}

/** Shortest decimal that round-trips to the same float32 (so 0.1f prints as 0.1). */
export function shortestFloat32(n: number): number {
  if (!Number.isFinite(n) || n === 0) return n;
  for (let p = 1; p <= 9; p++) {
    const parsed = Number(n.toPrecision(p));
    if (Math.fround(parsed) === n) return parsed;
  }
  return n;
}

export function decodeFloat32(bytes: Uint8Array, le: boolean): string | null {
  if (bytes.length < 4) return null;
  const n = viewOf(bytes).getFloat32(0, le);
  return formatFloat(shortestFloat32(n));
}

export function decodeFloat64(bytes: Uint8Array, le: boolean): string | null {
  if (bytes.length < 8) return null;
  return formatFloat(viewOf(bytes).getFloat64(0, le));
}

/** First byte as 8 binary digits. */
export function decodeBinary(bytes: Uint8Array): string | null {
  return bytes.length < 1 ? null : bytes[0]!.toString(2).padStart(8, '0');
}

/** First byte in octal (3 digits). */
export function decodeOctal(bytes: Uint8Array): string | null {
  return bytes.length < 1 ? null : bytes[0]!.toString(8).padStart(3, '0');
}
