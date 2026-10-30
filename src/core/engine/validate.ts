/**
 * Hand-written validator for format specs. Specs are untrusted input: every key is checked, nothing is
 * assumed about shape, sizes are capped, and errors carry a JSON-path ("$.types.file.fields[2].size").
 */
import type { Expr } from './expr';
import { DEFAULT_EXPR_LIMITS, freeNames, parseExpr } from './expr';
import type { BitField, Encoding, FormatSpec, RepeatDef } from './schema';
import { ENCODINGS, MAX_FIND_WINDOW, MAX_SIGNATURE_BYTES, isBuiltinType, needsSpecEndian, parseEnumKey, parseHexBytes, primitiveInfo } from './schema';

export interface SpecLimits {
  maxSpecBytes: number;
  maxTypes: number;
  maxFieldsPerType: number;
  maxTotalFields: number;
  /** Longest chain of unconditionally nested types (cycles through `at`/`size` fields are exempt). */
  maxTypeNesting: number;
  maxExprLength: number;
  maxExprDepth: number;
  maxCases: number;
  maxEnumEntries: number;
  maxDocLength: number;
  maxBitFields: number;
  /** Largest literal `find.window`. */
  maxFindWindow: number;
}

export const DEFAULT_SPEC_LIMITS: SpecLimits = {
  maxSpecBytes: 1_048_576,
  maxTypes: 512,
  maxFieldsPerType: 1024,
  maxTotalFields: 20_000,
  maxTypeNesting: 32,
  maxExprLength: DEFAULT_EXPR_LIMITS.maxLength,
  maxExprDepth: DEFAULT_EXPR_LIMITS.maxDepth,
  maxCases: 256,
  maxEnumEntries: 4096,
  maxDocLength: 20_000,
  maxBitFields: 64,
  maxFindWindow: MAX_FIND_WINDOW,
};

export interface SpecIssue {
  /** JSON path, e.g. `$.types.file.fields[2].size`. */
  path: string;
  message: string;
}

export type ValidationResult = { ok: true; spec: FormatSpec } | { ok: false; errors: SpecIssue[] };

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const EXT_RE = /^[a-z0-9_+-]{1,16}$/;
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const TOP_KEYS = new Set(['schemaVersion', 'id', 'name', 'endian', 'extensions', 'detect', 'doc', 'root', 'types', 'enums']);
const TYPE_KEYS = new Set(['doc', 'fields']);
const FIELD_KEYS = new Set(['name', 'type', 'size', 'terminator', 'encoding', 'at', 'find', 'if', 'ifMagic', 'repeat', 'enum', 'bits', 'expect', 'fatal', 'value', 'ref', 'link', 'doc', 'assert']);
const FIND_KEYS = new Set(['bytes', 'mask', 'from', 'window', 'direction', 'accept']);
const IFMAGIC_KEYS = new Set(['at', 'bytes', 'mask']);
const REF_KEYS = new Set(['type', 'at', 'doc', 'jumps']);
const JUMP_KEYS = new Set(['label', 'path']);
const LINK_KEYS = new Set(['at', 'size', 'label']);
const MAX_JUMPS = 8;
const MAX_JUMP_DEPTH = 8;
const MAX_ACCEPT_TIERS = 8;
const MAX_EXTENSIONS = 64;
const ASSERT_KEYS = new Set(['expr', 'level', 'message']);
const RESERVED_WORDS = new Set(['and', 'or', 'not', 'null', 'true', 'false', 'min', 'max', 'lookup']);
const SWITCH_KEYS = new Set(['switch', 'cases', 'default']);
const DETECT_KEYS = new Set(['at', 'bytes', 'mask']);
const BIT_KEYS = new Set(['name', 'offset', 'width', 'doc']);
const RESERVED_EXPR_NAMES = new Set(['_parent', '_root', '_index', '_', '_io', '_start']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class Ctx {
  readonly errors: SpecIssue[] = [];
  /** Raw `types` object and the fields of the type being validated, for static member-path checks. */
  typesRaw: Record<string, unknown> | null = null;
  curFields: Map<string, Record<string, unknown>> | null = null;
  constructor(readonly lim: SpecLimits) {}
  err(path: string, message: string): void {
    if (this.errors.length < 200) this.errors.push({ path, message });
  }
}

function checkKeys(c: Ctx, obj: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) c.err(`${path}.${k}`, `unknown key "${k}"`);
}

function checkString(c: Ctx, v: unknown, path: string, max: number): v is string {
  if (typeof v !== 'string') {
    c.err(path, 'must be a string');
    return false;
  }
  if (v.length > max) {
    c.err(path, `too long (${v.length} > ${max} characters)`);
    return false;
  }
  return true;
}

