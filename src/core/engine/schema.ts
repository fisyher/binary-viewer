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
 * `if` / `ifMagic` / `repeat` / `size` / `at` / `find` on a field also count as "progress" for recursive types: a type
 * may contain itself through a field that has any of them (the interpreter's depth, step and (type, offset) cycle
 * limits are the safety net).
 *
 * Positioning: `at` (absolute offset) or `find` (bounded signature search) place a field without moving the parent
 * cursor; they are mutually exclusive. Every struct scope exposes `_start`, the absolute offset where it begins.
 */

/** Byte order. Always explicit; see the conventions above. */
export type Endian = 'le' | 'be';
export type Encoding = 'ascii' | 'latin1' | 'cp437' | 'utf8' | 'utf16le' | 'utf16be';
/** All values accepted by `FieldDef.encoding`. */
export const ENCODINGS: readonly Encoding[] = ['ascii', 'latin1', 'cp437', 'utf8', 'utf16le', 'utf16be'];

/** Largest `find.window` the validator accepts and the interpreter's default `maxFindWindow` (1 MiB). */
export const MAX_FIND_WINDOW = 1 << 20;
/** Most hex bytes in a `detect`, `find` or `ifMagic` signature. */
export const MAX_SIGNATURE_BYTES = 64;

/** A number literal or an expression string. */
export type ExprSource = number | string;

/** A content-sniffing rule: a spec is a candidate for a file when its rules match (see detect.ts). */
export interface DetectRule {
  /** Offset of the magic; negative means relative to the end of the file. */
  at: number;
  /** Hex bytes, whitespace allowed: "42 4D". */
  bytes: string;
  /** Optional hex mask, same length as `bytes`; only masked bits are compared. */
  mask?: string;
}

/** Bounded signature search used instead of `at` to place a field. */
export interface FindDef {
  /** Hex bytes, whitespace allowed. */
  bytes: string;
  /** Optional hex mask, same length as `bytes`. */
  mask?: string;
  /** Expression for the absolute offset the window is measured from (a safe non-negative integer). */
  from: ExprSource;
  /** Window size in bytes (a literal, 1..MAX_FIND_WINDOW). */
  window: number;
  /** `backward`: the window is [from - window, from); `forward`: [from, from + window). */
  direction: 'backward' | 'forward';
  /**
   * Tiers of acceptance expressions, tried in order. Each candidate (nearest to `from` first) is probe-parsed as the
   * field's own type; the first candidate a tier accepts wins. Without `accept` the nearest candidate wins.
   */
  accept?: string[];
}

/** Guard: the field is only parsed when these bytes are at `at` (a quiet no when out of range). */
export interface IfMagicDef {
  at: ExprSource;
  bytes: string;
  mask?: string;
}

/** A deferred pointer: the target type is only parsed when the user opens it. */
export interface RefDef {
  type: string;
  at: ExprSource;
  doc?: string;
  /** Shortcut buttons on the ref node: each opens the ref (if needed) and selects the node at `path` inside the target. */
  jumps?: RefJump[];
}

/** A shortcut button on a `ref`: `path` is a dotted chain of child field names inside the target type (e.g. `data`, `header.extra`). */
export interface RefJump {
  label: string;
  path: string;
}

/**
 * A navigation link on a field: nothing is parsed. `at` (and `size`) are evaluated in the field's scope (`_` is its
 * value); a valid target becomes a "go to" button on the node that selects those bytes in the hex view.
 */
export interface LinkDef {
  /** Absolute file offset of the target (a safe integer inside the file: 0..size-1; at or past the end gives no link). */
  at: ExprSource;
  /** Bytes to select (clamped to the end of the file). Absent or null: just the byte at `at`. */
  size?: ExprSource;
  label?: string;
}

/** Choose the field's type from data already parsed in the same struct. */
export interface SwitchType {
  /** Expression evaluated in the struct scope; its value is compared with each case key. */
  switch: string;
  /** Case key (an expression, normally a literal) -> type name (builtin or user type). */
  cases: Record<string, string>;
  default?: string;
}

export type TypeRef = string | SwitchType;

