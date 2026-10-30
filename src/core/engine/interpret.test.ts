import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../byte-source';
import { MemoryByteSource } from '../byte-source';
import { expandLazy, findNodeAt, lazyElementIndexAt, parse } from './interpret';
import { find, mem, mkSpec, rawSpec } from './test-helpers';

const f = (name: string, type: unknown, extra: Record<string, unknown> = {}) => ({ name, type, ...extra });
const codes = (r: { errors: Array<{ code: string }> }) => r.errors.map((e) => e.code);

describe('primitives', () => {
  it('reads little- and big-endian integers and floats with explicit byte order', async () => {
    const spec = mkSpec({
      root: {
        fields: [
          f('a', 'u4'), // spec endian le
          f('b', 'u4be'),
          f('c', 's1'),
          f('d', 'u2le'),
          f('e', 'f4be'),
          f('g', 's2be'),
        ],
      },
    });
    const r = await parse(spec, mem([1, 2, 3, 4, 1, 2, 3, 4, 0xff, 0x34, 0x12, 0x3f, 0x80, 0, 0, 0xff, 0xfe]));
    expect(r.errors).toEqual([]);
    expect(find(r.root, 'a').value).toBe(0x04030201);
    expect(find(r.root, 'b').value).toBe(0x01020304);
    expect(find(r.root, 'c').value).toBe(-1);
    expect(find(r.root, 'd').value).toBe(0x1234);
    expect(find(r.root, 'e').value).toBe(1);
    expect(find(r.root, 'g').value).toBe(-2);
    expect(find(r.root, 'b').offset).toBe(4);
    expect(r.root.size).toBe(17);
  });

  it('uses the spec endian "be" for suffix-less types', async () => {
    const spec = mkSpec({ root: { fields: [f('a', 'u2')] } }, { endian: 'be' });
    const r = await parse(spec, mem([0x12, 0x34]));
    expect(find(r.root, 'a').value).toBe(0x1234);
  });

  it('never falls back to host order when the endian is missing (unvalidated spec)', async () => {
    const spec = rawSpec({ root: { fields: [f('a', 'u2')] } }, { endian: undefined });
    const r = await parse(spec, mem([1, 2]));
    expect(find(r.root, 'a').error).toMatch(/byte order/);
  });

  it('64-bit values are BigInt, smaller ones are Number', async () => {
    const spec = mkSpec({ root: { fields: [f('u', 'u8'), f('s', 's8'), f('w', 'u4')] } });
    const bytes = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 1, 0, 0, 0];
    const r = await parse(spec, mem(bytes));
    expect(find(r.root, 'u').value).toBe(0xffffffffffffffffn);
    expect(find(r.root, 's').value).toBe(-2n);
    expect(typeof find(r.root, 'w').value).toBe('number');
  });
});

describe('strings and bytes', () => {
  it('terminated strings consume the terminator', async () => {
    const spec = mkSpec({ root: { fields: [f('s', 'str', { terminator: 0, encoding: 'ascii' }), f('n', 'u1')] } });
    const r = await parse(spec, mem([0x68, 0x69, 0, 0x78]));
    expect(find(r.root, 's').value).toBe('hi');
    expect(find(r.root, 's').size).toBe(3);
    expect(find(r.root, 'n').value).toBe(0x78);
  });

  it('missing terminator is an error node, not a crash', async () => {
    const spec = mkSpec({ root: { fields: [f('s', 'str', { terminator: 0 })] } });
    const r = await parse(spec, mem([0x68, 0x69]));
    expect(find(r.root, 's').error).toMatch(/terminator/);
  });

  it('decoding is lossy and never throws', async () => {
    const spec = mkSpec({
      root: {
        fields: [f('a', 'str', { size: 2, encoding: 'ascii' }), f('u', 'str', { size: 2, encoding: 'utf8' }), f('w', 'str', { size: 3, encoding: 'utf16le' }), f('l', 'str', { size: 1, encoding: 'latin1' })],
      },
    });
    const r = await parse(spec, mem([0x41, 0xff, 0xc3, 0x28, 0x41, 0x00, 0x42, 0xe9]));
    expect(find(r.root, 'a').value).toBe('A�');
    expect(find(r.root, 'u').value).toBe('�(');
    expect(find(r.root, 'w').value).toBe('A�');
    expect(find(r.root, 'l').value).toBe('é');
  });

  it('str with size and terminator cuts at the terminator but consumes the whole field', async () => {
    const spec = mkSpec({ root: { fields: [f('s', 'str', { size: 6, terminator: 0, encoding: 'ascii' }), f('n', 'u1')] } });
    const r = await parse(spec, mem([0x61, 0x62, 0, 0x7a, 0x7a, 0, 9]));
    expect(find(r.root, 's').value).toBe('ab');
    expect(find(r.root, 'n').value).toBe(9);
  });

  it('small bytes fields are read fully; large ones record only a preview', async () => {
    const spec = mkSpec({ root: { fields: [f('small', 'bytes', { size: 4 }), f('big', 'bytes', { size: 'eos' })] } });
    const data = new Uint8Array(1000).map((_, i) => i & 0xff);
    const r = await parse(spec, new MemoryByteSource(data));
    expect(find(r.root, 'small').value).toEqual(data.slice(0, 4));
    const big = find(r.root, 'big');
    expect(big.size).toBe(996);
    expect((big.value as Uint8Array).length).toBe(16);
    expect(big.display).toMatch(/\(996 bytes\)/);
    expect(r.stats.bytesRead).toBe(4 + 16);
  });
});

