export type ParseOffsetResult = { ok: true; offset: number } | { ok: false; error: string };
export type OffsetMode = 'hex' | 'dec';

/**
 * Parse a go-to-offset string in the given mode (default hex).
 * Hex accepts an optional 0x prefix; decimal accepts digits only.
 * The offset must be a safe integer and < size.
 */
export function parseOffset(text: string, size: number, mode: OffsetMode = 'hex'): ParseOffsetResult {
  const s = text.trim();
  if (s === '') return { ok: false, error: 'Enter an offset' };

  let digits: string;
  if (mode === 'hex') {
    const m = /^(?:0x)?([0-9a-f]+)$/i.exec(s);
    if (!m) return { ok: false, error: 'Invalid hex offset (e.g. 1F or 0x1F)' };
    digits = m[1]!;
  } else {
    if (!/^[0-9]+$/.test(s)) return { ok: false, error: 'Invalid decimal offset' };
    digits = s;
  }

  const offset = parseInt(digits, mode === 'hex' ? 16 : 10);
  if (!Number.isSafeInteger(offset)) return { ok: false, error: 'Offset too large' };
  if (size <= 0) return { ok: false, error: 'No data to jump in' };
  if (offset >= size) {
    return { ok: false, error: `Out of range (last offset is 0x${(size - 1).toString(16).toUpperCase()})` };
  }
  return { ok: true, offset };
}
