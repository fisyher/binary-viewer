import { decodeDosDate, decodeDosDateTime, decodeDosTime, decodeFiletime, decodeUnixTime } from './datetime';
import { decodeGuidMicrosoft, decodeGuidRfc } from './guid';
import { decodeLeb128 } from './leb128';
import {
  decodeBinary,
  decodeFloat16,
  decodeFloat32,
  decodeFloat64,
  decodeInt,
  decodeOctal,
} from './numbers';
import { decodeLatin1, decodeUtf16, decodeUtf8 } from './text';

/** Bytes the inspector reads from the caret (enough for GUIDs, the widest decoder). */
export const INSPECTOR_WINDOW = 16;

export interface InspectorRow {
  id: string;
  group: string;
  label: string;
  /** Decoded value, or "n/a" when too few bytes are available. */
  value: string;
  /** Optional tooltip text for the row. */
  hint?: string;
}

type Decoder = (b: Uint8Array, le: boolean) => string | null;

const intRow = (bits: number, signed: boolean): Decoder => (b, le) => decodeInt(b, bits, signed, le);

const DOS_HINT = 'DOS date/time is normally stored little-endian; this row follows the LE/BE toggle.';
const HINTS: Record<string, string> = { dosdate: DOS_HINT, dostime: DOS_HINT, dosdatetime: DOS_HINT };

const SPEC: Array<[group: string, id: string, label: string, fn: Decoder]> = [
  ['Integers', 'int8', 'int8', intRow(8, true)],
  ['Integers', 'uint8', 'uint8', intRow(8, false)],
  ['Integers', 'int16', 'int16', intRow(16, true)],
  ['Integers', 'uint16', 'uint16', intRow(16, false)],
  ['Integers', 'int24', 'int24', intRow(24, true)],
  ['Integers', 'uint24', 'uint24', intRow(24, false)],
  ['Integers', 'int32', 'int32', intRow(32, true)],
  ['Integers', 'uint32', 'uint32', intRow(32, false)],
  ['Integers', 'int64', 'int64', intRow(64, true)],
  ['Integers', 'uint64', 'uint64', intRow(64, false)],
  ['Floats', 'float16', 'float16', decodeFloat16],
  ['Floats', 'float32', 'float32', decodeFloat32],
  ['Floats', 'float64', 'float64', decodeFloat64],
  ['Bits', 'binary', 'Binary (byte)', (b) => decodeBinary(b)],
  ['Bits', 'octal', 'Octal (byte)', (b) => decodeOctal(b)],
  ['Text', 'latin1', 'ASCII / Latin-1', (b) => decodeLatin1(b)],
  ['Text', 'utf8', 'UTF-8', (b) => decodeUtf8(b)],
  ['Text', 'utf16', 'UTF-16', decodeUtf16],
  ['Date / time', 'dosdate', 'DOS date', decodeDosDate],
  ['Date / time', 'dostime', 'DOS time', decodeDosTime],
  ['Date / time', 'dosdatetime', 'DOS date+time', decodeDosDateTime],
  ['Date / time', 'filetime', 'FILETIME', decodeFiletime],
  ['Date / time', 'time32', 'time_t (32, signed)', (b, le) => decodeUnixTime(b, 32, true, le)],
  ['Date / time', 'time32u', 'time_t (32, unsigned)', (b, le) => decodeUnixTime(b, 32, false, le)],
  ['Date / time', 'time64', 'time_t (64, signed)', (b, le) => decodeUnixTime(b, 64, true, le)],
  ['GUID', 'guidms', 'GUID (Microsoft)', (b) => decodeGuidMicrosoft(b)],
  ['GUID', 'guidrfc', 'GUID (RFC 4122)', (b) => decodeGuidRfc(b)],
  ['LEB128', 'uleb128', 'ULEB128', (b) => decodeLeb128(b, false)],
  ['LEB128', 'sleb128', 'SLEB128', (b) => decodeLeb128(b, true)],
];

/** Decode `bytes` (the data at the caret) into inspector rows. Never reads past `bytes`. */
export function decodeInspector(bytes: Uint8Array, littleEndian: boolean): InspectorRow[] {
  const window = bytes.length > INSPECTOR_WINDOW ? bytes.subarray(0, INSPECTOR_WINDOW) : bytes;
  return SPEC.map(([group, id, label, fn]) => ({
    group,
    id,
    label,
    value: fn(window, littleEndian) ?? 'n/a',
    ...(HINTS[id] ? { hint: HINTS[id] } : {}),
  }));
}
