import { describe, expect, it } from 'vitest';
import bmp from '../../formats/bmp.json';
import { validateSpec } from '../engine';
import { specText } from '../../test/spec-fixtures';
import {
  BLOCKS,
  addDetect,
  addEnum,
  addEnumEntry,
  addField,
  addSwitchCase,
  addType,
  moveType,
  nonFinitePath,
  removeSwitchCase,
  setSwitchCaseType,
  setTypeDoc,
  typeIssues,
  applyBlock,
  canRedo,
  canUndo,
  createHistory,
  defaultValues,
  duplicateField,
  duplicateType,
  editDetect,
  editEnumEntry,
  editField,
  exprFeedback,
  exprSuggestions,
  fieldIssues,
  findReferences,
  isCanonicalText,
  isModelError,
  locateIssue,
  locateIssues,
  moveField,
  pushState,
  redo,
  removeDetect,
  removeEnum,
  removeEnumEntry,
  removeField,
  removeType,
  renameEnum,
  renameSwitchCase,
  renameType,
  sameSpecText,
  setFieldType,
  setMeta,
  starterSpec,
  textToExpr,
  toModel,
  toText,
  undo,
  type BuilderModel,
  type FieldModel,
} from './index';

const model = (text: string): BuilderModel => {
  const m = toModel(text);
  if (isModelError(m)) throw new Error(m.error);
  return m;
};
const base = () => model(specText('t'));

describe('round trip', () => {
  const fixtures: Record<string, string> = {
    bmp: JSON.stringify(bmp),
    small: specText('t'),
    unknown: specText('t', { future: { a: [1, 2] }, types: { root: { x: 1, doc: 'd', fields: [{ name: 'a', type: 'u1', weird: true, size: undefined }] } }, detect: [{ at: 0, bytes: '00', extra: 1 }], enums: {} }),
    switchy: specText('t', {
      types: { root: { fields: [{ name: 'k', type: 'u1' }, { name: 'p', type: { switch: 'k', cases: { '1': 'u1' }, default: 'u2' }, bits: [{ name: 'a', offset: 0, width: 1 }], assert: [{ expr: '_ > 0', level: 'warning' }] }] } },
    }),
  };
  for (const [name, text] of Object.entries(fixtures)) {
    it(`${name}: toText(toModel(x)) parses to the same JSON`, () => {
      expect(JSON.parse(toText(model(text)))).toEqual(JSON.parse(text));
    });
  }
  it('bmp stays valid after the round trip', () => {
    expect(validateSpec(JSON.parse(toText(model(JSON.stringify(bmp))))).ok).toBe(true);
  });
  it('output is deterministic with schema key order', () => {
    const t = toText(base());
    expect(toText(model(t))).toBe(t);
    expect(Object.keys(JSON.parse(t))).toEqual(['schemaVersion', 'id', 'name', 'endian', 'extensions', 'root', 'types']);
  });
  it('reports unparseable JSON with a position, and uneditable structure', () => {
    const r = toModel('{\n "a": }');
    expect(isModelError(r) && r.line).toBe(2);
    expect(isModelError(toModel('[]'))).toBe(true);
    expect(isModelError(toModel('{"types": 3}'))).toBe(true);
  });
  it('keeps a __proto__ type name as data', () => {
    const t = '{"types":{"__proto__":{"fields":[]}}}';
    const m = model(t);
    expect(m.types[0]!.name).toBe('__proto__');
    expect(Object.keys(JSON.parse(toText(m)).types)).toEqual(['__proto__']);
  });
});

