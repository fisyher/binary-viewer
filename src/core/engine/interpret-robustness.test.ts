import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../byte-source';
import { MemoryByteSource } from '../byte-source';
import { expandLazy, findNodeAt, parse } from './interpret';
import type { Node } from './interpret';
import { find, mem, mkSpec } from './test-helpers';

const f = (name: string, type: unknown, extra: Record<string, unknown> = {}) => ({ name, type, ...extra });
const codes = (r: { errors: Array<{ code: string }> }) => r.errors.map((e) => e.code);

/** 3000 records of [len=1, byte]; element size is variable as far as the engine knows. */
const recSpec = (extraRoot: unknown[] = []) =>
  mkSpec({
    root: { fields: [f('head', 'u1'), f('items', 'rec', { repeat: { count: 3000 } }), ...extraRoot] },
    rec: { fields: [f('len', 'u1'), f('data', 'bytes', { size: 'len' })] },
  });
const recData = () => {
  const d = new Uint8Array(1 + 6000 + 1);
  d[0] = 9;
  for (let i = 0; i < 3000; i++) {
    d[1 + i * 2] = 1;
    d[2 + i * 2] = i & 0xff;
  }
  d[6001] = 7;
  return d;
};
const names = (n: Node) => (n.children ?? []).map((c) => c.name);
const expectContiguous = (items: Node) => expect(names(items)).toEqual(Array.from({ length: items.children!.length }, (_, i) => `items[${i}]`));

describe('expandLazy robustness (variable-size arrays)', () => {
  it('a node-limit Halt mid-expand leaves no partial element; later calls continue with correct indices', async () => {
    const r = await parse(recSpec(), new MemoryByteSource(recData()), { limits: { maxNodes: 3100 } });
    const items = find(r.root, 'items');
    expect(items.children).toHaveLength(1000);
    let calls = 0;
    while (items.lazy!.resumeOffset !== null && calls++ < 6) {
      const before = items.children!.length;
      await expandLazy(r, items.id, { start: before, count: 5000 });
      expectContiguous(items); // no duplicates, no half-built tail, indices intact
      expect(items.lazy!.loaded).toBe(items.children!.length);
      expect(items.error).toBeUndefined(); // transient halts must not poison the array
    }
    expect(calls).toBeGreaterThan(1); // it really was halted at least once
    expect(codes(r)).toContain('limit');
    expect(items.children).toHaveLength(3000);
    expect(items.lazy).toMatchObject({ count: 3000, loaded: 3000, resumeOffset: null });
    expect(find(items.children![2999]!, 'data').value).toEqual(Uint8Array.of(2999 & 0xff));
  });

  it('an abort mid-expand is transient: nothing sticks and a retry succeeds', async () => {
    const data = recData();
    const inner = new MemoryByteSource(data);
    let reads = 0;
    let abortAt = Infinity;
    const ac = new AbortController();
    const source: ByteSource = {
      size: inner.size,
      async read(o, l) {
        if (++reads === abortAt) ac.abort();
        return inner.read(o, l);
      },
    };
    const r = await parse(recSpec(), source);
    const items = find(r.root, 'items');
    abortAt = reads + 60;
    const got = await expandLazy(r, items.id, { start: 1000, count: 500 }, { signal: ac.signal });
    expect(r.errors.some((e) => e.code === 'aborted')).toBe(true);
    expect(got.length).toBeLessThan(500);
    expectContiguous(items);
    expect(items.error).toBeUndefined();
    expect(items.lazy!.loaded).toBe(items.children!.length);
    const retry = await expandLazy(r, items.id, { start: 1000, count: 500 });
    expect(retry.map((n) => n.name)).toEqual(Array.from({ length: 500 }, (_, i) => `items[${1000 + i}]`));
    expectContiguous(items);
  });

  it('start is capped: a huge start does no work and reports it', async () => {
    const s = mkSpec({
      root: { fields: [f('items', 'rec', { repeat: 'eos', at: 0 })] },
      rec: { fields: [f('len', 'u1'), f('data', 'bytes', { size: 'len' })] },
    });
    const src = new MemoryByteSource(recData().subarray(1));
    const r = await parse(s, src);
    const items = find(r.root, 'items');
    expect(items.lazy!.count).toBeNull();
    const bytesBefore = r.stats.bytesRead;
    const out = await expandLazy(r, items.id, { start: 1e9, count: 10 });
    expect(out).toEqual([]);
    expect(r.errors.some((e) => e.code === 'lazy' && /more than/.test(e.message))).toBe(true);
    expect(items.children).toHaveLength(1000);
    // an in-reach start still works, and never parses more than maxLazyRange beyond what is loaded
    const ok = await expandLazy(r, items.id, { start: 1000, count: 3 });
    expect(ok).toHaveLength(3);
  });

  it('start beyond a known count is rejected; start == count is an empty window', async () => {
    const fixed = mkSpec({ root: { fields: [f('t', 'u4', { repeat: { count: 5000 } })] } });
    const r = await parse(fixed, new MemoryByteSource(new Uint8Array(20_000)));
    const t = find(r.root, 't');
    expect(await expandLazy(r, t.id, { start: 1e9, count: 5 })).toEqual([]);
    expect(await expandLazy(r, t.id, { start: 5001, count: 5 })).toEqual([]);
    expect(r.errors.filter((e) => e.code === 'lazy')).toHaveLength(2);
    expect(await expandLazy(r, t.id, { start: 5000, count: 5 })).toEqual([]);
    expect(r.errors.filter((e) => e.code === 'lazy')).toHaveLength(2);

    const v = await parse(recSpec(), new MemoryByteSource(recData()));
    const items = find(v.root, 'items');
    expect(await expandLazy(v, items.id, { start: 1e9, count: 5 })).toEqual([]);
    expect(items.children).toHaveLength(1000);
  });

  it('stale ids and bad ranges cannot grow result.errors without bound', async () => {
    const r = await parse(recSpec(), new MemoryByteSource(recData()), { limits: { maxDiagnostics: 5 } });
    for (let i = 0; i < 500; i++) await expandLazy(r, 424242, { start: 0, count: 1 });
    expect(r.errors.length).toBeLessThanOrEqual(5);
    expect(r.stats.suppressedDiagnostics).toBeGreaterThan(400);
  });
});

