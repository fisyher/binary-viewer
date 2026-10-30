import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../byte-source';
import { MemoryByteSource } from '../byte-source';
import { generateMarkdown } from './docs';
import type { Node, ParseResult } from './interpret';
import { expandLazy, parse } from './interpret';
import { find, mkSpec } from './test-helpers';

const f = (name: string, type: unknown, extra: Record<string, unknown> = {}) => ({ name, type, ...extra });

function allIds(n: Node, out = new Set<number>()): Set<number> {
  out.add(n.id);
  n.children?.forEach((c) => allIds(c, out));
  return out;
}
const noDanglingDiagnostics = (r: ParseResult) => {
  const ids = allIds(r.root);
  for (const e of r.errors) if (e.nodeId !== undefined) expect(ids.has(e.nodeId), e.message).toBe(true);
};

describe('failures while skimming are reported', () => {
  it('probe: a truncated record after 1200 good ones is visible on the array and in the diagnostics', async () => {
    const spec = mkSpec({
      root: { fields: [f('items', 'rec', { repeat: 'eos' }), f('tail', 'u1')] },
      rec: { fields: [f('kind', 'u1'), f('ext', 'u4', { if: 'kind == 1' })] },
    });
    const data = Uint8Array.from([...new Array(1200).fill(0), 1, 0, 0]);
    const r = await parse(spec, new MemoryByteSource(data));
    const items = find(r.root, 'items');
    expect(items.children).toHaveLength(1000);
    expect(items.error).toMatch(/element 1200 failed while skimming past the first 1000 elements: truncated/);
    const diag = r.errors.find((e) => e.nodeId === items.id);
    expect(diag?.severity).toBe('error');
    expect(diag?.message).toMatch(/element 1200/);
    expect(r.root.children!.some((c) => c.name === 'tail')).toBe(false); // the struct stopped, but visibly
    noDanglingDiagnostics(r);
  });

  it('nested: a failure inside a skimmed element reports on the outer array only, never with a dangling node id', async () => {
    const spec = mkSpec({
      root: { fields: [f('items', 'rec', { repeat: 'eos' }), f('tail', 'u1')] },
      rec: { fields: [f('n', 'u1'), f('vals', 'sub', { repeat: { count: 'n' } })] },
      sub: { fields: [f('k', 'u1'), f('ext', 'u4', { if: 'k == 1' })] },
    });
    const bytes: number[] = [];
    for (let i = 0; i < 1200; i++) bytes.push(1, 0); // n=1, sub k=0
    bytes.push(1, 1, 0, 0); // n=1, sub k=1 but only 2 of the 4 ext bytes
    const r = await parse(spec, new MemoryByteSource(Uint8Array.from(bytes)));
    const items = find(r.root, 'items');
    expect(items.error).toMatch(/element 1200 failed while skimming.*truncated/);
    expect(r.errors.filter((e) => e.nodeId === items.id)).toHaveLength(1);
    expect(r.errors.every((e) => e.nodeId === undefined || e.nodeId === items.id || allIds(r.root).has(e.nodeId))).toBe(true);
    noDanglingDiagnostics(r);
  });

  it('the same failure inside the kept part is an element error node', async () => {
    const spec = mkSpec({
      root: { fields: [f('items', 'rec', { repeat: 'eos' })] },
      rec: { fields: [f('kind', 'u1'), f('ext', 'u4', { if: 'kind == 1' })] },
    });
    const r = await parse(spec, new MemoryByteSource(Uint8Array.from([0, 0, 1, 0, 0])));
    expect(find(r.root, 'items.items[2].ext').error).toMatch(/truncated/);
    noDanglingDiagnostics(r);
  });
});

describe('a Halt during expansion is recorded on the result', () => {
  const spec = () =>
    mkSpec({
      root: { fields: [f('items', 'rec', { repeat: { count: 3000 } })] },
      rec: { fields: [f('len', 'u1'), f('data', 'bytes', { size: 'len' })] },
    });
  const data = () => {
    const d = new Uint8Array(6000);
    for (let i = 0; i < 3000; i++) d[i * 2] = 1;
    return d;
  };

  it('node limit: truncated is set, the result is short, a later call continues', async () => {
    const r = await parse(spec(), new MemoryByteSource(data()), { limits: { maxNodes: 3100 } });
    expect(r.stats.truncated).toBe(false);
    const items = find(r.root, 'items');
    const got = await expandLazy(r, items.id, { start: 1000, count: 2000 });
    expect(got.length).toBeLessThan(2000); // partial expansion
    expect(r.stats.truncated).toBe(true);
    expect(r.stats.aborted).toBe(false);
    const more = await expandLazy(r, items.id, { start: 1000 + got.length, count: 10 });
    expect(more.length).toBe(10);
  });

  it('abort: aborted and truncated are set', async () => {
    const inner = new MemoryByteSource(data());
    const ac = new AbortController();
    let reads = 0;
    let abortAt = Infinity;
    const source: ByteSource = {
      size: inner.size,
      async read(o, l) {
        if (++reads === abortAt) ac.abort();
        return inner.read(o, l);
      },
    };
    const r = await parse(spec(), source);
    expect(r.stats.aborted).toBe(false);
    abortAt = reads + 20;
    await expandLazy(r, find(r.root, 'items').id, { start: 1000, count: 500 }, { signal: ac.signal });
    expect(r.stats.aborted).toBe(true);
    expect(r.stats.truncated).toBe(true);
  });

  it('fixed-size arrays too', async () => {
    const s = mkSpec({
      root: { fields: [f('recs', 'rec', { repeat: { count: 3000 } })] },
      rec: { fields: [f('a', 'u1'), f('b', 'u1')] },
    });
    const r = await parse(s, new MemoryByteSource(new Uint8Array(6000)), { limits: { maxNodes: 50 } });
    expect(r.stats.truncated).toBe(false);
    await expandLazy(r, find(r.root, 'recs').id, { start: 0, count: 500 });
    expect(r.stats.truncated).toBe(true);
  });
});

describe('docs: www. cannot be hidden behind punctuation', () => {
  it.each(['_www.evil.example', '*www.evil.example', '(www.evil.example', 'x-www.evil.example', 'WWW.EVIL.EXAMPLE'])('%s', (text) => {
    const out = generateMarkdown(mkSpec({ root: { fields: [f('a', 'u1', { doc: `go ${text} now` })] } }));
    expect(out).toMatch(/www\\\.evil/i);
    expect(out).not.toMatch(/(^|[^\\A-Za-z0-9])www\.evil/i);
  });
});
