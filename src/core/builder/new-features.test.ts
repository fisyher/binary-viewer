import { describe, expect, it } from 'vitest';
import { validateSpec } from '../engine';
import { BLOCKS, CONTEXT_NAMES, applyBlock, defaultValues, exprSuggestions, fieldExpressions, findReferences, isModelError, setFieldType, toModel, toText } from './index';
import type { BuilderModel } from './index';

const SPEC = {
  schemaVersion: 1,
  id: 'zipish',
  name: 'Zipish',
  endian: 'le',
  root: 'root',
  types: {
    rec: { fields: [{ name: 'n', type: 'u2' }] },
    root: {
      fields: [
        { name: 'count', type: 'u2' },
        { name: 'total', type: 'value', value: 'count * 2' },
        { name: 'eocd', type: 'rec', find: { bytes: '50 4B 05 06', mask: 'FF FF FF FF', from: '_io.end', window: 65557, direction: 'backward', accept: ['n == _parent.count', 'true'] } },
        { name: 'opt', type: 'u1', ifMagic: { at: 'total', bytes: '41 42' }, if: 'count > 0' },
        { name: 'ptr', type: 'u4', ref: { type: 'rec', at: 'ptr', doc: 'target' } },
        { name: 'magic', type: 'u2', expect: 1, fatal: true },
        { name: 'name', type: 'str', size: 4, encoding: 'cp437' },
      ],
    },
  },
};

const load = (json: unknown): BuilderModel => {
  const m = toModel(JSON.stringify(json));
  if (isModelError(m)) throw new Error(m.error);
  return m;
};
const rootFields = (m: BuilderModel) => m.types.find((t) => t.name === 'root')!.fields;

describe('builder: new schema keys', () => {
  it('the sample spec is valid', () => {
    const v = validateSpec(SPEC);
    expect(v.ok, JSON.stringify(v.ok ? '' : v.errors)).toBe(true);
  });

  it('round-trips losslessly (parsed JSON equal) and writes the new keys in schema order', () => {
    const text = toText(load(SPEC));
    expect(JSON.parse(text)).toEqual(SPEC);
    const fields = JSON.parse(text).types.root.fields;
    expect(Object.keys(fields[2].find)).toEqual(['bytes', 'mask', 'from', 'window', 'direction', 'accept']);
    expect(Object.keys(fields[3])).toEqual(['name', 'type', 'if', 'ifMagic']);
    expect(Object.keys(fields[4].ref)).toEqual(['type', 'at', 'doc']);
    expect(Object.keys(fields[5])).toEqual(['name', 'type', 'expect', 'fatal']);
    expect(Object.keys(fields[1])).toEqual(['name', 'type', 'value']);
    // scrambled key order in the input comes back canonical, and a second pass is stable
    const scrambled = {
      ...SPEC,
      types: {
        ...SPEC.types,
        root: { fields: [{ ifMagic: { mask: 'FF FF', bytes: '41 42', at: 0 }, type: 'u1', name: 'x', find: { direction: 'forward', window: 4, from: 0, bytes: '41 42' } }] },
      },
    };
    const once = toText(load(scrambled));
    expect(toText(load(JSON.parse(once)))).toBe(once);
    const x = JSON.parse(once).types.root.fields[0];
    expect(Object.keys(x.ifMagic)).toEqual(['at', 'bytes', 'mask']);
    expect(Object.keys(x.find)).toEqual(['bytes', 'from', 'window', 'direction']);
  });

  it('fieldExpressions lists every new expression slot', () => {
    const fields = rootFields(load(SPEC));
    expect(fieldExpressions(fields[1]!)).toEqual([{ slot: 'value', expr: 'count * 2' }]);
    expect(fieldExpressions(fields[2]!)).toEqual([
      { slot: 'find.from', expr: '_io.end' },
      { slot: 'find.accept[0]', expr: 'n == _parent.count' },
      { slot: 'find.accept[1]', expr: 'true' },
    ]);
    expect(fieldExpressions(fields[3]!)).toEqual([
      { slot: 'if', expr: 'count > 0' },
      { slot: 'ifMagic.at', expr: 'total' },
    ]);
    expect(fieldExpressions(fields[4]!)).toEqual([{ slot: 'ref.at', expr: 'ptr' }]);
  });

  it('reference tracking sees the new slots (rename / delete warnings)', () => {
    const m = load(SPEC);
    const slots = (name: string) => findReferences(m, name, 'root').map((r) => `${r.fieldName}:${r.slot}`);
    expect(slots('count')).toEqual(['total:value', 'eocd:find.accept[0]', 'opt:if']);
    expect(slots('total')).toEqual(['opt:ifMagic.at']);
    expect(slots('ptr')).toEqual(['ptr:ref.at']);
  });

  it('changing a field to `value` drops keys that would no longer validate, and away from it drops `value`', () => {
    const m = load({ ...SPEC, types: { ...SPEC.types, root: { fields: [{ name: 'a', type: 'u2', at: 4, expect: 1, fatal: true }] } } });
    const asValue = setFieldType(m, 'root', 0, 'value');
    const f = rootFields(asValue)[0]!;
    expect(f.type).toBe('value');
    for (const k of ['at', 'expect', 'fatal', 'size', 'find']) expect(f[k]).toBeUndefined();
    const withValue: BuilderModel = { ...asValue, types: asValue.types.map((t) => ({ ...t, fields: t.fields.map((x) => ({ ...x, value: 'a' })) })) };
    expect(rootFields(setFieldType(withValue, 'root', 0, 'u2'))[0]!.value).toBeUndefined();
  });

  it('expression suggestions offer _start and lookup', () => {
    expect(CONTEXT_NAMES).toContain('_start');
    expect(CONTEXT_NAMES).toContain('lookup');
    expect(exprSuggestions(load(SPEC), 'root', 3)).toEqual(expect.arrayContaining(['count', 'total', '_start', 'lookup']));
  });
});

