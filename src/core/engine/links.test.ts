import { describe, expect, it } from 'vitest';
import bmpJson from '../../formats/bmp.json';
import zipJson from '../../formats/zip.json';
import { buildZip, type ZipEntry } from '../../test/zip-builder';
import { MemoryByteSource } from '../byte-source';
import { isModelError, fieldExpressions, toModel, toText } from '../builder';
import { buildDocModel, generateHtml, generateMarkdown } from './docs';
import { expandRef, parse } from './interpret';
import { find, le16, le32, mem, mkSpec } from './test-helpers';
import { formatIssues, validateSpec } from './validate';

const f = (name: string, type: unknown, extra: Record<string, unknown> = {}) => ({ name, type, ...extra });
const issues = (types: Record<string, unknown>) => {
  const r = validateSpec({ schemaVersion: 1, id: 't', name: 'T', endian: 'le', root: 'root', types });
  return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
};

// ------------------------------------------------------------------------------------------------ engine: link

describe('field link', () => {
  const run = (bytes: number[], link: unknown, extra: Record<string, unknown> = {}) =>
    parse(mkSpec({ root: { fields: [f('p', 'u1', { link, ...extra }), f('pad', 'bytes', { size: bytes.length - 1 })] } }), mem(bytes));

  it('records {offset, size, label} from expressions evaluated with `_` = the field value; nothing is read', async () => {
    const reads: number[] = [];
    const inner = new MemoryByteSource(Uint8Array.from([4, 0, 0, 0, 9, 9, 9, 9]));
    const src = { size: inner.size, read: (o: number, l: number) => (reads.push(o), inner.read(o, l)) };
    const spec = mkSpec({ root: { fields: [f('p', 'u1', { link: { at: '_', size: '2', label: 'tail' } }), f('pad', 'bytes', { size: 7 })] } });
    const r = await parse(spec, src);
    expect(r.errors).toEqual([]);
    expect(find(r.root, 'p').link).toEqual({ offset: 4, size: 2, label: 'tail' });
    expect(reads).toEqual([0, 1]); // just the field and the pad preview, never offset 4
  });

  it('size is optional (one byte), clamped to the end of the file, and a null size means one byte too', async () => {
    const b = [3, 0, 0, 7, 8];
    expect(find((await run(b, { at: '_' })).root, 'p').link).toEqual({ offset: 3, size: 1 });
    expect(find((await run(b, { at: '_', size: 100 })).root, 'p').link).toEqual({ offset: 3, size: 2 });
    expect(find((await run(b, { at: '_', size: 'null' })).root, 'p').link).toEqual({ offset: 3, size: 1 });
    expect(find((await run(b, { at: '_', size: 0 })).root, 'p').link).toEqual({ offset: 3, size: 0 });
  });

  it('an offset at or past the end of the file is quietly no link (nothing to select there)', async () => {
    for (const at of [5, 6, 200]) {
      const q = await run([at, 0, 0, 0, 0], { at: '_' });
      expect(find(q.root, 'p').link).toBeUndefined();
      expect(q.errors).toEqual([]);
    }
  });

  it('null, negative and beyond-2^53 results are quiet: no link, no diagnostics', async () => {
    const cases = ['null', '0 - 1', '_ - 5', '0x20000000000000 + _', '0xFFFFFFFFFFFFFFFF'];
    for (const at of cases) {
      const r = await run([1, 0, 0], { at });
      expect(find(r.root, 'p').link, at).toBeUndefined();
      expect(r.errors, at).toEqual([]);
    }
    // an unusable size drops the link too
    const r = await run([1, 0, 0], { at: '_', size: '0 - 1' });
    expect(find(r.root, 'p').link).toBeUndefined();
    expect(r.errors).toEqual([]);
  });

  it('an expression that errors adds one warning on the node and no link', async () => {
    for (const link of [{ at: '"text"' }, { at: '_', size: 'true' }, { at: '1 / 0' }]) {
      const r = await run([1, 0, 0], link);
      const p = find(r.root, 'p');
      expect(p.link).toBeUndefined();
      expect(p.error).toBeUndefined();
      expect(p.validation?.[0]).toMatch(/^link: /);
      expect(r.errors).toEqual([expect.objectContaining({ severity: 'warning', code: 'expr', nodeId: p.id })]);
    }
  });

  it('works on value fields and sees earlier fields; a skipped field gets no link', async () => {
    const spec = mkSpec({
      root: { fields: [f('a', 'u1'), f('v', 'value', { value: 'a * 2', link: { at: '_ + a', label: 'x' } }), f('s', 'u1', { if: 'false', link: { at: '0' } }), f('pad', 'bytes', { size: 8 })] },
    });
    const r = await parse(spec, mem([2, 0, 0, 0, 0, 0, 0, 0, 0]));
    expect(find(r.root, 'v').link).toEqual({ offset: 6, size: 1, label: 'x' });
    expect(r.root.children?.some((c) => c.name === 's')).toBe(false);
  });

  it('is evaluated for fields inside lazily expanded refs and arrays too', async () => {
    const spec = mkSpec({
      tgt: { fields: [f('o', 'u1', { link: { at: '_', size: 1 } })] },
      root: { fields: [f('p', 'u1', { ref: { type: 'tgt', at: '_' } }), f('pad', 'bytes', { size: 3 })] },
    });
    const r = await parse(spec, mem([2, 0, 3, 0]));
    const [t] = await expandRef(r, find(r.root, 'p').id);
    expect(find(t!, 'o').link).toEqual({ offset: 3, size: 1 });
  });
});