describe('skimming', () => {
  // each element holds a nested fixed-size array big enough to become lazy
  const nestedSpec = () =>
    mkSpec({
      root: { fields: [f('items', 'rec', { repeat: 'eos' })] },
      rec: { fields: [f('cnt', 'u2'), f('vals', 'u1', { repeat: { count: 'cnt' } })] },
    });
  const nestedData = (n: number, cnt: number) => {
    const d = new Uint8Array(n * (2 + cnt));
    for (let i = 0; i < n; i++) {
      d[i * (2 + cnt)] = cnt & 0xff;
      d[i * (2 + cnt) + 1] = cnt >> 8;
      d[i * (2 + cnt) + 2] = i & 0xff;
    }
    return d;
  };

  it('skimmed elements with nested lazy arrays are harmless; the same elements expand with working nested lazies', async () => {
    const r = await parse(nestedSpec(), new MemoryByteSource(nestedData(1100, 1200)));
    const items = find(r.root, 'items');
    expect(items.children).toHaveLength(1000);
    expect(items.size).toBe(1100 * 1202);
    expect(r.stats.nodes).toBeLessThan(4100); // skimmed nodes are not charged to the node budget
    expect(r.errors).toEqual([]);
    const [el] = await expandLazy(r, items.id, { start: 1050, count: 1 });
    expect(el!.name).toBe('items[1050]');
    const vals = find(el!, 'vals');
    expect(vals.lazy).toMatchObject({ count: 1200, elemSize: 1 });
    const nested = await expandLazy(r, vals.id, { start: 0, count: 2 });
    expect(nested.map((n) => n.value)).toEqual([1050 & 0xff, 0]);
  });

  it('an exhausted skim budget makes the array incomplete but keeps siblings and `at` fields', async () => {
    const spec = recSpec([f('tail', 'u1'), f('marker', 'u1', { at: 0 })]);
    const r = await parse(spec, new MemoryByteSource(recData()), { limits: { maxSkimNodes: 50 } });
    const items = find(r.root, 'items');
    expect(items.error).toMatch(/skim budget exhausted.*incomplete/);
    expect(items.children).toHaveLength(1000);
    expect(items.lazy!.count).toBeNull(); // the true count is unknown
    expect(find(r.root, 'head').value).toBe(9); // earlier sibling kept
    expect(r.root.children!.some((c) => c.name === 'tail')).toBe(false); // sequential parsing stopped
    expect(find(r.root, 'marker').value).toBe(9); // `at` field still parsed
    expect(r.stats.truncated).toBe(true);
    expect(codes(r)).toContain('limit');
    expectContiguous(items);
  });

  it('a Halt during the skim ends the parse with a clean partial tree and no continuation', async () => {
    const data = recData();
    const inner = new MemoryByteSource(data);
    const ac = new AbortController();
    let reads = 0;
    const source: ByteSource = {
      size: inner.size,
      async read(o, l) {
        if (++reads === 2300) ac.abort(); // 2 reads per element: 1000 kept elements need ~2000 reads
        return inner.read(o, l);
      },
    };
    const r = await parse(recSpec(), source, { signal: ac.signal });
    const items = find(r.root, 'items');
    expect(r.stats.aborted).toBe(true);
    expect(items.children).toHaveLength(1000);
    expectContiguous(items);
    expect(items.lazy).toBeUndefined();
    expect(await expandLazy(r, items.id, { start: 0, count: 1 })).toEqual([]);
  });

  it('a step-budget Halt in the middle of the kept elements leaves only whole elements', async () => {
    const r = await parse(recSpec(), new MemoryByteSource(recData()), { limits: { maxSteps: 1500 } });
    const items = find(r.root, 'items');
    expect(r.stats.truncated).toBe(true);
    expect(items.children!.length).toBeGreaterThan(100);
    expectContiguous(items);
    for (const c of items.children!) expect(c.children).toHaveLength(2);
  });
});

