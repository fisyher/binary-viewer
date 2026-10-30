/**
 * Editable model of a format spec, for the visual builder. Pure: no DOM, no Svelte.
 *
 * The model mirrors the schema (meta, ordered types with ordered fields, enums) but keeps every value it does not
 * understand: unknown keys on the spec, a type, a field or a detect rule live next to the known ones (or in `extra`),
 * so `toText(toModel(text))` never drops data. Every operation returns a NEW model and leaves its input untouched
 * (so the model can sit on an undo stack). Operations that can be refused return `{ ok: false, error }`.
 *
 * Why renaming a field does not rewrite expressions: expressions are free-form text in a small language
 * (`a.b`, `_parent.x`, `min(a, b)`, string literals that may merely look like names). Rewriting them textually would
 * risk changing the meaning of a spec silently, and printing an AST back would reformat what the user wrote. Instead
 * `findReferences` lists the expressions that mention a name and the UI warns the user to update them.
 *
 * Canonical form: `toText` re-serialises the whole spec, so layout, key order and number spelling may change (meaning
 * is preserved). Two JSON consequences are inherent to parsing and not specific to the builder: object keys that look
 * like array indices (enum keys such as "1", "2") are always enumerated in ascending numeric order by JavaScript, and
 * numbers beyond 2^53 lose precision when parsed. The engine parses specs with the same JSON.parse, so it sees exactly
 * what the model holds. Unknown keys are kept with own-property semantics (a `__proto__` key stays plain data).
 */
import { parseExpr, type DetectRule, type Endian, type Expr, type FieldDef } from '../engine';
import { isBuiltinType, parseEnumKey } from '../engine/schema';
import { exceedsBytes } from '../spec-folder';
import { jsonErrorLocation } from '../spec-text';

export type FieldModel = FieldDef & Record<string, unknown>;
export type DetectModel = DetectRule & Record<string, unknown>;

export interface MetaModel {
  /** Kept as found (normally 1); an absent key stays absent. */
  schemaVersion?: unknown;
  id?: string;
  name?: string;
  endian?: Endian;
  extensions?: string[];
  detect?: DetectModel[];
  doc?: string;
  root?: string;
  /** Unknown top-level keys, preserved. */
  extra: Record<string, unknown>;
}

export interface TypeModel {
  name: string;
  doc?: string;
  fields: FieldModel[];
  /** Unknown keys of the type definition, preserved. */
  extra: Record<string, unknown>;
}

export interface EnumEntry {
  key: string;
  label: string;
}
export interface EnumModel {
  name: string;
  entries: EnumEntry[];
}

export interface BuilderModel {
  meta: MetaModel;
  types: TypeModel[];
  /** undefined = the spec has no `enums` key. */
  enums?: EnumModel[];
}

export interface ModelError {
  error: string;
  line?: number;
  column?: number;
}

export type ModelResult = BuilderModel | ModelError;
export const isModelError = (r: ModelResult): r is ModelError => 'error' in r;

export const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

