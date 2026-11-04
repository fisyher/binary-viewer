import { describe, expect, it, vi } from 'vitest';
import { MemoryByteSource, type ByteSource } from '../core/byte-source';
import * as realEngine from '../core/engine';
import type { Node } from '../core/engine';
import { find, mkSpec } from '../core/engine/test-helpers';
import { loadBuiltinSpecs } from '../formats';
import { createEngineHandler, type EngineApi } from './engine-handler';
import { computeRegions } from './overview';
import type { EngineRequest, EngineResponse, RequestBody, ResponseOf } from './protocol';

vi.mock('./overview', async (orig) => {
  const actual = await orig<typeof import('./overview')>();
  return { ...actual, computeRegions: vi.fn(actual.computeRegions) };
});

const stats = { nodes: 1, steps: 0, reads: 0, bytesRead: 0, truncated: false, aborted: false, suppressedDiagnostics: 0 };
const leaf = (id: number, offset: number, size: number, extra: Partial<Node> = {}): Node => ({ id, name: `n${id}`, typeName: 'u1', offset, size, ...extra });

function engineWith(root: Node): EngineApi {
  return { ...realEngine, parse: async () => ({ root, errors: [], stats }) };
}

function setup(opts: { engine?: EngineApi; source?: ByteSource } = {}) {
  const out: EngineResponse[] = [];
  const builtin = loadBuiltinSpecs();
  const lazy = mkSpec(
    { root: { fields: [{ name: 'hdr', type: 'u4' }, { name: 'recs', type: 'rec', repeat: { count: 3000 } }] }, rec: { fields: [{ name: 'a', type: 'u2' }, { name: 'b', type: 'u1' }] } },
    { id: 'lazy', name: 'Lazy' },
  );
  const handler = createEngineHandler({
    specs: [...builtin.specs, lazy],
    specErrors: [],
    post: (m) => out.push(m),
    engine: opts.engine,
    makeSource: () => opts.source ?? new MemoryByteSource(new Uint8Array(4 + 9000)),
  });
  let id = 0;
  const send = async <T extends EngineResponse['type']>(r: RequestBody) => {
    const req = { ...r, id: ++id } as EngineRequest;
    await handler.handle(req);
    return out.find((m) => m.id === req.id) as ResponseOf<T> | undefined;
  };
  return { send, out };
}

async function openParsed(s: ReturnType<typeof setup>) {
  await s.send({ type: 'open', file: null, fileName: 'a.bin' });
  return s.send<'parse'>({ type: 'parse', specId: 'lazy' });
}