describe('eager eos with a trailing partial element', () => {
  it('is a warning like the lazy path, and the struct keeps going', async () => {
    const spec = mkSpec({ root: { fields: [f('a', 'u4', { repeat: 'eos' }), f('rest', 'u2')] } });
    const r = await parse(spec, mem([1, 0, 0, 0, 2, 0, 0, 0, 0xaa, 0xbb]));
    const a = find(r.root, 'a');
    expect(a.children).toHaveLength(2);
    expect(a.error).toBeUndefined();
    expect(a.validation![0]).toMatch(/2 trailing byte/);
    expect(r.errors.map((e) => e.severity)).toEqual(['warning']);
    expect(find(r.root, 'rest').value).toBe(0xbbaa);
  });

  it('lazy and eager paths agree', async () => {
    const spec = mkSpec({ root: { fields: [f('a', 'u1', { repeat: 'eos' })] } });
    const eager = await parse(spec, mem(new Array(5).fill(1)));
    expect(eager.errors).toEqual([]);
    const lazySpec = mkSpec({ root: { fields: [f('a', 'u2', { repeat: 'eos' })] } });
    const lazy = await parse(lazySpec, new MemoryByteSource(new Uint8Array(4001)));
    expect(find(lazy.root, 'a').lazy!.count).toBe(2000);
    expect(find(lazy.root, 'a').validation![0]).toMatch(/1 trailing byte/);
  });
});