const META_KEYS = ['schemaVersion', 'id', 'name', 'endian', 'extensions', 'detect', 'doc', 'root'] as const;
const TOP_ORDER = [...META_KEYS, 'types', 'enums'];
const TYPE_ORDER = ['doc', 'fields'];
export const FIELD_ORDER = ['name', 'type', 'size', 'terminator', 'encoding', 'at', 'find', 'if', 'ifMagic', 'repeat', 'enum', 'bits', 'expect', 'fatal', 'value', 'ref', 'assert', 'doc'];
const FIND_ORDER = ['bytes', 'mask', 'from', 'window', 'direction', 'accept'];
const IFMAGIC_ORDER = ['at', 'bytes', 'mask'];
const REF_ORDER = ['type', 'at', 'doc'];
const SWITCH_ORDER = ['switch', 'cases', 'default'];
const DETECT_ORDER = ['at', 'bytes', 'mask'];
const BIT_ORDER = ['name', 'offset', 'width', 'doc'];
const ASSERT_ORDER = ['expr', 'level', 'message'];

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Own data property, even for the key `__proto__` (plain assignment to it would set the prototype instead). */
function setOwn(o: Rec, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

// ------------------------------------------------------------------ text <-> model

/** Parse spec text into a model. `{ error }` when the JSON is unparseable or its structure cannot be edited visually. */
export function toModel(specText: string): ModelResult {
  if (exceedsBytes(specText)) return { error: 'The spec is too large for the builder.' };
  let json: unknown;
  try {
    json = JSON.parse(specText);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { error: message, ...jsonErrorLocation(specText, message) };
  }
  return modelFromJson(json);
}

/** Build a model from parsed JSON. Structure that the builder cannot represent without losing data is refused. */
export function modelFromJson(json: unknown): ModelResult {
  if (!isRec(json)) return { error: 'The spec must be a JSON object.' };
  const nf = nonFinitePath(json);
  if (nf !== null) return { error: `number out of range at ${nf}; fix it in JSON` };
  const bad = (path: string, what: string): ModelError => ({ error: `${path} ${what}` });
  const meta: MetaModel = { extra: {} };
  for (const [k, v] of Object.entries(json)) {
    if (k === 'types' || k === 'enums') continue;
    if ((META_KEYS as readonly string[]).includes(k)) (meta as unknown as Rec)[k] = v;
    else setOwn(meta.extra, k, v);
  }
  for (const k of ['id', 'name', 'doc', 'root'] as const) {
    if (meta[k] !== undefined && typeof meta[k] !== 'string') return bad(`$.${k}`, 'must be a string');
  }
  if (meta.extensions !== undefined) {
    if (!Array.isArray(meta.extensions) || !meta.extensions.every((e) => typeof e === 'string')) return bad('$.extensions', 'must be an array of strings');
    meta.extensions = [...meta.extensions];
  }
  if (meta.detect !== undefined) {
    if (!Array.isArray(meta.detect) || !meta.detect.every(isRec)) return bad('$.detect', 'must be an array of objects');
    meta.detect = (meta.detect as Rec[]).map((d) => ({ ...d })) as DetectModel[];
  }

  if (!isRec(json.types)) return bad('$.types', 'must be an object');
  const types: TypeModel[] = [];
  for (const [name, def] of Object.entries(json.types)) {
    if (!isRec(def)) return bad(`$.types.${name}`, 'must be an object');
    if (!Array.isArray(def.fields) || !def.fields.every(isRec)) return bad(`$.types.${name}.fields`, 'must be an array of objects');
    if (def.doc !== undefined && typeof def.doc !== 'string') return bad(`$.types.${name}.doc`, 'must be a string');
    const extra: Rec = {};
    for (const [k, v] of Object.entries(def)) if (k !== 'fields' && k !== 'doc') setOwn(extra, k, v);
    const fields: FieldModel[] = [];
    for (let i = 0; i < def.fields.length; i++) {
      const f = def.fields[i] as Rec;
      if (typeof f.name !== 'string') return bad(`$.types.${name}.fields[${i}].name`, 'must be a string');
      fields.push({ ...f } as FieldModel);
    }
    const t: TypeModel = { name, fields, extra };
    if (typeof def.doc === 'string') t.doc = def.doc;
    types.push(t);
  }

  let enums: EnumModel[] | undefined;
  if (json.enums !== undefined) {
    if (!isRec(json.enums)) return bad('$.enums', 'must be an object');
    enums = [];
    for (const [name, vals] of Object.entries(json.enums)) {
      if (!isRec(vals)) return bad(`$.enums.${name}`, 'must be an object');
      const entries: EnumEntry[] = [];
      for (const [key, label] of Object.entries(vals)) {
        if (typeof label !== 'string') return bad(`$.enums.${name}.${key}`, 'must be a string');
        entries.push({ key, label });
      }
      enums.push({ name, entries });
    }
  }
  const model: BuilderModel = { meta, types };
  if (enums) model.enums = enums;
  return model;
}

function ordered(obj: Rec, order: readonly string[]): Rec {
  const out: Array<[string, unknown]> = [];
  for (const k of order) if (Object.hasOwn(obj, k) && obj[k] !== undefined) out.push([k, obj[k]]);
  for (const k of Object.keys(obj)) if (!order.includes(k) && obj[k] !== undefined) out.push([k, obj[k]]);
  return Object.fromEntries(out);
}

function orderedList(v: unknown, order: readonly string[]): unknown {
  return Array.isArray(v) ? v.map((x) => (isRec(x) ? ordered(x, order) : x)) : v;
}

function fieldJson(f: FieldModel): Rec {
  const o: Rec = { ...f };
  if (isRec(o.type)) o.type = ordered(o.type, SWITCH_ORDER);
  if (o.bits !== undefined) o.bits = orderedList(o.bits, BIT_ORDER);
  if (o.assert !== undefined) o.assert = orderedList(o.assert, ASSERT_ORDER);
  if (isRec(o.find)) o.find = ordered(o.find, FIND_ORDER);
  if (isRec(o.ifMagic)) o.ifMagic = ordered(o.ifMagic, IFMAGIC_ORDER);
  if (isRec(o.ref)) o.ref = ordered(o.ref, REF_ORDER);
  return ordered(o, FIELD_ORDER);
}

/** The plain JSON object for a model (keys in schema order, unknown keys last). */
export function toJson(model: BuilderModel): Rec {
  const m = model.meta;
  const top: Rec = {};
  for (const k of META_KEYS) if (m[k] !== undefined) top[k] = k === 'detect' ? orderedList(m.detect, DETECT_ORDER) : m[k];
  top.types = Object.fromEntries(
    model.types.map((t) => {
      const def: Rec = { ...t.extra, fields: t.fields.map(fieldJson) };
      if (t.doc !== undefined) def.doc = t.doc;
      return [t.name, ordered(def, TYPE_ORDER)] as const;
    }),
  );
  if (model.enums) top.enums = Object.fromEntries(model.enums.map((e) => [e.name, Object.fromEntries(e.entries.map((x) => [x.key, x.label]))] as const));
  for (const [k, v] of Object.entries(m.extra)) setOwn(top, k, v);
  return ordered(top, TOP_ORDER);
}

/** Path of the first number that is not finite (NaN, or Infinity from e.g. 1e400), which JSON cannot represent; null if none. */
export function nonFinitePath(v: unknown, path = '$', depth = 0): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? null : path;
  if (depth > 200 || typeof v !== 'object' || v === null) return null;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const r = nonFinitePath(v[i], `${path}[${i}]`, depth + 1);
      if (r !== null) return r;
    }
    return null;
  }
  for (const [k, x] of Object.entries(v)) {
    const r = nonFinitePath(x, `${path}.${k}`, depth + 1);
    if (r !== null) return r;
  }
  return null;
}

