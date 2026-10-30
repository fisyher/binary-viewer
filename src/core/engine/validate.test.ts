import { describe, expect, it } from 'vitest';
import bmp from '../../formats/bmp.json';
import { loadSpec, validateSpec } from './validate';

function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'x',
    name: 'X',
    endian: 'le',
    root: 'root',
    types: { root: { fields: [{ name: 'a', type: 'u4' }] } },
    ...over,
  };
}
function issues(spec: unknown, limits = {}) {
  const r = validateSpec(spec, limits);
  return r.ok ? [] : r.errors;
}
function expectIssue(spec: unknown, path: string, msg: RegExp, limits = {}) {
  const found = issues(spec, limits);
  expect(found.some((i) => i.path === path && msg.test(i.message)), JSON.stringify(found)).toBe(true);
}
const withFields = (fields: unknown[], over: Record<string, unknown> = {}) => base({ types: { root: { fields } }, ...over });

describe('validateSpec', () => {
  it('accepts a minimal spec and the built-in BMP spec', () => {
    expect(validateSpec(base()).ok).toBe(true);
    const r = validateSpec(bmp);
    expect(r.ok, r.ok ? '' : JSON.stringify(r.errors)).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(issues(null)[0]?.path).toBe('$');
    expect(issues([])[0]?.path).toBe('$');
    expect(issues('x')[0]?.path).toBe('$');
  });

  it('requires endian for multi-byte types without a suffix, with a readable path', () => {
    const spec = base({ endian: undefined, types: { root: { fields: [{ name: 'a', type: 'u1' }, { name: 'b', type: 'u4' }] } } });
    delete spec.endian;
    expectIssue(spec, '$.types.root.fields[1].type', /declares no "endian"/);
  });

  it('accepts explicit suffixes without a spec endian, and u1 without either', () => {
    const spec = base({ types: { root: { fields: [{ name: 'a', type: 'u1' }, { name: 'b', type: 'u4be' }, { name: 'c', type: 'f8le' }] } } });
    delete spec.endian;
    expect(validateSpec(spec).ok).toBe(true);
  });

  it('applies the endian rule inside switch cases', () => {
    const spec = withFields([{ name: 'k', type: 'u1' }, { name: 'v', type: { switch: 'k', cases: { '1': 'u2' } } }]);
    delete spec.endian;
    expectIssue(spec, '$.types.root.fields[1].type.cases.1', /declares no "endian"/);
  });

  it('rejects unknown keys at every level', () => {
    expectIssue(base({ bogus: 1 }), '$.bogus', /unknown key/);
    expectIssue(base({ types: { root: { fields: [], extra: 1 } } }), '$.types.root.extra', /unknown key/);
    expectIssue(withFields([{ name: 'a', type: 'u1', colour: 'red' }]), '$.types.root.fields[0].colour', /unknown key/);
    expectIssue(withFields([{ name: 'a', type: { switch: '1', cases: { '1': 'u1' }, nope: 1 } }]), '$.types.root.fields[0].type.nope', /unknown key/);
    expectIssue(base({ detect: [{ at: 0, bytes: '00', foo: 1 }] }), '$.detect[0].foo', /unknown key/);
  });

  it('rejects bad type references', () => {
    expectIssue(withFields([{ name: 'a', type: 'nope' }]), '$.types.root.fields[0].type', /unknown type "nope"/);
    expectIssue(withFields([{ name: 'a', type: { switch: '1', cases: { '1': 'nope' } } }]), '$.types.root.fields[0].type.cases.1', /unknown type/);
    expectIssue(base({ root: 'missing' }), '$.root', /not defined/);
    expectIssue(withFields([{ name: 'a', type: 3 }]), '$.types.root.fields[0].type', /type name/);
  });

  it('rejects type cycles without at/size progress, naming the cycle', () => {
    const spec = base({
      types: {
        root: { fields: [{ name: 'a', type: 'a' }] },
        a: { fields: [{ name: 'b', type: 'b' }] },
        b: { fields: [{ name: 'a', type: 'a' }] },
      },
    });
    const found = issues(spec);
    expect(found.some((i) => /cycle without .* on any field of the cycle: a -> b -> a/.test(i.message)), JSON.stringify(found)).toBe(true);
  });

  it('rejects direct unconditional self nesting', () => {
    expect(issues(base({ types: { root: { fields: [{ name: 'r', type: 'root' }] } } })).length).toBeGreaterThan(0);
    expect(issues(base({ types: { root: { fields: [{ name: 'r', type: 'root', size: 'eos' }] } } })).length).toBeGreaterThan(0);
  });

  it('allows cycles through a field with "if" or "repeat" (recursive trees); runtime limits are the safety net', () => {
    expect(validateSpec(base({ types: { root: { fields: [{ name: 'r', type: 'root', if: 'true' }] } } })).ok).toBe(true);
    expect(validateSpec(base({ types: { root: { fields: [{ name: 'n', type: 'u1' }, { name: 'kids', type: 'root', repeat: { count: 'n' } }] } } })).ok).toBe(true);
  });

  it('allows cycles that make progress through "at" or "size"', () => {
    expect(validateSpec(base({ types: { root: { fields: [{ name: 'n', type: 'u4' }, { name: 'next', type: 'root', at: 'n', if: 'n != 0' }] } } })).ok).toBe(true);
    expect(validateSpec(base({ types: { root: { fields: [{ name: 'n', type: 'u1' }, { name: 'sub', type: 'root', size: 'n', if: 'n > 0' }] } } })).ok).toBe(true);
  });

  it('caps type nesting depth', () => {
    const types: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) types[i === 0 ? 'root' : `t${i}`] = { fields: [{ name: 'c', type: i === 39 ? 'u1' : `t${i + 1}` }] };
    const found = issues(base({ types }));
    expect(found.some((i) => /nesting too deep/.test(i.message)), JSON.stringify(found)).toBe(true);
  });

  it('caps spec size, type count, fields, and expression length', () => {
    const big = JSON.stringify(base({ doc: 'x'.repeat(2_000_000) }));
    const r = loadSpec(big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/too large/);

    const types: Record<string, unknown> = { root: { fields: [] } };
    for (let i = 0; i < 20; i++) types[`t${i}`] = { fields: [] };
    expectIssue(base({ types }), '$.types', /too many types/, { maxTypes: 10 });
    expectIssue(withFields([{ name: 'a', type: 'u1' }, { name: 'b', type: 'u1' }]), '$.types.root.fields', /too many fields/, { maxFieldsPerType: 1 });
    expectIssue(withFields([{ name: 'a', type: 'u1', if: '1 + ' + '1 + '.repeat(600) + '1 == 2' }]), '$.types.root.fields[0].if', /too long/);
  });

  it('reports invalid JSON text', () => {
    const r = loadSpec('{ not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/invalid JSON/);
  });

  it('rejects prototype-pollution style names', () => {
    const r = loadSpec('{"schemaVersion":1,"id":"x","name":"X","root":"root","types":{"root":{"fields":[]},"__proto__":{"fields":[]}}}');
    expect(r.ok).toBe(false);
  });

  it('checks expressions and the names they use', () => {
    expectIssue(withFields([{ name: 'a', type: 'u1', if: '1 +' }]), '$.types.root.fields[0].if', /bad expression/);
    expectIssue(withFields([{ name: 'a', type: 'u1', if: 'typo > 1' }]), '$.types.root.fields[0].if', /unknown name "typo"/);
    expect(validateSpec(withFields([{ name: 'a', type: 'u1' }, { name: 'b', type: 'u1', if: 'a > 1 && _io.pos < _io.size' }])).ok).toBe(true);
  });

  it('validates field modifiers', () => {
    expectIssue(withFields([{ name: 'a', type: 'str' }]), '$.types.root.fields[0].size', /needs "size" or "terminator"/);
    expect(validateSpec(withFields([{ name: 'a', type: 'str', terminator: 0 }])).ok).toBe(true);
    expectIssue(withFields([{ name: 'a', type: 'bytes' }]), '$.types.root.fields[0].size', /needs "size"/);
    expectIssue(withFields([{ name: 'a', type: 'str', size: 2, encoding: 'ebcdic' }]), '$.types.root.fields[0].encoding', /must be one of/);
    expectIssue(withFields([{ name: 'a', type: 'u1', encoding: 'ascii' }]), '$.types.root.fields[0].encoding', /only valid for "str"/);
    expectIssue(withFields([{ name: 'a', type: 'u4', size: 4 }]), '$.types.root.fields[0].size', /fixed size/);
    expectIssue(withFields([{ name: 'a', type: 'u1', repeat: { count: 1, until: 'true' } }]), '$.types.root.fields[0].repeat', /exactly one key/);
    expectIssue(withFields([{ name: 'a', type: 'u1', repeat: 'forever' }]), '$.types.root.fields[0].repeat', /"eos"/);
    expectIssue(withFields([{ name: 'a', type: 'u1' }, { name: 'a', type: 'u1' }]), '$.types.root.fields[1].name', /duplicate/);
    expectIssue(withFields([{ name: '_x', type: 'u1' }]), '$.types.root.fields[0].name', /invalid field name/);
    expectIssue(withFields([{ name: 'a', type: 'u1', size: -1 }]), '$.types.root.fields[0].size', /non-negative/);
  });

  it('validates enums and bits', () => {
    expectIssue(withFields([{ name: 'a', type: 'u1', enum: 'nope' }]), '$.types.root.fields[0].enum', /unknown enum/);
    expectIssue(withFields([{ name: 'a', type: 'f4', enum: 'e' }], { enums: { e: { '1': 'one' } } }), '$.types.root.fields[0].enum', /plain integer/);
    expectIssue(base({ enums: { e: { abc: 'x' } } }), '$.enums.e.abc', /integer/);
    expectIssue(withFields([{ name: 'a', type: 'u1', bits: [{ name: 'x', offset: 6, width: 4 }] }]), '$.types.root.fields[0].bits[0]', /exceed the 8-bit type/);
    expectIssue(withFields([{ name: 'a', type: 'u1', bits: [{ name: 'x', offset: 0, width: 1 }, { name: 'x', offset: 1, width: 1 }] }]), '$.types.root.fields[0].bits[1].name', /duplicate/);
    expect(validateSpec(withFields([{ name: 'a', type: 'u2', bits: [{ name: 'lo', offset: 0, width: 4 }, { name: 'hi', offset: 12, width: 4 }] }])).ok).toBe(true);
  });

  it('validates expect and detect', () => {
    expectIssue(withFields([{ name: 'a', type: 'u1', expect: 'x' }]), '$.types.root.fields[0].expect', /integer/);
    expectIssue(withFields([{ name: 'a', type: 'u1', expect: 1.5 }]), '$.types.root.fields[0].expect', /integer/);
    expectIssue(withFields([{ name: 'a', type: 'bytes', size: 1, expect: 1 }]), '$.types.root.fields[0].expect', /only valid/);
    expectIssue(base({ detect: [{ at: 0, bytes: 'ZZ' }] }), '$.detect[0].bytes', /hex/);
    expectIssue(base({ detect: [{ at: 0, bytes: '00 01', mask: 'FF' }] }), '$.detect[0].mask', /same length/);
    expectIssue(base({ detect: [{ at: 1.5, bytes: '00' }] }), '$.detect[0].at', /integer/);
    expectIssue(base({ extensions: ['.bmp'] }), '$.extensions[0]', /without a dot/);
  });
});