// ------------------------------------------------------------------------------------------------ validator

describe('link and jumps: validation', () => {
  const tgt = { fields: [f('header', 'u1'), f('data', 'bytes', { size: 1 }), f('inner', 'sub'), f('list', 'u1', { repeat: { count: 2 } }), f('sw', { switch: 'header', cases: { '1': 'sub' }, default: 'sub' })] };
  const base = (field: Record<string, unknown>) => ({ sub: { fields: [f('leaf', 'u1')] }, tgt, root: { fields: [f('p', 'u1', field)] } });

  it('accepts a well-formed link and jumps', () => {
    expect(issues(base({ link: { at: '_', size: 4, label: 'x' } }))).toEqual([]);
    expect(issues(base({ ref: { type: 'tgt', at: '_', jumps: [{ label: 'd', path: 'data' }, { label: 'l', path: 'inner.leaf' }, { label: 'n', path: 'list' }, { label: 's', path: 'sw' }] } }))).toEqual([]);
  });

  it('rejects unknown link keys, a missing/bad `at`, bad size and labels, and link with repeat', () => {
    expect(issues(base({ link: { at: '_', bogus: 1 } }))[0]).toMatch(/link\.bogus: unknown key/);
    expect(issues(base({ link: {} }))[0]).toMatch(/link\.at: is required/);
    expect(issues(base({ link: { at: '1 +' } }))[0]).toMatch(/link\.at: bad expression/);
    expect(issues(base({ link: { at: 'nope' } }))[0]).toMatch(/unknown name "nope"/);
    expect(issues(base({ link: { at: '_', size: -1 } }))[0]).toMatch(/link\.size: number must be a non-negative integer/);
    expect(issues(base({ link: { at: '_', label: 5 } }))[0]).toMatch(/link\.label: must be a string/);
    expect(issues(base({ link: { at: '_', label: 'x'.repeat(101) } }))[0]).toMatch(/link\.label: too long/);
    expect(issues(base({ link: 'x' }))[0]).toMatch(/link: must be an object/);
    expect(issues(base({ link: { at: '_' }, repeat: { count: 2 } }))[0]).toMatch(/"link" cannot be combined with "repeat"/);
  });

  it('rejects bad jumps: shape, labels, unknown keys, paths that do not resolve', () => {
    const ref = (jumps: unknown) => base({ ref: { type: 'tgt', at: '_', jumps } });
    expect(issues(ref('x'))[0]).toMatch(/ref\.jumps: must be an array/);
    expect(issues(ref([]))[0]).toMatch(/ref\.jumps: must be an array of 1-8/);
    expect(issues(ref(Array.from({ length: 9 }, () => ({ label: 'a', path: 'data' }))))[0]).toMatch(/ref\.jumps: must be an array of 1-8/);
    expect(issues(ref(['x']))[0]).toMatch(/jumps\[0\]: must be an object/);
    expect(issues(ref([{ label: 'a', path: 'data', extra: 1 }]))[0]).toMatch(/unknown key "extra"/);
    expect(issues(ref([{ label: 7, path: 'data' }]))[0]).toMatch(/jumps\[0\]\.label: must be a string/);
    expect(issues(ref([{ label: '', path: 'data' }]))[0]).toMatch(/label: must not be empty/);
    expect(issues(ref([{ label: 'a', path: 3 }]))[0]).toMatch(/jumps\[0\]\.path: must be a string/);
    expect(issues(ref([{ label: 'a', path: 'missing' }]))[0]).toMatch(/jumps\[0\]\.path: "missing" is not a field of type "tgt"/);
    expect(issues(ref([{ label: 'a', path: 'inner.nope' }]))[0]).toMatch(/"nope" is not a field of type "sub"/);
    expect(issues(ref([{ label: 'a', path: 'data.x' }]))[0]).toMatch(/type "bytes", which has no fields/);
    expect(issues(ref([{ label: 'a', path: 'list.x' }]))[0]).toMatch(/is an array/);
    expect(issues(ref([{ label: 'a', path: 'sw.leaf' }]))[0]).toMatch(/switch type/);
    expect(issues(ref([{ label: 'a', path: 'inner..leaf' }]))[0]).toMatch(/"" is not a field/);
    expect(issues(ref([{ label: 'a', path: '__proto__' }]))[0]).toMatch(/"__proto__" is not a field/);
    expect(issues(ref([{ label: 'a', path: Array.from({ length: 9 }, () => 'inner').join('.') }]))[0]).toMatch(/too deep/);
  });
});