/** Deterministic JSON text: 2-space indent, schema key order, trailing newline. */
export function toText(model: BuilderModel): string {
  const json = toJson(model);
  const bad = nonFinitePath(json);
  if (bad !== null) throw new Error(`number out of range at ${bad}; fix it in JSON`);
  return JSON.stringify(json, null, 2) + '\n';
}

// ------------------------------------------------------------------ helpers

export type Op = { ok: true; model: BuilderModel; name?: string } | { ok: false; error: string; references?: TypeReference[] };
const fail = (error: string, references?: TypeReference[]): Op => (references ? { ok: false, error, references } : { ok: false, error });

export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  const stem = base.replace(/_\d+$/, '');
  for (let n = 2; ; n++) {
    const c = `${stem}_${n}`;
    if (!set.has(c)) return c;
  }
}

export const typeNames = (m: BuilderModel): string[] => m.types.map((t) => t.name);
export const enumNames = (m: BuilderModel): string[] => (m.enums ?? []).map((e) => e.name);
export const findType = (m: BuilderModel, name: string): TypeModel | undefined => m.types.find((t) => t.name === name);
export const findEnum = (m: BuilderModel, name: string): EnumModel | undefined => m.enums?.find((e) => e.name === name);

function mapType(m: BuilderModel, name: string, fn: (t: TypeModel) => TypeModel): BuilderModel {
  let hit = false;
  const types = m.types.map((t) => {
    if (t.name !== name) return t;
    hit = true;
    return fn(t);
  });
  return hit ? { ...m, types } : m;
}

/** The field with its type reference(s) rewritten through `fn` (builtin names pass through `fn` too). */
function mapTypeRefs(f: FieldModel, fn: (name: string) => string): FieldModel {
  const t = f.type;
  if (typeof t === 'string') {
    const n = fn(t);
    return n === t ? f : { ...f, type: n };
  }
  if (isRec(t)) {
    const out: Rec = { ...t };
    if (isRec(t.cases)) out.cases = Object.fromEntries(Object.entries(t.cases).map(([k, v]) => [k, typeof v === 'string' ? fn(v) : v] as const));
    if (typeof t.default === 'string') out.default = fn(t.default);
    return { ...f, type: out } as unknown as FieldModel;
  }
  return f;
}

function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= arr.length || to < 0 || to >= arr.length || from === to) return arr as T[];
  const out = [...arr];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x as T);
  return out;
}

// ------------------------------------------------------------------ meta

export type MetaPatch = Partial<Omit<MetaModel, 'extra'>>;