function optDoc(c: Ctx, obj: Record<string, unknown>, path: string): void {
  if ('doc' in obj) checkString(c, obj.doc, `${path}.doc`, c.lim.maxDocLength);
}

/** Validate an expression's syntax and (given the owning type's field names) its root identifiers. */
function checkExpr(c: Ctx, src: unknown, path: string, fieldNames: Set<string> | null): void {
  if (typeof src !== 'string') {
    c.err(path, 'must be an expression string');
    return;
  }
  const r = parseExpr(src, { maxLength: c.lim.maxExprLength, maxDepth: c.lim.maxExprDepth });
  if (!r.ok) {
    c.err(path, `bad expression: ${r.error}`);
    return;
  }
  if (fieldNames) {
    for (const n of freeNames(r.ast)) {
      if (!fieldNames.has(n) && !RESERVED_EXPR_NAMES.has(n)) c.err(path, `expression refers to unknown name "${n}" (not a field of this type)`);
    }
    checkMemberPaths(c, r.ast, path);
  }
}

type StaticType = { any: true } | { types: string[] };

/** Static type(s) a field's value can have, for member checking. `any` = do not check further. */
function staticTypeOf(c: Ctx, field: Record<string, unknown>): StaticType {
  if (field.repeat !== undefined) return { any: true };
  const names: string[] = [];
  const t = field.type;
  if (typeof t === 'string') names.push(t);
  else if (isRecord(t)) {
    if (isRecord(t.cases)) for (const v of Object.values(t.cases)) if (typeof v === 'string') names.push(v);
    if (typeof t.default === 'string') names.push(t.default);
  } else return { any: true };
  if (names.length === 0) return { any: true };
  // builtins (bytes, str, numbers) read any member as null at runtime, so any such case makes every member plausible
  const user = names.filter((n) => !isBuiltinType(n) && c.typesRaw !== null && Object.hasOwn(c.typesRaw, n));
  if (user.length !== names.length) return { any: true };
  return { types: [...new Set(user)] };
}

function fieldsOfType(c: Ctx, typeName: string): Map<string, Record<string, unknown>> | null {
  const def = c.typesRaw && Object.hasOwn(c.typesRaw, typeName) ? c.typesRaw[typeName] : undefined;
  if (!isRecord(def) || !Array.isArray(def.fields)) return null;
  const m = new Map<string, Record<string, unknown>>();
  for (const f of def.fields) if (isRecord(f) && typeof f.name === 'string') m.set(f.name, f);
  return m;
}

/** Check `field.m1.m2...` chains against the declared types, only while the type is statically known. */
function checkMemberPaths(c: Ctx, ast: Expr, path: string): void {
  if (!c.curFields) return;
  const chain = (e: Expr): string[] | null => {
    if (e.k === 'name') return [e.name];
    if (e.k === 'member') {
      const inner = chain(e.obj);
      return inner ? [...inner, e.name] : null;
    }
    return null;
  };
  const visit = (e: Expr): void => {
    switch (e.k) {
      case 'member': {
        const parts = chain(e);
        if (parts) return checkChain(parts);
        visit(e.obj);
        return;
      }
      case 'unary':
        return visit(e.arg);
      case 'bin':
        visit(e.l);
        visit(e.r);
        return;
      case 'cond':
        visit(e.c);
        visit(e.a);
        visit(e.b);
        return;
      case 'call':
        e.args.forEach(visit);
        return;
      default:
        return;
    }
  };
  const checkChain = (parts: string[]): void => {
    const root = parts[0]!;
    if (RESERVED_EXPR_NAMES.has(root)) return;
    const field = c.curFields!.get(root);
    if (!field) return;
    let st = staticTypeOf(c, field);
    for (let i = 1; i < parts.length; i++) {
      if ('any' in st) return;
      const m = parts[i]!;
      if (m === '_start') return; // every struct exposes its start offset
      const maps = st.types.map((t) => ({ t, fields: fieldsOfType(c, t) }));
      if (maps.some((x) => x.fields === null)) return;
      const having = maps.filter((x) => x.fields!.has(m));
      if (having.length === 0) {
        c.err(path, `unknown member "${m}" of type "${st.types.join('" or "')}"`);
        return;
      }
      if (st.types.length !== 1) return; // not statically unique: stop here
      st = staticTypeOf(c, having[0]!.fields!.get(m)!);
    }
  };
  visit(ast);
}

function checkExprOrInt(c: Ctx, v: unknown, path: string, names: Set<string> | null): void {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) c.err(path, 'number must be a non-negative integer');
  } else checkExpr(c, v, path, names);
}