// ------------------------------------------------------------------------------------------------ jumps carried to nodes

describe('ref jumps on nodes', () => {
  it('are copied onto the ref node (and survive expandRef), and are absent without jumps', async () => {
    const spec = mkSpec({
      tgt: { fields: [f('head', 'u1'), f('body', 'bytes', { size: 2 })] },
      root: { fields: [f('p', 'u1', { ref: { type: 'tgt', at: '_', jumps: [{ label: 'body', path: 'body' }] } }), f('q', 'u1', { ref: { type: 'tgt', at: '_' } }), f('pad', 'bytes', { size: 3 })] },
    });
    const r = await parse(spec, mem([2, 2, 5, 6, 7]));
    expect(find(r.root, 'p').ref).toEqual({ typeName: 'tgt', offset: 2, jumps: [{ label: 'body', path: 'body' }] });
    expect(find(r.root, 'q').ref).toEqual({ typeName: 'tgt', offset: 2 });
    await expandRef(r, find(r.root, 'p').id);
    expect(find(r.root, 'p').ref).toEqual({ typeName: 'tgt', offset: 2, loaded: true, jumps: [{ label: 'body', path: 'body' }] });
    expect(find(r.root, 'p.tgt.body')).toMatchObject({ offset: 3, size: 2 });
  });
});

// ------------------------------------------------------------------------------------------------ docs + builder

describe('docs and builder', () => {
  const spec = mkSpec({
    tgt: { fields: [f('data', 'bytes', { size: 1 })] },
    root: {
      fields: [
        f('p', 'u1', { link: { at: '_', size: '2', label: '<img src=x onerror=alert(1)> | `x`' } }),
        f('q', 'u1', { ref: { type: 'tgt', at: '_', jumps: [{ label: '<b>d</b>|x', path: 'data' }] } }),
      ],
    },
  });

  it('documents link and jumps in the model, markdown and HTML, escaped', () => {
    const lenient = spec;
    const m = buildDocModel(lenient);
    const fields = m.types.find((t) => t.name === 'root')!.fields;
    expect(fields[0]!.link).toEqual({ at: '_', size: '2', label: '<img src=x onerror=alert(1)> | `x`' });
    expect(fields[1]!.ref?.jumps).toEqual([{ label: '<b>d</b>|x', path: 'data' }]);
    const md = generateMarkdown(lenient);
    expect(md).toContain('Link: jumps to file offset `_` (`2` bytes)');
    expect(md).toContain('Jump shortcuts:');
    expect(md).not.toContain('<img'); // escaped
    expect(md).not.toContain('<b>');
    expect(md.split('\n').filter((l) => l.startsWith('| `p`'))).toHaveLength(1); // the `|` in the label did not break the table row
    const html = generateHtml(lenient);
    expect(html).toContain('Link: jumps to file offset');
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<b>d/i);
    expect(html).toContain('&lt;img');
  });

  it('builder: round-trips link/jumps in schema key order and lists the link expression slots', () => {
    const json = {
      schemaVersion: 1,
      id: 'l',
      name: 'L',
      endian: 'le',
      root: 'root',
      types: {
        tgt: { fields: [{ name: 'data', type: 'bytes', size: 1 }] },
        root: {
          fields: [
            { name: 'p', type: 'u1', link: { at: '_', size: 'p + 1', label: 'x' }, doc: 'd' },
            { name: 'q', type: 'u1', ref: { type: 'tgt', at: '_', doc: 'r', jumps: [{ label: 'a', path: 'data' }] } },
          ],
        },
      },
    };
    expect(validateSpec(json).ok).toBe(true);
    const scrambled = JSON.parse(JSON.stringify(json));
    scrambled.types.root.fields[0].link = { label: 'x', size: 'p + 1', at: '_' };
    scrambled.types.root.fields[1].ref = { jumps: [{ path: 'data', label: 'a' }], doc: 'r', at: '_', type: 'tgt' };
    const model = toModel(JSON.stringify(scrambled));
    if (isModelError(model)) throw new Error(model.error);
    const out = JSON.parse(toText(model));
    expect(out).toEqual(json);
    expect(Object.keys(out.types.root.fields[0])).toEqual(['name', 'type', 'link', 'doc']);
    expect(Object.keys(out.types.root.fields[0].link)).toEqual(['at', 'size', 'label']);
    expect(Object.keys(out.types.root.fields[1].ref)).toEqual(['type', 'at', 'doc', 'jumps']);
    expect(Object.keys(out.types.root.fields[1].ref.jumps[0])).toEqual(['label', 'path']);
    const fields = model.types.find((t) => t.name === 'root')!.fields;
    expect(fieldExpressions(fields[0]!)).toEqual([
      { slot: 'link.at', expr: '_' },
      { slot: 'link.size', expr: 'p + 1' },
    ]);
    expect(fieldExpressions(fields[1]!)).toEqual([{ slot: 'ref.at', expr: '_' }]);
  });
});

