import { describe, expect, it } from 'vitest';
import zipJson from '../../formats/zip.json';
import { buildZip } from '../../test/zip-builder';
import { MemoryByteSource } from '../byte-source';
import { createInlineClient } from '../../worker/inline-client';
import { toModel, toText, isModelError } from '../builder/model';
import { buildDocModel, generateHtml, generateMarkdown } from './docs';
import { expandLazy, expandRef, findNodeAt, parse } from './interpret';
import { find } from './test-helpers';
import { formatIssues, validateSpec } from './validate';

const v = validateSpec(zipJson);
if (!v.ok) throw new Error(formatIssues(v.errors));
const zip = v.spec;

const N = 30_000;
const big = buildZip(Array.from({ length: N }, (_, i) => ({ name: `f${i}.txt`, data: '' })));

describe('ZIP: a huge central directory stays lazy', () => {
  it('T8b: only eagerElements entries are parsed at open; later pages and their refs work', async () => {
    const r = await parse(zip, new MemoryByteSource(big.bytes));
    const arr = find(r.root, 'central_directory.entries');
    expect(arr.children).toHaveLength(1000);
    expect(arr.lazy).toMatchObject({ count: N, loaded: 1000 });
    expect(r.stats.bytesRead).toBeLessThan(400_000);
    expect(r.errors).toEqual([]);
    // page forward like the UI does (200 at a time) up to a late page
    let loaded = 1000;
    let last: Awaited<ReturnType<typeof expandLazy>> = [];
    while (loaded < 20_000) {
      last = await expandLazy(r, arr.id, { start: loaded, count: 200 });
      expect(last).toHaveLength(200);
      loaded += 200;
    }
    const e = last[199]!;
    expect(e.name).toBe('entries[19999]');
    expect(find(e, 'name').value).toBe('f19999.txt');
    const ref = find(e, 'local_header');
    expect(ref.ref?.offset).toBe(big.layout.entries[19999]!.lfh);
    const [t] = await expandRef(r, ref.id);
    expect(find(t!, 'header.name').value).toBe('f19999.txt');
    expect(r.errors).toEqual([]);
    // the opened ref of a late page is found by byte position
    expect(findNodeAt(r.root, big.layout.entries[19999]!.lfh + 4)?.name).toBe('version_needed');
  }, 60_000);

  it('the same through the worker handler: nodeAt and ranges see a ref opened inside a lazily loaded page', async () => {
    const c = createInlineClient({ specs: [zip], specErrors: [], makeSource: () => new MemoryByteSource(big.bytes) });
    await c.open(null, 'big.zip');
    const snap = (await c.parse('zip'))!;
    const arr = find(snap.root, 'central_directory.entries');
    let loaded = 1000;
    let page: Awaited<ReturnType<typeof c.expand>> | null = null;
    while (loaded < 2000) {
      page = await c.expand(arr.id, loaded, 200);
      loaded += 200;
    }
    const e = page!.nodes[199]!;
    const ref = find(e, 'local_header');
    const res = await c.expandRef(ref.id);
    expect(res.nodes).toHaveLength(1);
    const at = big.layout.entries[1999]!.lfh;
    const loc = await c.nodeAt(at + 4);
    expect(loc.path).not.toBeNull();
    expect(loc.path!.at(-1)).toBe(find(res.nodes[0]!, 'header.version_needed').id);
    const segs = await c.ranges(at, at + 30);
    expect(segs.length).toBeGreaterThan(5);
  }, 60_000);
});

describe('ZIP: documentation and builder', () => {
  it('docs generation succeeds and mentions the signatures and key structures', () => {
    const md = generateMarkdown(zip);
    expect(md).toContain('50 4B 05 06');
    expect(md).toContain('End of central directory');
    expect(md).toContain('Central directory file header');
    expect(md).toContain('`.zip`');
    expect(md).toMatch(/found by searching backward/);
    expect(md).toMatch(/Reference: can be opened as `local_entry`/);
    expect(md).toMatch(/Computed value/);
    const html = generateHtml(zip);
    expect(html.length).toBeGreaterThan(1000);
    expect(buildDocModel(zip).types.length).toBeGreaterThan(20);
  });

  it('opens in the builder model and round-trips losslessly', () => {
    const text = JSON.stringify(zipJson);
    const m = toModel(text);
    if (isModelError(m)) throw new Error(m.error);
    expect(JSON.parse(toText(m))).toEqual(JSON.parse(text));
    expect(validateSpec(JSON.parse(toText(m))).ok).toBe(true);
  });

  it('declares more than 32 extensions (the validator cap is 64)', () => {
    expect(zip.extensions!.length).toBeGreaterThan(32);
    const over = { ...zipJson, extensions: Array.from({ length: 65 }, (_, i) => `e${i}`) };
    expect(validateSpec(over).ok).toBe(false);
  });
});