function checkTypeName(c: Ctx, name: unknown, path: string, specEndian: boolean, typeNames: Set<string>, allowValue = false): void {
  if (typeof name !== 'string') {
    c.err(path, 'must be a type name string');
    return;
  }
  if (name === 'value') {
    if (!allowValue) c.err(path, '"value" is only valid as the type of a field, not inside a switch');
    return;
  }
  const prim = primitiveInfo(name);
  if (prim) {
    if (needsSpecEndian(prim) && !specEndian) {
      c.err(path, `type "${name}" is multi-byte but the spec declares no "endian"; add "endian": "le"|"be" or use an explicit suffix (e.g. "${name}le")`);
    }
    return;
  }
  if (name === 'str' || name === 'bytes') return;
  if (!typeNames.has(name)) c.err(path, `unknown type "${name}"`);
}

export function validateSpec(input: unknown, limits: Partial<SpecLimits> = {}): ValidationResult {
  const lim = { ...DEFAULT_SPEC_LIMITS, ...limits };
  const c = new Ctx(lim);
  if (!isRecord(input)) return { ok: false, errors: [{ path: '$', message: 'spec must be a JSON object' }] };
  checkKeys(c, input, TOP_KEYS, '$');

  if (input.schemaVersion !== 1) c.err('$.schemaVersion', 'must be 1');
  if (typeof input.id !== 'string' || !ID_RE.test(input.id)) c.err('$.id', 'must be a short identifier ([A-Za-z0-9_-], up to 64 chars)');
  if (checkString(c, input.name, '$.name', 200) && input.name.length === 0) c.err('$.name', 'must not be empty');
  if ('endian' in input && input.endian !== 'le' && input.endian !== 'be') c.err('$.endian', 'must be "le" or "be"');
  const specEndian = input.endian === 'le' || input.endian === 'be';
  optDoc(c, input, '$');

  if ('extensions' in input) {
    if (!Array.isArray(input.extensions) || input.extensions.length > MAX_EXTENSIONS) c.err('$.extensions', `must be an array of at most ${MAX_EXTENSIONS} strings`);
    else
      input.extensions.forEach((e, i) => {
        if (typeof e !== 'string' || !EXT_RE.test(e)) c.err(`$.extensions[${i}]`, 'must be a lowercase extension without a dot');
      });
  }

  if ('detect' in input) {
    if (!Array.isArray(input.detect) || input.detect.length > 16) c.err('$.detect', 'must be an array of at most 16 rules');
    else
      input.detect.forEach((r: unknown, i) => {
        const p = `$.detect[${i}]`;
        if (!isRecord(r)) return c.err(p, 'must be an object');
        checkKeys(c, r, DETECT_KEYS, p);
        if (typeof r.at !== 'number' || !Number.isSafeInteger(r.at)) c.err(`${p}.at`, 'must be an integer (negative = from end of file)');
        const bytes = typeof r.bytes === 'string' ? parseHexBytes(r.bytes, 64) : null;
        if (!bytes) c.err(`${p}.bytes`, 'must be 1-64 hex bytes, e.g. "42 4D"');
        if ('mask' in r) {
          const m = typeof r.mask === 'string' ? parseHexBytes(r.mask, 64) : null;
          if (!m) c.err(`${p}.mask`, 'must be hex bytes');
          else if (bytes && m.length !== bytes.length) c.err(`${p}.mask`, 'must have the same length as "bytes"');
          else if (m.every((b) => b === 0)) c.err(`${p}.mask`, 'must not be all zero (it would match every file)');
        }
      });
  }

  // enums
  const enumNames = new Set<string>();
  if ('enums' in input) {
    if (!isRecord(input.enums)) c.err('$.enums', 'must be an object');
    else
      for (const [en, vals] of Object.entries(input.enums)) {
        const p = `$.enums.${en}`;
        if (!NAME_RE.test(en) || FORBIDDEN_NAMES.has(en)) c.err(p, 'invalid enum name');
        enumNames.add(en);
        if (!isRecord(vals)) {
          c.err(p, 'must be an object mapping integer -> label');
          continue;
        }
        const keys = Object.keys(vals);
        if (keys.length > lim.maxEnumEntries) c.err(p, `too many entries (max ${lim.maxEnumEntries})`);
        for (const k of keys.slice(0, lim.maxEnumEntries)) {
          if (parseEnumKey(k) === null) c.err(`${p}.${k}`, 'key must be an integer (decimal or 0x hex)');
          checkString(c, vals[k], `${p}.${k}`, 200);
        }
      }
  }

  // types
  const typeNames = new Set<string>();
  const types = isRecord(input.types) ? input.types : null;
  if (!types) c.err('$.types', 'must be an object');
  else {
    const names = Object.keys(types);
    if (names.length > lim.maxTypes) c.err('$.types', `too many types (${names.length} > ${lim.maxTypes})`);
    if (names.length === 0) c.err('$.types', 'must define at least one type');
    for (const n of names) {
      if (!NAME_RE.test(n) || FORBIDDEN_NAMES.has(n)) c.err(`$.types.${n}`, 'invalid type name (letters, digits, underscore; must start with a letter)');
      else if (isBuiltinType(n)) c.err(`$.types.${n}`, 'name clashes with a builtin type');
      typeNames.add(n);
    }
  }
  if (typeof input.root !== 'string') c.err('$.root', 'must be a type name');
  else if (!typeNames.has(input.root)) c.err('$.root', `root type "${input.root}" is not defined in "types"`);

  const edges = new Map<string, Array<{ to: string; guarded: boolean; path: string }>>();
  let totalFields = 0;
  if (types && typeNames.size <= lim.maxTypes) {
    for (const [tn, tdef] of Object.entries(types)) {
      const tp = `$.types.${tn}`;
      const out: Array<{ to: string; guarded: boolean; path: string }> = [];
      edges.set(tn, out);
      if (!isRecord(tdef)) {
        c.err(tp, 'must be an object with "fields"');
        continue;
      }
      checkKeys(c, tdef, TYPE_KEYS, tp);
      optDoc(c, tdef, tp);
      if (!Array.isArray(tdef.fields)) {
        c.err(`${tp}.fields`, 'must be an array');
        continue;
      }
      if (tdef.fields.length > lim.maxFieldsPerType) {
        c.err(`${tp}.fields`, `too many fields (max ${lim.maxFieldsPerType})`);
        continue;
      }
      totalFields += tdef.fields.length;
      if (totalFields > lim.maxTotalFields) {
        c.err('$.types', `too many fields in total (max ${lim.maxTotalFields})`);
        break;
      }
      const fieldNames = new Set<string>();
      const fieldMap = new Map<string, Record<string, unknown>>();
      for (const f of tdef.fields) {
        if (isRecord(f) && typeof f.name === 'string') {
          fieldNames.add(f.name);
          fieldMap.set(f.name, f);
        }
      }
      c.typesRaw = types;
      c.curFields = fieldMap;
      const seen = new Set<string>();
      tdef.fields.forEach((f: unknown, i: number) => {
        validateField(c, f, `${tp}.fields[${i}]`, { input, specEndian, typeNames, enumNames, fieldNames, seen, out });
      });
    }
  }

  if (c.errors.length === 0) checkTypeGraph(c, edges, typeof input.root === 'string' ? input.root : undefined);

  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  return { ok: true, spec: input as unknown as FormatSpec };
}