describe('builder: new blocks', () => {
  const base = () => load({ schemaVersion: 1, id: 'b', name: 'B', endian: 'le', root: 'root', types: { root: { fields: [{ name: 'tag', type: 'u1' }] } } });
  const ctx = { typeName: 'root', index: 1 };
  const block = (id: string) => BLOCKS.find((b) => b.id === id)!;

  it('Computed value adds a zero-size value field', () => {
    const b = block('computed');
    const r = applyBlock(b, base(), ctx, { ...defaultValues(b, base(), ctx), name: 'twice', expr: 'tag * 2' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.parse(toText(r.model)).types.root.fields[1]).toEqual({ name: 'twice', type: 'value', value: 'tag * 2' });
    expect(validateSpec(JSON.parse(toText(r.model))).ok).toBe(true);
  });
  it('Computed value rejects an empty or broken expression and a reserved name', () => {
    const b = block('computed');
    expect(applyBlock(b, base(), ctx, { ...defaultValues(b, base(), ctx), expr: '' }).ok).toBe(false);
    expect(applyBlock(b, base(), ctx, { ...defaultValues(b, base(), ctx), expr: 'tag +' }).ok).toBe(false);
    expect(applyBlock(b, base(), ctx, { ...defaultValues(b, base(), ctx), name: 'lookup', expr: '1' }).ok).toBe(false);
  });

  it('Signature search defaults to backward from _io.end and builds a find field', () => {
    const b = block('find');
    const v = defaultValues(b, base(), ctx);
    expect(v).toMatchObject({ direction: 'backward', from: '_io.end', bytes: '50 4B 05 06' });
    const r = applyBlock(b, base(), ctx, { ...v, name: 'eocd' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const f = JSON.parse(toText(r.model)).types.root.fields[1];
    expect(f).toEqual({ name: 'eocd', type: 'u4', find: { bytes: '50 4B 05 06', from: '_io.end', window: 65557, direction: 'backward' } });
    expect(validateSpec(JSON.parse(toText(r.model))).ok).toBe(true);
  });
  it('Signature search validates its inputs', () => {
    const b = block('find');
    const v = defaultValues(b, base(), ctx);
    const ok = (over: Record<string, string>) => applyBlock(b, base(), ctx, { ...v, ...over }).ok;
    expect(ok({ bytes: 'zz' })).toBe(false);
    expect(ok({ bytes: '' })).toBe(false);
    expect(ok({ mask: 'FF' })).toBe(false);
    expect(ok({ mask: '00 00 00 00' })).toBe(false);
    expect(ok({ from: '' })).toBe(false);
    expect(ok({ from: '(' })).toBe(false);
    expect(ok({ window: '0' })).toBe(false);
    expect(ok({ window: String((1 << 20) + 1) })).toBe(false);
    expect(ok({ window: '1048576', mask: 'FF 00 FF FF', direction: 'forward', from: '0' })).toBe(true);
    expect(ok({ type: 'bytes', size: '' })).toBe(false);
    expect(ok({ type: 'bytes', size: '8' })).toBe(true);
  });
  it('the `value` type is not offered as an ordinary type to blocks', () => {
    const b = block('conditional');
    expect(applyBlock(b, base(), ctx, { ...defaultValues(b, base(), ctx), cond: 'tag == 1', type: 'value' }).ok).toBe(false);
  });
  it('the string blocks offer cp437', () => {
    const p = block('str-fixed').params.find((x) => x.key === 'encoding')!;
    expect(p.options!.map((o) => o.value)).toContain('cp437');
  });
});