/** Set meta keys; a value of `undefined` removes the key. */
export function setMeta(model: BuilderModel, patch: MetaPatch): BuilderModel {
  const meta: MetaModel = { ...model.meta };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (meta as unknown as Rec)[k];
    else (meta as unknown as Rec)[k] = v;
  }
  return { ...model, meta };
}

export function addDetect(model: BuilderModel, rule: DetectModel = { at: 0, bytes: '' }): BuilderModel {
  return setMeta(model, { detect: [...(model.meta.detect ?? []), { ...rule }] });
}
export function removeDetect(model: BuilderModel, index: number): BuilderModel {
  const d = model.meta.detect;
  if (!d || index < 0 || index >= d.length) return model;
  const next = d.filter((_, i) => i !== index);
  return setMeta(model, { detect: next.length > 0 ? next : undefined });
}
/** Edit one detect rule; a patch value of `undefined` removes that key (e.g. the mask). */
export function editDetect(model: BuilderModel, index: number, patch: Partial<DetectModel>): BuilderModel {
  const d = model.meta.detect;
  if (!d || index < 0 || index >= d.length) return model;
  const rule: Rec = { ...d[index] };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete rule[k];
    else setOwn(rule, k, v);
  }
  return setMeta(model, { detect: d.map((r, i) => (i === index ? (rule as DetectModel) : r)) });
}

// ------------------------------------------------------------------ types

export function validTypeName(name: string): string | null {
  if (!NAME_RE.test(name) || FORBIDDEN.has(name)) return 'Type names start with a letter and use letters, digits and underscores (up to 64).';
  if (isBuiltinType(name)) return `"${name}" is a builtin type name.`;
  return null;
}

export function addType(model: BuilderModel, name?: string): Op {
  const want = name ?? uniqueName('new_type', typeNames(model));
  const bad = validTypeName(want);
  if (bad) return fail(bad);
  if (findType(model, want)) return fail(`A type named "${want}" already exists.`);
  return { ok: true, model: { ...model, types: [...model.types, { name: want, fields: [], extra: {} }] }, name: want };
}

export function duplicateType(model: BuilderModel, name: string): Op {
  const src = findType(model, name);
  if (!src) return fail(`Unknown type "${name}".`);
  const copy = uniqueName(`${name}_copy`, typeNames(model));
  const idx = model.types.indexOf(src);
  const dup: TypeModel = { ...src, name: copy, fields: src.fields.map((f) => structuredClone(f)), extra: structuredClone(src.extra) };
  const types = [...model.types.slice(0, idx + 1), dup, ...model.types.slice(idx + 1)];
  return { ok: true, model: { ...model, types }, name: copy };
}

export function moveType(model: BuilderModel, from: number, to: number): BuilderModel {
  const types = moveItem(model.types, from, to);
  return types === model.types ? model : { ...model, types };
}

/** Rename a type and update every reference to it (field types, switch cases and default, `root`). */
export function renameType(model: BuilderModel, oldName: string, newName: string): Op {
  if (!findType(model, oldName)) return fail(`Unknown type "${oldName}".`);
  if (oldName === newName) return { ok: true, model, name: newName };
  const bad = validTypeName(newName);
  if (bad) return fail(bad);
  if (findType(model, newName)) return fail(`A type named "${newName}" already exists.`);
  const swap = (n: string) => (n === oldName ? newName : n);
  const types = model.types.map((t) => ({ ...t, name: swap(t.name), fields: t.fields.map((f) => mapTypeRefs(f, swap)) }));
  const meta = model.meta.root === oldName ? { ...model.meta, root: newName } : model.meta;
  return { ok: true, model: { ...model, meta, types }, name: newName };
}

export interface TypeReference {
  /** Human-readable place, e.g. `header.fields[2] (payload)`. */
  where: string;
  typeName?: string;
  fieldIndex?: number;
}

/** Everything that refers to user type `name`, not counting the type's own fields. */
export function findTypeReferences(model: BuilderModel, name: string): TypeReference[] {
  const out: TypeReference[] = [];
  if (model.meta.root === name) out.push({ where: 'the spec root' });
  for (const t of model.types) {
    if (t.name === name) continue;
    t.fields.forEach((f, i) => {
      let hit = false;
      mapTypeRefs(f, (n) => {
        if (n === name) hit = true;
        return n;
      });
      if (hit) out.push({ where: `${t.name}.fields[${i}] (${f.name})`, typeName: t.name, fieldIndex: i });
    });
  }
  return out;
}