interface FieldCtx {
  input: Record<string, unknown>;
  specEndian: boolean;
  typeNames: Set<string>;
  enumNames: Set<string>;
  fieldNames: Set<string>;
  seen: Set<string>;
  out: Array<{ to: string; guarded: boolean; path: string }>;
}

function validateField(c: Ctx, f: unknown, p: string, x: FieldCtx): void {
  if (!isRecord(f)) return c.err(p, 'must be an object');
  checkKeys(c, f, FIELD_KEYS, p);
  if (typeof f.name !== 'string' || !NAME_RE.test(f.name) || FORBIDDEN_NAMES.has(f.name) || RESERVED_WORDS.has(f.name)) {
    c.err(`${p}.name`, 'invalid field name (letters, digits, underscore; must start with a letter; and/or/not/null/true/false/min/max are reserved)');
  } else if (x.seen.has(f.name)) c.err(`${p}.name`, `duplicate field name "${f.name}"`);
  else x.seen.add(f.name);
  optDoc(c, f, p);

  // resolve the set of concrete type names this field may take
  const concrete: string[] = [];
  const t = f.type;
  if (typeof t === 'string') {
    checkTypeName(c, t, `${p}.type`, x.specEndian, x.typeNames, true);
    concrete.push(t);
  } else if (isRecord(t)) {
    checkKeys(c, t, SWITCH_KEYS, `${p}.type`);
    checkExpr(c, t.switch, `${p}.type.switch`, x.fieldNames);
    if (!isRecord(t.cases)) c.err(`${p}.type.cases`, 'must be an object mapping case value -> type name');
    else {
      const keys = Object.keys(t.cases);
      if (keys.length === 0) c.err(`${p}.type.cases`, 'must have at least one case');
      if (keys.length > c.lim.maxCases) c.err(`${p}.type.cases`, `too many cases (max ${c.lim.maxCases})`);
      for (const k of keys.slice(0, c.lim.maxCases)) {
        checkExpr(c, k, `${p}.type.cases.${k}`, x.fieldNames);
        checkTypeName(c, t.cases[k], `${p}.type.cases.${k}`, x.specEndian, x.typeNames);
        if (typeof t.cases[k] === 'string') concrete.push(t.cases[k] as string);
      }
    }
    if ('default' in t) {
      checkTypeName(c, t.default, `${p}.type.default`, x.specEndian, x.typeNames);
      if (typeof t.default === 'string') concrete.push(t.default);
    }
  } else c.err(`${p}.type`, 'must be a type name or a {"switch", "cases"} object');

  const isSwitch = isRecord(t);
  const hasSize = f.size !== undefined && f.size !== 'eos';
  const guarded = hasSize || f.at !== undefined || f.find !== undefined || f.if !== undefined || f.ifMagic !== undefined || f.repeat !== undefined;
  for (const ct of concrete) if (x.typeNames.has(ct)) x.out.push({ to: ct, guarded, path: `${p}.type` });

  const prims = concrete.map((n) => primitiveInfo(n));
  const allInt = !isSwitch && prims.length === 1 && prims[0]?.kind === 'int';
  const allNumeric = !isSwitch && prims.length === 1 && prims[0] !== null;
  const single = typeof t === 'string' ? t : '';
  const anyUser = concrete.some((n) => x.typeNames.has(n));
  const anyStrOrBytes = concrete.some((n) => n === 'str' || n === 'bytes');
  const anyBytes = concrete.some((n) => n === 'bytes');
  const anyStr = concrete.some((n) => n === 'str');
  const anyPrim = prims.some((q) => q !== null);

  const isValue = single === 'value';
  if (isValue && 'size' in f) c.err(`${p}.size`, '"value" fields take no bytes; remove "size"');
  else if ('size' in f && 'repeat' in f) {
    c.err(`${p}.size`, '"size" together with "repeat" is not supported (the size would be ignored); put the sized element in its own type and repeat that');
  }
  if ('size' in f) {
    if (isValue) {
      /* reported above */
    } else if (f.size === 'eos') {
      /* ok for bytes/str/user types */
    } else checkExprOrInt(c, f.size, `${p}.size`, x.fieldNames);
    if (anyPrim && !anyStrOrBytes && !anyUser) c.err(`${p}.size`, 'primitive numeric types have a fixed size; remove "size"');
  } else if (!isValue) {
    if (anyBytes) c.err(`${p}.size`, '"bytes" needs "size" (a number, an expression, or "eos")');
    if (anyStr && !('terminator' in f)) c.err(`${p}.size`, '"str" needs "size" or "terminator"');
  }

  if ('terminator' in f) {
    if (!anyStr) c.err(`${p}.terminator`, '"terminator" is only valid for "str"');
    if (typeof f.terminator !== 'number' || !Number.isInteger(f.terminator) || f.terminator < 0 || f.terminator > 0xffff) {
      c.err(`${p}.terminator`, 'must be an integer 0..65535');
    }
  }
  if ('encoding' in f) {
    if (!anyStr) c.err(`${p}.encoding`, '"encoding" is only valid for "str"');
    if (!ENCODINGS.includes(f.encoding as Encoding)) c.err(`${p}.encoding`, `must be one of ${ENCODINGS.join(', ')}`);
  }
  if ('terminator' in f && typeof f.terminator === 'number' && f.terminator > 255) {
    const enc = f.encoding ?? 'utf8';
    if (enc !== 'utf16le' && enc !== 'utf16be') c.err(`${p}.terminator`, `terminator ${f.terminator} does not fit a single-byte encoding (${String(enc)}); use 0..255 or a utf16 encoding`);
  }
  if ('assert' in f) {
    if (!Array.isArray(f.assert) || f.assert.length === 0 || f.assert.length > 16) c.err(`${p}.assert`, 'must be an array of 1-16 {expr, level?, message?}');
    else
      (f.assert as unknown[]).forEach((a, i) => {
        const ap = `${p}.assert[${i}]`;
        if (!isRecord(a)) return c.err(ap, 'must be an object');
        checkKeys(c, a, ASSERT_KEYS, ap);
        checkExpr(c, a.expr, `${ap}.expr`, x.fieldNames);
        if ('level' in a && a.level !== 'warning' && a.level !== 'error') c.err(`${ap}.level`, 'must be "warning" or "error"');
        if ('message' in a) checkString(c, a.message, `${ap}.message`, 500);
      });
  }
  if ('at' in f) checkExprOrInt(c, f.at, `${p}.at`, x.fieldNames);
  if ('if' in f) checkExpr(c, f.if, `${p}.if`, x.fieldNames);
  if ('find' in f) {
    if ('at' in f) c.err(`${p}.find`, '"find" and "at" both place the field; use only one');
    if ('repeat' in f) c.err(`${p}.find`, '"find" cannot be combined with "repeat"');
    if (isValue) c.err(`${p}.find`, '"value" fields are not placed; remove "find"');
    validateFind(c, f.find, `${p}.find`, x, !isSwitch && typeof t === 'string' && x.typeNames.has(t) ? t : null);
  }
  if ('ifMagic' in f) validateIfMagic(c, f.ifMagic, `${p}.ifMagic`, x);
  if (isValue) {
    if ('at' in f) c.err(`${p}.at`, '"value" fields are not placed; remove "at"');
    if ('repeat' in f) c.err(`${p}.repeat`, '"value" fields cannot repeat');
    for (const k of ['terminator', 'encoding', 'enum', 'bits', 'expect', 'fatal'] as const) if (k in f) c.err(`${p}.${k}`, `"${k}" does not apply to a "value" field`);
    if (typeof f.value !== 'string') c.err(`${p}.value`, 'a "value" field needs "value": an expression string');
    else checkExpr(c, f.value, `${p}.value`, x.fieldNames);
  } else if ('value' in f) c.err(`${p}.value`, '"value" is only valid on a field of type "value"');
  if ('ref' in f) {
    if ('repeat' in f) c.err(`${p}.ref`, '"ref" cannot be combined with "repeat" (put it on a field inside the element type)');
    validateRef(c, f.ref, `${p}.ref`, x);
  }
  if ('link' in f) {
    if ('repeat' in f) c.err(`${p}.link`, '"link" cannot be combined with "repeat" (put it on a field inside the element type)');
    validateLink(c, f.link, `${p}.link`, x);
  }
  if ('fatal' in f && !isValue) {
    if (typeof f.fatal !== 'boolean') c.err(`${p}.fatal`, 'must be true or false');
    if (!('expect' in f)) c.err(`${p}.fatal`, '"fatal" only applies together with "expect"');
  }

  if ('repeat' in f) {
    const r = f.repeat as RepeatDef | unknown;
    if (r === 'eos') {
      /* ok */
    } else if (isRecord(r)) {
      const keys = Object.keys(r);
      if (keys.length !== 1 || (keys[0] !== 'count' && keys[0] !== 'until')) c.err(`${p}.repeat`, 'must have exactly one key: "count" or "until"');
      else if (keys[0] === 'count') checkExprOrInt(c, r.count, `${p}.repeat.count`, x.fieldNames);
      else checkExpr(c, r.until, `${p}.repeat.until`, x.fieldNames);
    } else c.err(`${p}.repeat`, 'must be "eos", {"count": expr} or {"until": expr}');
  }

  if ('enum' in f) {
    if (!allInt) c.err(`${p}.enum`, '"enum" is only valid on a plain integer type');
    if (typeof f.enum !== 'string' || !x.enumNames.has(f.enum)) c.err(`${p}.enum`, `unknown enum "${String(f.enum)}"`);
  }

  if ('bits' in f) {
    const info = single ? primitiveInfo(single) : null;
    if (!allInt || !info) c.err(`${p}.bits`, '"bits" is only valid on a plain integer type');
    if (!Array.isArray(f.bits) || f.bits.length === 0 || f.bits.length > c.lim.maxBitFields) {
      c.err(`${p}.bits`, `must be a non-empty array of at most ${c.lim.maxBitFields} {name, offset, width}`);
    } else {
      const names = new Set<string>();
      (f.bits as unknown[]).forEach((b, i) => {
        const bp = `${p}.bits[${i}]`;
        if (!isRecord(b)) return c.err(bp, 'must be an object');
        checkKeys(c, b, BIT_KEYS, bp);
        optDoc(c, b, bp);
        const nm = (b as unknown as BitField).name;
        if (typeof nm !== 'string' || !NAME_RE.test(nm) || FORBIDDEN_NAMES.has(nm)) c.err(`${bp}.name`, 'invalid bit field name');
        else if (names.has(nm)) c.err(`${bp}.name`, `duplicate bit field name "${nm}"`);
        else names.add(nm);
        const off = b.offset;
        const w = b.width;
        if (typeof off !== 'number' || !Number.isInteger(off) || off < 0) c.err(`${bp}.offset`, 'must be a non-negative integer');
        if (typeof w !== 'number' || !Number.isInteger(w) || w < 1) c.err(`${bp}.width`, 'must be an integer >= 1');
        else if (typeof off === 'number' && info && off + w > info.size * 8) c.err(bp, `bits ${off}..${off + w - 1} exceed the ${info.size * 8}-bit type`);
      });
    }
  }

  if ('expect' in f) {
    const e = f.expect;
    if (!(allNumeric || (!isSwitch && single === 'str'))) c.err(`${p}.expect`, '"expect" is only valid on numeric or "str" fields');
    else if (typeof e !== 'number' && typeof e !== 'string') c.err(`${p}.expect`, 'must be a number or string');
    else if (single === 'str') {
      if (typeof e !== 'string') c.err(`${p}.expect`, 'must be a string for "str"');
    } else if (allInt) {
      if (typeof e === 'number' ? !Number.isSafeInteger(e) : parseEnumKey(e) === null) c.err(`${p}.expect`, 'must be an integer (or a decimal/0x string for 64-bit values)');
    } else if (typeof e !== 'number') c.err(`${p}.expect`, 'must be a number for float types');
  }
}