describe('float expect', () => {
  it('compares f4 with single-precision rounding and treats -0 as 0', async () => {
    const spec = mkSpec({
      root: { fields: [f('x', 'f4be', { expect: 0.1 }), f('z', 'f4be', { expect: 0 }), f('y', 'f8be', { expect: 0.1 }), f('bad', 'f4be', { expect: 0.2 })] },
    });
    const dv = new DataView(new ArrayBuffer(20));
    dv.setFloat32(0, 0.1);
    dv.setUint32(4, 0x80000000); // -0
    dv.setFloat64(8, 0.1);
    dv.setFloat32(16, 0.1);
    const r = await parse(spec, new MemoryByteSource(new Uint8Array(dv.buffer)));
    expect(find(r.root, 'x').validation).toBeUndefined();
    expect(find(r.root, 'z').validation).toBeUndefined();
    expect(find(r.root, 'y').validation).toBeUndefined();
    expect(find(r.root, 'bad').validation![0]).toMatch(/expected 0.2/);
  });
});

describe('findNodeAt ties', () => {
  it('prefers the narrowest range at equal depth', async () => {
    const spec = mkSpec({ root: { fields: [f('wide', 'bytes', { size: 4 }), f('narrow', 'u1', { at: 1 })] } });
    const r = await parse(spec, mem([1, 2, 3, 4]));
    expect(findNodeAt(r.root, 1)!.name).toBe('narrow');
    expect(findNodeAt(r.root, 2)!.name).toBe('wide');
  });

  it('searches inside detached expandLazy nodes when given one as root', async () => {
    const spec = mkSpec({
      root: { fields: [f('recs', 'rec', { repeat: { count: 3000 } })] },
      rec: { fields: [f('a', 'u2'), f('b', 'u1')] },
    });
    const r = await parse(spec, new MemoryByteSource(new Uint8Array(9000)));
    const [el] = await expandLazy(r, find(r.root, 'recs').id, { start: 5, count: 1 });
    expect(findNodeAt(r.root, 15)!.name).toBe('recs'); // the tree only knows the lazy array
    expect(findNodeAt(el!, 17)!.name).toBe('b');
  });
});

describe('null semantics, short-circuiting and failure containment', () => {
  it('short-circuit: the unevaluated side may reference fields that do not exist yet', async () => {
    const spec = mkSpec({
      root: { fields: [f('a', 'u1', { if: 'false and later == 1' }), f('b', 'u1', { if: 'true or later == 1' }), f('c', 'u1', { if: 'true ? true : later == 1' }), f('later', 'u1')] },
    });
    const r = await parse(spec, mem([1, 2, 3]));
    expect(r.errors).toEqual([]);
    expect(r.root.children!.map((c) => c.name)).toEqual(['b', 'c', 'later']);
  });

  it('fields skipped by `if` are null; arithmetic on them is a per-expression error that does not stop the struct', async () => {
    const spec = mkSpec({
      root: {
        fields: [
          f('flag', 'u1'),
          f('opt', 'u1', { if: 'flag == 1' }),
          f('absent', 'u1', { if: 'opt == null' }),
          f('present', 'u1', { if: 'opt != null' }),
          f('bad', 'u1', { if: 'opt + 1 == 2' }),
          f('after', 'u1'),
        ],
      },
    });
    const off = await parse(spec, mem([0, 5, 6]));
    expect(off.root.children!.map((c) => c.name)).toEqual(['flag', 'absent', 'bad', 'after']);
    expect(find(off.root, 'bad').error).toMatch(/needs integers, got null/);
    expect(find(off.root, 'absent').value).toBe(5);
    expect(find(off.root, 'after').value).toBe(6); // the struct carried on
    const on = await parse(spec, mem([1, 1, 5, 6, 7]));
    expect(on.root.children!.map((c) => c.name)).toEqual(['flag', 'opt', 'present', 'bad', 'after']);
    expect(on.errors).toEqual([]);
  });

  it('members of raw-bytes fields and failed structs read as null', async () => {
    const spec = mkSpec({
      root: {
        fields: [
          f('tag', 'u1'),
          f('body', { switch: 'tag', cases: { '1': 'u1' }, default: 'bytes' }, { size: 2 }),
          f('x', 'u1', { if: 'body.compression == null' }),
          f('y', 'u1', { if: 'body.compression != null' }),
        ],
      },
    });
    const r = await parse(spec, mem([7, 0, 0, 1, 2]));
    expect(r.root.children!.map((c) => c.name)).toEqual(['tag', 'body', 'x']);
    expect(r.errors).toEqual([]);
  });

  it('after a sequential failure, later `at` fields are still parsed', async () => {
    const spec = mkSpec({ root: { fields: [f('a', 'u1'), f('big', 'u4'), f('skipped', 'u1'), f('late', 'u1', { at: 0 })] } });
    const r = await parse(spec, mem([5, 0, 0]));
    expect(find(r.root, 'big').error).toMatch(/truncated/);
    expect(r.root.children!.some((c) => c.name === 'skipped')).toBe(false);
    expect(find(r.root, 'late').value).toBe(5);
  });
});