describe('operations are immutable', () => {
  it('addField / editField / moveField / duplicateField / removeField', () => {
    const m0 = base();
    const snapshot = toText(m0);
    const m1 = addField(m0, 'root', { name: 'b', type: 'u2' });
    const m2 = editField(m1, 'root', 1, { type: 'u4', doc: 'x' });
    const m3 = moveField(m2, 'root', 1, 0);
    const m4 = duplicateField(m3, 'root', 0);
    expect(m4.types[0]!.fields.map((f) => f.name)).toEqual(['b', 'b_copy', 'magic']);
    expect(m3.types[0]!.fields[0]).toMatchObject({ type: 'u4', doc: 'x' });
    const m5 = removeField(m4, 'root', 1);
    expect(m5.types[0]!.fields.map((f) => f.name)).toEqual(['b', 'magic']);
    expect(toText(m0)).toBe(snapshot);
    expect(editField(m5, 'root', 0, { doc: undefined }).types[0]!.fields[0]).not.toHaveProperty('doc');
  });
  it('addField makes names unique', () => {
    const m = addField(base(), 'root', { name: 'magic', type: 'u1' });
    expect(m.types[0]!.fields.map((f) => f.name)).toEqual(['magic', 'magic_2']);
  });
  it('setFieldType drops keys that no longer apply', () => {
    let m = addField(base(), 'root', { name: 's', type: 'str', size: 4, encoding: 'ascii', expect: 'ab' });
    m = setFieldType(m, 'root', 1, 'u2');
    expect(m.types[0]!.fields[1]).toEqual({ name: 's', type: 'u2' });
  });
  it('meta and detect operations', () => {
    let m = setMeta(base(), { name: 'Z', doc: 'd', extensions: undefined });
    expect(m.meta).toMatchObject({ name: 'Z', doc: 'd' });
    expect(m.meta.extensions).toBeUndefined();
    m = addDetect(m, { at: -4, bytes: '00 01' });
    m = editDetect(m, 0, { mask: 'FF 00' });
    expect(toText(m)).toContain('"mask": "FF 00"');
    m = editDetect(m, 0, { mask: undefined });
    expect(m.meta.detect![0]).toEqual({ at: -4, bytes: '00 01' });
    m = removeDetect(m, 0);
    expect(m.meta.detect).toBeUndefined();
  });
  it('enum operations', () => {
    const r = addEnum(base(), 'kind', [{ key: '0', label: 'A' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = addEnumEntry(r.model, 'kind');
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const ed = editEnumEntry(a.model, 'kind', 1, { label: 'B' });
    expect(ed.ok).toBe(true);
    if (!ed.ok) return;
    let m = ed.model;
    expect(JSON.parse(toText(m)).enums).toEqual({ kind: { '0': 'A', '1': 'B' } });
    m = removeEnumEntry(m, 'kind', 0);
    expect(m.enums![0]!.entries).toHaveLength(1);
    m = editField(m, 'root', 0, { enum: 'kind' });
    expect(removeEnum(m, 'kind').ok).toBe(false);
    const rn = renameEnum(m, 'kind', 'kind2');
    expect(rn.ok && rn.model.types[0]!.fields[0]!.enum).toBe('kind2');
    expect(addEnum(m, 'kind').ok).toBe(false);
    const rm = removeEnum(editField(m, 'root', 0, { enum: undefined }), 'kind');
    expect(rm.ok && rm.model.enums).toBeUndefined();
  });
});

describe('duplicate keys', () => {
  const withEnum = () => {
    const r = addEnum(base(), 'kind', [{ key: '16', label: 'A' }, { key: '1', label: 'B' }]);
    if (!r.ok) throw new Error();
    return r.model;
  };
  it('enum entries: a key that exists by value is refused, so no entry is dropped', () => {
    const m = withEnum();
    const e = editEnumEntry(m, 'kind', 1, { key: '0x10' });
    expect(!e.ok && e.error).toContain('already exists');
    expect(editEnumEntry(m, 'kind', 1, { key: '16' }).ok).toBe(false);
    expect(editEnumEntry(m, 'kind', 0, { key: '0x10' }).ok).toBe(true); // itself
    expect(addEnumEntry(m, 'kind', { key: '0x01', label: 'x' }).ok).toBe(false);
    const a = addEnumEntry(m, 'kind');
    expect(a.ok && a.model.enums![0]!.entries.map((x) => x.key)).toEqual(['16', '1', '17']);
    expect(Object.keys(JSON.parse(toText(m)).enums.kind)).toHaveLength(2);
  });
  it('switch cases: add and rename refuse a colliding key', () => {
    let m = addField(base(), 'root', { name: 'sw', type: { switch: 'magic', cases: { '1': 'u1' } } } as FieldModel);
    const casesOf = (x: BuilderModel) => Object.keys((x.types[0]!.fields[1]!.type as unknown as { cases: object }).cases);
    const a = addSwitchCase(m, 'root', 1);
    expect(a.ok && casesOf(a.model)).toEqual(['1', '2']);
    expect(addSwitchCase(m, 'root', 1, '0x1').ok).toBe(false);
    if (a.ok) m = a.model;
    expect(renameSwitchCase(m, 'root', 1, '2', '1').ok).toBe(false);
    expect(renameSwitchCase(m, 'root', 1, '2', '0x1').ok).toBe(false);
    const ok = renameSwitchCase(m, 'root', 1, '2', '3');
    expect(ok.ok && casesOf(ok.model)).toEqual(['1', '3']);
    expect(addSwitchCase(m, 'root', 0).ok).toBe(false);
  });
});

describe('__proto__ and key order', () => {
  it('unknown __proto__ keys survive at top level, on a type and on a field', () => {
    const text =
      '{"schemaVersion":1,"id":"p","name":"P","endian":"le","root":"r","__proto__":{"top":1},' +
      '"types":{"r":{"__proto__":{"t":2},"fields":[{"name":"a","type":"u1","__proto__":{"f":3},"zz":1}]}}}';
    const m = model(text);
    const out = JSON.parse(toText(m));
    const keysOf = (o: object) => Object.keys(o).sort();
    expect(keysOf(out)).toEqual(keysOf(JSON.parse(text)));
    expect(keysOf(out.types.r)).toEqual(['__proto__', 'fields']);
    expect(keysOf(out.types.r.fields[0])).toEqual(['__proto__', 'name', 'type', 'zz']);
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toEqual({ top: 1 });
    expect(Object.getPrototypeOf(m.meta.extra)).toBe(Object.prototype);
    const m2 = editField(m, 'r', 0, { doc: 'x' });
    expect(Object.keys(m2.types[0]!.fields[0]!)).toContain('__proto__');
    expect(Object.hasOwn(JSON.parse(toText(m2)).types.r.fields[0], '__proto__')).toBe(true);
  });
  it('round trips keep the same keys, not only equal values', () => {
    const t = specText('t', { future: { b: 1, a: 2 }, types: { root: { fields: [{ name: 'a', type: 'u1', weird: 1 }] } } });
    const walk = (a: unknown, b: unknown): void => {
      if (a && typeof a === 'object') {
        expect(Object.keys(b as object).sort()).toEqual(Object.keys(a).sort());
        for (const k of Object.keys(a)) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]);
      }
    };
    walk(JSON.parse(t), JSON.parse(toText(model(t))));
    walk(bmp, JSON.parse(toText(model(JSON.stringify(bmp)))));
  });
});

describe('semantic comparison', () => {
  it('sameSpecText ignores layout and key order; canonical detection', () => {
    expect(sameSpecText('{"a":1,"b":[1,2]}', '{ "a": 1,   "b": [1, 2] }')).toBe(true);
    expect(sameSpecText('{"a":1,"b":2}', '{"b":2,"a":1}')).toBe(true); // key order only matters in cases and enum maps
    expect(sameSpecText('{"a":0}', '{"a":-0}')).toBe(true);
    expect(sameSpecText('{"a":1}', '{"a":2}')).toBe(false);
    expect(sameSpecText('{"a":', '{"a":')).toBe(true);
    expect(sameSpecText('{"a":', '{"a":1}')).toBe(false);
    expect(isCanonicalText(toText(base()))).toBe(true);
    expect(isCanonicalText(JSON.stringify(JSON.parse(specText('t'))))).toBe(false);
  });
});

describe('types', () => {
  const two = () => {
    let m = base();
    const a = addType(m, 'hdr');
    if (!a.ok) throw new Error();
    m = addField(a.model, 'root', { name: 'h', type: 'hdr' });
    m = addField(m, 'root', { name: 'sw', type: { switch: 'magic', cases: { '1': 'hdr' }, default: 'hdr' } } as FieldModel);
    return m;
  };
  it('rename updates field types, switch cases/default and root', () => {
    const r = renameType(two(), 'hdr', 'header');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const j = JSON.parse(toText(r.model));
    expect(j.types.header).toBeDefined();
    expect(j.types.root.fields[1].type).toBe('header');
    expect(j.types.root.fields[2].type).toEqual({ switch: 'magic', cases: { '1': 'header' }, default: 'header' });
    const rr = renameType(r.model, 'root', 'top');
    expect(rr.ok && rr.model.meta.root).toBe('top');
  });
  it('rename refuses bad, builtin and taken names', () => {
    expect(renameType(two(), 'hdr', '1x').ok).toBe(false);
    expect(renameType(two(), 'hdr', 'u4').ok).toBe(false);
    expect(renameType(two(), 'hdr', 'root').ok).toBe(false);
  });
  it('delete is blocked while referenced and lists the references', () => {
    const r = removeType(two(), 'hdr');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.references!.map((x) => x.where)).toEqual(['root.fields[1] (h)', 'root.fields[2] (sw)']);
    const root = removeType(base(), 'root');
    expect(!root.ok && root.references![0]!.where).toBe('the spec root');
    const free = addType(base(), 'free');
    expect(free.ok && removeType(free.model, 'free').ok).toBe(true);
  });
  it('duplicate and add', () => {
    const d = duplicateType(base(), 'root');
    expect(d.ok && d.name).toBe('root_copy');
  });
});