/** Delete a type; refused while the root or another type refers to it. */
export function removeType(model: BuilderModel, name: string): Op {
  if (!findType(model, name)) return fail(`Unknown type "${name}".`);
  const refs = findTypeReferences(model, name);
  if (refs.length > 0) return fail(`"${name}" is still used by ${refs.length} place${refs.length === 1 ? '' : 's'}.`, refs);
  return { ok: true, model: { ...model, types: model.types.filter((t) => t.name !== name) } };
}

export function setTypeDoc(model: BuilderModel, name: string, doc: string | undefined): BuilderModel {
  return mapType(model, name, (t) => {
    const next: TypeModel = { ...t };
    if (doc === undefined) delete next.doc;
    else next.doc = doc;
    return next;
  });
}

// ------------------------------------------------------------------ fields

/** Insert `field` at index `at` (default: the end). A clashing name is made unique. */
export function addField(model: BuilderModel, typeName: string, field: FieldModel, at?: number): BuilderModel {
  return mapType(model, typeName, (t) => {
    const i = at === undefined ? t.fields.length : Math.max(0, Math.min(at, t.fields.length));
    const name = uniqueName(field.name || 'field', t.fields.map((f) => f.name));
    return { ...t, fields: [...t.fields.slice(0, i), { ...field, name }, ...t.fields.slice(i)] };
  });
}

export function removeField(model: BuilderModel, typeName: string, index: number): BuilderModel {
  return mapType(model, typeName, (t) => (index < 0 || index >= t.fields.length ? t : { ...t, fields: t.fields.filter((_, i) => i !== index) }));
}

export function moveField(model: BuilderModel, typeName: string, from: number, to: number): BuilderModel {
  return mapType(model, typeName, (t) => {
    const fields = moveItem(t.fields, from, to);
    return fields === t.fields ? t : { ...t, fields };
  });
}

export function duplicateField(model: BuilderModel, typeName: string, index: number): BuilderModel {
  return mapType(model, typeName, (t) => {
    const f = t.fields[index];
    if (!f) return t;
    const copy = { ...structuredClone(f), name: uniqueName(`${f.name}_copy`, t.fields.map((x) => x.name)) } as FieldModel;
    return { ...t, fields: [...t.fields.slice(0, index + 1), copy, ...t.fields.slice(index + 1)] };
  });
}

/** Edit one field: set keys from `patch`; a value of `undefined` removes that key. Renaming does NOT touch expressions. */
export function editField(model: BuilderModel, typeName: string, index: number, patch: Partial<FieldModel>): BuilderModel {
  return mapType(model, typeName, (t) => {
    const f = t.fields[index];
    if (!f) return t;
    const next: Rec = { ...f };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k];
      else setOwn(next, k, v);
    }
    return { ...t, fields: t.fields.map((x, i) => (i === index ? (next as FieldModel) : x)) };
  });
}

/**
 * Change a field's type and drop the keys that cannot apply to the new one (fixed-size primitives take no `size`,
 * only `str` has `encoding`/`terminator`, `bits`/`enum` need an integer, `expect` needs a number or `str`), so a type
 * change does not leave a spec the validator rejects for stale keys.
 */
export function setFieldType(model: BuilderModel, typeName: string, index: number, type: FieldDef['type']): BuilderModel {
  const patch: Record<string, unknown> = { type };
  if (type === 'value') {
    // a computed field consumes no bytes and is not placed: drop everything that would make the validator object
    for (const k of ['size', 'encoding', 'terminator', 'bits', 'enum', 'expect', 'fatal', 'repeat', 'at', 'find']) patch[k] = undefined;
    return editField(model, typeName, index, patch as Partial<FieldModel>);
  }
  patch.value = undefined;
  const isPrim = typeof type === 'string' && /^[usf][1248](le|be)?$/.test(type);
  const isInt = typeof type === 'string' && /^[us][1248](le|be)?$/.test(type);
  if (isPrim) patch.size = undefined;
  if (type !== 'str') patch.encoding = patch.terminator = undefined;
  if (!isInt) patch.bits = patch.enum = undefined;
  const cat = (t: unknown) => (t === 'str' ? 'str' : typeof t === 'string' && /^[usf][1248](le|be)?$/.test(t) ? 'num' : 'other');
  const old = findType(model, typeName)?.fields[index]?.type;
  if (cat(type) === 'other' || cat(type) !== cat(old)) patch.expect = undefined;
  return editField(model, typeName, index, patch as Partial<FieldModel>);
}

