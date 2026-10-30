import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../byte-source';
import { MemoryByteSource } from '../byte-source';
import { parse } from './interpret';
import { find, mem, mkSpec, rawSpec } from './test-helpers';
import { validateSpec } from './validate';

const SIG = [0x50, 0x4b, 0x05, 0x06];
const f = (name: string, type: unknown, extra: Record<string, unknown> = {}) => ({ name, type, ...extra });

/** root: head, eocd (found by signature), after. `rec` is sig u4 + n u2. */
function eocdSpec(findExtra: Record<string, unknown> = {}, build = mkSpec) {
  return build({
    rec: { fields: [f('sig', 'u4', { expect: 0x06054b50 }), f('n', 'u2')] },
    root: {
      fields: [
        f('head', 'u1'),
        f('eocd', 'rec', { find: { bytes: '50 4B 05 06', from: '_io.end', window: 100, direction: 'backward', ...findExtra } }),
        f('after', 'u1'),
      ],
    },
  });
}

/** Counts every read so tests can assert how much was looked at. */
function counting(bytes: Uint8Array) {
  const inner = new MemoryByteSource(bytes);
  const reads: Array<{ offset: number; length: number }> = [];
  const source: ByteSource = {
    size: inner.size,
    async read(offset, length) {
      reads.push({ offset, length });
      return inner.read(offset, length);
    },
  };
  return { source, reads, total: () => reads.reduce((a, r) => a + r.length, 0) };
}