describe('findReferences', () => {
  const m = model(
    specText('t', {
      types: {
        root: { fields: [{ name: 'n', type: 'u1' }, { name: 'd', type: 'bytes', size: 'n * 2' }, { name: 'e', type: 'u1', if: 'n > 0', assert: [{ expr: '_ < n' }] }, { name: 'o', type: 'other', size: 'bad (' }] },
        other: { fields: [{ name: 'x', type: 'u1' }, { name: 'y', type: 'u1', if: '_parent.n == 1 or n == 2' }] },
      },
    }),
  );
  it('lists expressions that mention a name', () => {
    const r = findReferences(m, 'n');
    expect(r.map((x) => `${x.typeName}.${x.fieldName}:${x.slot}`)).toEqual(['root.d:size', 'root.e:if', 'root.e:assert[0].expr', 'other.y:if']);
  });
  it('scopes bare identifiers to the owning type but keeps member paths', () => {
    expect(findReferences(m, 'n', 'root').map((x) => x.typeName)).toEqual(['root', 'root', 'root', 'other']);
    expect(findReferences(m, 'n', 'other').map((x) => x.typeName)).toEqual(['other']);
    expect(findReferences(m, 'nothing')).toEqual([]);
  });
});

describe('building blocks', () => {
  const minimal = () => model(specText('t', { types: { root: { fields: [{ name: 'tag', type: 'u1' }, { name: 'len', type: 'u2' }] } } }));
  const ctx = { typeName: 'root', index: 2 };
  it('every block with default values yields a model that validates', () => {
    for (const b of BLOCKS) {
      const m = minimal();
      const v = defaultValues(b, m, ctx);
      // fill the parameters that have no sensible default
      if (b.id === 'magic') v.value = '42 4D';
      if ('sizeField' in v) v.sizeField = 'len';
      if ('countField' in v) v.countField = 'len';
      if ('on' in v) v.on = 'tag';
      if ('offsetField' in v) v.offsetField = 'len';
      if (b.id === 'conditional') v.cond = 'tag == 1';
      if (b.id === 'computed') v.expr = 'tag + 1';
      if (b.id === 'assert') v.target = 'tag';
      const r = applyBlock(b, m, ctx, v);
      expect(r.ok, `${b.id}: ${r.ok ? '' : r.error}`).toBe(true);
      if (!r.ok) continue;
      const out = validateSpec(JSON.parse(toText(r.model)));
      expect(out.ok, `${b.id}: ${JSON.stringify(out.ok ? '' : out.errors)}`).toBe(true);
      expect(b.description.length).toBeGreaterThan(10);
    }
  });
  it('covers the required catalogue', () => {
    expect(BLOCKS.map((b) => b.id)).toEqual(['integer', 'float', 'magic', 'str-fixed', 'str-nul', 'str-prefixed', 'bytes', 'enum', 'flags', 'struct', 'array', 'switch', 'pointer', 'conditional', 'padding', 'computed', 'find', 'assert']);
  });
  it('length-prefixed string adds the length field and links size', () => {
    const b = BLOCKS.find((x) => x.id === 'str-prefixed')!;
    const r = applyBlock(b, minimal(), ctx, { ...defaultValues(b, minimal(), ctx), name: 'title' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.types[0]!.fields.slice(2)).toEqual([{ name: 'title_len', type: 'u2' }, { name: 'title', type: 'str', size: 'title_len', encoding: 'utf8' }]);
  });
  it('magic adds a detect rule and an expect; struct creates a type; enum creates an enum', () => {
    const magic = BLOCKS.find((x) => x.id === 'magic')!;
    const r = applyBlock(magic, minimal(), { typeName: 'root', index: 0 }, { name: 'sig', mode: 'hex', value: '89 50', addDetect: 'true', detectAt: '0' });
    expect(r.ok && r.model.meta.detect).toEqual([{ at: 0, bytes: '89 50' }]);
    expect(r.ok && r.model.types[0]!.fields[0]).toMatchObject({ type: 'str', size: 2, encoding: 'latin1', expect: '\u0089P' });
    const st = applyBlock(BLOCKS.find((x) => x.id === 'struct')!, minimal(), ctx, { name: 'hdr', typeName: '' });
    expect(st.ok && st.model.types.map((t) => t.name)).toEqual(['root', 'hdr_type']);
    const en = BLOCKS.find((x) => x.id === 'enum')!;
    const e = applyBlock(en, minimal(), ctx, defaultValues(en, minimal(), ctx));
    expect(e.ok && e.model.enums![0]!.entries).toHaveLength(3);
  });
  it('magic text rejects lone surrogates', () => {
    const magic = BLOCKS.find((x) => x.id === 'magic')!;
    const r = applyBlock(magic, minimal(), ctx, { name: 'sig', mode: 'text', value: 'ab' + String.fromCharCode(0xd800), addDetect: 'false' });
    expect(!r.ok && r.error).toContain('surrogate');
    expect(applyBlock(magic, minimal(), ctx, { name: 'sig', mode: 'text', value: 'ab' + String.fromCharCode(0xd83d, 0xde00), addDetect: 'false' }).ok).toBe(true);
  });
  it('rejects bad input and ambiguous endian', () => {
    const int = BLOCKS.find((x) => x.id === 'integer')!;
    expect(applyBlock(int, minimal(), ctx, { name: '1bad', width: '4', signed: 'false', endian: 'le' }).ok).toBe(false);
    const noEndian = model(JSON.stringify({ schemaVersion: 1, id: 'a', name: 'a', root: 'root', types: { root: { fields: [] } } }));
    const r = applyBlock(int, noEndian, ctx, { name: 'x', width: '4', signed: 'false', endian: 'spec' });
    expect(!r.ok && r.error).toContain('no default endian');
    expect(applyBlock(BLOCKS.find((x) => x.id === 'array')!, minimal(), ctx, { name: 'a', elem: 'u1', mode: 'until', until: '(' }).ok).toBe(false);
  });
});

describe('history', () => {
  it('undo, redo, cap and redo discard', () => {
    let h = createHistory(0, 3);
    for (const n of [1, 2, 3, 4]) h = pushState(h, n);
    expect(h.past).toEqual([1, 2, 3]);
    expect(canUndo(h)).toBe(true);
    h = undo(undo(h));
    expect(h.present).toBe(2);
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(h.present).toBe(3);
    h = pushState(undo(h), 9);
    expect(canRedo(h)).toBe(false);
    expect(pushState(h, 9)).toBe(h);
  });
});

describe('issue paths and expressions', () => {
  it('maps paths to locations', () => {
    expect(locateIssue('$.id')).toEqual({ kind: 'meta', key: 'id' });
    expect(locateIssue('$')).toEqual({ kind: 'meta', key: '' });
    expect(locateIssue('$.extensions[1]')).toEqual({ kind: 'meta', key: 'extensions' });
    expect(locateIssue('$.detect[2].mask')).toEqual({ kind: 'detect', index: 2, key: 'mask' });
    expect(locateIssue('$.types.file.fields[2].size')).toEqual({ kind: 'field', type: 'file', index: 2, key: 'size', rest: '' });
    expect(locateIssue('$.types.f.fields[0].type.cases.1')).toEqual({ kind: 'field', type: 'f', index: 0, key: 'type', rest: '.cases.1' });
    expect(locateIssue('$.types.f.fields[0].assert[1].expr')).toMatchObject({ key: 'assert', rest: '[1].expr' });
    expect(locateIssue('$.types.f.doc')).toEqual({ kind: 'type', type: 'f', key: 'doc' });
    expect(locateIssue('$.types.f')).toEqual({ kind: 'type', type: 'f', key: '' });
    expect(locateIssue('$.enums.e.0x1')).toEqual({ kind: 'enum', name: 'e', entry: '0x1' });
    const l = locateIssues([{ path: '$.types.r.fields[1].if', message: 'm' }]);
    expect(fieldIssues(l, 'r', 1, 'if')).toHaveLength(1);
    expect(fieldIssues(l, 'r', 0)).toHaveLength(0);
  });
  it('expression feedback, suggestions and text conversion', () => {
    expect(exprFeedback('a +')).toMatchObject({ ok: false });
    expect(exprFeedback('a + 1')).toEqual({ ok: true });
    expect(exprFeedback('')).toEqual({ ok: true });
    const s = exprSuggestions(base(), 'root', 1, { withValue: true });
    expect(s).toEqual(['magic', '_', '_io.size', '_parent', '_root', '_index', '_start', 'lookup']);
    expect(exprSuggestions(base(), 'root', 0)).not.toContain('magic');
    expect(textToExpr(' 12 ')).toBe(12);
    expect(textToExpr('n * 2')).toBe('n * 2');
    expect(textToExpr('')).toBeUndefined();
  });
});

describe('starter spec', () => {
  it('builds a valid spec with and without magic', () => {
    const a = starterSpec({ id: 'x', name: 'X', endian: 'be' });
    expect(a.ok && validateSpec(JSON.parse(a.text)).ok).toBe(true);
    const b = starterSpec({ id: 'x', name: 'X', endian: 'le', magic: 'DE AD', extension: '.Abc' });
    expect(b.ok).toBe(true);
    if (b.ok) {
      const j = JSON.parse(b.text);
      expect(validateSpec(j).ok).toBe(true);
      expect(j.extensions).toEqual(['abc']);
      expect(j.detect).toEqual([{ at: 0, bytes: 'DE AD' }]);
    }
    expect(starterSpec({ id: 'x', name: 'X', endian: 'le', magic: 'zz' }).ok).toBe(false);
    expect(starterSpec({ id: 'x', name: 'X', endian: 'le', extension: 'a b' }).ok).toBe(false);
  });
});

describe('remaining operations and edge cases', () => {
  it('moveType and setTypeDoc', () => {
    const a = addType(base(), 'second');
    if (!a.ok) throw new Error();
    const moved = moveType(a.model, 1, 0);
    expect(moved.types.map((t) => t.name)).toEqual(['second', 'root']);
    expect(moveType(a.model, 0, 5)).toBe(a.model);
    expect(Object.keys(JSON.parse(toText(moved)).types)).toEqual(['second', 'root']);
    const d = setTypeDoc(moved, 'root', 'The root');
    expect(JSON.parse(toText(d)).types.root.doc).toBe('The root');
    expect(setTypeDoc(d, 'root', undefined).types[1]).not.toHaveProperty('doc');
    expect(moved.types[1]).not.toHaveProperty('doc'); // immutable
  });

  it('removeSwitchCase and setSwitchCaseType', () => {
    const m = addField(base(), 'root', { name: 'sw', type: { switch: 'magic', cases: { '1': 'u1', '2': 'u2' } } } as FieldModel);
    const cases = (x: BuilderModel) => (x.types[0]!.fields[1]!.type as unknown as { cases: Record<string, string> }).cases;
    expect(cases(removeSwitchCase(m, 'root', 1, '1'))).toEqual({ '2': 'u2' });
    expect(cases(setSwitchCaseType(m, 'root', 1, '2', 'u4le'))).toEqual({ '1': 'u1', '2': 'u4le' });
    expect(cases(m)).toEqual({ '1': 'u1', '2': 'u2' });
    expect(removeSwitchCase(m, 'root', 0, '1')).toBe(m); // not a switch
  });

  it('renameSwitchCase stores the trimmed key', () => {
    const m = addField(base(), 'root', { name: 'sw', type: { switch: 'magic', cases: { '1': 'u1' } } } as FieldModel);
    const r = renameSwitchCase(m, 'root', 1, '1', '  7 ');
    expect(r.ok && Object.keys((r.model.types[0]!.fields[1]!.type as unknown as { cases: object }).cases)).toEqual(['7']);
    expect(renameSwitchCase(m, 'root', 1, '1', '   ').ok).toBe(false);
  });

  it('typeIssues counts type-level and field-level issues of one type', () => {
    const l = locateIssues([
      { path: '$.types.a.doc', message: '1' },
      { path: '$.types.a.fields[0].size', message: '2' },
      { path: '$.types.b.fields[0].size', message: '3' },
      { path: '$.id', message: '4' },
    ]);
    expect(typeIssues(l, 'a').map((x) => x.issue.message)).toEqual(['1', '2']);
    expect(typeIssues(l, 'c')).toEqual([]);
  });

  it('pre-existing value-equal enum keys are both kept and round-trip in order', () => {
    const text = specText('t', { enums: { e: { '0x10': 'A', '0x010': 'B', '16': 'C' } } });
    const m = model(text);
    expect(m.enums![0]!.entries.map((e) => e.key)).toEqual(['16', '0x10', '0x010']); // JS lists index-like keys first
    const out = toText(m);
    expect(Object.keys(JSON.parse(out).enums.e)).toEqual(['16', '0x10', '0x010']);
    expect(JSON.parse(out).enums.e).toEqual(JSON.parse(text).enums.e);
  });

  it('order-only changes are real changes only in switch cases and enum maps', () => {
    const sw = (cases: object) => JSON.stringify({ types: { r: { fields: [{ name: 'p', type: { switch: 'k', cases } }] } } });
    expect(sameSpecText(sw({ 'k == 1': 'u1', 'k > 0': 'u2' }), sw({ 'k > 0': 'u2', 'k == 1': 'u1' }))).toBe(false);
    const en = (e: object) => JSON.stringify({ enums: { e } });
    expect(sameSpecText(en({ '0x10': 'A', '0x010': 'B' }), en({ '0x010': 'B', '0x10': 'A' }))).toBe(false);
    // elsewhere order is irrelevant: schema order vs hand-written order
    const a = '{"types":{"r":{"fields":[{"type":"u1","name":"a"}]}},"id":"x"}';
    const b = '{"id":"x","types":{"r":{"fields":[{"name":"a","type":"u1"}]}}}';
    expect(sameSpecText(a, b)).toBe(true);
  });

  it('non-finite numbers: the model is refused and toText will not emit them', () => {
    const r = toModel(specText('t').replace('"schemaVersion": 1', '"schemaVersion": 1,\n  "big": 1e400'));
    expect(isModelError(r) && r.error).toBe('number out of range at $.big; fix it in JSON');
    const m = addField(base(), 'root', { name: 'x', type: 'u1', size: Infinity } as unknown as FieldModel);
    expect(() => toText(m)).toThrow(/number out of range at \$\.types\.root\.fields\[1\]\.size; fix it in JSON/);
    expect(nonFinitePath({ a: [1, NaN] })).toBe('$.a[1]');
    expect(nonFinitePath({ a: 1 })).toBeNull();
  });
});