function checkHexPair(c: Ctx, o: Record<string, unknown>, p: string): void {
  const bytes = typeof o.bytes === 'string' ? parseHexBytes(o.bytes, MAX_SIGNATURE_BYTES) : null;
  if (!bytes) c.err(`${p}.bytes`, `must be 1-${MAX_SIGNATURE_BYTES} hex bytes, e.g. "50 4B 05 06"`);
  if ('mask' in o) {
    const m = typeof o.mask === 'string' ? parseHexBytes(o.mask, MAX_SIGNATURE_BYTES) : null;
    if (!m) c.err(`${p}.mask`, 'must be hex bytes');
    else if (bytes && m.length !== bytes.length) c.err(`${p}.mask`, 'must have the same length as "bytes"');
    else if (m.every((b) => b === 0)) c.err(`${p}.mask`, 'must not be all zero (it would match everywhere)');
  }
}

function validateFind(c: Ctx, v: unknown, p: string, x: FieldCtx, ownType: string | null): void {
  if (!isRecord(v)) return c.err(p, 'must be an object {bytes, from, window, direction, accept?}');
  checkKeys(c, v, FIND_KEYS, p);
  checkHexPair(c, v, p);
  if (!('from' in v)) c.err(`${p}.from`, 'is required (an expression for the absolute offset to search from)');
  else checkExprOrInt(c, v.from, `${p}.from`, x.fieldNames);
  if (typeof v.window !== 'number' || !Number.isSafeInteger(v.window) || v.window < 1) c.err(`${p}.window`, 'must be a positive integer number of bytes');
  else if (v.window > c.lim.maxFindWindow) c.err(`${p}.window`, `too large (${v.window} > ${c.lim.maxFindWindow} bytes)`);
  if (v.direction !== 'backward' && v.direction !== 'forward') c.err(`${p}.direction`, 'must be "backward" or "forward"');
  if ('accept' in v) {
    if (!Array.isArray(v.accept) || v.accept.length === 0 || v.accept.length > MAX_ACCEPT_TIERS) {
      return c.err(`${p}.accept`, `must be an array of 1-${MAX_ACCEPT_TIERS} expression strings`);
    }
    // Accept expressions see the probe-parsed field, so a user type's own field names are what they may mention.
    const own = ownType !== null ? fieldsOfType(c, ownType) : null;
    const saved = c.curFields;
    c.curFields = own;
    try {
      (v.accept as unknown[]).forEach((e, i) => checkExpr(c, e, `${p}.accept[${i}]`, own ? new Set(own.keys()) : null));
    } finally {
      c.curFields = saved;
    }
  }
}