// ------------------------------------------------------------------ enums

export function addEnum(model: BuilderModel, name?: string, entries: EnumEntry[] = []): Op {
  const want = name ?? uniqueName('new_enum', (model.enums ?? []).map((e) => e.name));
  if (!NAME_RE.test(want) || FORBIDDEN.has(want)) return fail('Enum names start with a letter and use letters, digits and underscores (up to 64).');
  if (findEnum(model, want)) return fail(`An enum named "${want}" already exists.`);
  return { ok: true, model: { ...model, enums: [...(model.enums ?? []), { name: want, entries: entries.map((e) => ({ ...e })) }] }, name: want };
}

/** Fields that use enum `name`. */
export function findEnumReferences(model: BuilderModel, name: string): TypeReference[] {
  const out: TypeReference[] = [];
  for (const t of model.types) t.fields.forEach((f, i) => f.enum === name && out.push({ where: `${t.name}.fields[${i}] (${f.name})`, typeName: t.name, fieldIndex: i }));
  return out;
}

export function removeEnum(model: BuilderModel, name: string): Op {
  if (!findEnum(model, name)) return fail(`Unknown enum "${name}".`);
  const refs = findEnumReferences(model, name);
  if (refs.length > 0) return fail(`Enum "${name}" is still used by ${refs.length} field${refs.length === 1 ? '' : 's'}.`, refs);
  const enums = (model.enums ?? []).filter((e) => e.name !== name);
  const next: BuilderModel = { ...model };
  if (enums.length > 0) next.enums = enums;
  else delete next.enums;
  return { ok: true, model: next };
}

export function renameEnum(model: BuilderModel, oldName: string, newName: string): Op {
  if (!findEnum(model, oldName)) return fail(`Unknown enum "${oldName}".`);
  if (oldName === newName) return { ok: true, model, name: newName };
  if (!NAME_RE.test(newName) || FORBIDDEN.has(newName)) return fail('Enum names start with a letter and use letters, digits and underscores (up to 64).');
  if (findEnum(model, newName)) return fail(`An enum named "${newName}" already exists.`);
  const enums = (model.enums ?? []).map((e) => (e.name === oldName ? { ...e, name: newName } : e));
  const types = model.types.map((t) => ({ ...t, fields: t.fields.map((f) => (f.enum === oldName ? ({ ...f, enum: newName } as FieldModel) : f)) }));
  return { ok: true, model: { ...model, enums, types }, name: newName };
}

function mapEnum(model: BuilderModel, name: string, fn: (e: EnumModel) => EnumModel): BuilderModel {
  if (!model.enums) return model;
  return { ...model, enums: model.enums.map((e) => (e.name === name ? fn(e) : e)) };
}

/** Enum keys compare by value: "0x10" and "16" are the same key. Non-numeric keys compare as written. */
export function normalizeKey(key: string): string {
  const n = parseEnumKey(key.trim());
  return n === null ? key.trim() : n.toString();
}

function keyTaken(keys: readonly string[], key: string, except = -1): boolean {
  const n = normalizeKey(key);
  return keys.some((k, i) => i !== except && normalizeKey(k) === n);
}

export function addEnumEntry(model: BuilderModel, enumName: string, entry?: EnumEntry): Op {
  const e = findEnum(model, enumName);
  if (!e) return fail(`Unknown enum "${enumName}".`);
  const keys = e.entries.map((x) => x.key);
  let key = entry?.key;
  if (key === undefined) {
    const nums = keys.map((k) => parseEnumKey(k)).filter((n): n is bigint => n !== null);
    let n = nums.length > 0 ? nums.reduce((a, b) => (a > b ? a : b)) + 1n : 0n;
    while (keyTaken(keys, n.toString())) n++;
    key = n.toString();
  } else if (keyTaken(keys, key)) return fail(`The value ${key} already exists in "${enumName}" (0x10 and 16 are the same value).`);
  const added: EnumEntry = entry ? { ...entry } : { key, label: `value_${key}` };
  return { ok: true, model: mapEnum(model, enumName, (x) => ({ ...x, entries: [...x.entries, added] })) };
}
export function removeEnumEntry(model: BuilderModel, enumName: string, index: number): BuilderModel {
  return mapEnum(model, enumName, (e) => ({ ...e, entries: e.entries.filter((_, i) => i !== index) }));
}
/** Edit one entry. Changing the key to one that already exists (by value) is refused: it would silently drop an entry. */
export function editEnumEntry(model: BuilderModel, enumName: string, index: number, patch: Partial<EnumEntry>): Op {
  const e = findEnum(model, enumName);
  if (!e || index < 0 || index >= e.entries.length) return fail(`Unknown entry ${index + 1} of "${enumName}".`);
  if (patch.key !== undefined && keyTaken(e.entries.map((x) => x.key), patch.key, index)) {
    return fail(`The value ${patch.key} already exists in "${enumName}" (0x10 and 16 are the same value).`);
  }
  return { ok: true, model: mapEnum(model, enumName, (x) => ({ ...x, entries: x.entries.map((y, i) => (i === index ? { ...y, ...patch } : y)) })) };
}