describe('assert', () => {
  it('records validation per level, sees `_`, and never stops parsing', async () => {
    const spec = mkSpec({
      root: {
        fields: [
          f('w', 'u2', { assert: [{ expr: '_ > 0', level: 'warning', message: 'width must be positive' }, { expr: '_ < 100' }] }),
          f('s', 'str', { size: 2, encoding: 'ascii', assert: [{ expr: '_ == "ok"', message: 'not ok' }] }),
          f('broken', 'u1', { assert: [{ expr: 'later.x > 1' }, { expr: '_ + null > 1' }] }),
          f('later', 'u1'),
        ],
      },
    });
    const r = await parse(spec, mem([0, 0, 0x6e, 0x6f, 4, 5]));
    const w = find(r.root, 'w');
    expect(w.validation).toEqual(['width must be positive']);
    expect(find(r.root, 's').validation).toEqual(['not ok']);
    const broken = find(r.root, 'broken');
    expect(broken.validation!.some((v) => /could not be evaluated/.test(v))).toBe(true);
    expect(find(r.root, 'later').value).toBe(5); // parsing continued
    const sev = Object.fromEntries(r.errors.filter((e) => /width|not ok/.test(e.message)).map((e) => [e.message.split(': ')[1], e.severity]));
    expect(sev).toEqual({ 'width must be positive': 'warning', 'not ok': 'error' });
    const good = await parse(spec, mem([1, 0, 0x6f, 0x6b, 4, 5]));
    expect(find(good.root, 'w').validation).toBeUndefined();
    expect(find(good.root, 's').validation).toBeUndefined();
  });

  it('sees sibling fields and, for `at` fields, the parent cursor as _io.pos', async () => {
    const spec = mkSpec({
      root: { fields: [f('n', 'u1'), f('m', 'u1'), f('p', 'u1', { at: 'n', assert: [{ expr: 'n >= _io.pos', level: 'warning', message: 'points into the header' }] })] },
    });
    const bad = await parse(spec, mem([1, 0, 9]));
    expect(find(bad.root, 'p').validation).toEqual(['points into the header']);
    const good = await parse(spec, mem([2, 0, 9]));
    expect(find(good.root, 'p').validation).toBeUndefined();
  });
});

describe('recursive types', () => {
  const tree = () => mkSpec({ root: { fields: [f('n', 'u1'), f('v', 'u1'), f('kids', 'root', { repeat: { count: 'n' } })] } });

  it('parses a recursive tree type', async () => {
    // root(n=2,v=10) -> kid(n=1,v=11) -> grandkid(n=0,v=12) ; kid(n=0,v=13)
    const r = await parse(tree(), mem([2, 10, 1, 11, 0, 12, 0, 13]));
    expect(r.errors).toEqual([]);
    expect(find(r.root, 'kids.kids[0].kids.kids[0].v').value).toBe(12);
    expect(find(r.root, 'kids.kids[1].v').value).toBe(13);
    expect(r.root.size).toBe(8);
  });

  it('a hostile self-referencing file is stopped by the depth limit', async () => {
    const r = await parse(tree(), mem(new Array(400).fill(1)));
    expect(r.stats.truncated).toBe(true);
    expect(r.errors.some((e) => /nesting depth/.test(e.message))).toBe(true);
  });
});
