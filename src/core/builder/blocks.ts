/**
 * Building blocks: presets that insert one or more fields (or types, enums, detect rules) into a spec. Pure.
 *
 * Each block declares its parameters (rendered by the palette wizard) and an `apply` that turns the parameter values
 * into a new model, or an error message. `ctx.index` is the position at which new fields are inserted.
 *
 * Deviation worth knowing: the validator only allows `expect` on numeric and `str` fields, so a "magic bytes" block
 * cannot use `bytes` + `expect`. Hex magic is therefore a `str` field with `encoding: "latin1"` (one byte = one
 * character, so any byte sequence is representable) and the expected text; plain-text magic is an ordinary `str`.
 */
import { parseExpr, parseEnumKey, parseHexBytes, isBuiltinType } from '../engine';
import {
  NAME_RE,
  addDetect,
  addEnum,
  addField,
  addType,
  editField,
  findType,
  typeNames,
  uniqueName,
  type BuilderModel,
  type FieldModel,
} from './model';
import { hasLoneSurrogate } from '../spec-folder';

export interface BlockContext {
  typeName: string;
  /** Insert position (after the selected row, or the end). */
  index: number;
}

export type ParamKind = 'text' | 'number' | 'select' | 'checkbox' | 'textarea' | 'expr' | 'field' | 'type';

export interface Option {
  value: string;
  label: string;
}

export interface BlockParam {
  key: string;
  label: string;
  kind: ParamKind;
  /** `select`: fixed options. */
  options?: Option[];
  /** `field`: which fields are offered (earlier than the insert position, or all of the type). */
  scope?: 'earlier' | 'all';
  /** `type`: also offer `str` and `bytes` (which need a size). */
  sized?: boolean;
  default: string | ((m: BuilderModel, ctx: BlockContext) => string);
  help?: string;
  showIf?: (values: Record<string, string>) => boolean;
}

export type BlockResult = { ok: true; model: BuilderModel; note?: string } | { ok: false; error: string };
const bad = (error: string): BlockResult => ({ ok: false, error });

export interface BlockDef {
  id: string;
  label: string;
  group: string;
  /** Short help text shown in the palette. */
  description: string;
  params: BlockParam[];
  apply(model: BuilderModel, ctx: BlockContext, v: Record<string, string>): BlockResult;
}

// ------------------------------------------------------------------ shared pieces

const RESERVED = new Set(['and', 'or', 'not', 'null', 'true', 'false', 'min', 'max', '__proto__', 'constructor', 'prototype']);

export function fieldNameProblem(name: string): string | null {
  if (!NAME_RE.test(name) || RESERVED.has(name)) return `"${name}" is not a valid field name (letters, digits, underscore; starts with a letter; and/or/not/null/true/false/min/max are reserved).`;
  return null;
}

export const INT_TYPES: Option[] = ['u1', 's1', 'u2', 's2', 'u4', 's4', 'u8', 's8'].map((t) => ({ value: t, label: t }));
export const FLOAT_TYPES: Option[] = ['f4', 'f8'].map((t) => ({ value: t, label: t }));
/** Primitive type names grouped for type selects. */
export const PRIMITIVE_GROUPS: Array<{ label: string; types: string[] }> = [
  { label: 'Integers (spec endian)', types: ['u1', 'u2', 'u4', 'u8', 's1', 's2', 's4', 's8'] },
  { label: 'Floats (spec endian)', types: ['f4', 'f8'] },
  { label: 'Little-endian', types: ['u2le', 'u4le', 'u8le', 's2le', 's4le', 's8le', 'f4le', 'f8le'] },
  { label: 'Big-endian', types: ['u2be', 'u4be', 'u8be', 's2be', 's4be', 's8be', 'f4be', 'f8be'] },
  { label: 'Text and raw', types: ['str', 'bytes'] },
];

const ENDIAN_OPTIONS: Option[] = [
  { value: 'spec', label: 'Spec default' },
  { value: 'le', label: 'Little-endian (le)' },
  { value: 'be', label: 'Big-endian (be)' },
];
const ENCODING_OPTIONS: Option[] = ['ascii', 'latin1', 'utf8', 'utf16le', 'utf16be'].map((t) => ({ value: t, label: t }));
const defaultEndian = (m: BuilderModel) => (m.meta.endian ? 'spec' : 'le');