describe('validateSpec: assert, reserved words, terminator, masks, recursive trees', () => {
  it('accepts valid asserts and rejects bad ones', () => {
    expect(validateSpec(withFields([{ name: 'a', type: 'u1', assert: [{ expr: '_ > 0', level: 'warning', message: 'm' }, { expr: 'a == 1' }] }])).ok).toBe(true);
    expectIssue(withFields([{ name: 'a', type: 'u1', assert: [{ expr: '_ >', level: 'warning' }] }]), '$.types.root.fields[0].assert[0].expr', /bad expression/);
    expectIssue(withFields([{ name: 'a', type: 'u1', assert: [{ expr: 'true', level: 'fatal' }] }]), '$.types.root.fields[0].assert[0].level', /warning/);
    expectIssue(withFields([{ name: 'a', type: 'u1', assert: [{ expr: 'true', x: 1 }] }]), '$.types.root.fields[0].assert[0].x', /unknown key/);
    expectIssue(withFields([{ name: 'a', type: 'u1', assert: [] }]), '$.types.root.fields[0].assert', /1-16/);
    expectIssue(withFields([{ name: 'a', type: 'u1', assert: [{ expr: 'nope > 1' }] }]), '$.types.root.fields[0].assert[0].expr', /unknown name/);
  });

  it('reserves the expression words as field names', () => {
    for (const n of ['and', 'or', 'not', 'null', 'true', 'min']) expectIssue(withFields([{ name: n, type: 'u1' }]), '$.types.root.fields[0].name', /reserved/);
  });

  it('rejects a terminator that does not fit a single-byte encoding', () => {
    expectIssue(withFields([{ name: 'a', type: 'str', terminator: 256, encoding: 'ascii' }]), '$.types.root.fields[0].terminator', /single-byte/);
    expectIssue(withFields([{ name: 'a', type: 'str', terminator: 300 }]), '$.types.root.fields[0].terminator', /single-byte/);
    expect(validateSpec(withFields([{ name: 'a', type: 'str', terminator: 300, encoding: 'utf16le' }])).ok).toBe(true);
    expect(validateSpec(withFields([{ name: 'a', type: 'str', terminator: 255, encoding: 'latin1' }])).ok).toBe(true);
  });

  it('rejects an all-zero detect mask', () => {
    expectIssue(base({ detect: [{ at: 0, bytes: '42 4D', mask: '00 00' }] }), '$.detect[0].mask', /all zero/);
    expect(validateSpec(base({ detect: [{ at: 0, bytes: '42 4D', mask: 'FF 00' }] })).ok).toBe(true);
  });

  it('accepts a recursive tree type guarded by repeat/if', () => {
    const spec = base({ types: { root: { fields: [{ name: 'v', type: 'u1' }, { name: 'n', type: 'u1' }, { name: 'kids', type: 'root', repeat: { count: 'n' } }] } } });
    expect(validateSpec(spec).ok).toBe(true);
  });
});