describe('find: basics', () => {
  it('finds the signature backward from the end, parses there, and leaves the parent cursor alone', async () => {
    const r = await parse(eocdSpec(), mem([0xaa, 0, 0, 0, ...SIG, 7, 0, 9, 9]));
    expect(r.errors).toEqual([]);
    expect(find(r.root, 'eocd').offset).toBe(4);
    expect(find(r.root, 'eocd.n').value).toBe(7);
    expect(find(r.root, 'after').offset).toBe(1); // sequential cursor was not moved by the found field
  });

  it('no match is a field error (code "find"), the struct carries on', async () => {
    const r = await parse(eocdSpec(), mem([0xaa, 1, 2, 3, 4, 5, 6, 7]));
    const n = find(r.root, 'eocd');
    expect(n.error).toMatch(/not found/);
    expect(r.errors.map((e) => e.code)).toEqual(['find']);
    expect(find(r.root, 'after').offset).toBe(1);
  });

  it('a window larger than the file is clipped to the stream (reads only what exists)', async () => {
    const bytes = Uint8Array.from([0xaa, ...SIG, 5, 0]);
    const c = counting(bytes);
    const r = await parse(eocdSpec({ window: 1_000_000 }), c.source);
    expect(r.errors).toEqual([]);
    expect(find(r.root, 'eocd').offset).toBe(1);
    expect(c.reads[1]).toEqual({ offset: 0, length: bytes.length }); // (reads[0] is `head`) one clipped window read
  });

  it('a signature outside the (small) window is not found even though it exists', async () => {
    const bytes = [0xaa, ...SIG, 5, 0, 1, 1, 1, 1, 1, 1];
    const r = await parse(eocdSpec({ window: 6 }), mem(bytes));
    expect(find(r.root, 'eocd').error).toMatch(/not found/);
    const r2 = await parse(eocdSpec({ window: 12 }), mem(bytes));
    expect(r2.errors).toEqual([]);
  });

  it('a signature must lie wholly inside the window', async () => {
    // window [8, 12) cuts the signature at offset 7..10 in half
    const bytes = [0, 0, 0, 0, 0, 0, 0, ...SIG, 0];
    const r = await parse(eocdSpec({ window: 4 }), mem(bytes));
    expect(find(r.root, 'eocd').error).toMatch(/not found/);
  });

  it('forward direction scans [from, from+window) lowest offset first', async () => {
    const bytes = [0xaa, 0, ...SIG, 1, 0, ...SIG, 2, 0, 0];
    const spec = eocdSpec({ from: 1, direction: 'forward', window: 20 });
    const r = await parse(spec, mem(bytes));
    expect(find(r.root, 'eocd').offset).toBe(2);
    expect(find(r.root, 'eocd.n').value).toBe(1);
    // from beyond the first hit
    const r2 = await parse(eocdSpec({ from: 3, direction: 'forward', window: 20 }), mem(bytes));
    expect(find(r2.root, 'eocd').offset).toBe(8);
  });

  it('applies a mask', async () => {
    const spec = eocdSpec({ bytes: '50 00 05 06', mask: 'FF 00 FF FF' });
    const r = await parse(spec, mem([0xaa, 0x50, 0x99, 0x05, 0x06, 0, 0]));
    expect(find(r.root, 'eocd').offset).toBe(1);
    expect(find(r.root, 'eocd.sig').validation?.[0]).toMatch(/expected/); // sig differs from the expected 0x06054b50
  });

  it('a negative / non-integer "from" is a field error', async () => {
    const r = await parse(eocdSpec({ from: '0 - 1' }), mem([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(find(r.root, 'eocd').error).toMatch(/negative/);
    const r2 = await parse(eocdSpec({ from: '"x"' }), mem([1, 2, 3, 4]));
    expect(find(r2.root, 'eocd').error).toMatch(/integer/);
  });

  it('works on a field that is not a struct (primitive at the match)', async () => {
    const spec = mkSpec({ root: { fields: [f('x', 'u2', { find: { bytes: '34 12', from: 0, window: 10, direction: 'forward' } })] } });
    const r = await parse(spec, mem([0, 0, 0x34, 0x12, 0]));
    expect(find(r.root, 'x').offset).toBe(2);
    expect(find(r.root, 'x').value).toBe(0x1234);
  });

  it('is limited to the enclosing substream', async () => {
    const spec = mkSpec({
      inner: { fields: [f('hit', 'u1', { find: { bytes: 'AA', from: '_io.end', window: 100, direction: 'backward' } })] },
      root: { fields: [f('sub', 'inner', { size: 4 }), f('rest', 'bytes', { size: 'eos' })] },
    });
    // 0xAA exists at offset 6 only, outside the 4-byte substream
    const r = await parse(spec, mem([1, 2, 3, 4, 5, 6, 0xaa]));
    expect(find(r.root, 'sub.hit').error).toMatch(/not found/);
    const r2 = await parse(spec, mem([1, 0xaa, 3, 4, 5, 6, 0xaa]));
    expect(find(r2.root, 'sub.hit').offset).toBe(1);
  });
});

describe('find: multiple matches, accept tiers, candidate cap', () => {
  const rec2 = (n1: number, n2: number) => [0xaa, ...SIG, n1, 0, 0, ...SIG, n2, 0]; // farther rec at 1, nearer rec at 8

  it('warns about other matches and picks the nearest', async () => {
    const r = await parse(eocdSpec(), mem(rec2(1, 2)));
    expect(find(r.root, 'eocd').offset).toBe(8);
    expect(find(r.root, 'eocd').validation).toEqual(['1 other match in search window']);
    expect(r.errors.filter((e) => e.severity === 'warning')).toHaveLength(1);
    const three = await parse(eocdSpec(), mem([...SIG, 0, 0, ...SIG, 0, 0, ...SIG, 0, 0]));
    expect(find(three.root, 'eocd').validation).toEqual(['2 other matches in search window']);
  });

  it('a single match gives no warning', async () => {
    const r = await parse(eocdSpec(), mem([...SIG, 0, 0]));
    expect(r.errors).toEqual([]);
    expect(find(r.root, 'eocd').validation).toBeUndefined();
  });

  it('accept: a tier can choose a farther candidate', async () => {
    const r = await parse(eocdSpec({ accept: ['n == 1'] }), mem(rec2(1, 2)));
    expect(find(r.root, 'eocd').offset).toBe(1);
    expect(find(r.root, 'eocd.n').value).toBe(1);
  });

  it('accept: tiers are tried in order (an earlier tier beats a nearer candidate of a later tier)', async () => {
    // nearer rec has n=2; farther has n=1. tier 1 wants n==1, tier 2 wants n==2.
    const r = await parse(eocdSpec({ accept: ['n == 1', 'n == 2'] }), mem(rec2(1, 2)));
    expect(find(r.root, 'eocd').offset).toBe(1);
    const r2 = await parse(eocdSpec({ accept: ['n == 9', 'n == 2'] }), mem(rec2(1, 2)));
    expect(find(r2.root, 'eocd').offset).toBe(8);
  });

  it('accept sees _start and _io of the probe', async () => {
    const r = await parse(eocdSpec({ accept: ['_start + 6 == _io.end'] }), mem(rec2(1, 2)));
    expect(find(r.root, 'eocd').offset).toBe(8);
    const r2 = await parse(eocdSpec({ accept: ['_start == 1'] }), mem(rec2(1, 2)));
    expect(find(r2.root, 'eocd').offset).toBe(1);
  });

  it('accept can read the enclosing struct through _parent', async () => {
    const spec = mkSpec({
      rec: { fields: [f('sig', 'u4'), f('n', 'u2')] },
      root: {
        fields: [
          f('want', 'u1'),
          f('eocd', 'rec', { find: { bytes: '50 4B 05 06', from: '_io.end', window: 100, direction: 'backward', accept: ['n == _parent.want'] } }),
        ],
      },
    });
    const r = await parse(spec, mem([1, ...SIG, 1, 0, 0, ...SIG, 2, 0]));
    expect(find(r.root, 'eocd').offset).toBe(1);
    expect(validateSpec({ schemaVersion: 1, id: 'x', name: 'X', root: 'root', types: { rec: { fields: [{ name: 'n', type: 'u2' }] }, root: { fields: [{ name: 'want', type: 'u1' }, { name: 'e', type: 'rec', find: { bytes: '00', from: 0, window: 4, direction: 'forward', accept: ['n == want'] } }] } } }).ok).toBe(false);
  });

  it('no candidate accepted is a field error', async () => {
    const r = await parse(eocdSpec({ accept: ['n == 99'] }), mem(rec2(1, 2)));
    expect(find(r.root, 'eocd').error).toMatch(/no candidate .* was accepted/);
  });

  it('accept expressions that fail or are not boolean just reject the candidate', async () => {
    const r = await parse(eocdSpec({ accept: ['n + null', '5', 'n == 1'] }, rawSpec), mem(rec2(1, 2)));
    expect(find(r.root, 'eocd').offset).toBe(1);
  });

  it('probe failures leak no nodes and no diagnostics', async () => {
    // nearest candidate is truncated (only 4 bytes after it), so probing it fails inside the probe
    const bytes = [0xaa, ...SIG, 7, 0, 0, ...SIG];
    const r = await parse(eocdSpec({ accept: ['n == 7'] }), mem(bytes));
    expect(r.errors.map((e) => e.message)).toEqual(['1 other match in search window']); // nothing from the failed probe
    const eocd = find(r.root, 'eocd');
    expect(eocd.offset).toBe(1);
    expect(eocd.children).toHaveLength(2);
    // head + eocd + sig + n + after
    expect(r.stats.nodes).toBe(1 + 4 + 1);
    expect(JSON.stringify(r.root)).not.toContain('truncated');
  });

  it('caps the probed candidates and says so', async () => {
    const many = [0, ...Array.from({ length: 10 }, (_, i) => [...SIG, i, 0]).flat()];
    // candidate with n == 0 is the FARTHEST (first in the file); only the nearest 3 are examined
    const capped = await parse(eocdSpec({ accept: ['n == 0'] }), mem(many), { limits: { maxFindCandidates: 3 } });
    expect(find(capped.root, 'eocd').error).toMatch(/candidate limit 3 reached, 7 later match/);
    const ok = await parse(eocdSpec({ accept: ['n == 8'] }), mem(many), { limits: { maxFindCandidates: 3 } });
    expect(find(ok.root, 'eocd').offset).toBe(1 + 8 * 6);
    expect(find(ok.root, 'eocd').validation?.join('|')).toMatch(/candidate limit \(3\) reached; 7 later match/);
    const uncapped = await parse(eocdSpec({ accept: ['n == 0'] }), mem(many));
    expect(find(uncapped.root, 'eocd').offset).toBe(1);
  });

  it('without accept the cap still counts every hit', async () => {
    const many = [0, ...Array.from({ length: 10 }, (_, i) => [...SIG, i, 0]).flat()];
    const r = await parse(eocdSpec(), mem(many), { limits: { maxFindCandidates: 2 } });
    expect(find(r.root, 'eocd').validation).toEqual(['9 other matches in search window']);
  });
});

describe('find: reads and budgets', () => {
  it('reads in chunks of at most 64 KiB and charges everything to the budget', async () => {
    const bytes = new Uint8Array(300_000);
    bytes.set(SIG, 100_000);
    bytes.set([7, 0], 100_004);
    const c = counting(bytes);
    const r = await parse(eocdSpec({ window: 250_000 }), c.source);
    expect(r.errors).toEqual([]);
    expect(find(r.root, 'eocd').offset).toBe(100_000);
    expect(Math.max(...c.reads.map((x) => x.length))).toBeLessThanOrEqual(65536);
    expect(r.stats.bytesRead).toBe(c.total());
    expect(r.stats.reads).toBe(c.reads.length);
    // window (250000) + overlaps + the 1-byte head + the 6-byte record
    expect(c.total()).toBeLessThan(250_000 + 100);
    expect(c.total()).toBeGreaterThanOrEqual(250_000);
  });

  it.each([234_462, 234_463, 234_464, 234_465])('finds a signature straddling a chunk edge (offset %i) exactly once', async (at) => {
    const bytes = new Uint8Array(300_000);
    bytes.set(SIG, at);
    bytes.set([3, 0], at + 4);
    const r = await parse(eocdSpec({ window: 200_000 }), mem(bytes));
    expect(r.errors).toEqual([]); // a duplicate hit would produce an "other match" warning
    expect(find(r.root, 'eocd').offset).toBe(at);
  });

  it('probe reads are charged to the run (bytesRead equals what the source served)', async () => {
    const bytes = Uint8Array.from([0xaa, ...SIG, 1, 0, 0, ...SIG, 2, 0]);
    const c = counting(bytes);
    const r = await parse(eocdSpec({ accept: ['n == 1'] }), c.source);
    expect(find(r.root, 'eocd').offset).toBe(1);
    expect(r.stats.bytesRead).toBe(c.total());
    expect(r.stats.reads).toBe(c.reads.length);
  });

  it('the parent I/O budget bounds find (Halt, partial tree)', async () => {
    const bytes = new Uint8Array(200_000);
    const r = await parse(eocdSpec({ window: 150_000 }), mem(bytes), { limits: { maxBytesRead: 70_000 } });
    expect(r.stats.truncated).toBe(true);
    expect(r.errors.some((e) => e.code === 'limit')).toBe(true);
  });

  it('a window above maxFindWindow is refused at run time (hostile spec bypassing the validator)', async () => {
    const r = await parse(eocdSpec({ window: 5000 }, rawSpec), mem(new Uint8Array(6000)), { limits: { maxFindWindow: 1000 } });
    expect(find(r.root, 'eocd').error).toMatch(/exceeds the limit of 1000/);
  });

  it('hostile find definitions never throw', async () => {
    for (const bad of [{ bytes: 'zz' }, { bytes: '' }, { window: -1 }, { window: 1.5 }, { direction: 'sideways' }, { mask: '00' }]) {
      const r = await parse(eocdSpec(bad, rawSpec), mem([1, 2, 3, 4, 5, 6, 7, 8]));
      expect(find(r.root, 'eocd').error, JSON.stringify(bad)).toBeDefined();
    }
  });
});

describe('find: validator', () => {
  const base = (fld: Record<string, unknown>) => ({
    schemaVersion: 1,
    id: 'x',
    name: 'X',
    endian: 'le',
    root: 'root',
    types: { rec: { fields: [{ name: 'n', type: 'u2' }] }, root: { fields: [{ name: 'a', type: 'u1' }, { name: 'r', type: 'rec', ...fld }] } },
  });
  const good = { bytes: '50 4B', from: '_io.end', window: 100, direction: 'backward' };
  const errs = (fld: Record<string, unknown>) => {
    const v = validateSpec(base(fld));
    return v.ok ? [] : v.errors;
  };

  it('accepts a good find', () => {
    expect(errs({ find: good })).toEqual([]);
    expect(errs({ find: { ...good, mask: 'FF 00', accept: ['n == 1', 'true'] } })).toEqual([]);
  });

  it('rejects find together with at', () => {
    expect(errs({ find: good, at: 0 }).some((e) => e.path.endsWith('.find') && /both place the field/.test(e.message))).toBe(true);
  });

  it('rejects find with repeat', () => {
    expect(errs({ find: good, repeat: { count: 2 } }).some((e) => /repeat/.test(e.message))).toBe(true);
  });

  it('rejects windows above the limit (default 1 MiB and custom) and non-integers', () => {
    expect(errs({ find: { ...good, window: 1 << 20 } })).toEqual([]);
    expect(errs({ find: { ...good, window: (1 << 20) + 1 } }).some((e) => e.path.endsWith('.window') && /too large/.test(e.message))).toBe(true);
    const v = validateSpec(base({ find: { ...good, window: 2000 } }), { maxFindWindow: 1000 });
    expect(v.ok).toBe(false);
    expect(errs({ find: { ...good, window: 0 } }).length).toBeGreaterThan(0);
    expect(errs({ find: { ...good, window: '10' } }).length).toBeGreaterThan(0);
  });

  it('checks bytes, mask, direction, keys, from and accept', () => {
    expect(errs({ find: { ...good, bytes: 'xyz' } }).some((e) => e.path.endsWith('.bytes'))).toBe(true);
    expect(errs({ find: { ...good, bytes: '00'.repeat(65) } }).some((e) => e.path.endsWith('.bytes'))).toBe(true);
    expect(errs({ find: { ...good, mask: 'FF' } }).some((e) => e.path.endsWith('.mask'))).toBe(true);
    expect(errs({ find: { ...good, mask: '00 00' } }).some((e) => /all zero/.test(e.message))).toBe(true);
    expect(errs({ find: { ...good, direction: 'up' } }).some((e) => e.path.endsWith('.direction'))).toBe(true);
    expect(errs({ find: { ...good, extra: 1 } }).some((e) => /unknown key/.test(e.message))).toBe(true);
    expect(errs({ find: { ...good, from: 'nope' } }).some((e) => e.path.endsWith('.from'))).toBe(true);
    expect(errs({ find: { ...good, from: undefined } }).some((e) => e.path.endsWith('.from'))).toBe(true);
    expect(errs({ find: { ...good, accept: [] } }).some((e) => e.path.endsWith('.accept'))).toBe(true);
    expect(errs({ find: { ...good, accept: ['n =='] } }).some((e) => /bad expression/.test(e.message))).toBe(true);
    // accept names resolve against the probed type's fields, not the enclosing type's
    expect(errs({ find: { ...good, accept: ['a == 1'] } }).some((e) => /unknown name "a"/.test(e.message))).toBe(true);
    expect(errs({ find: 'x' }).length).toBeGreaterThan(0);
  });

  it('a find field counts as guarded for type cycles', () => {
    const spec = {
      schemaVersion: 1,
      id: 'x',
      name: 'X',
      root: 'root',
      types: { root: { fields: [{ name: 'again', type: 'root', find: { bytes: '00', from: 0, window: 10, direction: 'forward' } }] } },
    };
    expect(validateSpec(spec).ok).toBe(true);
  });
});