/** `u4` / `u4le` ...; null (with `error`) when the spec default is requested but the spec declares none. */
function numType(m: BuilderModel, kind: 'u' | 's' | 'f', width: number, endian: string): { type: string } | { error: string } {
  const base = `${kind}${width}`;
  if (width === 1) return { type: base };
  if (endian === 'le' || endian === 'be') return { type: base + endian };
  if (!m.meta.endian) return { error: `The spec has no default endian, so "${base}" is ambiguous. Choose le or be, or set the spec endian first.` };
  return { type: base };
}

function nameOf(m: BuilderModel, ctx: BlockContext, v: Record<string, string>, key = 'name', taken: string[] = []): { name: string } | { error: string } {
  const raw = (v[key] ?? '').trim();
  const problem = fieldNameProblem(raw);
  if (problem) return { error: problem };
  const t = findType(m, ctx.typeName);
  return { name: uniqueName(raw, [...(t?.fields.map((f) => f.name) ?? []), ...taken]) };
}

function insertAll(model: BuilderModel, ctx: BlockContext, fields: FieldModel[]): BuilderModel {
  let out = model;
  fields.forEach((f, i) => (out = addField(out, ctx.typeName, f, ctx.index + i)));
  return out;
}

function posInt(text: string | undefined, what: string, min = 1, max = 1 << 24): { n: number } | { error: string } {
  const t = (text ?? '').trim();
  if (!/^\d{1,9}$/.test(t)) return { error: `${what} must be a whole number.` };
  const n = Number(t);
  if (n < min || n > max) return { error: `${what} must be between ${min} and ${max}.` };
  return { n };
}

/** Lines of `left<sep>right`; blank lines skipped. */
function parseLines(text: string, sep: string): Array<[string, string]> | { error: string } {
  const out: Array<[string, string]> = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '') continue;
    const at = t.indexOf(sep);
    if (at <= 0 || at === t.length - 1) return { error: `Could not read "${t}": use the form "left${sep}right".` };
    out.push([t.slice(0, at).trim(), t.slice(at + 1).trim()]);
  }
  return out;
}

const hexOf = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

const field = (key: string, label: string, kind: ParamKind, def: BlockParam['default'], extra: Partial<BlockParam> = {}): BlockParam => ({ key, label, kind, default: def, ...extra });
const nameParam = (def: string) => field('name', 'Field name', 'text', def);
const endianParam = field('endian', 'Byte order', 'select', defaultEndian, { options: ENDIAN_OPTIONS });

// ------------------------------------------------------------------ the catalogue