describe('substreams, at, if', () => {
  it('confines children to a sized substream', async () => {
    const spec = mkSpec({
      root: { fields: [f('inner', 'inner', { size: 6 }), f('after', 'u1')] },
      inner: { fields: [f('a', 'u2'), f('b', 'u2'), f('c', 'u4')] },
    });
    const r = await parse(spec, mem([1, 0, 2, 0, 3, 0, 0, 0, 0, 0]));
    const inner = find(r.root, 'inner');
    expect(inner.size).toBe(6);
    expect(find(inner, 'b').value).toBe(2);
    expect(find(inner, 'c').error).toMatch(/truncated/); // c would cross the substream end
    expect(r.root.children!.some((c) => c.name === 'after')).toBe(false); // the parent stops after a failed child
  });

  it('clamps a substream larger than its parent and records an error on the node', async () => {
    const spec = mkSpec({
      root: { fields: [f('inner', 'inner', { size: 100 }), f('after', 'u1')] },
      inner: { fields: [f('a', 'u2')] },
    });
    const r = await parse(spec, mem([1, 0, 9, 9]));
    const inner = find(r.root, 'inner');
    expect(inner.size).toBe(4);
    expect(inner.error).toMatch(/exceeds/);
    expect(codes(r)).toContain('bounds');
    expect(r.root.children!.some((c) => c.name === 'after')).toBe(true); // later fields still attempted (and fail cleanly)
  });

  it('a nested substream cannot exceed its parent substream', async () => {
    const spec = mkSpec({
      root: { fields: [f('outer', 'outer', { size: 4 })] },
      outer: { fields: [f('in', 'inner', { size: 50 })] },
      inner: { fields: [f('x', 'u1')] },
    });
    const r = await parse(spec, mem([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(find(r.root, 'outer.in').size).toBe(4);
    expect(find(r.root, 'outer.in').error).toMatch(/exceeds/);
  });

  it('negative sizes are errors', async () => {
    const spec = mkSpec({ root: { fields: [f('n', 'u1'), f('b', 'bytes', { size: 'n - 5' })] } });
    const r = await parse(spec, mem([1, 2, 3]));
    expect(find(r.root, 'b').error).toMatch(/negative/);
  });

  it('"at" positions without advancing the cursor, and out-of-range "at" is an error node', async () => {
    const spec = mkSpec({
      root: { fields: [f('first', 'u1'), f('far', 'u1', { at: 100 }), f('late', 'u1', { at: 3 }), f('second', 'u1')] },
    });
    const r = await parse(spec, mem([10, 20, 30, 40]));
    expect(find(r.root, 'far').error).toMatch(/outside the file/);
    expect(find(r.root, 'late').value).toBe(40);
    expect(find(r.root, 'late').offset).toBe(3);
    expect(find(r.root, 'second').value).toBe(20); // cursor not advanced by the at fields
    expect(codes(r)).toContain('bounds');
  });

  it('"at" must stay inside the enclosing substream', async () => {
    const spec = mkSpec({
      root: { fields: [f('sub', 'sub', { size: 2 })] },
      sub: { fields: [f('x', 'u1', { at: 3 })] },
    });
    const r = await parse(spec, mem([1, 2, 3, 4, 5]));
    expect(find(r.root, 'sub.x').error).toMatch(/enclosing substream/);
  });

  it('"if" skips fields and nodes', async () => {
    const spec = mkSpec({ root: { fields: [f('flag', 'u1'), f('opt', 'u2', { if: 'flag == 1' }), f('end', 'u1')] } });
    const off = await parse(spec, mem([0, 7]));
    expect(off.root.children!.map((c) => c.name)).toEqual(['flag', 'end']);
    const on = await parse(spec, mem([1, 5, 0, 7]));
    expect(find(on.root, 'opt').value).toBe(5);
    expect(find(on.root, 'end').value).toBe(7);
  });

  it('non-boolean "if" is an error', async () => {
    const spec = mkSpec({ root: { fields: [f('a', 'u1'), f('b', 'u1', { if: 'a + 1' })] } });
    const r = await parse(spec, mem([1, 2]));
    expect(find(r.root, 'b').error).toMatch(/boolean/);
  });
});

describe('expressions in context', () => {
  it('supports _parent, _root, _index, _io and `_` in until', async () => {
    const spec = mkSpec({
      root: { fields: [f('n', 'u1'), f('items', 'item', { repeat: { count: 'n' } }), f('rest', 'bytes', { size: '_io.size - _io.pos' }), f('done', 'u1', { if: '!_io.eof' })] },
      item: { fields: [f('v', 'u1'), f('is_root_n', 'u1', { if: '_parent.n == _root.n && v == _index + 1' })] },
    });
    const r = await parse(spec, mem([2, 1, 5, 2, 6, 99]));
    expect(find(r.root, 'items.items[0]').children!.map((c) => c.name)).toEqual(['v', 'is_root_n']);
    expect(find(r.root, 'items.items[1]').children!.map((c) => c.name)).toEqual(['v', 'is_root_n']);
    expect(find(r.root, 'rest').size).toBe(1);
    expect(r.root.children!.some((c) => c.name === 'done')).toBe(false);
  });

  it('unknown names are error nodes with a diagnostic', async () => {
    const spec = rawSpec({ root: { fields: [f('a', 'u1', { if: 'nope == 1' })] } });
    const r = await parse(spec, mem([1]));
    expect(find(r.root, 'a').error).toMatch(/unknown name 'nope'/);
    expect(codes(r)).toContain('expr');
  });
});

describe('switch, enum, bits, expect', () => {
  it('switch picks a type by value, with default', async () => {
    const spec = mkSpec({
      root: { fields: [f('tag', 'u1'), f('body', { switch: 'tag', cases: { '1': 'u1', '0x2': 'u2', '"x"': 'u1' }, default: 'bytes' }, { size: 3 })] },
    });
    const one = await parse(spec, mem([1, 9, 9, 9]));
    expect(find(one.root, 'body').typeName).toBe('u1');
    const two = await parse(spec, mem([2, 1, 0, 0]));
    expect(find(two.root, 'body').typeName).toBe('u2');
    const other = await parse(spec, mem([7, 1, 2, 3]));
    expect(find(other.root, 'body').typeName).toBe('bytes');
    expect(find(other.root, 'body').size).toBe(3);
  });

  it('switch without a matching case or default is an error', async () => {
    const spec = mkSpec({ root: { fields: [f('tag', 'u1'), f('body', { switch: 'tag', cases: { '1': 'u1' } })] } });
    const r = await parse(spec, mem([5, 0]));
    expect(find(r.root, 'body').error).toMatch(/no switch case/);
  });

  it('enums give a label, unknown values are kept', async () => {
    const spec = mkSpec({ root: { fields: [f('a', 'u1', { enum: 'e' }), f('b', 'u1', { enum: 'e' })] } }, { enums: { e: { '0': 'ZERO', '0x01': 'ONE' } } });
    const r = await parse(spec, mem([1, 9]));
    const a = find(r.root, 'a');
    expect(a.enumName).toBe('e');
    expect(a.enumLabel).toBe('ONE');
    expect(a.display).toBe('ONE (1)');
    expect(find(r.root, 'b').enumLabel).toBeUndefined();
    expect(find(r.root, 'b').display).toMatch(/unknown e/);
  });

  it('bits: bit 0 is the least significant bit after endian conversion', async () => {
    const spec = mkSpec({ root: { fields: [f('flags', 'u2be', { bits: [{ name: 'lo', offset: 0, width: 4 }, { name: 'mid', offset: 4, width: 8 }, { name: 'top', offset: 15, width: 1 }] })] } });
    const r = await parse(spec, mem([0x80, 0x1a])); // value 0x801A
    expect(find(r.root, 'flags').value).toBe(0x801a);
    expect(find(r.root, 'flags.lo').value).toBe(0xa);
    expect(find(r.root, 'flags.mid').value).toBe(0x01);
    expect(find(r.root, 'flags.top').value).toBe(1);
  });

  it('expect mismatches are validation errors and parsing continues', async () => {
    const spec = mkSpec({ root: { fields: [f('magic', 'str', { size: 2, encoding: 'ascii', expect: 'BM' }), f('v', 'u1', { expect: 1 }), f('after', 'u1')] } });
    const r = await parse(spec, mem([0x41, 0x42, 2, 7]));
    expect(find(r.root, 'magic').validation).toEqual(['expected "BM", found "AB"']);
    expect(find(r.root, 'v').validation).toEqual(['expected 1, found 2']);
    expect(find(r.root, 'after').value).toBe(7);
    expect(codes(r).filter((c) => c === 'validation')).toHaveLength(2);
    const good = await parse(spec, mem([0x42, 0x4d, 1, 7]));
    expect(good.errors).toEqual([]);
  });
});

describe('repeat', () => {
  it('count, until and eos', async () => {
    const spec = mkSpec({
      root: { fields: [f('c', 'u1', { repeat: { count: 3 } }), f('u', 'u1', { repeat: { until: '_ == 0' } }), f('e', 'u2', { repeat: 'eos' })] },
    });
    const r = await parse(spec, mem([1, 2, 3, 5, 6, 0, 9, 0, 8, 0]));
    expect(r.errors).toEqual([]);
    expect(find(r.root, 'c').children!.map((c) => c.value)).toEqual([1, 2, 3]);
    expect(find(r.root, 'u').children!.map((c) => c.value)).toEqual([5, 6, 0]);
    expect(find(r.root, 'e').children!.map((c) => c.value)).toEqual([9, 8]);
    expect(find(r.root, 'e').size).toBe(4);
  });

  it('count 0 yields an empty array; negative counts are errors', async () => {
    const spec = mkSpec({ root: { fields: [f('n', 's1'), f('a', 'u1', { repeat: { count: 'n' } })] } });
    expect(find((await parse(spec, mem([0]))).root, 'a').children).toEqual([]);
    expect(find((await parse(spec, mem([0xff]))).root, 'a').error).toMatch(/negative/);
  });

  it('until that never becomes true is an error at the end of the stream', async () => {
    const spec = mkSpec({ root: { fields: [f('u', 'u1', { repeat: { until: '_ == 0' } })] } });
    const r = await parse(spec, mem([1, 2, 3]));
    expect(find(r.root, 'u').error).toMatch(/never became true/);
    expect(find(r.root, 'u').children).toHaveLength(3);
  });

  it('a zero-size element type with a huge count is an error and does no work', async () => {
    const spec = mkSpec({ root: { fields: [f('z', 'empty', { repeat: { count: '0xFFFFFFFFFFFFFFFF' } })] }, empty: { fields: [] } });
    const r = await parse(spec, mem([1, 2, 3]));
    expect(find(r.root, 'z').error ?? r.errors[0]?.message).toMatch(/zero size/);
    expect(codes(r)).toContain('array');
    expect(r.stats.steps).toBeLessThan(10);
  });

  it('dynamically zero-size elements (all fields skipped) are caught after the first element', async () => {
    const spec = mkSpec({ root: { fields: [f('z', 'maybe', { repeat: { count: '0xFFFFFFFF' } })] }, maybe: { fields: [f('x', 'u1', { if: 'false' })] } });
    const r = await parse(spec, mem(new Array(50).fill(0)));
    expect(r.errors.some((e) => /consumed no bytes/.test(e.message))).toBe(true);
    expect(find(r.root, 'z').children!.length).toBeLessThanOrEqual(1);
    expect(r.stats.steps).toBeLessThan(20);
  });

  it('a count of 2^64-1 is capped by the remaining bytes', async () => {
    const spec = mkSpec({ root: { fields: [f('a', 'u1', { repeat: { count: '0xFFFFFFFFFFFFFFFF' } })] } });
    const r = await parse(spec, mem(new Array(10).fill(7)));
    const a = find(r.root, 'a');
    expect(a.children).toHaveLength(10);
    expect(a.error).toMatch(/clamped to 10/);
    expect(codes(r)).toContain('array');
  });

  it('the cap uses the element size', async () => {
    const spec = mkSpec({ root: { fields: [f('a', 'u4', { repeat: { count: 1000 } })] } });
    const r = await parse(spec, mem(new Array(40).fill(1)));
    expect(find(r.root, 'a').children).toHaveLength(10);
  });
});

describe('limits and cancellation', () => {
  it('detects an "at" cycle on the current path', async () => {
    const spec = mkSpec({ root: { fields: [f('x', 'u1'), f('next', 'root', { at: 0 })] } });
    const r = await parse(spec, mem([0, 0, 0]));
    expect(codes(r)).toContain('cycle');
    expect(find(r.root, 'next').error).toMatch(/cycle/);
  });

  it('stops at the node limit with a partial tree and no throw', async () => {
    const spec = mkSpec({ root: { fields: [f('a', 'u1', { repeat: { count: 500 } })] } });
    const r = await parse(spec, mem(new Array(500).fill(1)), { limits: { maxNodes: 20 } });
    expect(r.stats.truncated).toBe(true);
    expect(r.stats.nodes).toBeLessThanOrEqual(20);
    expect(codes(r)).toContain('limit');
    expect(find(r.root, 'a').children!.length).toBeGreaterThan(0);
  });

  it('stops at the step budget', async () => {
    const spec = mkSpec({ root: { fields: [f('a', 'u1', { repeat: 'eos' })] } });
    const r = await parse(spec, mem(new Array(500).fill(1)), { limits: { maxSteps: 50 } });
    expect(r.stats.truncated).toBe(true);
    expect(r.errors.some((e) => /step budget/.test(e.message))).toBe(true);
  });

  it('stops at the recursion depth limit', async () => {
    const spec = mkSpec({
      root: { fields: [f('n', 'u1'), f('child', 'root', { size: '_io.size - 1', if: '_io.size > 1' })] },
    });
    const r = await parse(spec, mem(new Array(200).fill(1)));
    expect(r.stats.truncated).toBe(true);
    expect(r.errors.some((e) => /nesting depth/.test(e.message))).toBe(true);
    let depth = 0;
    for (let n = r.root; n.children?.some((c) => c.name === 'child'); n = find(n, 'child')) depth++;
    expect(depth).toBeLessThanOrEqual(65);
    const shallow = await parse(spec, mem(new Array(200).fill(1)), { limits: { maxDepth: 3 } });
    expect(shallow.stats.truncated).toBe(true);
  });

  it('honours an already-aborted signal', async () => {
    const spec = mkSpec({ root: { fields: [f('a', 'u1')] } });
    const ac = new AbortController();
    ac.abort();
    const r = await parse(spec, mem([1]), { signal: ac.signal });
    expect(r.stats.aborted).toBe(true);
    expect(codes(r)).toContain('aborted');
    expect(r.root.children).toEqual([]);
  });

  it('honours an abort that happens mid-parse', async () => {
    const spec = mkSpec({ root: { fields: [f('a', 'u1', { repeat: { count: 100 } })] } });
    const ac = new AbortController();
    const inner = mem(new Array(100).fill(1));
    let reads = 0;
    const source: ByteSource = {
      size: inner.size,
      async read(o, l) {
        if (++reads === 5) ac.abort();
        return inner.read(o, l);
      },
    };
    const r = await parse(spec, source, { signal: ac.signal });
    expect(r.stats.aborted).toBe(true);
    expect(find(r.root, 'a').children!.length).toBeLessThan(10);
  });

  it('turns source read failures into error nodes', async () => {
    const spec = mkSpec({ root: { fields: [f('a', 'u1'), f('b', 'u1')] } });
    const source: ByteSource = {
      size: 2,
      async read(o) {
        if (o === 1) throw new Error('disk on fire');
        return new Uint8Array([1]);
      },
    };
    const r = await parse(spec, source);
    expect(find(r.root, 'a').value).toBe(1);
    expect(find(r.root, 'b').error).toMatch(/disk on fire/);
    expect(codes(r)).toContain('read');
  });

  it('survives an unvalidated, hostile spec', async () => {
    const spec = rawSpec({ root: { fields: [f('a', 'nope'), f('b', 'u1')] } }, { root: 'constructor' });
    const r = await parse(spec, mem([1]));
    expect(r.errors.length).toBeGreaterThan(0);
    const r2 = await parse(rawSpec({ root: { fields: [f('a', 'toString')] } }), mem([1]));
    expect(find(r2.root, 'a').error).toMatch(/unknown type/);
  });

  it('handles an empty file', async () => {
    const spec = mkSpec({ root: { fields: [f('a', 'u4')] } });
    const r = await parse(spec, mem([]));
    expect(find(r.root, 'a').error).toMatch(/truncated/);
  });
});

describe('lazy arrays', () => {
  const fixedSpec = () => mkSpec({ root: { fields: [f('table', 'u4', { repeat: { count: 5000 } }), f('tail', 'u1')] } });
  const fixedData = () => {
    const d = new Uint8Array(20_001);
    const dv = new DataView(d.buffer);
    for (let i = 0; i < 5000; i++) dv.setUint32(i * 4, i, true);
    d[20_000] = 0xee;
    return d;
  };

  it('large fixed-size arrays are lazy: no elements parsed up front', async () => {
    const r = await parse(fixedSpec(), new MemoryByteSource(fixedData()));
    const t = find(r.root, 'table');
    expect(t.lazy).toEqual({ start: 0, count: 5000, elemType: 'u4', elemSize: 4, loaded: 0, resumeOffset: null });
    expect(t.children).toEqual([]);
    expect(t.size).toBe(20_000);
    expect(find(r.root, 'tail').offset).toBe(20_000);
    expect(find(r.root, 'tail').value).toBe(0xee);
    expect(r.stats.nodes).toBeLessThan(10);
    expect(r.stats.bytesRead).toBe(1);
  });

  it('expandLazy parses a window of a fixed-size array', async () => {
    const src = new MemoryByteSource(fixedData());
    const r = await parse(fixedSpec(), src);
    const t = find(r.root, 'table');
    const nodes = await expandLazy(r, t.id, { start: 10, count: 3 });
    expect(nodes.map((n) => n.value)).toEqual([10, 11, 12]);
    expect(nodes.map((n) => n.offset)).toEqual([40, 44, 48]);
    expect(nodes.map((n) => n.name)).toEqual(['table[10]', 'table[11]', 'table[12]']);
    // clamped at the end
    const end = await expandLazy(r, t.id, { start: 4998, count: 50 });
    expect(end.map((n) => n.value)).toEqual([4998, 4999]);
    expect(await expandLazy(r, t.id, { start: 5000, count: 5 })).toEqual([]);
  });

  it('expandLazy of struct elements gives them children and the owner as _parent', async () => {
    const spec = mkSpec({
      root: { fields: [f('k', 'u1'), f('recs', 'rec', { repeat: { count: 2000 } })] },
      rec: { fields: [f('a', 'u1'), f('b', 'u1'), f('same', 'u1', { if: '_parent.k == a' })] },
    });
    // static size of rec is unknown because of "if", so this exercises the variable path too
    const d = new Uint8Array(1 + 2000 * 3).fill(0);
    d[0] = 7;
    for (let i = 0; i < 2000; i++) d[1 + i * 3] = 7;
    const r = await parse(spec, new MemoryByteSource(d));
    const recs = find(r.root, 'recs');
    expect(recs.lazy?.elemSize).toBeNull();
    expect(recs.children).toHaveLength(1000);
    const more = await expandLazy(r, recs.id, { start: 1500, count: 2 });
    expect(more.map((n) => n.name)).toEqual(['recs[1500]', 'recs[1501]']);
    expect(find(more[0]!, 'same').offset).toBe(1 + 1500 * 3 + 2);
  });

  it('fixed-size struct elements are lazy and expand correctly', async () => {
    const spec = mkSpec({
      root: { fields: [f('recs', 'rec', { repeat: { count: 3000 } })] },
      rec: { fields: [f('a', 'u2'), f('b', 'u1')] },
    });
    const d = new Uint8Array(9000);
    for (let i = 0; i < 3000; i++) d[i * 3 + 2] = i & 0xff;
    const r = await parse(spec, new MemoryByteSource(d));
    const recs = find(r.root, 'recs');
    expect(recs.lazy?.elemSize).toBe(3);
    const nodes = await expandLazy(r, recs.id, { start: 2999, count: 1 });
    expect(nodes[0]!.offset).toBe(2999 * 3);
    expect(find(nodes[0]!, 'b').value).toBe(2999 & 0xff);
    expect(lazyElementIndexAt(recs, 2999 * 3 + 1)).toBe(2999);
    expect(lazyElementIndexAt(recs, 9000)).toBeNull();
  });

  describe('variable-size elements', () => {
    // record: len u1, then len bytes -> size 1 + len. 3000 records of len 1 => 2 bytes each.
    const spec = () =>
      mkSpec({
        root: { fields: [f('items', 'rec', { repeat: 'eos' }), f('never', 'u1', { if: 'false' })] },
        rec: { fields: [f('len', 'u1'), f('data', 'bytes', { size: 'len' })] },
      });
    const data = () => {
      const d = new Uint8Array(6000);
      for (let i = 0; i < 3000; i++) {
        d[i * 2] = 1;
        d[i * 2 + 1] = i & 0xff;
      }
      return d;
    };

    it('parses the first N eagerly and exposes a continuation', async () => {
      const r = await parse(spec(), new MemoryByteSource(data()));
      const items = find(r.root, 'items');
      expect(items.children).toHaveLength(1000);
      expect(items.lazy).toEqual({ start: 0, count: 3000, elemType: 'rec', elemSize: null, loaded: 1000, resumeOffset: 2000 });
      expect(items.size).toBe(6000); // the whole array was skimmed to find its end
      expect(r.stats.nodes).toBeLessThan(3100);
    });

    it('expandLazy resumes, appends, and advances the continuation', async () => {
      const r = await parse(spec(), new MemoryByteSource(data()));
      const items = find(r.root, 'items');
      const got = await expandLazy(r, items.id, { start: 990, count: 30 });
      expect(got).toHaveLength(30);
      expect(got[0]!.name).toBe('items[990]');
      expect(got[29]!.name).toBe('items[1019]');
      expect(items.children).toHaveLength(1020);
      expect(items.lazy).toMatchObject({ loaded: 1020, resumeOffset: 2040, count: 3000 });
      const tail = await expandLazy(r, items.id, { start: 2990, count: 100 });
      expect(tail.map((n) => n.name)).toEqual(Array.from({ length: 10 }, (_, i) => `items[${2990 + i}]`));
      expect(items.lazy).toMatchObject({ loaded: 3000, resumeOffset: null, count: 3000 });
      expect(find(items.children![2999]!, 'data').value).toEqual(Uint8Array.of(2999 & 0xff));
    });

    it('serialises overlapping expansions', async () => {
      const r = await parse(spec(), new MemoryByteSource(data()));
      const items = find(r.root, 'items');
      const [a, b] = await Promise.all([expandLazy(r, items.id, { start: 1000, count: 10 }), expandLazy(r, items.id, { start: 1005, count: 10 })]);
      expect(a.map((n) => n.name)).toEqual(Array.from({ length: 10 }, (_, i) => `items[${1000 + i}]`));
      expect(b.map((n) => n.name)).toEqual(Array.from({ length: 10 }, (_, i) => `items[${1005 + i}]`));
      expect(new Set(items.children!.map((n) => n.id)).size).toBe(items.children!.length);
    });

    it('an array placed with "at" is not skimmed; its count may be unknown', async () => {
      const s = mkSpec({
        root: { fields: [f('items', 'rec', { repeat: 'eos', at: 0 })] },
        rec: { fields: [f('len', 'u1'), f('data', 'bytes', { size: 'len' })] },
      });
      const r = await parse(s, new MemoryByteSource(data()));
      const items = find(r.root, 'items');
      expect(items.children).toHaveLength(1000);
      expect(items.lazy).toMatchObject({ count: null, loaded: 1000, resumeOffset: 2000 });
      expect(items.size).toBe(2000);
      await expandLazy(r, items.id, { start: 0, count: 5000 }); // clamped by maxLazyRange but the array ends first
      expect(items.lazy).toMatchObject({ count: 3000, resumeOffset: null });
      expect(items.size).toBe(6000);
    });
  });

  it('expandLazy rejects unknown nodes and bad ranges without throwing', async () => {
    const r = await parse(fixedSpec(), new MemoryByteSource(fixedData()));
    expect(await expandLazy(r, 99999, { start: 0, count: 1 })).toEqual([]);
    const t = find(r.root, 'table');
    expect(await expandLazy(r, t.id, { start: -1, count: 1 })).toEqual([]);
    expect(await expandLazy(r, t.id, { start: 0, count: Number.NaN })).toEqual([]);
    expect(r.errors.filter((e) => e.code === 'lazy')).toHaveLength(3);
  });

  it('caps one expansion at maxLazyRange', async () => {
    const r = await parse(fixedSpec(), new MemoryByteSource(fixedData()), { limits: { maxLazyRange: 25 } });
    const nodes = await expandLazy(r, find(r.root, 'table').id, { start: 0, count: 5000 });
    expect(nodes).toHaveLength(25);
  });
});

describe('findNodeAt', () => {
  const spec = () =>
    mkSpec({
      root: { fields: [f('a', 'u2'), f('s', 'inner'), f('far', 'u1', { at: 6 }), f('flags', 'u1', { bits: [{ name: 'x', offset: 0, width: 1 }] })] },
      inner: { fields: [f('x', 'u1'), f('y', 'u1')] },
    });

  it('returns the deepest node covering the offset', async () => {
    const r = await parse(spec(), mem([1, 0, 2, 3, 4, 0, 5, 6]));
    expect(findNodeAt(r.root, 0)!.name).toBe('a');
    expect(findNodeAt(r.root, 1)!.name).toBe('a');
    expect(findNodeAt(r.root, 2)!.name).toBe('x');
    expect(findNodeAt(r.root, 3)!.name).toBe('y');
    expect(findNodeAt(r.root, 4)!.name).toBe('flags'); // an integer, not its bit child
    expect(findNodeAt(r.root, 6)!.name).toBe('far'); // placed with "at", outside the sequential extent
  });

  it('returns null for offsets outside any node', async () => {
    const r = await parse(spec(), mem([1, 0, 2, 3, 4, 0, 5, 6]));
    expect(findNodeAt(r.root, 5)).toBeNull();
    expect(findNodeAt(r.root, 8)).toBeNull();
    expect(findNodeAt(r.root, -1)).toBeNull();
    expect(findNodeAt(r.root, Number.NaN)).toBeNull();
  });

  it('returns the lazy array node for offsets inside an unexpanded range', async () => {
    const s = mkSpec({ root: { fields: [f('t', 'u1', { repeat: { count: 3000 } })] } });
    const r = await parse(s, new MemoryByteSource(new Uint8Array(3000)));
    expect(findNodeAt(r.root, 2500)!.name).toBe('t');
  });
});

describe('ids', () => {
  it('node ids are unique within a parse', async () => {
    const spec = mkSpec({ root: { fields: [f('a', 'u1', { repeat: { count: 50 } }), f('s', 'inner')] }, inner: { fields: [f('x', 'u1')] } });
    const r = await parse(spec, mem(new Array(60).fill(1)));
    const ids: number[] = [];
    const walk = (n: typeof r.root): void => {
      ids.push(n.id);
      n.children?.forEach(walk);
    };
    walk(r.root);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(r.stats.nodes);
  });
});
