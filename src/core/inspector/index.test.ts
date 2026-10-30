import { describe, expect, it } from 'vitest';
import { decodeInspector, INSPECTOR_WINDOW } from './index';

const u8 = (...b: number[]) => Uint8Array.from(b);
const val = (rows: ReturnType<typeof decodeInspector>, id: string) => rows.find((r) => r.id === id)!.value;

describe('decodeInspector', () => {
  it('every row is n/a for an empty buffer', () => {
    const rows = decodeInspector(u8(), true);
    expect(rows.length).toBeGreaterThan(25);
    expect(rows.every((r) => r.value === 'n/a')).toBe(true);
  });

  it('rows are n/a until enough bytes are available (never partial)', () => {
    const need: Record<string, number> = {
      int8: 1, uint8: 1, int16: 2, uint16: 2, int24: 3, uint24: 3, int32: 4, uint32: 4, int64: 8, uint64: 8,
      float16: 2, float32: 4, float64: 8, binary: 1, octal: 1, latin1: 1, utf8: 1, utf16: 2,
      dosdate: 2, dostime: 2, dosdatetime: 4, filetime: 8, time32: 4, time32u: 4, time64: 8,
      guidms: 16, guidrfc: 16, uleb128: 1, sleb128: 1,
    };
    // Terminated LEB128 would still need a terminator; 0x01 bytes are terminators, so use 0x01 filler.
    const filler = (n: number) => new Uint8Array(n).fill(0x01);
    for (const le of [true, false]) {
      for (const [id, n] of Object.entries(need)) {
        expect(val(decodeInspector(filler(n), le), id), `${id} with ${n} bytes`).not.toBe('n/a');
        if (n > 1) expect(val(decodeInspector(filler(n - 1), le), id), `${id} with ${n - 1} bytes`).toBe('n/a');
      }
    }
  });

  it('multi-byte integers follow the byte-order flag', () => {
    const b = u8(0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08);
    const le = decodeInspector(b, true);
    const be = decodeInspector(b, false);
    expect(val(le, 'uint16')).toBe('513');
    expect(val(be, 'uint16')).toBe('258');
    expect(val(le, 'uint32')).toBe(String(0x04030201));
    expect(val(be, 'uint32')).toBe(String(0x01020304));
    expect(val(le, 'uint64')).toBe('578437695752307201');
    expect(val(be, 'uint64')).toBe('72623859790382856');
    // single-byte rows do not depend on byte order
    expect(val(le, 'uint8')).toBe(val(be, 'uint8'));
  });

  it('reads at most the window and ignores extra bytes', () => {
    const rows = decodeInspector(new Uint8Array(100).fill(0x01), true);
    expect(val(rows, 'guidrfc')).toContain('01010101-0101-0101-0101-010101010101');
    expect(INSPECTOR_WINDOW).toBe(16);
  });

  it('group order is stable', () => {
    const groups = [...new Set(decodeInspector(u8(0), true).map((r) => r.group))];
    expect(groups).toEqual(['Integers', 'Floats', 'Bits', 'Text', 'Date / time', 'GUID', 'LEB128']);
  });
});