export const BLOCKS: BlockDef[] = [
  {
    id: 'integer',
    label: 'Integer',
    group: 'Numbers',
    description: 'A 1, 2, 4 or 8 byte whole number, signed or unsigned, with an explicit or spec-default byte order.',
    params: [
      nameParam('value'),
      field('width', 'Size in bytes', 'select', '4', { options: ['1', '2', '4', '8'].map((v) => ({ value: v, label: v })) }),
      field('signed', 'Signed', 'checkbox', 'false'),
      endianParam,
    ],
    apply(m, ctx, v) {
      const n = nameOf(m, ctx, v);
      if ('error' in n) return bad(n.error);
      const t = numType(m, v.signed === 'true' ? 's' : 'u', Number(v.width), v.endian ?? 'spec');
      if ('error' in t) return bad(t.error);
      return { ok: true, model: insertAll(m, ctx, [{ name: n.name, type: t.type }]) };
    },
  },
  {
    id: 'float',
    label: 'Float',
    group: 'Numbers',
    description: 'A 4 byte (single) or 8 byte (double) IEEE floating-point number.',
    params: [
      nameParam('value'),
      field('width', 'Size in bytes', 'select', '4', { options: [{ value: '4', label: '4 (f4, single)' }, { value: '8', label: '8 (f8, double)' }] }),
      endianParam,
    ],
    apply(m, ctx, v) {
      const n = nameOf(m, ctx, v);
      if ('error' in n) return bad(n.error);
      const t = numType(m, 'f', Number(v.width), v.endian ?? 'spec');
      if ('error' in t) return bad(t.error);
      return { ok: true, model: insertAll(m, ctx, [{ name: n.name, type: t.type }]) };
    },
  },
  {
    id: 'magic',
    label: 'Magic / signature',
    group: 'Identification',
    description: 'Fixed bytes or text that must appear (checked with expect). Can also add a detect rule so the format is recognised when a file is opened.',
    params: [
      nameParam('magic'),
      field('mode', 'Given as', 'select', 'hex', { options: [{ value: 'hex', label: 'Hex bytes (42 4D)' }, { value: 'text', label: 'Text (BM)' }] }),
      field('value', 'Value', 'text', '', { help: 'Up to 64 bytes.' }),
      field('addDetect', 'Also add a detect rule', 'checkbox', 'true'),
      field('detectAt', 'Detect offset', 'number', '0', { help: 'Negative = from the end of the file.', showIf: (v) => v.addDetect === 'true' }),
    ],
    apply(m, ctx, v) {
      const n = nameOf(m, ctx, v);
      if ('error' in n) return bad(n.error);
      let bytes: Uint8Array;
      let f: FieldModel;
      if (v.mode === 'text') {
        const text = v.value ?? '';
        if (hasLoneSurrogate(text)) return bad('The signature contains an unpaired surrogate character (invalid Unicode).');
        bytes = new TextEncoder().encode(text);
        if (bytes.length === 0 || bytes.length > 64) return bad('The signature must be 1 to 64 bytes long.');
        const ascii = [...bytes].every((b) => b < 0x80);
        f = { name: n.name, type: 'str', size: bytes.length, encoding: ascii ? 'ascii' : 'utf8', expect: text };
      } else {
        const parsed = parseHexBytes(v.value ?? '', 64);
        if (!parsed) return bad('Enter 1 to 64 hex bytes, for example "42 4D".');
        bytes = parsed;
        f = { name: n.name, type: 'str', size: bytes.length, encoding: 'latin1', expect: String.fromCharCode(...bytes) };
      }
      f.doc = 'Signature';
      let out = insertAll(m, ctx, [f]);
      let note: string | undefined;
      if (v.addDetect === 'true') {
        const at = Number((v.detectAt ?? '0').trim());
        if (!Number.isSafeInteger(at)) return bad('The detect offset must be a whole number.');
        const bytesText = hexOf(bytes);
        if (!(out.meta.detect ?? []).some((r) => r.at === at && r.bytes === bytesText && r.mask === undefined)) out = addDetect(out, { at, bytes: bytesText });
        note = `Added a detect rule at offset ${at}.`;
      }
      return { ok: true, model: out, ...(note ? { note } : {}) };
    },
  },
  {
    id: 'str-fixed',
    label: 'Fixed-length string',
    group: 'Text',
    description: 'Text that always takes the same number of bytes.',
    params: [nameParam('text'), field('size', 'Length in bytes', 'number', '16'), field('encoding', 'Encoding', 'select', 'ascii', { options: ENCODING_OPTIONS })],
    apply(m, ctx, v) {
      const n = nameOf(m, ctx, v);
      if ('error' in n) return bad(n.error);
      const size = posInt(v.size, 'The length', 0);
      if ('error' in size) return bad(size.error);
      return { ok: true, model: insertAll(m, ctx, [{ name: n.name, type: 'str', size: size.n, encoding: (v.encoding ?? 'ascii') as FieldModel['encoding'] }]) };
    },
  },
  {
    id: 'str-nul',
    label: 'Null-terminated string',
    group: 'Text',
    description: 'Text that runs up to a zero byte (the terminator is consumed).',
    params: [nameParam('text'), field('encoding', 'Encoding', 'select', 'ascii', { options: ENCODING_OPTIONS })],
    apply(m, ctx, v) {
      const n = nameOf(m, ctx, v);
      if ('error' in n) return bad(n.error);
      return { ok: true, model: insertAll(m, ctx, [{ name: n.name, type: 'str', terminator: 0, encoding: (v.encoding ?? 'ascii') as FieldModel['encoding'] }]) };
    },
  },
  {
    id: 'str-prefixed',
    label: 'Length-prefixed string',
    group: 'Text',
    description: 'A length number followed by that many bytes of text. Adds both fields and links them with size.',
    params: [
      nameParam('text'),
      field('lenType', 'Length field type', 'select', 'u2', { options: ['u1', 'u2', 'u4'].map((t) => ({ value: t, label: t })) }),
      endianParam,
      field('encoding', 'Encoding', 'select', 'utf8', { options: ENCODING_OPTIONS }),
    ],
    apply(m, ctx, v) {
      const n = nameOf(m, ctx, v);
      if ('error' in n) return bad(n.error);
      const len = nameOf({ ...m }, ctx, { name: `${n.name}_len` }, 'name', [n.name]);
      if ('error' in len) return bad(len.error);
      const t = numType(m, 'u', Number((v.lenType ?? 'u2').slice(1)), v.endian ?? 'spec');
      if ('error' in t) return bad(t.error);
      return {
        ok: true,
        model: insertAll(m, ctx, [
          { name: len.name, type: t.type },
          { name: n.name, type: 'str', size: len.name, encoding: (v.encoding ?? 'utf8') as FieldModel['encoding'] },
        ]),
      };
    },
  },
  {
    id: 'bytes',
    label: 'Raw bytes',
    group: 'Raw data',
    description: 'Opaque bytes: a fixed count, a count taken from an earlier field, or everything up to the end of the data.',
    params: [
      nameParam('data'),
      field('mode', 'Length', 'select', 'fixed', {
        options: [
          { value: 'fixed', label: 'Fixed number of bytes' },
          { value: 'field', label: 'From an earlier field' },
          { value: 'eos', label: 'To end of stream' },
        ],
      }),
      field('size', 'Bytes', 'number', '16', { showIf: (v) => v.mode === 'fixed' }),
      field('sizeField', 'Length field', 'field', '', { scope: 'earlier', showIf: (v) => v.mode === 'field' }),
    ],
    apply(m, ctx, v) {
      const n = nameOf(m, ctx, v);
      if ('error' in n) return bad(n.error);
      let size: number | string;
      if (v.mode === 'field') {
        if (!v.sizeField) return bad('Choose the field that holds the length (add it first).');
        size = v.sizeField;
      } else if (v.mode === 'eos') size = 'eos';
      else {
        const s = posInt(v.size, 'The byte count', 0);
        if ('error' in s) return bad(s.error);
        size = s.n;
      }
      return { ok: true, model: insertAll(m, ctx, [{ name: n.name, type: 'bytes', size }]) };
    },
  },
  {
    id: 'enum',
    label: 'Enum field',
    group: 'Numbers',
    description: 'An integer whose values have names, such as 1 = Red. Creates the integer field and a new enum.',
    params: [
      nameParam('kind'),
      field('width', 'Size in bytes', 'select', '1', { options: ['1', '2', '4'].map((v) => ({ value: v, label: v })) }),
      endianParam,
      field('enumName', 'Enum name', 'text', '', { help: 'Leave empty to derive it from the field name.' }),
      field('entries', 'Values (one "number=label" per line)', 'textarea', '0=None\n1=First\n2=Second'),
    ],
    apply(m, ctx, v) {
      const n = nameOf(m, ctx, v);
      if ('error' in n) return bad(n.error);
      const t = numType(m, 'u', Number(v.width), v.endian ?? 'spec');
      if ('error' in t) return bad(t.error);
      const lines = parseLines(v.entries ?? '', '=');
      if ('error' in lines) return bad(lines.error);
      if (lines.length === 0) return bad('Add at least one value.');
      const seen = new Set<string>();
      for (const [k, label] of lines) {
        if (parseEnumKey(k) === null) return bad(`"${k}" is not a whole number (decimal or 0x hex).`);
        if (seen.has(k)) return bad(`The value ${k} appears twice.`);
        if (label.length > 200) return bad('Labels are limited to 200 characters.');
        seen.add(k);
      }
      const wanted = (v.enumName ?? '').trim() || `${n.name}_enum`;
      const en = addEnum(m, uniqueName(wanted, (m.enums ?? []).map((e) => e.name)), lines.map(([key, label]) => ({ key, label })));
      if (!en.ok) return bad(en.error);
      return { ok: true, model: insertAll(en.model, ctx, [{ name: n.name, type: t.type, enum: en.name }]) };
    },
  },
  {
    id: 'flags',
    label: 'Flags / bitfield',
    group: 'Numbers',
    description: 'An integer split into named bit ranges (bit 0 is the least significant bit).',
    params: [
      nameParam('flags'),
      field('width', 'Size in bytes', 'select', '1', { options: ['1', '2', '4', '8'].map((v) => ({ value: v, label: v })) }),
      endianParam,
      field('bits', 'Bits (one "name:offset" or "name:offset:width" per line)', 'textarea', 'first:0\nsecond:1\nmode:2:3'),
    ],
    apply(m, ctx, v) {
      const n = nameOf(m, ctx, v);
      if ('error' in n) return bad(n.error);
      const width = Number(v.width);
      const t = numType(m, 'u', width, v.endian ?? 'spec');
      if ('error' in t) return bad(t.error);
      const bits: Array<{ name: string; offset: number; width: number }> = [];
      for (const raw of (v.bits ?? '').split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '') continue;
        const parts = line.split(':').map((p) => p.trim());
        const [bn, off, w = '1'] = parts;
        if (parts.length < 2 || parts.length > 3 || !bn || !NAME_RE.test(bn) || !/^\d{1,3}$/.test(off ?? '') || !/^\d{1,3}$/.test(w)) return bad(`Could not read "${line}": use "name:offset" or "name:offset:width".`);
        const offset = Number(off);
        const bw = Number(w);
        if (bw < 1 || offset + bw > width * 8) return bad(`"${bn}" (bits ${offset}..${offset + bw - 1}) does not fit in ${width * 8} bits.`);
        if (bits.some((b) => b.name === bn)) return bad(`The bit name "${bn}" appears twice.`);
        bits.push({ name: bn, offset, width: bw });
      }
      if (bits.length === 0) return bad('Add at least one bit range.');
      return { ok: true, model: insertAll(m, ctx, [{ name: n.name, type: t.type, bits }]) };
    },
  },
  {
    id: 'struct',
    label: 'Struct',
    group: 'Structure',
    description: 'A group of fields kept in its own type. Creates the type and a field that uses it; add the inner fields by selecting the new type.',
    params: [nameParam('header'), field('typeName', 'New type name', 'text', '', { help: 'Leave empty to derive it from the field name.' })],
    apply(m, ctx, v) {
      const n = nameOf(m, ctx, v);
      if ('error' in n) return bad(n.error);
      const wanted = (v.typeName ?? '').trim() || `${n.name}_type`;
      const created = addType(m, wanted);
      if (!created.ok) return bad(created.error);
      return { ok: true, model: insertAll(created.model, ctx, [{ name: n.name, type: created.name! }]), note: `Created the type "${created.name}".` };
    },
  },
  {
    id: 'array',
    label: 'Array',
    group: 'Structure',
    description: 'Repeats an element: a count from an earlier field, a fixed count, until a condition holds, or to the end of the stream.',
    params: [
      nameParam('items'),
      field('elem', 'Element type', 'type', 'u1'),
      field('mode', 'How many', 'select', 'field', {
        options: [
          { value: 'field', label: 'Count from an earlier field' },
          { value: 'count', label: 'Fixed count' },
          { value: 'until', label: 'Until a condition is true' },
          { value: 'eos', label: 'To end of stream' },
        ],
      }),
      field('countField', 'Count field', 'field', '', { scope: 'earlier', showIf: (v) => v.mode === 'field' }),
      field('count', 'Count', 'number', '4', { showIf: (v) => v.mode === 'count' }),
      field('until', 'Stop when', 'expr', '_ == 0', { help: '_ is the element just read.', showIf: (v) => v.mode === 'until' }),
    ],
    apply(m, ctx, v) {
      const n = nameOf(m, ctx, v);
      if ('error' in n) return bad(n.error);
      const elem = v.elem ?? 'u1';
      const typeProblem = typeRefProblem(m, elem, false);
      if (typeProblem) return bad(typeProblem);
      let repeat: FieldModel['repeat'];
      if (v.mode === 'eos') repeat = 'eos';
      else if (v.mode === 'count') {
        const c = posInt(v.count, 'The count', 0);
        if ('error' in c) return bad(c.error);
        repeat = { count: c.n };
      } else if (v.mode === 'until') {
        const u = (v.until ?? '').trim();
        if (!u) return bad('Enter the condition that ends the array.');
        const r = parseExpr(u);
        if (!r.ok) return bad(`Bad condition: ${r.error}`);
        repeat = { until: u };
      } else {
        if (!v.countField) return bad('Choose the field that holds the count (add it first).');
        repeat = { count: v.countField };
      }
      return { ok: true, model: insertAll(m, ctx, [{ name: n.name, type: elem, repeat }]) };
    },
  },
  {
    id: 'switch',
    label: 'Switch (type by tag)',
    group: 'Structure',
    description: 'A field whose type is chosen by the value of another field, such as a record tag.',
    params: [
      nameParam('payload'),
      field('on', 'Tag field', 'field', '', { scope: 'earlier' }),
      field('cases', 'Cases (one "value=Type" per line)', 'textarea', '1=u1\n2=u2'),
      field('default', 'Default type (optional)', 'type', '', { sized: true }),
    ],
    apply(m, ctx, v) {
      const n = nameOf(m, ctx, v);
      if ('error' in n) return bad(n.error);
      if (!v.on) return bad('Choose the field that selects the type (add it first).');
      const lines = parseLines(v.cases ?? '', '=');
      if ('error' in lines) return bad(lines.error);
      if (lines.length === 0) return bad('Add at least one case.');
      const cases: Record<string, string> = {};
      for (const [k, ty] of lines) {
        const pe = parseExpr(k);
        if (!pe.ok) return bad(`Bad case value "${k}": ${pe.error}`);
        const tp = typeRefProblem(m, ty, true);
        if (tp) return bad(tp);
        cases[k] = ty;
      }
      const type: { switch: string; cases: Record<string, string>; default?: string } = { switch: v.on, cases };
      if (v.default) {
        const tp = typeRefProblem(m, v.default, true);
        if (tp) return bad(tp);
        type.default = v.default;
      }
      return { ok: true, model: insertAll(m, ctx, [{ name: n.name, type }]) };
    },
  },
  {
    id: 'pointer',
    label: 'Pointer / offset',
    group: 'Structure',
    description: 'Reads a value at a position given by an earlier field (an absolute file offset). The cursor does not move.',
    params: [
      nameParam('target'),
      field('offsetField', 'Offset field', 'field', '', { scope: 'earlier' }),
      field('type', 'Type at that offset', 'type', 'u1', { sized: true }),
      field('size', 'Size (for str / bytes)', 'expr', '', { help: 'A number or an expression.' }),
    ],
    apply(m, ctx, v) {
      const n = nameOf(m, ctx, v);
      if ('error' in n) return bad(n.error);
      if (!v.offsetField) return bad('Choose the field that holds the offset (add it first).');
      const f = sizedField(m, n.name, v.type ?? 'u1', v.size ?? '');
      if ('error' in f) return bad(f.error);
      return { ok: true, model: insertAll(m, ctx, [{ ...f.field, at: v.offsetField }]) };
    },
  },
  {
    id: 'conditional',
    label: 'Conditional field',
    group: 'Structure',
    description: 'A field that is only read when a condition holds, for example flags & 1 == 1.',
    params: [
      nameParam('optional'),
      field('type', 'Type', 'type', 'u1', { sized: true }),
      field('cond', 'Only when', 'expr', ''),
      field('size', 'Size (for str / bytes)', 'expr', ''),
    ],
    apply(m, ctx, v) {
      const n = nameOf(m, ctx, v);
      if ('error' in n) return bad(n.error);
      const cond = (v.cond ?? '').trim();
      if (!cond) return bad('Enter the condition.');
      const r = parseExpr(cond);
      if (!r.ok) return bad(`Bad condition: ${r.error}`);
      const f = sizedField(m, n.name, v.type ?? 'u1', v.size ?? '');
      if ('error' in f) return bad(f.error);
      return { ok: true, model: insertAll(m, ctx, [{ ...f.field, if: cond }]) };
    },
  },
  {
    id: 'padding',
    label: 'Padding / reserved',
    group: 'Raw data',
    description: 'Bytes that are reserved or unused. Kept as raw bytes so the layout stays visible.',
    params: [nameParam('reserved'), field('size', 'Length in bytes', 'number', '4')],
    apply(m, ctx, v) {
      const n = nameOf(m, ctx, v);
      if ('error' in n) return bad(n.error);
      const size = posInt(v.size, 'The length', 1);
      if ('error' in size) return bad(size.error);
      return { ok: true, model: insertAll(m, ctx, [{ name: n.name, type: 'bytes', size: size.n, doc: 'Reserved / padding' }]) };
    },
  },
  {
    id: 'assert',
    label: 'Assert / validation',
    group: 'Identification',
    description: 'Adds a check to an existing field. A failed check is reported on the node; parsing continues. _ is the field value.',
    params: [
      field('target', 'Field to check', 'field', (m, ctx) => findType(m, ctx.typeName)?.fields[ctx.index - 1]?.name ?? '', { scope: 'all' }),
      field('expr', 'Must be true', 'expr', '_ != 0', { help: '_ is the field value.' }),
      field('level', 'Severity', 'select', 'error', { options: [{ value: 'error', label: 'Error' }, { value: 'warning', label: 'Warning' }] }),
      field('message', 'Message (optional)', 'text', ''),
    ],
    apply(m, ctx, v) {
      const t = findType(m, ctx.typeName);
      const idx = t ? t.fields.findIndex((f) => f.name === v.target) : -1;
      if (!t || idx < 0) return bad('Choose the field to check.');
      const expr = (v.expr ?? '').trim();
      if (!expr) return bad('Enter the condition.');
      const r = parseExpr(expr);
      if (!r.ok) return bad(`Bad condition: ${r.error}`);
      const a: Record<string, unknown> = { expr };
      if (v.level === 'warning') a.level = 'warning';
      if ((v.message ?? '').trim()) a.message = (v.message ?? '').trim();
      const prev = Array.isArray(t.fields[idx]!.assert) ? t.fields[idx]!.assert! : [];
      return { ok: true, model: editField(m, ctx.typeName, idx, { assert: [...prev, a] as FieldModel['assert'] }) };
    },
  },
];

