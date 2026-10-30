import { describe, expect, it } from 'vitest';
import bmpJson from '../../formats/bmp.json';
import type { ByteSource } from '../byte-source';
import { MemoryByteSource } from '../byte-source';
import { generateMarkdown } from './docs';
import { expandLazy, parse } from './interpret';
import { find, mem, mkSpec } from './test-helpers';
import { validateSpec } from './validate';

const f = (name: string, type: unknown, extra: Record<string, unknown> = {}) => ({ name, type, ...extra });
const codes = (r: { errors: Array<{ code: string }> }) => r.errors.map((e) => e.code);

describe('lost mode (after a sequential failure)', () => {
  it('registers skipped sequential fields as null so later `at` fields can test them', async () => {
    const spec = mkSpec({
      root: { fields: [f('a', 'u1'), f('big', 'u4'), f('skipped', 'u1'), f('late', 'u1', { at: 0, if: 'skipped == null' })] },
    });
    const r = await parse(spec, mem([5, 0, 0]));
    expect(r.root.children!.some((c) => c.name === 'skipped')).toBe(false);
    expect(find(r.root, 'late').value).toBe(5);
    expect(find(r.root, 'late').error).toBeUndefined();
  });

  it('an `at` field that needs the stale cursor becomes an error node', async () => {
    const spec = mkSpec({
      root: {
        fields: [
          f('a', 'u1'),
          f('big', 'u4'),
          f('byPos', 'u1', { at: '_io.pos' }),
          f('byEof', 'u1', { at: 0, if: '_io.eof' }),
          f('checked', 'u1', { at: 0, assert: [{ expr: '_io.pos > 0', level: 'warning' }] }),
          f('fine', 'u1', { at: 1 }),
        ],
      },
    });
    const r = await parse(spec, mem([5, 6, 7]));
    expect(find(r.root, 'byPos').error).toMatch(/position unknown after earlier failure/);
    expect(find(r.root, 'byEof').error).toMatch(/position unknown/);
    expect(find(r.root, 'checked').validation![0]).toMatch(/could not be evaluated.*position unknown/);
    expect(find(r.root, 'fine').value).toBe(6);
  });

  it('while the cursor is trustworthy, _io.pos works as before', async () => {
    const spec = mkSpec({ root: { fields: [f('a', 'u1'), f('p', 'u1', { at: '_io.pos + 1' })] } });
    const r = await parse(spec, mem([5, 6, 7]));
    expect(find(r.root, 'p').value).toBe(7);
  });
});

describe('I/O budget', () => {
  const scanSpec = () =>
    mkSpec({
      root: {
        fields: [f('a', 'u1'), f('s', 'str', { terminator: 0, at: '_io.start' }), f('kid', 'root', { size: '_io.size - 1', if: '_io.size > 1' })],
      },
    });

  it('a hostile recursive spec with an unfindable terminator stops at the byte budget', async () => {
    const src = new MemoryByteSource(new Uint8Array(100_000).fill(1));
    const r = await parse(scanSpec(), src, { limits: { maxBytesRead: 1_000_000 } });
    expect(r.stats.truncated).toBe(true);
    expect(r.stats.bytesRead).toBeLessThanOrEqual(1_000_000);
    expect(r.errors.some((e) => e.code === 'limit' && /I\/O budget/.test(e.message))).toBe(true);
  });

  it('ordinary parses stay far below the default budgets', async () => {
    const spec = mkSpec({ root: { fields: [f('a', 'u4', { repeat: { count: 100 } })] } });
    const r = await parse(spec, mem(new Array(400).fill(1)));
    expect(r.stats.truncated).toBe(false);
    expect(r.stats.reads).toBe(100);
  });

  it('maxReads limits the number of source calls', async () => {
    const spec = mkSpec({ root: { fields: [f('a', 'u1', { repeat: { count: 100 } })] } });
    const r = await parse(spec, mem(new Array(100).fill(1)), { limits: { maxReads: 10 } });
    expect(r.stats.truncated).toBe(true);
    expect(r.stats.reads).toBe(10);
    expect(r.errors.some((e) => /read budget/.test(e.message))).toBe(true);
  });

  it('an abort during a long terminated-string scan stops promptly', async () => {
    const inner = new MemoryByteSource(new Uint8Array(1_000_000).fill(1));
    const ac = new AbortController();
    let reads = 0;
    const source: ByteSource = {
      size: inner.size,
      async read(o, l) {
        if (++reads === 5) ac.abort();
        return inner.read(o, l);
      },
    };
    const spec = mkSpec({ root: { fields: [f('s', 'str', { terminator: 0 })] } });
    const r = await parse(spec, source, { signal: ac.signal });
    expect(r.stats.aborted).toBe(true);
    expect(reads).toBeLessThanOrEqual(6);
  });
});

