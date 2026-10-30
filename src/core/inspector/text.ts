import { hex2, hexBytes, readU16 } from './bytes';

/** Invisible, bidi-control, separator and combining characters are never rendered raw. */
const UNSAFE_GLYPH = /[\p{C}\p{Z}\p{M}]/u;

function isSafeGlyph(ch: string): boolean {
  return ch === ' ' || !UNSAFE_GLYPH.test(ch);
}

function cpLabel(cp: number): string {
  const label = 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
  const ch = String.fromCodePoint(cp); // lone surrogates are category Cs, hence unsafe
  return isSafeGlyph(ch) ? `${label} '${ch}'` : label;
}

/** ASCII/Latin-1 character of the first byte; anything not safely printable is shown as \xNN. */
export function decodeLatin1(bytes: Uint8Array): string | null {
  if (bytes.length < 1) return null;
  const b = bytes[0]!;
  const ch = String.fromCharCode(b);
  return isSafeGlyph(ch) ? ch : `\\x${hex2(b)}`;
}

export type Utf8Result =
  | { ok: true; codePoint: number; length: number }
  | { ok: false; reason: string; length: number };

/** Decode one UTF-8 code point at the start of `bytes`, strictly (RFC 3629). Null if empty. */
export function decodeUtf8Char(bytes: Uint8Array): Utf8Result | null {
  if (bytes.length < 1) return null;
  const b0 = bytes[0]!;
  if (b0 < 0x80) return { ok: true, codePoint: b0, length: 1 };
  if (b0 < 0xc0) return { ok: false, reason: 'unexpected continuation byte', length: 1 };
  if (b0 > 0xf4) return { ok: false, reason: 'invalid lead byte', length: 1 };

  const need = b0 >= 0xf0 ? 4 : b0 >= 0xe0 ? 3 : 2;
  const have = Math.min(need, bytes.length);
  for (let i = 1; i < have; i++) {
    if ((bytes[i]! & 0xc0) !== 0x80) return { ok: false, reason: 'invalid continuation byte', length: i };
  }
  if (have < need) {
    // Already-visible second byte may rule the sequence out before it is complete.
    if (have >= 2) {
      const b1 = bytes[1]!;
      if ((b0 === 0xe0 && b1 < 0xa0) || (b0 === 0xf0 && b1 < 0x90)) {
        return { ok: false, reason: 'overlong encoding', length: have };
      }
      if (b0 === 0xed && b1 >= 0xa0) return { ok: false, reason: 'surrogate code point', length: have };
      if (b0 === 0xf4 && b1 >= 0x90) return { ok: false, reason: 'beyond U+10FFFF', length: have };
    }
    return { ok: false, reason: 'truncated sequence', length: have };
  }

  let cp = b0 & (0xff >> (need + 1));
  for (let i = 1; i < need; i++) cp = (cp << 6) | (bytes[i]! & 0x3f);

  const min = need === 2 ? 0x80 : need === 3 ? 0x800 : 0x10000;
  if (cp < min) return { ok: false, reason: 'overlong encoding', length: need };
  if (cp >= 0xd800 && cp <= 0xdfff) return { ok: false, reason: 'surrogate code point', length: need };
  if (cp > 0x10ffff) return { ok: false, reason: 'beyond U+10FFFF', length: need };
  return { ok: true, codePoint: cp, length: need };
}

export function decodeUtf8(bytes: Uint8Array): string | null {
  const r = decodeUtf8Char(bytes);
  if (!r) return null;
  const used = hexBytes(bytes.subarray(0, r.length));
  return r.ok ? `${cpLabel(r.codePoint)} (${r.length} byte${r.length > 1 ? 's' : ''}: ${used})` : `invalid: ${r.reason} (${used})`;
}

/** UTF-16 character in the given byte order, with surrogate pairs; lone surrogates are flagged. */
export function decodeUtf16(bytes: Uint8Array, le: boolean): string | null {
  const u = readU16(bytes, 0, le);
  if (u === null) return null;
  if (u >= 0xdc00 && u <= 0xdfff) return `invalid: lone low surrogate (U+${u.toString(16).toUpperCase()})`;
  if (u >= 0xd800 && u <= 0xdbff) {
    const lo = readU16(bytes, 2, le);
    if (lo === null || lo < 0xdc00 || lo > 0xdfff) {
      return `invalid: lone high surrogate (U+${u.toString(16).toUpperCase()})`;
    }
    const cp = 0x10000 + ((u - 0xd800) << 10) + (lo - 0xdc00);
    return `${cpLabel(cp)} (surrogate pair, 4 bytes)`;
  }
  return `${cpLabel(u)} (2 bytes)`;
}