describe('overview request', () => {
  it('summarises a small tree: groups, gaps, bits skipped', async () => {
    const root: Node = {
      id: 1, name: 'r', typeName: 'r', offset: 0, size: 100,
      children: [
        { id: 2, name: 'a', typeName: 's', offset: 0, size: 40, children: [leaf(3, 0, 40), leaf(4, 0, 8, { typeName: 'bits' })] },
        { id: 5, name: 'b', typeName: 's', offset: 60, size: 40, children: [leaf(6, 60, 40)] },
      ],
    };
    const s = setup({ engine: engineWith(root), source: new MemoryByteSource(new Uint8Array(100)) });
    await openParsed(s);
    const r = await s.send<'overview'>({ type: 'overview', buckets: 20 });
    expect(r?.size).toBe(100);
    expect(r?.buckets).toBeInstanceOf(Uint8Array);
    expect([...r!.buckets]).toEqual([...Array(8).fill(1), ...Array(4).fill(0), ...Array(8).fill(2)]);
  });

  it('counts an unexpanded lazy array by its own extent and uses the same group as ranges', async () => {
    const s = setup();
    const p = await openParsed(s);
    const recs = find(p!.snapshot!.root, 'recs');
    const r = await s.send<'overview'>({ type: 'overview', buckets: 4096 });
    expect(r!.size).toBe(9004);
    expect(r!.buckets[0]).toBe(1); // hdr: root child 0
    expect(r!.buckets[4095]).toBe(2); // recs: root child 1, still unexpanded
    expect(r!.buckets.every((v) => v !== 0)).toBe(true);
    const ranges = await s.send<'ranges'>({ type: 'ranges', start: recs.offset, end: recs.offset + 10 });
    expect(ranges!.segments[0]!.group + 1).toBe(r!.buckets[4095]);
  });

  it('answers an error without a parse result (the client keeps its last overview during a re-parse)', async () => {
    const s = setup();
    await s.send({ type: 'open', file: null, fileName: 'a.bin' });
    expect(await s.send<'error'>({ type: 'overview', buckets: 32 })).toMatchObject({ type: 'error', message: 'no parse result' });
  });

  it('never makes more buckets than bytes: a 5-byte file gets 5 buckets, an empty one 16', async () => {
    const root: Node = { id: 1, name: 'r', typeName: 'r', offset: 0, size: 5, children: [{ id: 2, name: 'a', typeName: 's', offset: 0, size: 5, children: [leaf(3, 0, 5)] }] };
    const s = setup({ engine: engineWith(root), source: new MemoryByteSource(new Uint8Array(5)) });
    await openParsed(s);
    const r = await s.send<'overview'>({ type: 'overview', buckets: 300 });
    expect([...r!.buckets]).toEqual([1, 1, 1, 1, 1]);
    const empty = setup({ engine: engineWith(root), source: new MemoryByteSource(new Uint8Array(0)) });
    await openParsed(empty);
    expect((await empty.send<'overview'>({ type: 'overview', buckets: 1 }))!.buckets).toHaveLength(16);
  });

  it('lists the root regions in file order, with a group each, and caches them with the buckets', async () => {
    const root: Node = {
      id: 1, name: 'r', typeName: 'r', offset: 0, size: 1000,
      children: [
        { id: 2, name: 'head', typeName: 's', offset: 0, size: 14, children: [leaf(3, 0, 14)] },
        { id: 4, name: 'val', typeName: 'value', offset: 14, size: 0 },
        { id: 5, name: 'tail', typeName: 's', offset: 900, size: 100, children: [leaf(6, 900, 100)] },
        { id: 7, name: 'mid', typeName: 's', offset: 14, size: 886, children: [leaf(8, 14, 886)] },
      ],
    };
    const s = setup({ engine: engineWith(root), source: new MemoryByteSource(new Uint8Array(1000)) });
    await openParsed(s);
    const r = await s.send<'overview'>({ type: 'overview', buckets: 64 });
    expect(r!.truncated).toBe(false);
    expect(r!.regions).toEqual([
      { start: 0, end: 14, group: 0, name: 'head' },
      { start: 14, end: 900, group: 3, name: 'mid' },
      { start: 900, end: 1000, group: 2, name: 'tail' },
    ]);
  });

  it('truncates a region name to 64 characters', async () => {
    const long = 'x'.repeat(200);
    const root: Node = { id: 1, name: 'r', typeName: 'r', offset: 0, size: 10, children: [{ id: 2, name: long, typeName: 's', offset: 0, size: 10, children: [leaf(3, 0, 10)] }, { id: 4, name: 'b', typeName: 's', offset: 20, size: 0 }] };
    const s = setup({ engine: engineWith(root), source: new MemoryByteSource(new Uint8Array(10)) });
    await openParsed(s);
    const r = await s.send<'overview'>({ type: 'overview', buckets: 16 });
    expect(r!.regions[0]!.name).toBe('x'.repeat(64));
  });

  it('a root with a single child groups by that child\'s children in ranges, buckets and regions alike', async () => {
    const root: Node = {
      id: 1, name: 'file', typeName: 'file', offset: 0, size: 90,
      children: [
        {
          id: 2, name: 'wrap', typeName: 's', offset: 0, size: 90,
          children: [
            { id: 3, name: 'one', typeName: 's', offset: 0, size: 30, children: [leaf(4, 0, 30)] },
            { id: 5, name: 'two', typeName: 's', offset: 30, size: 30, children: [leaf(6, 30, 30)] },
            { id: 7, name: 'three', typeName: 's', offset: 60, size: 30, children: [leaf(8, 60, 30)] },
          ],
        },
      ],
    };
    const s = setup({ engine: engineWith(root), source: new MemoryByteSource(new Uint8Array(90)) });
    await openParsed(s);
    const ov = await s.send<'overview'>({ type: 'overview', buckets: 18 });
    const ranges = await s.send<'ranges'>({ type: 'ranges', start: 0, end: 90 });
    expect(ranges!.segments.map((g) => g.group)).toEqual([0, 1, 2]);
    expect(ov!.regions.map((r) => r.group)).toEqual([0, 1, 2]);
    expect(ov!.regions.map((r) => r.name)).toEqual(['one', 'two', 'three']);
    expect([...new Set(ov!.buckets)]).toEqual([1, 2, 3]); // bucket value = group + 1
    expect(ov!.buckets[0]).toBe(ranges!.segments[0]!.group + 1);
    expect(ov!.buckets[17]).toBe(ranges!.segments[2]!.group + 1);
  });


  it('clamps the bucket count to 16..4096 and rejects values that are not counts', async () => {
    const s = setup();
    await openParsed(s);
    expect((await s.send<'overview'>({ type: 'overview', buckets: 1 }))!.buckets).toHaveLength(16);
    expect((await s.send<'overview'>({ type: 'overview', buckets: 0 }))!.buckets).toHaveLength(16);
    expect((await s.send<'overview'>({ type: 'overview', buckets: 1e9 }))!.buckets).toHaveLength(4096);
    for (const bad of [-1, 1.5, NaN, Infinity, '10', null, undefined, 2 ** 60]) {
      const r = await s.send<'error'>({ type: 'overview', buckets: bad as unknown as number });
      expect(r, String(bad)).toMatchObject({ type: 'error', message: 'invalid bucket count' });
    }
  });

  it('hands out independent buffers (the reply is transferred) and caches per bucket count', async () => {
    let reads = 0;
    const root = {
      id: 1, name: 'r', typeName: 'r', offset: 0, size: 64,
      get children() {
        reads++;
        return [{ id: 2, name: 'a', typeName: 's', offset: 0, size: 64, children: [leaf(3, 0, 64)] }];
      },
    };
    const s = setup({ engine: engineWith(root), source: new MemoryByteSource(new Uint8Array(64)) });
    await openParsed(s);
    const a = await s.send<'overview'>({ type: 'overview', buckets: 16 });
    const afterFirst = reads;
    a!.buckets.fill(0); // as if the buffer was transferred away and reused
    const b = await s.send<'overview'>({ type: 'overview', buckets: 16 });
    expect(reads).toBe(afterFirst); // cached
    expect(b!.buckets.every((v) => v === 1)).toBe(true);
    await s.send({ type: 'overview', buckets: 32 });
    expect(reads).toBeGreaterThan(afterFirst); // another size: recomputed
  });

  it('computes the regions once per tree shape: another bucket count recomputes only the buckets', async () => {
    const root: Node = {
      id: 1, name: 'r', typeName: 'r', offset: 0, size: 64,
      children: [{ id: 2, name: 'a', typeName: 's', offset: 0, size: 32, children: [leaf(3, 0, 32)] }, { id: 4, name: 'b', typeName: 's', offset: 32, size: 32, children: [leaf(5, 32, 32)] }],
    };
    const s = setup({ engine: engineWith(root), source: new MemoryByteSource(new Uint8Array(64)) });
    await openParsed(s);
    vi.mocked(computeRegions).mockClear();
    const a = await s.send<'overview'>({ type: 'overview', buckets: 16 });
    const b = await s.send<'overview'>({ type: 'overview', buckets: 32 });
    expect(computeRegions).toHaveBeenCalledTimes(1);
    expect(a!.buckets).toHaveLength(16);
    expect(b!.buckets).toHaveLength(32);
    const expected = [{ start: 0, end: 32, group: 0, name: 'a' }, { start: 32, end: 64, group: 1, name: 'b' }];
    expect(a!.regions).toEqual(expected);
    expect(b!.regions).toEqual(expected);
    await s.send({ type: 'parse', specId: 'lazy' }); // a new tree shape: computed again
    await s.send({ type: 'overview', buckets: 16 });
    expect(computeRegions).toHaveBeenCalledTimes(2);
  });

  it('is recomputed after a variable-size expansion attached nodes, but not after a fixed-size page load', async () => {
    const fixed: Node = { id: 2, name: 'fixed', typeName: 'u1[]', offset: 0, size: 32, lazy: { start: 0, count: 32, elemType: 'u1', elemSize: 1, loaded: 0, resumeOffset: null } };
    const variable: Node = {
      id: 3, name: 'var', typeName: 'x[]', offset: 32, size: 32, children: [],
      lazy: { start: 32, count: null, elemType: 'x', elemSize: null, loaded: 0, resumeOffset: 32 },
    };
    const root: Node = { id: 1, name: 'r', typeName: 'r', offset: 0, size: 64, children: [fixed, variable] };
    const engine: EngineApi = {
      ...realEngine,
      parse: async () => ({ root, errors: [], stats }),
      expandLazy: async (_r, nodeId) => {
        if (nodeId === 3) variable.children!.push(leaf(9, 32, 4));
        return [];
      },
    };
    const s = setup({ engine, source: new MemoryByteSource(new Uint8Array(64)) });
    await openParsed(s);
    const first = await s.send<'overview'>({ type: 'overview', buckets: 16 });
    expect([...first!.buckets.slice(0, 8)]).toEqual(Array(8).fill(1));
    expect([...first!.buckets.slice(8)]).toEqual(Array(8).fill(2)); // all of var counts while it is unexpanded
    expect((await s.send<'expand'>({ type: 'expand', nodeId: 2, start: 0, count: 4 }))!.treeChanged).toBe(false);
    expect([...(await s.send<'overview'>({ type: 'overview', buckets: 16 }))!.buckets]).toEqual([...first!.buckets]);
    expect((await s.send<'expand'>({ type: 'expand', nodeId: 3, start: 0, count: 1 }))!.treeChanged).toBe(true);
    const after = await s.send<'overview'>({ type: 'overview', buckets: 16 });
    // Only the loaded element is covered now, exactly as `ranges` sees it.
    expect([...after!.buckets.slice(8)]).toEqual([2, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('a new parse drops the cached overview', async () => {
    const s = setup();
    await openParsed(s);
    expect((await s.send<'overview'>({ type: 'overview', buckets: 16 }))!.buckets.some((v) => v !== 0)).toBe(true);
    await s.send({ type: 'parse', specId: null });
    expect((await s.send<'error'>({ type: 'overview', buckets: 16 }))?.type).toBe('error');
  });

  it('copes with a 4 GiB (and 1 PiB) file without reading it or allocating per byte', async () => {
    for (const size of [2 ** 32, 2 ** 50]) {
      let readCalls = 0;
      const source: ByteSource = { size, read: async () => (readCalls++, new Uint8Array(0)) };
      const root: Node = {
        id: 1, name: 'r', typeName: 'r', offset: 0, size,
        children: [
          { id: 2, name: 'head', typeName: 's', offset: 0, size: 64, children: [leaf(3, 0, 64)] },
          { id: 4, name: 'body', typeName: 's', offset: 64, size: size - 64, children: [leaf(5, 64, size - 64)] },
        ],
      };
      const s = setup({ engine: engineWith(root), source });
      await openParsed(s);
      const readsBefore = readCalls; // open() sniffed the magic bytes
      const t = performance.now();
      const r = await s.send<'overview'>({ type: 'overview', buckets: 4096 });
      expect(performance.now() - t).toBeLessThan(500);
      expect(r!.size).toBe(size);
      expect(r!.buckets).toHaveLength(4096);
      expect(r!.buckets[0]).toBe(2); // the 64-byte header is a sliver of bucket 0: the body dominates
      expect(r!.buckets.every((v) => v === 2)).toBe(true);
      expect(readCalls).toBe(readsBefore);
    }
  });
});