describe('hostile recursion with two recursive children per node', () => {
  const treeSpec = () => mkSpec({ root: { fields: [f('x', 'u1'), f('kids', 'root', { repeat: { count: 2 }, if: 'x == 1' })] } });
  const preorder = (d: number): number[] => (d === 0 ? [0] : [1, ...preorder(d - 1), ...preorder(d - 1)]);

  it('a full binary tree of depth 12 parses within default limits', async () => {
    const r = await parse(treeSpec(), mem(preorder(12)));
    expect(r.stats.truncated).toBe(false);
    expect(r.errors).toEqual([]);
  });

  it('ends at maxNodes with truncated set', async () => {
    const r = await parse(treeSpec(), mem(preorder(12)), { limits: { maxNodes: 1000 } });
    expect(r.stats.truncated).toBe(true);
    expect(r.stats.nodes).toBeLessThanOrEqual(1000);
    expect(codes(r)).toContain('limit');
  });

  it('ends at maxSteps with truncated set', async () => {
    const r = await parse(treeSpec(), mem(preorder(12)), { limits: { maxSteps: 300 } });
    expect(r.stats.truncated).toBe(true);
    expect(r.errors.some((e) => /step budget/.test(e.message))).toBe(true);
  });

  it('an all-ones file ends at the depth limit', async () => {
    const r = await parse(treeSpec(), mem(new Array(5000).fill(1)));
    expect(r.stats.truncated).toBe(true);
    expect(r.errors.some((e) => /nesting depth/.test(e.message))).toBe(true);
  });
});

describe('maxDiagnostics covers assert diagnostics', () => {
  it('caps them and counts the rest as suppressed', async () => {
    const spec = mkSpec({
      root: { fields: [f('recs', 'rec', { repeat: { count: 50 } })] },
      rec: { fields: [f('v', 'u1', { assert: [{ expr: '_ > 100', level: 'warning', message: 'too small' }] })] },
    });
    const r = await parse(spec, mem(new Array(50).fill(1)), { limits: { maxDiagnostics: 5 } });
    expect(r.errors).toHaveLength(5);
    expect(r.stats.suppressedDiagnostics).toBe(45);
    // validation messages stay on the nodes even when the diagnostic list is capped
    expect(find(r.root, 'recs.recs[49].v').validation).toEqual(['too small']);
  });
});

describe('expandFixed keeps what it collected when halted', () => {
  it('returns the elements parsed before a node-limit Halt', async () => {
    const spec = mkSpec({
      root: { fields: [f('recs', 'rec', { repeat: { count: 3000 } })] },
      rec: { fields: [f('a', 'u1'), f('b', 'u1')] },
    });
    const r = await parse(spec, new MemoryByteSource(new Uint8Array(6000)), { limits: { maxNodes: 50 } });
    const got = await expandLazy(r, find(r.root, 'recs').id, { start: 0, count: 500 });
    expect(got.length).toBeGreaterThan(10);
    expect(got.length).toBeLessThan(500);
    expect(got.map((n) => n.name)).toEqual(got.map((_, i) => `recs[${i}]`));
    expect(codes(r)).toContain('limit');
  });
});

describe('array length of failed arrays', () => {
  it('is null for a failed array and the real count otherwise', async () => {
    const spec = mkSpec({
      root: {
        fields: [
          f('good', 'u1', { repeat: { count: 2 } }),
          f('bad', 'u1', { repeat: { until: '_ == 0' } }),
          f('goodCheck', 'u1', { at: 0, if: 'good.length == 2' }),
          f('failedCheck', 'u1', { at: 1, if: 'bad.length == null' }),
          f('wrongCheck', 'u1', { at: 2, if: 'bad.length != null' }),
        ],
      },
    });
    const r = await parse(spec, mem([1, 2, 3]));
    expect(find(r.root, 'bad').error).toMatch(/never became true/);
    expect(find(r.root, 'goodCheck').value).toBe(1);
    expect(find(r.root, 'failedCheck').value).toBe(2);
    expect(r.root.children!.some((c) => c.name === 'wrongCheck')).toBe(false);
    // an `until` array that succeeds reports its real length
    const ok = mkSpec({ root: { fields: [f('arr', 'u1', { repeat: { until: '_ == 0' } }), f('chk', 'u1', { at: 0, if: 'arr.length == 2' })] } });
    const r2 = await parse(ok, mem([5, 0, 9]));
    expect(find(r2.root, 'chk').value).toBe(5);
  });
});

describe('skim diagnostics', () => {
  it('validation problems inside skimmed elements are not reported twice or dangling; they appear on expansion', async () => {
    const spec = mkSpec({
      root: { fields: [f('items', 'rec', { repeat: { count: 1100 } })] },
      rec: { fields: [f('len', 'u1', { expect: 1 }), f('data', 'bytes', { size: 'len' })] },
    });
    const bytes: number[] = [];
    for (let i = 0; i < 1100; i++) bytes.push(...(i < 1000 ? [1, 9] : [2, 9, 9])); // elements >= 1000 violate expect
    const d = Uint8Array.from(bytes);
    const r = await parse(spec, new MemoryByteSource(d));
    expect(r.errors.filter((e) => e.code === 'validation')).toHaveLength(0);
    await expandLazy(r, find(r.root, 'items').id, { start: 1000, count: 100 });
    expect(r.errors.filter((e) => e.code === 'validation')).toHaveLength(100);
  });
});

