import { describe, expect, it } from 'vitest';
import { parse } from './interpret';
import { find, mem, mkSpec } from './test-helpers';

const f = (name: string, type: unknown, extra: Record<string, unknown> = {}) => ({ name, type, ...extra });

describe('_parent chains', () => {
  it('_parent._parent reaches grandparents (and null beyond the root)', async () => {
    const s = mkSpec({
      c: { fields: [f('a', 'value', { value: '_parent._parent.top' }), f('b', 'value', { value: '_parent._parent._parent.top' }), f('z', 'value', { value: '_parent._parent._parent._parent == null' })] },
      b: { fields: [f('c', 'c')] },
      root: { fields: [f('top', 'u1'), f('b', 'b')] },
    });
    const r = await parse(s, mem([7]));
    expect(r.errors).toEqual([]);
    expect(find(r.root, 'b.c.a').value).toBe(7);
    expect(find(r.root, 'b.c.b').display).toBe('null'); // three levels up is past the root
    expect(find(r.root, 'b.c.z').display).toBe('true'); // a member read through a null stays null
  });
});

describe('a sized struct is self-delimiting', () => {
  const s = mkSpec({
    rec: { fields: [f('a', 'u1'), f('b', 'u4'), f('c', 'u1')] },
    root: { fields: [f('r', 'rec', { size: 3 }), f('after', 'u1')] },
  });
  it('a failure inside it is recorded there and the parent continues after the declared size', async () => {
    const r = await parse(s, mem([1, 2, 3, 9]));
    expect(find(r.root, 'r.b').error).toMatch(/truncated/);
    expect(find(r.root, 'after')).toMatchObject({ offset: 3, value: 9 });
    expect(r.errors).toHaveLength(1);
  });
  it('an unsized struct that fails still stops its parent', async () => {
    const u = mkSpec({
      rec: { fields: [f('a', 'u1'), f('b', 'u4', { expect: 1, fatal: true })] },
      root: { fields: [f('r', 'rec'), f('after', 'u1')] },
    });
    const r = await parse(u, mem([1, 2, 0, 0, 0, 9]));
    expect(r.root.children!.some((c) => c.name === 'after')).toBe(false);
  });
  it('asserts of a sized struct are skipped when something inside it failed (no "could not be evaluated" noise)', async () => {
    const a = mkSpec({
      rec: { fields: [f('a', 'u1'), f('b', 'u4')] },
      root: {
        fields: [
          f('r', 'rec', { size: 3, assert: [{ expr: '_.b == 1', level: 'warning' }] }),
          f('ok', 'rec', { size: 5, at: 3, assert: [{ expr: '_.a == 5', level: 'warning', message: 'a is not 5' }] }),
        ],
      },
    });
    const r = await parse(a, mem([1, 2, 3, 9, 9, 9, 9, 9]));
    expect(find(r.root, 'r').validation).toBeUndefined();
    expect(r.errors.map((e) => e.severity + ':' + e.code)).toEqual(['error:read', 'warning:validation']); // the truncation, and the assert of the intact struct
  });
});
