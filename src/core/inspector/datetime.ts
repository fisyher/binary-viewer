import { readU16, readUint } from './bytes';

const MAX_DATE_MS = 8_640_000_000_000_000n; // ECMAScript Date range limit (+/-)
const FILETIME_EPOCH_MS = 11_644_473_600_000n; // 1601-01-01 to 1970-01-01

const p2 = (n: number) => String(n).padStart(2, '0');

function msToIso(ms: bigint): string {
  if (ms > MAX_DATE_MS || ms < -MAX_DATE_MS) return 'out of range';
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? 'out of range' : d.toISOString();
}

/** Seconds since the Unix epoch as a UTC ISO string, or "out of range". */
export function unixSecondsToIso(seconds: bigint): string {
  return msToIso(seconds * 1000n);
}

/** FILETIME ticks (100 ns since 1601-01-01 UTC) as a UTC ISO string (millisecond precision). */
export function filetimeToIso(ticks: bigint): string {
  return msToIso(ticks / 10_000n - FILETIME_EPOCH_MS); // ticks are unsigned, so / floors
}

export function decodeFiletime(bytes: Uint8Array, le: boolean): string | null {
  const v = readUint(bytes, 0, 8, le);
  return v === null ? null : filetimeToIso(v);
}

export function decodeUnixTime(bytes: Uint8Array, bits: 32 | 64, signed: boolean, le: boolean): string | null {
  const v = readUint(bytes, 0, bits / 8, le);
  if (v === null) return null;
  return unixSecondsToIso(signed ? BigInt.asIntN(bits, v) : v);
}

// ---- MS-DOS date/time ----
// Date word: bits 15-9 year since 1980, 8-5 month (1-12), 4-0 day (1-31).
// Time word: bits 15-11 hour (0-23), 10-5 minute (0-59), 4-0 seconds/2 (0-29).

/** "YYYY-MM-DD" or null when any field is out of range (including day vs. month length). */
export function dosDateToString(word: number): string | null {
  const year = 1980 + ((word >> 9) & 0x7f);
  const month = (word >> 5) & 0xf;
  const day = word & 0x1f;
  if (month < 1 || month > 12 || day < 1) return null;
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > dim) return null;
  return `${year}-${p2(month)}-${p2(day)}`;
}

/** "HH:MM:SS" or null when out of range. DOS time has 2-second resolution. */
export function dosTimeToString(word: number): string | null {
  const hour = (word >> 11) & 0x1f;
  const minute = (word >> 5) & 0x3f;
  const sec2 = word & 0x1f;
  if (hour > 23 || minute > 59 || sec2 > 29) return null;
  return `${p2(hour)}:${p2(minute)}:${p2(sec2 * 2)}`;
}

export function decodeDosDate(bytes: Uint8Array, le: boolean): string | null {
  const w = readU16(bytes, 0, le);
  return w === null ? null : (dosDateToString(w) ?? 'invalid');
}

export function decodeDosTime(bytes: Uint8Array, le: boolean): string | null {
  const w = readU16(bytes, 0, le);
  return w === null ? null : (dosTimeToString(w) ?? 'invalid');
}

/** Time word followed by date word, as stored in FAT directory entries and ZIP headers. */
export function decodeDosDateTime(bytes: Uint8Array, le: boolean): string | null {
  const t = readU16(bytes, 0, le);
  const d = readU16(bytes, 2, le);
  if (t === null || d === null) return null;
  const ds = dosDateToString(d);
  const ts = dosTimeToString(t);
  return ds && ts ? `${ds} ${ts}` : 'invalid';
}