describe('static member-path validation', () => {
  const spec = (exprs: string[], over: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    id: 'x',
    name: 'X',
    endian: 'le',
    root: 'root',
    types: {
      root: {
        fields: [
          f('hdr', 'hdr'),
          f('p', 'pt'),
          f('arr', 'u1', { repeat: { count: 2 } }),
          ...exprs.map((e, i) => f(`c${i}`, 'u1', { if: e })),
        ],
      },
      hdr: { fields: [f('size', 'u4'), f('body', { switch: 'size', cases: { '1': 'a', '2': 'b' } })] },
      a: { fields: [f('compression', 'u4')] },
      b: { fields: [f('compression', 'u4'), f('other', 'u4')] },
      pt: { fields: [f('q', 'qt')] },
      qt: { fields: [f('z', 'u1')] },
    },
    ...over,
  });
  const messages = (s: unknown) => {
    const r = validateSpec(s);
    return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
  };

  it('catches a typo in a switch-typed member', () => {
    expect(messages(spec(['hdr.body.compresion == 0']))).toEqual([expect.stringMatching(/\.if: unknown member "compresion" of type "a" or "b"/)]);
  });
  it('accepts valid switch paths, including members only some cases define', () => {
    expect(messages(spec(['hdr.body.compression == 0', 'hdr.body.other == 0', 'hdr.size == 1', 'hdr.body.other == null']))).toEqual([]);
  });
  it('catches typos on a statically unique type, at any depth', () => {
    expect(messages(spec(['hdr.sizee == 1']))).toEqual([expect.stringMatching(/unknown member "sizee" of type "hdr"/)]);
    expect(messages(spec(['p.q.zz == 1']))).toEqual([expect.stringMatching(/unknown member "zz" of type "qt"/)]);
    expect(messages(spec(['p.q.z == 1']))).toEqual([]);
  });
  it('stops at builtins, repeats and reserved roots', () => {
    expect(messages(spec(['arr.length == 2', 'arr.whatever == null', 'hdr.size.x == null', '_parent.zzz == null', '_io.zzz == null', '_root.zzz == null']))).toEqual([]);
  });
  it('a bytes or primitive case makes any member plausible (it reads as null at runtime)', () => {
    const s = spec(['hdr.body.compresion == null'], {});
    (s.types.hdr.fields[1] as { type: { default?: string } }).type.default = 'u4';
    expect(messages(s)).toEqual([]);
  });
  it('built-in BMP still validates', () => {
    expect(validateSpec(bmpJson).ok).toBe(true);
  });
  it('checks expressions anywhere: until, switch, assert, repeat count', () => {
    const s = spec([]);
    s.types.root.fields.push(f('n', 'u1', { assert: [{ expr: 'hdr.nope == 1' }] }));
    expect(messages(s)).toEqual([expect.stringMatching(/assert\[0\]\.expr: unknown member "nope" of type "hdr"/)]);
  });
});

describe('docs: autolinks and empty code', () => {
  it('neutralises bare URLs, www hosts and e-mail addresses in prose', () => {
    const spec = mkSpec({ root: { fields: [f('a', 'u1', { doc: 'see https://evil.example/x www.evil.example mail me@evil.example' })] } });
    const out = generateMarkdown(spec);
    expect(out).toContain('https\\://evil.example/x');
    expect(out).toContain('www\\.evil.example');
    expect(out).toContain('me\\@evil.example');
    expect(out).not.toMatch(/https:\/\//);
  });
  it('renders an empty code span as a valid one', () => {
    const spec = mkSpec({ root: { fields: [f('s', 'str', { size: 0, encoding: 'ascii', expect: '' })] } });
    expect(generateMarkdown(spec)).toContain('Expected value: ` `.');
  });
});

describe('BMP: truncated known-size body', () => {
  it('falls back to the remaining-bytes pixel size when size_image is unavailable', async () => {
    const v = validateSpec(bmpJson);
    if (!v.ok) throw new Error('bmp invalid');
    const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
    // 14-byte file header with off_bits = 20, then a 40-byte DIB header cut after bpp (30 bytes in total)
    const full = [0x42, 0x4d, ...le32(100), 0, 0, 0, 0, ...le32(20), ...le32(40), ...le32(2), ...le32(2), 1, 0, 24, 0];
    expect(full.length).toBe(30);
    const bytes = Uint8Array.from(full.slice(0, 30));
    const r = await parse(v.spec, new MemoryByteSource(bytes));
    expect(find(r.root, 'dib.body').children!.some((c) => c.name === 'size_image')).toBe(false);
    const px = find(r.root, 'pixels');
    expect(px.error).toBeUndefined();
    expect([px.offset, px.size]).toEqual([20, 10]);
  });
});