// ------------------------------------------------------------------------------------------------ BMP spec

const vb = validateSpec(bmpJson);
if (!vb.ok) throw new Error(formatIssues(vb.errors));
const vz = validateSpec(zipJson);
if (!vz.ok) throw new Error(formatIssues(vz.errors));

function bmpBytes(opts: { v5?: boolean; profile?: boolean } = {}): { bytes: Uint8Array; pixelsAt: number; profileAt: number } {
  const hdrSize = opts.v5 ? 124 : 40;
  const dib = [...le32(hdrSize), ...le32(2), ...le32(2), ...le16(1), ...le16(24), ...le32(0), ...le32(16), ...le32(0), ...le32(0), ...le32(0), ...le32(0)];
  while (dib.length < hdrSize) dib.push(0);
  const pixelsAt = 14 + hdrSize;
  const pixels = new Array(16).fill(0xab);
  const profile = opts.profile ? [1, 2, 3, 4, 5, 6] : [];
  if (opts.v5) {
    dib.splice(56, 4, ...le32(opts.profile ? 0x4d424544 : 0)); // cs_type 'MBED'
    dib.splice(112, 4, ...le32(opts.profile ? pixelsAt + pixels.length - 14 : 0)); // profile_data (relative to the DIB header)
    dib.splice(116, 4, ...le32(profile.length));
  }
  const total = pixelsAt + pixels.length + profile.length;
  const bytes = Uint8Array.from([0x42, 0x4d, ...le32(total), 0, 0, 0, 0, ...le32(pixelsAt), ...dib, ...pixels, ...profile]);
  return { bytes, pixelsAt, profileAt: pixelsAt + pixels.length };
}

