/** Conversions between bytes and the text used for copy/paste. Pure; sizes are capped. */

/** Largest copy or paste accepted. */
export const MAX_CLIPBOARD_BYTES = 16 * 1024 * 1024;

export type TextResult = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

const HEX = '0123456789ABCDEF';

/** "DE AD BE EF" (uppercase, space separated). Throws RangeError beyond MAX_CLIPBOARD_BYTES. */
export function bytesToHexText(bytes: Uint8Array): string {
  if (bytes.length > MAX_CLIPBOARD_BYTES) throw new RangeError(`Too large to copy (limit ${MAX_CLIPBOARD_BYTES} bytes)`);
  const parts = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) parts[i] = HEX[bytes[i]! >> 4]! + HEX[bytes[i]! & 15]!;
  return parts.join(' ');
}

const TOO_LARGE = `Paste is too large (limit ${MAX_CLIPBOARD_BYTES} bytes)`;

/**
 * Hex text such as "DE AD BE EF", "deadbeef", "0xDE,0xAD". Whitespace and commas separate; an optional
 * 0x prefix is allowed per token. Odd digit counts and other characters are rejected.
 */
export function parseHexText(text: string): TextResult {
  if (text.length > MAX_CLIPBOARD_BYTES * 4) return { ok: false, error: TOO_LARGE };
  const tokens = text.split(/[\s,]+/).filter((t) => t.length > 0);
  const digits: string[] = [];
  for (const t of tokens) {
    const body = /^0x/i.test(t) ? t.slice(2) : t;
    const bad = /[^0-9a-fA-F]/.exec(body);
    if (bad) return { ok: false, error: `Invalid hex text: unexpected "${bad[0]}"` };
    digits.push(body);
  }
  const joined = digits.join('');
  if (joined.length === 0) return { ok: false, error: 'Nothing to paste' };
  if (joined.length % 2 !== 0) return { ok: false, error: 'Invalid hex text: odd number of digits' };
  if (joined.length / 2 > MAX_CLIPBOARD_BYTES) return { ok: false, error: TOO_LARGE };
  const out = new Uint8Array(joined.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(joined.substr(i * 2, 2), 16);
  return { ok: true, bytes: out };
}

/** Plain text pasted into the ASCII column: printable ASCII (0x20-0x7E) only. */
export function parseAsciiText(text: string): TextResult {
  if (text.length === 0) return { ok: false, error: 'Nothing to paste' };
  if (text.length > MAX_CLIPBOARD_BYTES) return { ok: false, error: TOO_LARGE };
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return { ok: false, error: `Pasted text has a non-printable or non-ASCII character at position ${i}` };
    out[i] = c;
  }
  return { ok: true, bytes: out };
}