function validateIfMagic(c: Ctx, v: unknown, p: string, x: FieldCtx): void {
  if (!isRecord(v)) return c.err(p, 'must be an object {at, bytes, mask?}');
  checkKeys(c, v, IFMAGIC_KEYS, p);
  checkHexPair(c, v, p);
  if (!('at' in v)) c.err(`${p}.at`, 'is required (an expression for the absolute offset of the bytes)');
  else checkExprOrInt(c, v.at, `${p}.at`, x.fieldNames);
}

function validateRef(c: Ctx, v: unknown, p: string, x: FieldCtx): void {
  if (!isRecord(v)) return c.err(p, 'must be an object {type, at, doc?}');
  checkKeys(c, v, REF_KEYS, p);
  if (typeof v.type !== 'string' || !x.typeNames.has(v.type)) c.err(`${p}.type`, `must be the name of a type defined in "types"${typeof v.type === 'string' ? ` (unknown "${v.type}")` : ''}`);
  if (!('at' in v)) c.err(`${p}.at`, 'is required (an expression for the absolute offset of the target)');
  else checkExprOrInt(c, v.at, `${p}.at`, x.fieldNames);
  optDoc(c, v, p);
  if ('jumps' in v) {
    if (!Array.isArray(v.jumps) || v.jumps.length === 0 || v.jumps.length > MAX_JUMPS) return c.err(`${p}.jumps`, `must be an array of 1-${MAX_JUMPS} {label, path}`);
    const target = typeof v.type === 'string' && x.typeNames.has(v.type) ? v.type : null;
    (v.jumps as unknown[]).forEach((j, i) => {
      const jp = `${p}.jumps[${i}]`;
      if (!isRecord(j)) return c.err(jp, 'must be an object {label, path}');
      checkKeys(c, j, JUMP_KEYS, jp);
      if (checkString(c, j.label, `${jp}.label`, 100) && j.label.length === 0) c.err(`${jp}.label`, 'must not be empty');
      if (checkString(c, j.path, `${jp}.path`, 256) && target !== null) checkJumpPath(c, target, j.path, `${jp}.path`);
    });
  }
}

