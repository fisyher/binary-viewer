/**
 * Format spec schema (JSON). Concepts are borrowed from Kaitai Struct but the format is our own.
 *
 * Conventions:
 * - Integer byte order is always explicit: a `le`/`be` suffix on the type (`u4be`) or the spec-level
 *   `endian`. The host byte order is never used.
 * - `bits`: bit 0 is the least significant bit of the integer value AFTER endian conversion (and, for
 *   signed types, of the two's-complement representation). `offset` counts up from bit 0.
 * - `at` is an ABSOLUTE file offset (not relative to the enclosing substream) but must lie inside the
 *   enclosing substream.
 * - Expression strings use the language in `expr.ts`.
 *
 * EXPRESSION PRECEDENCE (lowest to highest) follows Python/Rust, NOT C: bitwise operators bind TIGHTER than
 * comparison, so `flags & 4 == 4` means `(flags & 4) == 4`. Order: `?:`, `||`/`or`, `&&`/`and`, `==` `!=`,
 * `<` `<=` `>` `>=`, `|`, `^`, `&`, `<<` `>>`, `+` `-`, `*` `/` `%`, unary `-` `~` `!`/`not`. When in doubt,
 * use parentheses. `&&`, `||` and `?:` short-circuit. Skipped/failed fields read as `null` (see expr.ts).
 *
 * `if` / `repeat` / `size` / `at` on a field also count as "progress" for recursive types: a type may contain
 * itself through a field that has any of them (the interpreter's depth, step and (type, offset) cycle limits
 * are the safety net).
 */

export type Endian = 'le' | 'be';
export type Encoding = 'ascii' | 'latin1' | 'utf8' | 'utf16le' | 'utf16be';
export const ENCODINGS: readonly Encoding[] = ['ascii', 'latin1', 'utf8', 'utf16le', 'utf16be'];

/** A number literal or an expression string. */
export type ExprSource = number | string;

export interface DetectRule {
  /** Offset of the magic; negative means relative to the end of the file. */
  at: number;
  /** Hex bytes, whitespace allowed: "42 4D". */
  bytes: string;
  /** Optional hex mask, same length as `bytes`; only masked bits are compared. */
  mask?: string;
}

export interface SwitchType {
  switch: string;
  /** Case key (an expression, normally a literal) -> type name (builtin or user type). */
  cases: Record<string, string>;
  default?: string;
}

export type TypeRef = string | SwitchType;

export type RepeatDef = 'eos' | { count: ExprSource } | { until: string };

export interface BitField {
  name: string;
  offset: number;
  width: number;
  doc?: string;
}

export interface AssertDef {
  /** Boolean expression evaluated after the field is parsed; `_` is the field's value. */
  expr: string;
  /** Default "error". Asserts only record a validation message on the node; they never stop parsing. */
  level?: 'warning' | 'error';
  message?: string;
}

export interface FieldDef {
  name: string;
  type: TypeRef;
  /** Substream size (number | expression | "eos"). For `bytes`/`str` it is the length. */
  size?: ExprSource | 'eos';
  /** `str` only: terminator code unit (0 for NUL). */
  terminator?: number;
  encoding?: Encoding;
  /** Absolute file offset; the parent cursor is not advanced. */
  at?: ExprSource;
  if?: string;
  repeat?: RepeatDef;
  enum?: string;
  bits?: BitField[];
  /** Expected value; a mismatch is a validation error on the node, parsing continues. */
  expect?: number | string;
  doc?: string;
  assert?: AssertDef[];
}

export interface TypeDef {
  doc?: string;
  fields: FieldDef[];
}

export interface FormatSpec {
  schemaVersion: 1;
  id: string;
  name: string;
  /** Default byte order for multi-byte types without a le/be suffix. */
  endian?: Endian;
  extensions?: string[];
  detect?: DetectRule[];
  doc?: string;
  root: string;
  types: Record<string, TypeDef>;
  enums?: Record<string, Record<string, string>>;
}

export type PrimitiveInfo =
  | { kind: 'int'; size: 1 | 2 | 4 | 8; signed: boolean; endian: Endian | null }
  | { kind: 'float'; size: 4 | 8; signed: true; endian: Endian | null };

const PRIM_RE = /^([usf])([1248])(le|be)?$/;

/** Parse a primitive type name like `u4`, `s2be`, `f8le`; null if it is not one. */
export function primitiveInfo(name: string): PrimitiveInfo | null {
  const m = PRIM_RE.exec(name);
  if (!m) return null;
  const size = Number(m[2]) as 1 | 2 | 4 | 8;
  const endian = (m[3] as Endian | undefined) ?? null;
  if (m[1] === 'f') {
    if (size !== 4 && size !== 8) return null;
    return { kind: 'float', size, signed: true, endian };
  }
  return { kind: 'int', size, signed: m[1] === 's', endian };
}

export function isBuiltinType(name: string): boolean {
  return name === 'str' || name === 'bytes' || primitiveInfo(name) !== null;
}

/** True when the type is multi-byte and has no explicit suffix, i.e. it needs the spec's `endian`. */
export function needsSpecEndian(info: PrimitiveInfo): boolean {
  return info.size > 1 && info.endian === null;
}

export function ownGet<T>(obj: Record<string, T> | undefined, key: string): T | undefined {
  return obj !== undefined && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** Parse "42 4D" style hex; null when malformed. */
export function parseHexBytes(text: string, maxBytes = 1 << 16): Uint8Array | null {
  const clean = text.replace(/\s+/g, '');
  if (clean.length === 0 || clean.length % 2 !== 0 || clean.length / 2 > maxBytes) return null;
  if (!/^[0-9a-fA-F]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Parse an enum key: decimal or 0x hex, optional leading minus. Null when malformed. */
export function parseEnumKey(key: string): bigint | null {
  if (!/^-?(0x[0-9a-fA-F]+|[0-9]+)$/.test(key) || key.length > 80) return null;
  const neg = key.startsWith('-');
  const v = BigInt(neg ? key.slice(1) : key);
  return neg ? -v : v;
}