export const blockById = (id: string): BlockDef | undefined => BLOCKS.find((b) => b.id === id);

/** Why `ref` cannot be used as a field type (null = fine). `sized` types (str, bytes) need a size elsewhere. */
function typeRefProblem(m: BuilderModel, ref: string, allowSized: boolean): string | null {
  if (!ref) return 'Choose a type.';
  if (ref === 'str' || ref === 'bytes') return allowSized ? null : `"${ref}" needs a size; use the String or Raw bytes blocks.`;
  if (isBuiltinType(ref)) {
    const multi = /^[usf][248](le|be)?$/.test(ref) && !/(le|be)$/.test(ref);
    return multi && !m.meta.endian ? `"${ref}" needs a spec endian; set one or use an explicit le/be type.` : null;
  }
  return typeNames(m).includes(ref) ? null : `Unknown type "${ref}".`;
}

/** A field of `type`, adding the size that str/bytes need (str without size gets a NUL terminator). */
function sizedField(m: BuilderModel, name: string, type: string, sizeText: string): { field: FieldModel } | { error: string } {
  const tp = typeRefProblem(m, type, true);
  if (tp) return { error: tp };
  const f: FieldModel = { name, type };
  const s = sizeText.trim();
  if (type === 'str' || type === 'bytes') {
    if (s !== '') f.size = /^\d{1,9}$/.test(s) ? Number(s) : s;
    else if (type === 'str') {
      f.terminator = 0;
      f.encoding = 'ascii';
    } else return { error: '"bytes" needs a size.' };
  } else if (s !== '') f.size = /^\d{1,9}$/.test(s) ? Number(s) : s;
  if (f.size !== undefined && typeof f.size === 'string') {
    const r = parseExpr(f.size);
    if (!r.ok) return { error: `Bad size: ${r.error}` };
  }
  return { field: f };
}