// ------------------------------------------------------------------ switch cases

type SwitchBody = { switch?: unknown; cases?: Record<string, unknown>; default?: unknown };

function caseKeys(f: FieldModel | undefined): string[] | null {
  if (!f || !isRec(f.type)) return null;
  const c = (f.type as unknown as SwitchBody).cases;
  return isRec(c) ? Object.keys(c) : [];
}

function withCases(model: BuilderModel, typeName: string, index: number, fn: (cases: Array<[string, unknown]>) => Array<[string, unknown]>): BuilderModel {
  const f = findType(model, typeName)?.fields[index];
  if (!f || !isRec(f.type)) return model;
  const body = f.type as unknown as SwitchBody;
  const cases = Object.fromEntries(fn(Object.entries(isRec(body.cases) ? body.cases : {})));
  return editField(model, typeName, index, { type: { ...body, cases } as never });
}

/** Add a case to a switch field. Case keys compare by value ("1" and "0x1" collide). */
export function addSwitchCase(model: BuilderModel, typeName: string, index: number, key?: string, type = 'u1'): Op {
  const keys = caseKeys(findType(model, typeName)?.fields[index]);
  if (!keys) return fail('That field is not a switch.');
  let k = key;
  if (k === undefined) {
    let n = keys.length + 1;
    while (keyTaken(keys, String(n))) n++;
    k = String(n);
  } else if (keyTaken(keys, k)) return fail(`The case ${k} already exists (0x1 and 1 are the same value).`);
  const added = k;
  return { ok: true, model: withCases(model, typeName, index, (c) => [...c, [added, type]]) };
}

/** Change a case key; refused when it collides with another case (by value). */
export function renameSwitchCase(model: BuilderModel, typeName: string, index: number, oldKey: string, newKey: string): Op {
  const keys = caseKeys(findType(model, typeName)?.fields[index]);
  if (!keys) return fail('That field is not a switch.');
  const at = keys.indexOf(oldKey);
  if (at < 0) return fail(`Unknown case ${oldKey}.`);
  const nk = newKey.trim();
  if (nk === '') return fail('A case needs a value.');
  if (keyTaken(keys, nk, at)) return fail(`The case ${nk} already exists (0x1 and 1 are the same value).`);
  return { ok: true, model: withCases(model, typeName, index, (c) => c.map(([k, v]) => [k === oldKey ? nk : k, v] as [string, unknown])) };
}

export function setSwitchCaseType(model: BuilderModel, typeName: string, index: number, key: string, type: string): BuilderModel {
  return withCases(model, typeName, index, (c) => c.map(([k, v]) => [k, k === key ? type : v] as [string, unknown]));
}

export function removeSwitchCase(model: BuilderModel, typeName: string, index: number, key: string): BuilderModel {
  return withCases(model, typeName, index, (c) => c.filter(([k]) => k !== key));
}

// ------------------------------------------------------------------ expression references

export interface Reference {
  typeName: string;
  fieldIndex: number;
  fieldName: string;
  /**
   * Which expression of the field: `size`, `at`, `if`, `repeat.count`, `repeat.until`, `type.switch`, `type.cases[k]`,
   * `assert[i].expr`, `find.from`, `find.accept[i]`, `ifMagic.at`, `value`, `ref.at`.
   */
  slot: string;
  expr: string;
}