/**
 * A jump path is a dotted chain of field names resolved statically from the ref's target type. Every segment but the last
 * must be a single, non-repeated field of a user type (switch-typed, builtin and repeated fields are rejected because the
 * node to select would depend on the data); the last may be any field.
 */
function checkJumpPath(c: Ctx, target: string, path: string, p: string): void {
  const parts = path.split('.');
  if (parts.length > MAX_JUMP_DEPTH) return c.err(p, `path is too deep (max ${MAX_JUMP_DEPTH} segments)`);
  let cur = target;
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]!;
    const fields = fieldsOfType(c, cur);
    const field = fields?.get(seg);
    if (!field) return c.err(p, `"${seg}" is not a field of type "${cur}"`);
    if (i === parts.length - 1) return;
    if (field.repeat !== undefined) return c.err(p, `"${seg}" is an array; a jump path cannot pass through arrays`);
    if (typeof field.type !== 'string') return c.err(p, `"${seg}" has a switch type; a jump path cannot pass through it`);
    if (!c.typesRaw || !Object.hasOwn(c.typesRaw, field.type)) return c.err(p, `"${seg}" is of type "${field.type}", which has no fields to continue into`);
    cur = field.type;
  }
}

function validateLink(c: Ctx, v: unknown, p: string, x: FieldCtx): void {
  if (!isRecord(v)) return c.err(p, 'must be an object {at, size?, label?}');
  checkKeys(c, v, LINK_KEYS, p);
  if (!('at' in v)) c.err(`${p}.at`, 'is required (an expression for the absolute file offset to point at)');
  else checkExprOrInt(c, v.at, `${p}.at`, x.fieldNames);
  if ('size' in v) checkExprOrInt(c, v.size, `${p}.size`, x.fieldNames);
  if ('label' in v) checkString(c, v.label, `${p}.label`, 100);
}