describe('BMP spec links', () => {
  const bmp = vb.spec;
  it('off_bits links to the pixel data (to the end of the file)', async () => {
    const { bytes, pixelsAt } = bmpBytes();
    const r = await parse(bmp, new MemoryByteSource(bytes));
    expect(r.errors).toEqual([]);
    expect(find(r.root, 'file_header.off_bits').link).toEqual({ offset: pixelsAt, size: bytes.length - pixelsAt, label: 'pixel data' });
    expect(find(r.root, 'pixels').offset).toBe(pixelsAt);
  });

  it('an off_bits beyond the file gets no link and no diagnostics from the link', async () => {
    const { bytes } = bmpBytes();
    const bad = Uint8Array.from(bytes);
    bad.set(le32(0x7fffffff), 10);
    const r = await parse(bmp, new MemoryByteSource(bad));
    expect(find(r.root, 'file_header.off_bits').link).toBeUndefined();
    expect(r.errors.filter((e) => /link/.test(e.message))).toEqual([]);
  });

  it('V5 profile_data/profile_size link to the absolute profile position (14 + offset) and size', async () => {
    const { bytes, profileAt } = bmpBytes({ v5: true, profile: true });
    const r = await parse(bmp, new MemoryByteSource(bytes));
    expect(find(r.root, 'dib.body.profile_data').link).toEqual({ offset: profileAt, size: 1, label: 'profile' });
    expect(find(r.root, 'dib.body.profile_size').link).toEqual({ offset: profileAt, size: 6, label: 'profile' });
    expect(find(r.root, 'profile').offset).toBe(profileAt);
  });

  it('V5 without an embedded profile has no profile links', async () => {
    const { bytes } = bmpBytes({ v5: true });
    const r = await parse(bmp, new MemoryByteSource(bytes));
    expect(find(r.root, 'dib.body.profile_data').link).toBeUndefined();
    expect(find(r.root, 'dib.body.profile_size').link).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------ ZIP spec

describe('ZIP spec links', () => {
  const zip = vz.spec;
  const run = (bytes: Uint8Array) => parse(zip, new MemoryByteSource(bytes));
  const link = (r: Awaited<ReturnType<typeof run>>, path: string) => find(r.root, path).link;
  const entryPath = (i: number) => `central_directory.entries.entries[${i}]`;

  it('T1: cd_start/eocd.cd_offset link to the central directory; the entry offset links to its local header', async () => {
    const { bytes, layout } = buildZip([{ name: 'a.txt', data: 'hi' }]);
    const r = await run(bytes);
    expect(r.errors).toEqual([]);
    expect(link(r, 'cd_start')).toEqual({ offset: layout.cd, size: layout.cdSize, label: 'central directory' });
    expect(link(r, 'eocd.cd_offset')).toEqual({ offset: layout.cd, size: layout.cdSize, label: 'central directory' });
    expect(link(r, `${entryPath(0)}.local_header_offset`)).toEqual({ offset: 0, size: 30, label: 'local header' });
    expect(link(r, `${entryPath(0)}.lho_eff`)).toEqual({ offset: 0, size: 30, label: 'local header' });
    expect(find(r.root, `${entryPath(0)}.local_header`).ref?.jumps).toEqual([
      { label: 'local header', path: 'header' },
      { label: 'data', path: 'data' },
      { label: 'descriptor', path: 'descriptor' },
    ]);
  });

  it('with a stub in front the effective links include the delta; the raw eocd link keeps the stored offset', async () => {
    const stub = new Array(512).fill(0x90);
    const { bytes, layout } = buildZip([{ name: 'a.txt', data: 'hi' }], { prefix: stub });
    const r = await run(bytes);
    expect(link(r, 'cd_start')).toEqual({ offset: layout.cd, size: layout.cdSize, label: 'central directory' });
    expect(link(r, 'eocd.cd_offset')?.offset).toBe(layout.cd - 512);
    expect(link(r, `${entryPath(0)}.lho_eff`)?.offset).toBe(512);
    expect(link(r, `${entryPath(0)}.local_header_offset`)?.offset).toBe(512);
  });

  it('ZIP64: sentinels carry no raw links; the effective ones and the ZIP64 record/locator do', async () => {
    const two: ZipEntry[] = [
      { name: 'one.txt', data: 'hello', zip64: true },
      { name: 'two.txt', data: 'world!!', zip64: true },
    ];
    const { bytes, layout } = buildZip(two, { zip64Eocd: true });
    const r = await run(bytes);
    expect(r.errors).toEqual([]);
    expect(link(r, 'eocd.cd_offset')).toBeUndefined(); // 0xFFFFFFFF sentinel
    expect(link(r, 'cd_start')).toEqual({ offset: layout.cd, size: layout.cdSize, label: 'central directory' });
    expect(link(r, 'locator.z64_eocd_offset')).toEqual({ offset: layout.z64eocd, size: 56, label: 'ZIP64 end of central directory' });
    expect(link(r, 'z64_adjacent.cd_offset')).toEqual({ offset: layout.cd, size: layout.cdSize, label: 'central directory' });
    for (const i of [0, 1]) {
      expect(link(r, `${entryPath(i)}.local_header_offset`)).toBeUndefined();
      expect(link(r, `${entryPath(i)}.lho_eff`)).toEqual({ offset: layout.entries[i]!.lfh, size: 30, label: 'local header' });
      expect(link(r, `${entryPath(i)}.extra.blocks.blocks[0].body.local_header_offset`)).toEqual({ offset: layout.entries[i]!.lfh, size: 30, label: 'local header' });
    }
  });

  it('the data jump path resolves to the entry data (offset = lfh + 30 + name + extra), and descriptor is absent without flag bit 3', async () => {
    const { bytes, layout } = buildZip([{ name: 'a.txt', data: 'hello' }, { name: 'b.txt', data: 'xy', descriptor: 'sig' }]);
    const r = await run(bytes);
    for (const i of [0, 1]) {
      const [t] = await expandRef(r, find(r.root, `${entryPath(i)}.local_header`).id);
      expect(find(t!, 'data')).toMatchObject({ offset: layout.entries[i]!.data, size: layout.entries[i]!.dataLen });
      expect(find(t!, 'header').offset).toBe(layout.entries[i]!.lfh);
      expect((t!.children ?? []).some((c) => c.name === 'descriptor')).toBe(i === 1);
    }
  });
});