/** Parameter values to start the wizard with. */
export function defaultValues(block: BlockDef, model: BuilderModel, ctx: BlockContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of block.params) out[p.key] = typeof p.default === 'function' ? p.default(model, ctx) : p.default;
  return out;
}

/** The fields a `field` parameter may pick from. */
export function fieldChoices(model: BuilderModel, ctx: BlockContext, scope: 'earlier' | 'all' = 'earlier'): string[] {
  const t = findType(model, ctx.typeName);
  if (!t) return [];
  return (scope === 'all' ? t.fields : t.fields.slice(0, Math.max(0, ctx.index))).map((f) => f.name);
}

/** The types a `type` parameter may pick from. */
export function typeChoices(model: BuilderModel, sized: boolean): string[] {
  const prims = PRIMITIVE_GROUPS.flatMap((g) => g.types).filter((t) => t !== 'str' && t !== 'bytes');
  return [...prims, ...(sized ? ['str', 'bytes'] : []), ...typeNames(model)];
}

/** Run a block with the wizard's values. */
export function applyBlock(block: BlockDef, model: BuilderModel, ctx: BlockContext, values: Record<string, string>): BlockResult {
  if (!findType(model, ctx.typeName)) return bad(`Unknown type "${ctx.typeName}".`);
  return block.apply(model, ctx, values);
}