/** Reject cycles of unconditional nesting and over-deep nesting. Edges with `size`/`at`/`if`/`repeat` are guarded. */
function checkTypeGraph(c: Ctx, edges: Map<string, Array<{ to: string; guarded: boolean; path: string }>>, root: string | undefined): void {
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const depth = new Map<string, number>();
  const stack: string[] = [];
  const visit = (n: string): number => {
    const st = state.get(n);
    if (st === 2) return depth.get(n)!;
    state.set(n, 1);
    stack.push(n);
    let d = 1;
    for (const e of edges.get(n) ?? []) {
      if (e.guarded) continue;
      if (state.get(e.to) === 1) {
        const cyc = [...stack.slice(stack.indexOf(e.to)), e.to].join(' -> ');
        c.err(e.path, `type cycle without "at"/"size"/"if"/"repeat" on any field of the cycle: ${cyc}`);
        continue;
      }
      d = Math.max(d, 1 + visit(e.to));
      if (c.errors.length >= 200) break;
    }
    stack.pop();
    state.set(n, 2);
    depth.set(n, d);
    return d;
  };
  for (const n of edges.keys()) {
    if (!state.has(n)) visit(n);
  }
  if (root !== undefined && (depth.get(root) ?? 0) > c.lim.maxTypeNesting) {
    c.err('$.root', `type nesting too deep (${depth.get(root)} > ${c.lim.maxTypeNesting})`);
  }
  for (const [n, d] of depth) {
    if (d > c.lim.maxTypeNesting && n !== root) {
      c.err(`$.types.${n}`, `type nesting too deep (${d} > ${c.lim.maxTypeNesting})`);
      break;
    }
  }
}

/** Parse + validate JSON text, enforcing the size cap before JSON.parse. */
export function loadSpec(text: string, limits: Partial<SpecLimits> = {}): ValidationResult {
  const lim = { ...DEFAULT_SPEC_LIMITS, ...limits };
  const bytes = text.length * 3 > lim.maxSpecBytes ? new TextEncoder().encode(text).length : text.length;
  if (bytes > lim.maxSpecBytes) return { ok: false, errors: [{ path: '$', message: `spec too large (${bytes} > ${lim.maxSpecBytes} bytes)` }] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [{ path: '$', message: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` }] };
  }
  return validateSpec(json, limits);
}

export function formatIssues(issues: SpecIssue[]): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join('\n');
}