/** `eos`: until the end of the enclosing substream; `count`: n elements; `until`: stop after the element for which the expression is true. Runtime step limits bound all three. */
export type RepeatDef = 'eos' | { count: ExprSource } | { until: string };

/** A named slice of an integer field; see the `bits` convention above (bit 0 = least significant). */
export interface BitField {
  name: string;
  /** First bit of the slice, counted up from bit 0. */
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
  /** Unique within its type; also the identifier expressions use to read this field's value. */
  name: string;
  type: TypeRef;
  /** Substream size in bytes (number | expression | "eos"). For `bytes`/`str` it is the length. */
  size?: ExprSource | 'eos';
  /** `str` only: terminator code unit (0 for NUL). */
  terminator?: number;
  encoding?: Encoding;
  /** Absolute file offset; the parent cursor is not advanced. */
  at?: ExprSource;
  /** Alternative to `at`: search for a signature. */
  find?: FindDef;
  /** Expression; when it is false the field is skipped (and reads as `null` in later expressions). */
  if?: string;
  ifMagic?: IfMagicDef;
  /** Only with type `value`: a computed (zero-byte) field. */
  value?: string;
  ref?: RefDef;
  link?: LinkDef;
  /** With `expect`: a mismatch fails the field (stops the struct / ends the array) instead of only recording a message. */
  fatal?: boolean;
  repeat?: RepeatDef;
  /** Name of an entry in `FormatSpec.enums`; only on plain integer types. */
  enum?: string;
  bits?: BitField[];
  /** Expected value; a mismatch is a validation error on the node, parsing continues. */
  expect?: number | string;
  doc?: string;
  assert?: AssertDef[];
}

/** A named struct: fields are parsed in order, each advancing the cursor unless it has `at`/`find`. */
export interface TypeDef {
  doc?: string;
  fields: FieldDef[];
}

/**
 * A format description. Instances reaching the engine have passed `validateSpec`; constructing one by hand skips
 * those guarantees. Specs are plain JSON data and are never executed.
 */
export interface FormatSpec {
  schemaVersion: 1;
  /** Stable identifier (`[A-Za-z0-9_-]`, up to 64 chars) used to refer to the spec. */
  id: string;
  name: string;
  /** Default byte order for multi-byte types without a le/be suffix. */
  endian?: Endian;
  /** Lowercase file extensions without the dot. */
  extensions?: string[];
  detect?: DetectRule[];
  doc?: string;
  /** Name of the type parsed at offset 0. */
  root: string;
  types: Record<string, TypeDef>;
  /** enum name -> (integer key as decimal or 0x hex text -> label). Keys are text so 64-bit values survive JSON. */
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

/** True for `str`, `bytes`, `value` and the primitives; user types may not use these names. */
export function isBuiltinType(name: string): boolean {
  return name === 'str' || name === 'bytes' || name === 'value' || primitiveInfo(name) !== null;
}

/** True when the type is multi-byte and has no explicit suffix, i.e. it needs the spec's `endian`. */
export function needsSpecEndian(info: PrimitiveInfo): boolean {
  return info.size > 1 && info.endian === null;
}

/** Own-property lookup (never reaches the prototype chain): safe for keys taken from untrusted specs/files. */
export function ownGet<T>(obj: Record<string, T> | undefined, key: string): T | undefined {
  return obj !== undefined && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** Parse "42 4D" style hex (whitespace ignored); null when empty, odd-length, non-hex, or longer than `maxBytes` (default 65536). */
export function parseHexBytes(text: string, maxBytes = 1 << 16): Uint8Array | null {
  const clean = text.replace(/\s+/g, '');
  if (clean.length === 0 || clean.length % 2 !== 0 || clean.length / 2 > maxBytes) return null;
  if (!/^[0-9a-fA-F]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Parse an enum key: decimal or 0x hex, optional leading minus; BigInt so 64-bit values are exact. Null when malformed or over 80 chars. */
export function parseEnumKey(key: string): bigint | null {
  if (!/^-?(0x[0-9a-fA-F]+|[0-9]+)$/.test(key) || key.length > 80) return null;
  const neg = key.startsWith('-');
  const v = BigInt(neg ? key.slice(1) : key);
  return neg ? -v : v;
}
