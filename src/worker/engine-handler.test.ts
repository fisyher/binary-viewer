import { describe, expect, it } from 'vitest';
import { MemoryByteSource } from '../core/byte-source';
import * as realEngine from '../core/engine';
import type { ParseResult } from '../core/engine';
import { find, le16, le32, mkSpec } from '../core/engine/test-helpers';
import { loadBuiltinSpecs } from '../formats';
import { createEngineHandler, type EngineApi } from './engine-handler';
import type { EngineRequest, EngineResponse, RequestBody, ResponseOf } from './protocol';

const flush = () => new Promise((r) => setTimeout(r, 0));

function bmpBytes(): Uint8Array {
  const dib = [...le32(40), ...le32(1), ...le32(1), ...le16(1), ...le16(24), ...le32(0), ...le32(4), ...le32(0), ...le32(0), ...le32(0), ...le32(0)];
  const pixels = [1, 2, 3, 0];
  return Uint8Array.from([0x42, 0x4d, ...le32(14 + 40 + 4), ...le16(0), ...le16(0), ...le32(54), ...dib, ...pixels]);
}

// A spec with a fixed-size lazy array of structs and a variable-size lazy array.
const lazySpec = () =>
  mkSpec(
    {
      root: {
        fields: [
          { name: 'hdr', type: 'u4' },
          { name: 'recs', type: 'rec', repeat: { count: 3000 } },
        ],
      },
      rec: { fields: [{ name: 'a', type: 'u2' }, { name: 'b', type: 'u1' }] },
    },
    { id: 'lazy', name: 'Lazy' },
  );

function setup(opts: { bytes?: Uint8Array; engine?: EngineApi; specs?: ReturnType<typeof lazySpec>[] } = {}) {
  const out: EngineResponse[] = [];
  const builtin = loadBuiltinSpecs();
  const bytes = opts.bytes ?? new Uint8Array(4 + 9000);
  const handler = createEngineHandler({
    specs: [...builtin.specs, lazySpec()],
    specErrors: builtin.errors,
    post: (m) => out.push(m),
    engine: opts.engine,
    makeSource: () => new MemoryByteSource(bytes),
  });
  let id = 0;
  const send = async <T extends EngineResponse['type']>(r: RequestBody) => {
    const req = { ...r, id: ++id } as EngineRequest;
    await handler.handle(req);
    return out.filter((m) => m.id === req.id)[0] as ResponseOf<T> | undefined;
  };
  return { out, send, handler, nextId: () => id + 1 };
}