/** The expression strings of a field, with a slot label each. */
export function fieldExpressions(f: FieldDef): Array<{ slot: string; expr: string }> {
  const out: Array<{ slot: string; expr: string }> = [];
  const add = (slot: string, v: unknown) => {
    if (typeof v === 'string') out.push({ slot, expr: v });
  };
  if (f.size !== 'eos') add('size', f.size);
  add('at', f.at);
  add('if', f.if);
  if (isRec(f.repeat)) {
    add('repeat.count', (f.repeat as Rec).count);
    add('repeat.until', (f.repeat as Rec).until);
  }
  if (isRec(f.type)) {
    add('type.switch', f.type.switch);
    if (isRec(f.type.cases)) for (const k of Object.keys(f.type.cases)) add(`type.cases[${k}]`, k);
  }
  if (Array.isArray(f.assert)) f.assert.forEach((a, i) => isRec(a) && add(`assert[${i}].expr`, a.expr));
  if (isRec(f.find)) {
    add('find.from', f.find.from);
    if (Array.isArray(f.find.accept)) f.find.accept.forEach((a, i) => add(`find.accept[${i}]`, a));
  }
  if (isRec(f.ifMagic)) add('ifMagic.at', f.ifMagic.at);
  add('value', f.value);
  if (isRec(f.ref)) add('ref.at', f.ref.at);
  return out;
}

function mentions(e: Expr, name: string, rootsToo: boolean): boolean {
  switch (e.k) {
    case 'name':
      return rootsToo && e.name === name;
    case 'member':
      return e.name === name || mentions(e.obj, name, rootsToo);
    case 'unary':
      return mentions(e.arg, name, rootsToo);
    case 'bin':
      return mentions(e.l, name, rootsToo) || mentions(e.r, name, rootsToo);
    case 'cond':
      return mentions(e.c, name, rootsToo) || mentions(e.a, name, rootsToo) || mentions(e.b, name, rootsToo);
    case 'call':
      return e.args.some((a) => mentions(a, name, rootsToo));
    default:
      return false;
  }
}

/**
 * Expressions that mention `name`. With `typeName` (the type that owns the field being renamed or removed), a bare
 * identifier only counts inside that type's own fields (that is where it resolves), while a dotted member `x.name`
 * counts anywhere (it may read the field through another type). Without `typeName` every identifier counts.
 */
export function findReferences(model: BuilderModel, name: string, typeName?: string): Reference[] {
  const out: Reference[] = [];
  for (const t of model.types) {
    t.fields.forEach((f, i) => {
      for (const { slot, expr } of fieldExpressions(f)) {
        const r = parseExpr(expr);
        if (!r.ok) continue;
        if (mentions(r.ast, name, typeName === undefined || typeName === t.name)) out.push({ typeName: t.name, fieldIndex: i, fieldName: f.name, slot, expr });
      }
    });
  }
  return out;
}

// ------------------------------------------------------------------ semantic comparison

/** Key order only matters where the engine depends on it: `enums.<name>` maps (value-equal keys: last wins) and switch `cases` maps (first match wins). */
function orderMatters(path: readonly string[]): boolean {
  if (path.length === 2 && path[0] === 'enums') return true;
  return path.length === 6 && path[0] === 'types' && path[2] === 'fields' && path[4] === 'type' && path[5] === 'cases';
}

/**
 * Deep equality of parsed JSON. Key order is compared only inside enum maps and switch `cases` maps (see `orderMatters`);
 * everywhere else objects compare order-insensitively, so a builder rewrite of a spec with non-schema key order is still
 * "the same spec". -0 equals 0.
 */
export function jsonEqual(a: unknown, b: unknown, path: readonly string[] = []): boolean {
  if (path.length > 200) return false;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (Object.is(a, b)) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i], [...path, String(i)]));
  if (isRec(a) && isRec(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    const ordered = orderMatters(path);
    return ka.every((k, i) => (ordered ? k === kb[i] : Object.hasOwn(b, k)) && jsonEqual(a[k], b[k], [...path, k]));
  }
  return false;
}

/** Parsed JSON of `text`, or null when it does not parse (a parsed `null` is wrapped, so callers can tell). */
export function parseJsonValue(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

/** True when `text` is the same JSON value as an already parsed `base` (layout ignored, key order significant). */
export function sameAsParsed(text: string, base: { value: unknown } | null): boolean {
  if (!base) return false;
  const t = parseJsonValue(text);
  return t !== null && jsonEqual(t.value, base.value);
}

/** True when both texts are the same JSON value (layout ignored, key order significant). Unparseable text only equals identical text. */
export function sameSpecText(a: string, b: string): boolean {
  return a === b || sameAsParsed(a, parseJsonValue(b));
}

/** True when `toText(toModel(text))` is `text`, i.e. a builder edit would not reformat it. */
export function isCanonicalText(text: string): boolean {
  const m = toModel(text);
  return !isModelError(m) && toText(m) === text;
}