describe('engine handler', () => {
  it('built-in specs validate', () => {
    const b = loadBuiltinSpecs();
    expect(b.errors).toEqual([]);
    expect(b.specs.map((s) => s.id)).toContain('bmp');
  });

  it('open returns ranked detections with spec names (magic + extension)', async () => {
    const { send } = setup({ bytes: bmpBytes() });
    const r = await send<'open'>({ type: 'open', file: null, fileName: 'pic.bmp' });
    expect(r?.type).toBe('open');
    expect(r?.size).toBe(58);
    expect(r?.detections[0]).toMatchObject({ specId: 'bmp', name: 'Windows Bitmap', magicMatched: true });
    expect(r?.detections[0]?.reasons.join(' ')).toContain('extension .bmp');
    expect(r?.specs.map((s) => s.id)).toEqual(['bmp', 'lazy']);
    expect(r?.specErrors).toEqual([]);
  });

  it('open reports invalid built-in specs instead of failing', async () => {
    const out: EngineResponse[] = [];
    const h = createEngineHandler({ specs: [], specErrors: ['bmp.json: boom'], post: (m) => out.push(m), makeSource: () => new MemoryByteSource(new Uint8Array(3)) });
    await h.handle({ id: 1, type: 'open', file: null, fileName: 'x.bin' });
    expect(out[0]).toMatchObject({ type: 'open', specErrors: ['bmp.json: boom'], detections: [] });
  });

  it('parse after open gives the tree; null spec drops the result', async () => {
    const { send } = setup({ bytes: bmpBytes() });
    await send({ type: 'open', file: null, fileName: 'a.bmp' });
    const p = await send<'parse'>({ type: 'parse', specId: 'bmp' });
    expect(p?.snapshot?.specId).toBe('bmp');
    expect(find(p!.snapshot!.root, 'file_header.magic').value).toBe('BM');
    expect(p!.snapshot!.stats.aborted).toBe(false);
    const hit = await send<'located'>({ type: 'nodeAt', offset: 10 });
    expect(hit?.path?.length).toBeGreaterThan(2);
    const none = await send<'parse'>({ type: 'parse', specId: null });
    expect(none?.snapshot).toBeNull();
    expect((await send<'located'>({ type: 'nodeAt', offset: 10 }))?.path).toBeNull();
    expect((await send<'error'>({ type: 'parse', specId: 'nope' }))?.type).toBe('error');
  });

  it('parse without a file is an error response, not a throw', async () => {
    const out: EngineResponse[] = [];
    const h = createEngineHandler({ specs: loadBuiltinSpecs().specs, specErrors: [], post: (m) => out.push(m) });
    await h.handle({ id: 1, type: 'parse', specId: 'bmp' });
    expect(out[0]).toMatchObject({ id: 1, type: 'error', message: 'no file is open' });
  });

  it('nodeAt returns the id path from the root; nodeById round-trips', async () => {
    const { send } = setup({ bytes: bmpBytes() });
    await send({ type: 'open', file: null, fileName: 'a.bmp' });
    const p = await send<'parse'>({ type: 'parse', specId: 'bmp' });
    const root = p!.snapshot!.root;
    const offBits = find(root, 'file_header.off_bits');
    const at = await send<'located'>({ type: 'nodeAt', offset: 10 });
    expect(at?.path?.[0]).toBe(root.id);
    expect(at?.path?.at(-1)).toBe(offBits.id);
    expect(at?.lazyIndex).toBeNull();
    const byId = await send<'located'>({ type: 'nodeById', nodeId: offBits.id });
    expect(byId?.path).toEqual(at?.path);
    expect((await send<'located'>({ type: 'nodeById', nodeId: 987654 }))?.path).toBeNull();
    expect((await send<'error'>({ type: 'nodeAt', offset: -1 }))?.type).toBe('error');
  });

  it('expand pages a fixed-size lazy array; nodeAt reports the lazy element index', async () => {
    const { send } = setup();
    await send({ type: 'open', file: null, fileName: 'a.bin' });
    const p = await send<'parse'>({ type: 'parse', specId: 'lazy' });
    const recs = find(p!.snapshot!.root, 'recs');
    expect(recs.lazy).toMatchObject({ count: 3000, elemSize: 3 });
    const e = await send<'expand'>({ type: 'expand', nodeId: recs.id, start: 100, count: 3 });
    expect(e?.nodes.map((n) => n.name)).toEqual(['recs[100]', 'recs[101]', 'recs[102]']);
    expect(e?.nodes[0]?.offset).toBe(4 + 300);

    const at = await send<'located'>({ type: 'nodeAt', offset: 4 + 2999 * 3 + 1 });
    expect(at?.path?.at(-1)).toBe(recs.id);
    expect(at?.lazyIndex).toBe(2999);
    const bad = await send<'error'>({ type: 'expand', nodeId: recs.id, start: -1, count: 3 });
    expect(bad?.type).toBe('error');
  });

  it('ranges returns leaf segments for the window grouped by top-level field, capped', async () => {
    const { send } = setup({ bytes: bmpBytes() });
    await send({ type: 'open', file: null, fileName: 'a.bmp' });
    await send({ type: 'parse', specId: 'bmp' });
    const r = await send<'ranges'>({ type: 'ranges', start: 0, end: 20 });
    const segs = r!.segments;
    expect(segs[0]).toEqual({ start: 0, end: 2, group: 0 }); // magic
    expect(segs.every((s) => s.start >= 0 && s.end <= 20 && s.end > s.start)).toBe(true);
    expect(segs.some((s) => s.group === 1)).toBe(true); // dib header begins at 14
    expect(segs.filter((s) => s.group === 0).every((s) => s.end <= 14)).toBe(true);
    expect((await send<'error'>({ type: 'ranges', start: 0, end: 1 << 22 }))?.type).toBe('error');
  });

  describe('concurrent expands and large ranges', () => {
    it('overlapping expands never send the same diagnostic twice', async () => {
      const releases: Array<() => void> = [];
      const engine: EngineApi = {
        ...realEngine,
        expandLazy: (r, _id, range) =>
          new Promise((resolve) => {
            releases.push(() => {
              if (range.start === 1) r.errors.push({ severity: 'error', code: 'lazy', message: 'only once' });
              resolve([]);
            });
          }),
      };
      const { out, handler } = setup({ engine });
      await handler.handle({ id: 1, type: 'open', file: null, fileName: 'a.bin' });
      await handler.handle({ id: 2, type: 'parse', specId: 'lazy' });
      const a = handler.handle({ id: 3, type: 'expand', nodeId: 1, start: 0, count: 5 });
      const b = handler.handle({ id: 4, type: 'expand', nodeId: 1, start: 1, count: 5 });
      await flush();
      releases[1]!(); // b finishes first and adds the diagnostic
      await flush();
      releases[0]!();
      await Promise.all([a, b]);
      const errs = out.filter((m): m is ResponseOf<'expand'> => m.type === 'expand').flatMap((m) => m.newErrors);
      expect(errs.map((e) => e.message)).toEqual(['only once']);
    });

    it('index and extents are rebuilt only when an expand actually added children', async () => {
      let reads = 0;
      const fixed = { id: 2, name: 'fixed', typeName: 'u1[]', offset: 0, size: 10, lazy: { start: 0, count: 10, elemType: 'u1', elemSize: 1, loaded: 0, resumeOffset: null } };
      const variable: import('../core/engine').Node = {
        id: 3, name: 'var', typeName: 'x[]', offset: 10, size: 10, children: [],
        lazy: { start: 10, count: null, elemType: 'x', elemSize: null, loaded: 0, resumeOffset: 10 },
      };
      const kids = [fixed, variable];
      const root = { id: 1, name: 'r', typeName: 'r', offset: 0, size: 20, get children() { reads++; return kids; } };
      const engine: EngineApi = {
        ...realEngine,
        parse: async () => ({ root, errors: [], stats: { nodes: 3, steps: 0, reads: 0, bytesRead: 0, truncated: false, aborted: false, suppressedDiagnostics: 0 } }),
        expandLazy: async (_r, nodeId) => {
          if (nodeId === 3) variable.children!.push({ id: 9, name: 'var[0]', typeName: 'x', offset: 10, size: 1 });
          return [];
        },
      };
      const { send } = setup({ engine });
      await send({ type: 'open', file: null, fileName: 'a.bin' });
      await send({ type: 'parse', specId: 'lazy' });
      await send({ type: 'nodeById', nodeId: 2 }); // builds the index
      const built = reads;
      await send({ type: 'expand', nodeId: 2, start: 0, count: 5 });
      await send({ type: 'expand', nodeId: 2, start: 5, count: 5 });
      await send({ type: 'nodeById', nodeId: 2 });
      expect(reads).toBe(built); // fixed-size page loads never rebuilt it
      await send({ type: 'expand', nodeId: 3, start: 0, count: 5 });
      const found = await send<'located'>({ type: 'nodeById', nodeId: 9 });
      expect(reads).toBeGreaterThan(built); // variable-size expansion did
      expect(found?.path).toEqual([1, 3, 9]);
    });

    function bigTreeEngine(leaves: number, order: 'asc' | 'desc' = 'asc'): EngineApi {
      return {
        ...realEngine,
        parse: async () => {
          const idx = Array.from({ length: leaves }, (_, i) => i);
          if (order === 'desc') idx.reverse();
          const kids = idx.map((i) => ({ id: i + 2, name: `k${i}`, typeName: 'u1', offset: i, size: 1 }));
          return {
            root: { id: 1, name: 'r', typeName: 'r', offset: 0, size: leaves, children: [{ id: 0, name: 'top', typeName: 's', offset: 0, size: leaves, children: kids }] },
            errors: [],
            stats: { nodes: leaves, steps: 0, reads: 0, bytesRead: 0, truncated: false, aborted: false, suppressedDiagnostics: 0 },
          };
        },
      };
    }

    it('a window over the end of a large tree still returns its segments', async () => {
      const { send } = setup({ engine: bigTreeEngine(100_000) });
      await send({ type: 'open', file: null, fileName: 'a.bin' });
      await send({ type: 'parse', specId: 'lazy' });
      const r = await send<'ranges'>({ type: 'ranges', start: 99_990, end: 100_000 });
      expect(r!.segments.map((s) => s.start)).toEqual(Array.from({ length: 10 }, (_, i) => 99_990 + i));
      const empty = await send<'ranges'>({ type: 'ranges', start: 200_000, end: 200_010 });
      expect(empty!.segments).toEqual([]);
    });

    it('the segment cap is applied in window order, not traversal order', async () => {
      const { send } = setup({ engine: bigTreeEngine(5000, 'desc') });
      await send({ type: 'open', file: null, fileName: 'a.bin' });
      await send({ type: 'parse', specId: 'lazy' });
      const r = await send<'ranges'>({ type: 'ranges', start: 0, end: 5000 });
      expect(r!.segments).toHaveLength(4096);
      expect(r!.segments[0]!.start).toBe(0);
      expect(r!.segments.at(-1)!.start).toBe(4095);
    });

    it('children placed outside their parent range (at-fields) are still found', async () => {
      const engine: EngineApi = {
        ...realEngine,
        parse: async () => ({
          root: {
            id: 1, name: 'r', typeName: 'r', offset: 0, size: 100,
            children: [{ id: 2, name: 'p', typeName: 's', offset: 0, size: 4, children: [{ id: 3, name: 'far', typeName: 'u1', offset: 90, size: 2 }] }],
          },
          errors: [],
          stats: { nodes: 3, steps: 0, reads: 0, bytesRead: 0, truncated: false, aborted: false, suppressedDiagnostics: 0 },
        }),
      };
      const { send } = setup({ engine });
      await send({ type: 'open', file: null, fileName: 'a.bin' });
      await send({ type: 'parse', specId: 'lazy' });
      const r = await send<'ranges'>({ type: 'ranges', start: 80, end: 100 });
      expect(r!.segments).toEqual([{ start: 90, end: 92, group: 0 }]);
    });
  });

  describe('supersede / cancel', () => {
    /** Engine whose parse() waits for a gate we control and records abort. */
    function gatedEngine() {
      const gates: Array<{ release: () => void; aborted: () => boolean; label: string }> = [];
      const engine: EngineApi = {
        ...realEngine,
        parse: (spec, source, opts) =>
          new Promise<ParseResult>((resolve) => {
            let aborted = false;
            opts?.signal?.addEventListener('abort', () => (aborted = true));
            const label = `${gates.length}`;
            const make = (): ParseResult => ({
              root: { id: 1, name: `root${label}`, typeName: 'x', offset: 0, size: 0, children: [] },
              errors: [],
              stats: { nodes: 1, steps: 0, reads: 0, bytesRead: 0, truncated: aborted, aborted, suppressedDiagnostics: 0 },
            });
            gates.push({ release: () => resolve(make()), aborted: () => aborted, label });
            // Real engine behaviour: an abort ends the parse with a partial result.
            opts?.signal?.addEventListener('abort', () => resolve(make()));
            void spec;
            void source;
          }),
      };
      return { engine, gates };
    }

    it('a newer parse aborts the older one and its stale response is dropped', async () => {
      const { engine, gates } = gatedEngine();
      const { out, handler } = setup({ engine });
      await handler.handle({ id: 1, type: 'open', file: null, fileName: 'a.bin' });
      const first = handler.handle({ id: 2, type: 'parse', specId: 'lazy' });
      await flush();
      const second = handler.handle({ id: 3, type: 'parse', specId: 'lazy' });
      await flush();
      expect(gates[0]!.aborted()).toBe(true);
      gates[1]!.release();
      gates[0]!.release();
      await Promise.all([first, second]);
      const parses = out.filter((m) => m.type === 'parse') as ResponseOf<'parse'>[];
      expect(parses.map((m) => m.id)).toEqual([3]);
      expect(parses[0]!.snapshot?.root.name).toBe('root1');
    });

    it('open supersedes an in-flight parse', async () => {
      const { engine, gates } = gatedEngine();
      const { out, handler } = setup({ engine });
      await handler.handle({ id: 1, type: 'open', file: null, fileName: 'a.bin' });
      const p = handler.handle({ id: 2, type: 'parse', specId: 'lazy' });
      await flush();
      await handler.handle({ id: 3, type: 'open', file: null, fileName: 'b.bin' });
      gates[0]!.release();
      await p;
      expect(out.filter((m) => m.id === 2)).toEqual([]);
      expect(out.filter((m) => m.id === 3)).toHaveLength(1);
    });

    it('a stale open (slow detect) is dropped when a newer open arrives', async () => {
      let releaseFirst!: () => void;
      let calls = 0;
      const engine: EngineApi = {
        ...realEngine,
        detect: async () => {
          if (calls++ === 0) await new Promise<void>((r) => (releaseFirst = r));
          return [];
        },
      };
      const { out, handler } = setup({ engine });
      const a = handler.handle({ id: 1, type: 'open', file: null, fileName: 'a' });
      await flush();
      await handler.handle({ id: 2, type: 'open', file: null, fileName: 'b' });
      releaseFirst();
      await a;
      expect(out.map((m) => m.id)).toEqual([2]);
    });

    it('cancel aborts the running parse, which still answers with an aborted partial snapshot', async () => {
      const { engine } = gatedEngine();
      const { out, handler } = setup({ engine });
      await handler.handle({ id: 1, type: 'open', file: null, fileName: 'a.bin' });
      const p = handler.handle({ id: 2, type: 'parse', specId: 'lazy' });
      await flush();
      await handler.handle({ id: 3, type: 'cancel' });
      await p;
      expect(out.find((m) => m.id === 3)).toEqual({ id: 3, type: 'cancel' });
      const res = out.find((m) => m.id === 2) as ResponseOf<'parse'>;
      expect(res.snapshot?.stats.aborted).toBe(true);
    });

    it('cancel with nothing running just acknowledges', async () => {
      const { send } = setup();
      expect(await send({ type: 'cancel' })).toEqual({ id: 1, type: 'cancel' });
    });
  });
});
