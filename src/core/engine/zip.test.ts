import { describe, expect, it } from 'vitest';
import bmpJson from '../../formats/bmp.json';
import zipJson from '../../formats/zip.json';
import { MemoryByteSource } from '../byte-source';
import { buildZip, crc32, extraBlock, le64, put16, put32, put64, utf8, type ZipEntry, type ZipOptions } from '../../test/zip-builder';
import { detect } from './detect';
import type { Limits, Node, ParseResult } from './interpret';
import { expandLazy, expandRef, parse } from './interpret';
import { find, le16, le32 } from './test-helpers';
import { formatIssues, validateSpec } from './validate';

const vz = validateSpec(zipJson);
if (!vz.ok) throw new Error(formatIssues(vz.errors));
const zip = vz.spec;
const vb = validateSpec(bmpJson);
if (!vb.ok) throw new Error(formatIssues(vb.errors));
const bmp = vb.spec;

const run = (bytes: Uint8Array | number[], limits?: Partial<Limits>) => parse(zip, new MemoryByteSource(Uint8Array.from(bytes)), limits ? { limits } : undefined);
const rootVal = (r: ParseResult, name: string) => find(r.root, name).value;
const entriesNode = (r: ParseResult) => find(r.root, 'central_directory.entries');
const entry = (r: ParseResult, i: number) => find(entriesNode(r), `entries[${i}]`);
const refNode = (r: ParseResult, i: number) => find(entry(r, i), 'local_header');
const open = async (r: ParseResult, i: number) => (await expandRef(r, refNode(r, i).id))[0]!;
/** Diagnostic messages without the "zip_file.field.path: " prefix that validation diagnostics carry. */
const plain = (m: string) => m.replace(/^zip_file[\w.[\]]*: /, '');
const warnings = (r: ParseResult) => r.errors.filter((e) => e.severity === 'warning').map((e) => plain(e.message));
const errors = (r: ParseResult) => r.errors.filter((e) => e.severity === 'error').map((e) => plain(e.message));
const has = (n: Node, name: string) => (n.children ?? []).some((c) => c.name === name);
const ZIP_JUMPS = [
  { label: 'local header', path: 'header' },
  { label: 'data', path: 'data' },
  { label: 'descriptor', path: 'descriptor' },
];
const T1 = (o: ZipOptions = {}) => buildZip([{ name: 'a.txt', data: 'hi' }], o);

// ------------------------------------------------------------------------------------------------ fixtures

describe('zip builder sanity', () => {
  it('crc32 matches the standard check value; T1 has the documented layout', () => {
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926);
    const { bytes, layout } = T1();
    expect(bytes.length).toBe(110);
    expect(layout).toMatchObject({ eocd: 88, cd: 37, cdSize: 51 });
  });
});

// ------------------------------------------------------------------------------------------------ T1, T2, detection

describe('ZIP: a minimal archive', () => {
  it('T1: locates the EOCD from the end, lists the entry and opens its local header', async () => {
    const { bytes } = T1();
    const r = await run(bytes);
    expect(r.errors).toEqual([]);
    const eocd = find(r.root, 'eocd');
    expect(eocd).toMatchObject({ offset: 88, size: 22 });
    expect(find(eocd, 'entries_total').value).toBe(1);
    expect(find(eocd, 'cd_offset').value).toBe(37);
    expect(find(eocd, 'cd_size').value).toBe(51);
    expect(rootVal(r, 'delta')).toBe(0);
    expect(rootVal(r, 'cd_start')).toBe(37);
    expect(has(r.root, 'locator')).toBe(false);
    const cd = find(r.root, 'central_directory');
    expect(cd).toMatchObject({ offset: 37, size: 51 });
    expect(entriesNode(r).children).toHaveLength(1);
    const e = entry(r, 0);
    expect(find(e, 'name').value).toBe('a.txt');
    expect(find(e, 'method').enumLabel).toBe('stored');
    expect(find(e, 'made_by_host').enumLabel).toBe('ms_dos');
    expect(find(e, 'crc32').value).toBe(crc32(utf8('hi')));
    expect(find(e, 'comp_size_eff').value).toBe(2);
    expect(find(e, 'lho_eff').value).toBe(0);
    expect(refNode(r, 0).ref).toEqual({ typeName: 'local_entry', offset: 0, jumps: ZIP_JUMPS });

    const target = await open(r, 0);
    expect(find(target, 'header.sig').value).toBe(0x04034b50);
    expect(find(target, 'header.name').value).toBe('a.txt');
    expect(find(target, 'header').size).toBe(35);
    expect(find(target, 'data')).toMatchObject({ offset: 35, size: 2 });
    expect(has(target, 'descriptor')).toBe(false);
    expect(r.errors).toEqual([]);
  });

  it('T1: decodes the DOS time and date, the flag bits and the attributes', async () => {
    const { bytes } = buildZip([{ name: 'a.txt', flags: 0x2808, dosTime: (13 << 11) | (45 << 5) | 15, dosDate: (44 << 9) | (12 << 5) | 31, externalAttr: (0o100644 << 16) | 0x20, madeBy: [63, 3] }]);
    const r = await run(bytes);
    const e = entry(r, 0);
    expect(find(e, 'made_by_host').enumLabel).toBe('unix');
    expect(['sec2', 'minute', 'hour'].map((n) => find(e, `mod_time.${n}`).value)).toEqual([15, 45, 13]);
    expect(['day', 'month', 'year_since_1980'].map((n) => find(e, `mod_date.${n}`).value)).toEqual([31, 12, 44]);
    expect(find(e, 'flags.data_descriptor').value).toBe(1);
    expect(find(e, 'flags.masked_headers').value).toBe(1);
    expect(find(e, 'flags.utf8').value).toBe(1);
    expect(find(e, 'flags.encrypted').value).toBe(0);
    expect(find(e, 'external_attr.dos_attr').value).toBe(0x20);
    expect(find(e, 'external_attr.unix_mode').value).toBe(0o100644);
  });

  it('T1: detection ranks zip first with and without the extension, and never mixes up BMP and ZIP', async () => {
    const { bytes } = T1();
    const src = new MemoryByteSource(bytes);
    for (const name of ['a.zip', 'noext', 'a.bin', 'a.jar', 'a.docx']) {
      const d = await detect([bmp, zip], name, src);
      expect(d[0]?.specId, name).toBe('zip');
      expect(d[0]?.magicMatched, name).toBe(true);
      expect(d.find((x) => x.specId === 'bmp'), name).toBeUndefined();
    }
    // a real BMP is not a ZIP, even when it is called .zip
    const b = Uint8Array.from([0x42, 0x4d, ...le32(26), ...le16(0), ...le16(0), ...le32(26), ...le32(12), ...le16(1), ...le16(1), ...le16(1), ...le16(24)]);
    const d = await detect([bmp, zip], 'pic.zip', new MemoryByteSource(b));
    expect(d[0]?.specId).toBe('bmp');
    expect(d.find((x) => x.specId === 'zip')?.magicMatched).toBe(false);
    expect((await detect([bmp, zip], 'pic.bmp', new MemoryByteSource(b)))[0]?.specId).toBe('bmp');
  });

  it('detects the three signatures at offset 0 (local header, end of central directory, spanning marker) and nothing else', async () => {
    const magic = async (sig: number[]) => (await detect([zip], 'x', new MemoryByteSource(Uint8Array.from([...sig, 0, 0, 0, 0])))).length > 0;
    expect(await magic([0x50, 0x4b, 3, 4])).toBe(true);
    expect(await magic([0x50, 0x4b, 5, 6])).toBe(true);
    expect(await magic([0x50, 0x4b, 7, 8])).toBe(true);
    expect(await magic([0x50, 0x4b, 3, 5])).toBe(false);
    expect(await magic([0x50, 0x4c, 3, 4])).toBe(false);
    expect(await magic([0x42, 0x4d, 3, 4])).toBe(false);
  });

  it('T2: an empty archive (just the EOCD) is detected and has no entries and no errors', async () => {
    const { bytes } = buildZip([]);
    expect(bytes.length).toBe(22);
    const d = await detect([bmp, zip], 'empty', new MemoryByteSource(bytes));
    expect(d[0]?.specId).toBe('zip');
    const r = await run(bytes);
    expect(r.errors).toEqual([]);
    expect(entriesNode(r).children).toEqual([]);
    expect(rootVal(r, 'entries_eff')).toBe(0);
  });

  it('T2b: files too small for an EOCD report "not found" and nothing else', async () => {
    for (const bytes of [[], [0x50, 0x4b, 5, 6].slice(0, 0), [1, 2, 3, 4], Array.from({ length: 21 }, (_, i) => i + 1)]) {
      const r = await run(bytes);
      expect(r.errors.map((e) => e.code), String(bytes.length)).toEqual(['find']);
      expect(find(r.root, 'eocd').error).toMatch(/not found/);
      expect(has(r.root, 'central_directory')).toBe(false);
      expect(rootVal(r, 'delta')).toBe(0);
    }
  });

  it('T2b: a signature with no room for the record (4 bytes, 21 bytes) is a truncation error, no crash', async () => {
    for (const len of [4, 12, 21]) {
      const bytes = [0x50, 0x4b, 5, 6, ...new Array(len - 4).fill(0)];
      const r = await run(bytes);
      expect(r.stats.truncated).toBe(false);
      expect(errors(r).join('\n'), String(len)).toMatch(/truncated|short read|expected/);
    }
  });

  it('T13: a 26-byte file with an empty archive at offset 4 gets no locator error (only the stub warning)', async () => {
    const eocd = buildZip([]).bytes;
    const r = await run([1, 2, 3, 4, ...eocd]);
    expect(errors(r)).toEqual([]);
    expect(warnings(r)).toEqual([expect.stringMatching(/bytes precede the archive/)]);
    expect(rootVal(r, 'delta')).toBe(4);
    expect(find(r.root, 'eocd').offset).toBe(4);
    expect(has(r.root, 'locator')).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ the EOCD search

describe('ZIP: finding the end of central directory record', () => {
  it('T3a: a fake EOCD inside the comment that is not consistent with the end of the file loses; the real one is shown with an "other matches" warning', async () => {
    const fake = [0x50, 0x4b, 5, 6, ...new Array(18).fill(0), 0x41, 0x41]; // its comment_len 0 ends 2 bytes before the end of the file
    const { bytes, layout } = T1({ comment: fake });
    const r = await run(bytes);
    expect(find(r.root, 'eocd').offset).toBe(layout.eocd);
    expect(find(r.root, 'eocd').validation).toEqual(['1 other match in search window']);
    expect(warnings(r)).toEqual(['1 other match in search window']);
    expect(errors(r)).toEqual([]);
    expect(entriesNode(r).children).toHaveLength(1);
  });

  it('T3b: a self-consistent fake record at the very end wins (documented ambiguity)', async () => {
    const fake = [0x50, 0x4b, 5, 6, ...new Array(18).fill(0)]; // comment_len 0 and it ends exactly at the end of the file
    const { bytes, layout } = T1({ comment: fake });
    const r = await run(bytes);
    expect(find(r.root, 'eocd').offset).toBe(layout.eocd + 22);
    expect(find(r.root, 'eocd.entries_total').value).toBe(0);
    expect(entriesNode(r).children).toEqual([]);
    // the fake claims an empty directory at offset 0, so everything before it looks like prepended data
    expect(rootVal(r, 'delta')).toBe(layout.eocd + 22);
    expect(warnings(r)).toEqual(expect.arrayContaining(['1 other match in search window', expect.stringMatching(/bytes precede the archive/)]));
  });

  it('T7c: a 65535-byte comment with the EOCD exactly at size-65557 is found', async () => {
    const { bytes, layout } = T1({ comment: new Array(65535).fill(0x20) });
    expect(layout.eocd).toBe(bytes.length - 65557);
    const r = await run(bytes);
    expect(find(r.root, 'eocd').offset).toBe(layout.eocd);
    expect(find(r.root, 'eocd.comment_len').value).toBe(65535);
    expect(find(r.root, 'eocd.comment').display).toMatch(/truncated, 65535 bytes/);
    expect(errors(r)).toEqual([]);
    expect(r.stats.bytesRead).toBeLessThan(65557 + 2 * 4096 + 2000); // the window, the comment read by the probe and by the real parse
  });

  it('T7c: a signature one byte before the window is not found', async () => {
    const bytes = new Uint8Array(80_000);
    bytes.set([0x50, 0x4b, 5, 6], bytes.length - 65557 - 1);
    const r = await run(bytes);
    expect(find(r.root, 'eocd').error).toMatch(/not found/);
    bytes.fill(0);
    bytes.set([0x50, 0x4b, 5, 6], bytes.length - 65557);
    const r2 = await run(bytes);
    expect(find(r2.root, 'eocd').error).toBeUndefined();
    expect(find(r2.root, 'eocd').offset).toBe(bytes.length - 65557);
  });

  it('prefers a record whose comment fits over a nearer one that overruns the file, and any record over none', async () => {
    // a comment-less empty-archive record at the start, then 10 bytes of junk starting with a signature whose comment_len overruns
    const good = buildZip([]).bytes;
    const junk = [0x50, 0x4b, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 1, 2];
    const r = await run([...good, 9, 9, ...junk]);
    // the nearer junk record's comment overruns the file (tier 3 only); the first record fits in the file (tier 2) and wins
    expect(find(r.root, 'eocd').offset).toBe(0);
    const only = await run([...junk]);
    expect(find(only.root, 'eocd').offset).toBe(0);
    expect(errors(only).length).toBeGreaterThan(0);
  });

  it('T7a: an EOCD cut off in the middle gives errors, no crash and no central directory', async () => {
    const { bytes } = T1();
    for (const cut of [1, 5, 10]) {
      const r = await run(bytes.subarray(0, bytes.length - cut));
      expect(errors(r).length, String(cut)).toBeGreaterThan(0);
      expect(r.stats.truncated).toBe(false);
    }
    // cutting only the comment_len + comment: the record is complete up to cd_offset
    const r = await run(bytes.subarray(0, bytes.length - 2));
    expect(find(r.root, 'eocd.cd_offset').value).toBe(37);
  });
});

// ------------------------------------------------------------------------------------------------ ZIP64

describe('ZIP: ZIP64', () => {
  const two: ZipEntry[] = [
    { name: 'one.txt', data: 'hello', zip64: true },
    { name: 'two.txt', data: 'world!!', zip64: true },
  ];

  it('T4: forced ZIP64 (sentinels everywhere, extras, ZIP64 EOCD and locator) resolves to the real values', async () => {
    const { bytes, layout } = buildZip(two, { zip64Eocd: true });
    const r = await run(bytes);
    expect(r.errors).toEqual([]);
    const eocd = find(r.root, 'eocd');
    expect(find(eocd, 'entries_total').value).toBe(0xffff);
    expect(find(eocd, 'cd_size').value).toBe(0xffffffff);
    expect(find(eocd, 'cd_offset').value).toBe(0xffffffff);
    expect(find(r.root, 'locator')).toMatchObject({ offset: layout.locator, size: 20 });
    expect(find(r.root, 'z64_adjacent')).toMatchObject({ offset: layout.z64eocd, size: 56 });
    expect(has(r.root, 'z64_by_offset')).toBe(false);
    expect(rootVal(r, 'entries_eff')).toBe(2);
    expect(rootVal(r, 'cd_size_eff')).toBe(layout.cdSize);
    expect(rootVal(r, 'cd_offset_eff')).toBe(layout.cd);
    expect(rootVal(r, 'delta')).toBe(0);
    expect(rootVal(r, 'ref_pos')).toBe(layout.z64eocd);
    expect(entriesNode(r).children).toHaveLength(2);
    for (const [i, e] of two.entries()) {
      const n = entry(r, i);
      expect(find(n, 'comp_size').value).toBe(0xffffffff);
      expect(find(n, 'local_header_offset').value).toBe(0xffffffff);
      // the three-level _parent chain (body -> block -> extra field -> header) reads the sentinels
      expect(find(n, 'extra.blocks.blocks[0].body.uncomp_size').value).toBe(BigInt(String(e.data).length));
      expect(find(n, 'extra.blocks.blocks[0].body.comp_size').value).toBe(BigInt(String(e.data).length));
      expect(find(n, 'extra.blocks.blocks[0].id').enumLabel).toBe('zip64');
      expect(find(n, 'comp_size_eff').value).toBe(String(e.data).length);
      expect(find(n, 'uncomp_size_eff').value).toBe(String(e.data).length);
      expect(find(n, 'lho_eff').value).toBe(layout.entries[i]!.lfh);
      expect(refNode(r, i).ref).toEqual({ typeName: 'local_entry', offset: layout.entries[i]!.lfh, jumps: ZIP_JUMPS });
    }
    const t = await open(r, 1);
    expect(find(t, 'header.sig').value).toBe(0x04034b50);
    expect(find(t, 'header.name').value).toBe('two.txt');
    expect(find(t, 'header.extra.blocks.blocks[0].body.uncomp_size').value).toBe(7n); // local ZIP64 block (both sizes)
    expect(find(t, 'data').size).toBe(7);
    expect(r.errors).toEqual([]);
  });

  it('ZIP64 sizes only (the local header offset stays 32 bits): only the present values are read', async () => {
    const { bytes } = buildZip([{ name: 'a', data: 'xyz', zip64: 'sizes' }]);
    const r = await run(bytes);
    expect(r.errors).toEqual([]);
    const body = find(entry(r, 0), 'extra.blocks.blocks[0].body');
    expect(body.size).toBe(16);
    expect(has(body, 'local_header_offset')).toBe(false);
    expect(find(entry(r, 0), 'comp_size_eff').value).toBe(3);
  });

  it('a ZIP64 EOCD record with extensible data is found through the locator offset', async () => {
    const ext = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const { bytes, layout } = buildZip(two, { zip64Eocd: { extensible: ext } });
    const r = await run(bytes);
    // the record is not 56 bytes before the locator, so the adjacent probe finds nothing and the offset is used
    expect(has(r.root, 'z64_adjacent')).toBe(false);
    expect(find(r.root, 'z64_by_offset').offset).toBe(layout.z64eocd);
    expect(find(r.root, 'z64_by_offset.extensible_data').size).toBe(ext.length);
    expect(rootVal(r, 'entries_eff')).toBe(2);
    expect(r.errors).toEqual([]);
  });

  it('T4b: sentinels without a ZIP64 record warn, do not crash and clamp the count', async () => {
    const { bytes, layout } = T1();
    put16(bytes, layout.eocd + 8, 0xffff); // entries_disk
    put16(bytes, layout.eocd + 10, 0xffff); // entries_total
    const r = await run(bytes);
    expect(warnings(r)).toEqual(expect.arrayContaining(['ZIP64 values required but no ZIP64 record found']));
    expect(rootVal(r, 'entries_eff')).toBe(0xffff);
    expect(entriesNode(r).children).toHaveLength(1);
    expect(warnings(r).some((w) => /count is clamped/.test(w))).toBe(true);
    expect(warnings(r)).toHaveLength(2);
    expect(errors(r)).toEqual([]);
    // cd_offset sentinel: nothing can be read, but nothing breaks
    const b2 = T1();
    put32(b2.bytes, b2.layout.eocd + 16, 0xffffffff);
    const r2 = await run(b2.bytes);
    expect(warnings(r2)).toEqual(expect.arrayContaining(['ZIP64 values required but no ZIP64 record found']));
    expect(find(r2.root, 'central_directory').error).toMatch(/outside the file/);
    expect(r2.stats.truncated).toBe(false);
  });

  it('T4c: a ZIP64 extra block that is too short gives a truncation error and the 32-bit values stay in effect', async () => {
    const { bytes, layout } = buildZip([{ name: 'a.txt', data: 'hi', cdExtra: extraBlock(1, [1, 2, 3, 4]) }, { name: 'b.txt' }]);
    const cdh = layout.entries[0]!.cdh;
    put32(bytes, cdh + 20, 0xffffffff); // comp_size
    put32(bytes, cdh + 24, 0xffffffff); // uncomp_size
    const r = await run(bytes);
    expect(errors(r).join('\n')).toMatch(/truncated: u8 needs 8 bytes/);
    const e = entry(r, 0);
    expect(find(e, 'extra.blocks.blocks[0].body').children!.some((c) => c.error)).toBe(true);
    expect(find(e, 'comp_size_eff').value).toBe(0xffffffff);
    expect(find(e, 'uncomp_size_eff').value).toBe(0xffffffff);
    expect(find(e, 'lho_eff').value).toBe(0);
    expect(has(e, 'local_header')).toBe(true);
    // the damage stays inside the block: the second entry is intact
    expect(find(entry(r, 1), 'name').value).toBe('b.txt');
    expect(entriesNode(r).children).toHaveLength(2);
  });

  it('T4d: values beyond 2^53 are errors on the field, with no hang and almost no I/O', async () => {
    const a = buildZip(two, { zip64Eocd: true });
    put64(a.bytes, a.layout.z64eocd! + 48, 0x0020000000000000n); // cd_offset = 2^53
    const r = await run(a.bytes);
    expect(find(r.root, 'central_directory').error).toMatch(/maximum safe integer|exceeds/);
    expect(r.stats.bytesRead).toBeLessThan(2000);
    expect(r.stats.truncated).toBe(false);

    const b = buildZip(two, { zip64Eocd: true });
    put64(b.bytes, b.layout.z64eocd! + 32, 0xffffffffffffffffn); // entries_total = 2^64 - 1
    const r2 = await run(b.bytes);
    // clamped to size / 46 = 3: the two real entries and one failed element
    expect(entriesNode(r2).children).toHaveLength(3);
    expect(warnings(r2).some((w) => /count is clamped/.test(w))).toBe(true);
    expect(find(entry(r2, 2), 'sig').error).toBeDefined();
    expect(r2.stats.truncated).toBe(false);

    const c = buildZip(two, { zip64Eocd: true });
    put64(c.bytes, c.layout.z64eocd! + 40, 0xffffffffffffffffn); // cd_size = 2^64 - 1
    const r3 = await run(c.bytes);
    expect(find(r3.root, 'central_directory').error).toBeDefined();
    expect(r3.stats.bytesRead).toBeLessThan(2000);
  });

  it('a ZIP64 locator that points at nothing: the two probes are quiet, only the final scan reports that the record is missing', async () => {
    const { bytes, layout } = buildZip(two, { zip64Eocd: true });
    const b = bytes.slice();
    put32(b, layout.z64eocd!, 0); // destroy the record signature
    const r = await run(b);
    expect(has(r.root, 'z64_adjacent')).toBe(false);
    expect(has(r.root, 'z64_by_offset')).toBe(false);
    expect(warnings(r)).toEqual(expect.arrayContaining(['ZIP64 values required but no ZIP64 record found']));
    expect(r.errors.filter((e) => e.code === 'find').map((e) => e.path)).toEqual(['zip_file.z64_scan']);
    // offset far outside the file
    const c = bytes.slice();
    put32(c, layout.z64eocd!, 0);
    put64(c, layout.locator! + 8, 0xfffffffffffffn);
    const r2 = await run(c);
    expect(has(r2.root, 'z64_by_offset')).toBe(false);
    expect(r2.errors.filter((e) => e.code === 'find').map((e) => e.path)).toEqual(['zip_file.z64_scan']);
  });
});

// ------------------------------------------------------------------------------------------------ data descriptors

describe('ZIP: data descriptors', () => {
  it('T5: a descriptor with signature follows the data', async () => {
    const { bytes } = buildZip([{ name: 'a.txt', data: 'hi', descriptor: 'sig' }]);
    const r = await run(bytes);
    expect(r.errors).toEqual([]);
    const t = await open(r, 0);
    expect(find(t, 'header.crc32').value).toBe(0); // zeros in the local header
    expect(find(t, 'header.flags.data_descriptor').value).toBe(1);
    const d = find(t, 'descriptor');
    expect(d.size).toBe(16);
    expect(find(d, 'sig').value).toBe(0x08074b50);
    expect(find(d, 'crc32').value).toBe(crc32(utf8('hi')));
    expect(find(d, 'comp_size').value).toBe(2);
    expect(find(d, 'uncomp_size').value).toBe(2);
    expect(has(d, 'comp_size64')).toBe(false);
    expect(r.errors).toEqual([]);
  });

  it('T5b: a descriptor without signature is read from the cursor', async () => {
    const { bytes, layout } = buildZip([{ name: 'a.txt', data: 'hi', descriptor: 'nosig' }]);
    const r = await run(bytes);
    const t = await open(r, 0);
    const d = find(t, 'descriptor');
    expect(has(d, 'sig')).toBe(false);
    expect(d).toMatchObject({ offset: layout.entries[0]!.descriptor, size: 12 });
    expect(find(d, 'crc32').value).toBe(crc32(utf8('hi')));
    expect(find(d, 'comp_size').value).toBe(2);
    expect(r.errors).toEqual([]);
  });

  it('T5c: a ZIP64 descriptor has 8-byte sizes', async () => {
    const { bytes } = buildZip([{ name: 'a.txt', data: 'hi', descriptor: 'zip64' }]);
    const r = await run(bytes);
    const t = await open(r, 0);
    const d = find(t, 'descriptor');
    expect(find(d, 'is64').display).toBe('true');
    expect(has(d, 'sig')).toBe(false);
    expect(d.size).toBe(4 + 8 + 8);
    expect(find(d, 'comp_size64').value).toBe(2n);
    expect(find(d, 'uncomp_size64').value).toBe(2n);
    expect(has(d, 'comp_size')).toBe(false);
    expect(r.errors).toEqual([]);
  });

  it('known ambiguity: without signature, a CRC equal to the signature value is taken for the signature', async () => {
    const built = buildZip([{ name: 'a.txt', data: 'hi', descriptor: 'nosig' }]);
    const at = built.layout.entries[0]!.descriptor!;
    put32(built.bytes, at, 0x08074b50); // a CRC that equals the descriptor signature
    const r = await run(built.bytes);
    const d = find(await open(r, 0), 'descriptor');
    expect(find(d, 'sig').value).toBe(0x08074b50);
    expect(find(d, 'crc32').value).toBe(2); // really the compressed size, read one field too early
  });
});

// ------------------------------------------------------------------------------------------------ prepended data

describe('ZIP: data in front of the archive', () => {
  const stub = [0x4d, 0x5a, ...new Array(510).fill(0x90)];

  it('T6: stored offsets that ignore a 512-byte stub are shifted: warning, and the entry opens at 512 with a valid header', async () => {
    const { bytes, layout } = T1({ prefix: stub });
    const r = await run(bytes);
    expect(rootVal(r, 'delta')).toBe(512);
    expect(find(r.root, 'eocd.cd_offset').value).toBe(37); // unadjusted
    expect(rootVal(r, 'cd_start')).toBe(37 + 512);
    expect(find(r.root, 'central_directory').offset).toBe(layout.cd);
    expect(warnings(r)).toEqual([expect.stringMatching(/bytes precede the archive/)]);
    expect(errors(r)).toEqual([]);
    expect(refNode(r, 0).ref?.offset).toBe(512);
    expect(find(await open(r, 0), 'header.sig').value).toBe(0x04034b50);
    expect(find(find(await open(r, 0), 'header'), 'sig').offset).toBe(512);
    expect(r.errors.filter((e) => e.severity === 'error')).toEqual([]);
  });

  it('T6b: offsets that are already file-relative give a delta of 0 and no warning', async () => {
    const { bytes } = T1({ prefix: stub, adjust: true });
    const r = await run(bytes);
    expect(r.errors).toEqual([]);
    expect(rootVal(r, 'delta')).toBe(0);
    expect(refNode(r, 0).ref?.offset).toBe(512);
    expect(find(await open(r, 0), 'header.sig').value).toBe(0x04034b50);
  });

  it('T16: a stub in front of a ZIP64 archive (offsets unadjusted) is handled with the ZIP64 record as the reference point', async () => {
    const e: ZipEntry[] = [{ name: 'one.txt', zip64: true }, { name: 'two.txt', zip64: true }];
    const { bytes, layout } = buildZip(e, { prefix: stub, zip64Eocd: true });
    const r = await run(bytes);
    expect(rootVal(r, 'delta')).toBe(512);
    expect(rootVal(r, 'ref_pos')).toBe(layout.z64eocd);
    expect(entriesNode(r).children).toHaveLength(2);
    expect(refNode(r, 1).ref?.offset).toBe(layout.entries[1]!.lfh);
    expect(find(await open(r, 1), 'header.name').value).toBe('two.txt');
    expect(warnings(r)).toEqual([expect.stringMatching(/bytes precede/)]);
    expect(errors(r)).toEqual([]);
  });

  it('a digital signature record between the directory and the EOCD is shown and does not look like a stub', async () => {
    const sig = [0x50, 0x4b, 5, 5, 4, 0, 1, 2, 3, 4];
    const { bytes, layout } = T1({ signature: sig });
    const r = await run(bytes);
    expect(layout.signature).toBe(layout.cd + layout.cdSize);
    expect(rootVal(r, 'delta')).toBe(0); // the directory is found at its stored offset
    expect(errors(r)).toEqual([]);
    expect(warnings(r)).toEqual([]);
    const s = find(r.root, 'signature');
    expect(find(s, 'data_size').value).toBe(4);
    expect(find(s, 'data').size).toBe(4);
    expect(entriesNode(r).children).toHaveLength(1);
  });

  it('warns when the central directory would extend past the EOCD', async () => {
    const { bytes, layout } = T1();
    put32(bytes, layout.eocd + 12, 60); // cd_size 60 > the real 51
    const r = await run(bytes);
    expect(warnings(r)).toEqual(expect.arrayContaining(['the central directory extends past the end-of-central-directory record']));
    const b = T1();
    put32(b.bytes, b.layout.eocd + 16, 50); // cd_offset 50: 50 + 51 > 88
    const r2 = await run(b.bytes);
    expect(warnings(r2)).toEqual(expect.arrayContaining(['the central directory extends past the end-of-central-directory record']));
  });
});

// ------------------------------------------------------------------------------------------------ damage

describe('ZIP: damaged archives', () => {
  it('T7b: a central directory offset into garbage ends the list at the first entry with a signature error', async () => {
    const { bytes, layout } = buildZip([{ name: 'a.txt' }, { name: 'b.txt' }]);
    put32(bytes, layout.eocd + 16, layout.cd + 3); // 3 bytes into the first header
    const r = await run(bytes);
    const e0 = entry(r, 0);
    expect(find(e0, 'sig').error).toMatch(/expected 33639248/);
    expect(entriesNode(r).children).toHaveLength(1);
    expect(entriesNode(r).error).toBeUndefined(); // the failing element carries the error itself
    expect(r.stats.truncated).toBe(false);
  });

  it('a cd_offset at the start of the file (where local headers are) also fails cleanly, then the delta rule absorbs it', async () => {
    const { bytes, layout } = T1();
    put32(bytes, layout.eocd + 16, 0);
    const r = await run(bytes);
    // delta = 88 - 51 - 0 = 37 shifts the directory back onto the real one: the archive looks like it has 37 bytes in front
    expect(rootVal(r, 'delta')).toBe(37);
    expect(entriesNode(r).children).toHaveLength(1);
  });

  it('T8: a lying entry count is clamped to what the directory can hold', async () => {
    const { bytes, layout } = T1();
    put16(bytes, layout.eocd + 10, 0xfffe);
    const r = await run(bytes);
    expect(rootVal(r, 'entries_eff')).toBe(0xfffe);
    expect(entriesNode(r).children).toHaveLength(1);
    expect(warnings(r).filter((w) => /count is clamped/.test(w))).toHaveLength(1);
    expect(errors(r)).toEqual([]);
    // a count that is too SMALL just shows fewer entries
    const two = buildZip([{ name: 'a' }, { name: 'b' }]);
    put16(two.bytes, two.layout.eocd + 10, 1);
    expect(entriesNode(await run(two.bytes)).children).toHaveLength(1);
  });

  it('a count larger than the real number of entries (but within size / 46) ends with a signature error on the extra element', async () => {
    const { bytes, layout } = buildZip([{ name: 'a' }, { name: 'b' }], { comment: new Array(100).fill(0) });
    put16(bytes, layout.eocd + 10, 4);
    put32(bytes, layout.eocd + 12, layout.cdSize + 60); // claims 60 more bytes of directory (the EOCD and its comment)
    const r = await run(bytes);
    const kids = entriesNode(r).children!;
    expect(kids).toHaveLength(3);
    expect(find(kids[2]!, 'sig').error).toMatch(/expected 33639248/);
    expect(r.stats.truncated).toBe(false);
  });

  it('T9: an extra field whose block overruns it clamps with an error; the entry is still shown and the next entries parse', async () => {
    const { bytes } = buildZip([{ name: 'a.txt', cdExtra: [0x01, 0x00, 0xff, 0x00] }, { name: 'b.txt' }, { name: 'c.txt' }]);
    const r = await run(bytes);
    const body = find(entry(r, 0), 'extra.blocks.blocks[0].body');
    expect(body.error).toMatch(/declared size 255 exceeds the 0 bytes left/);
    expect(find(entry(r, 0), 'name').value).toBe('a.txt');
    expect(has(entry(r, 0), 'local_header')).toBe(true);
    expect(entriesNode(r).children).toHaveLength(3);
    expect(find(entry(r, 2), 'name').value).toBe('c.txt');
    expect(errors(r)).toHaveLength(1);
  });

  it('T9: a name_len of 0xFFFF is clamped to the directory; the next element fails and the list ends with an error, no hang', async () => {
    const { bytes, layout } = buildZip([{ name: 'a.txt' }, { name: 'b.txt' }]);
    put16(bytes, layout.entries[0]!.cdh + 28, 0xffff);
    const r = await run(bytes);
    expect(find(entry(r, 0), 'name_cp437').error).toMatch(/declared size 65535 exceeds/);
    expect(entriesNode(r).children).toHaveLength(2); // the second element is the failed one
    expect(entry(r, 1).children![0]!.error).toMatch(/truncated/);
    expect(r.stats.truncated).toBe(false);
    // as the only entry: the entry itself is shown with its clamp error
    const one = buildZip([{ name: 'a.txt' }]);
    put16(one.bytes, one.layout.entries[0]!.cdh + 28, 0xffff);
    const r1 = await run(one.bytes);
    expect(entriesNode(r1).children).toHaveLength(1);
    expect(find(entry(r1, 0), 'name_cp437').error).toBeDefined();
  });

  it('T9b: a TLV header split by the end of the extra field is an error on that block only', async () => {
    for (const tail of [[0xaa, 0xbb], [0xaa, 0xbb, 0xcc]]) {
      const cdExtra = [...extraBlock(0x9999, [1, 2]), ...tail];
      const { bytes } = buildZip([{ name: 'a.txt', cdExtra }, { name: 'b.txt' }]);
      const r = await run(bytes);
      const blocks = find(entry(r, 0), 'extra.blocks');
      expect(blocks.children).toHaveLength(2);
      expect(blocks.children![1]!.children!.some((c) => c.error), String(tail.length)).toBe(true);
      expect(blocks.error ?? errors(r).join()).toBeTruthy();
      expect(find(entry(r, 1), 'name').value).toBe('b.txt'); // not lost
      expect(has(entry(r, 0), 'local_header')).toBe(true);
      expect(r.stats.truncated).toBe(false);
    }
  });

  it('an extra_len larger than the directory is clamped, the entry stays visible', async () => {
    const { bytes, layout } = T1();
    put16(bytes, layout.entries[0]!.cdh + 30, 0x4000);
    const r = await run(bytes);
    expect(find(entry(r, 0), 'extra').error).toMatch(/clamped/);
    expect(entry(r, 0).children!.length).toBeGreaterThan(20);
  });

  it('a local header that is not there is a fatal signature error when the reference is opened', async () => {
    const { bytes, layout } = T1();
    bytes[layout.entries[0]!.lfh] = 0x51;
    const r = await run(bytes);
    const t = await open(r, 0);
    expect(find(t, 'header.sig').error).toMatch(/expected 67324752/);
    expect(has(t, 'data')).toBe(false);
  });

  it('cross-checks the local header against the central directory and the data against the directory start', async () => {
    const { bytes, layout } = T1();
    put16(bytes, layout.entries[0]!.lfh + 8, 8); // method deflate in the LFH only
    put16(bytes, layout.entries[0]!.lfh + 26, 4); // name_len 4
    put32(bytes, layout.entries[0]!.cdh + 20, 70); // comp_size 70: the data would run into the directory
    const r = await run(bytes);
    const t = await open(r, 0);
    expect(find(t, 'header').validation).toEqual([
      'the local header name length differs from the central directory',
      'the local header compression method differs from the central directory',
    ]);
    expect(find(t, 'data').validation).toEqual(['the entry data runs into the central directory']);
  });

  it('T12: a multi-disk archive warns; entries on another disk have no reference; the directory is skipped when it is on another disk', async () => {
    const a = buildZip([{ name: 'a.txt', diskStart: 1 }, { name: 'b.txt' }], { eocd: { disk: 1, cdDisk: 1, entriesDisk: 1 } });
    const r = await run(a.bytes);
    expect(warnings(r)).toEqual(expect.arrayContaining([expect.stringMatching(/multi-disk/)]));
    expect(has(entry(r, 0), 'local_header')).toBe(false);
    expect(has(entry(r, 1), 'local_header')).toBe(true);
    expect(entriesNode(r).children).toHaveLength(2);
    const b = buildZip([{ name: 'a.txt' }], { eocd: { disk: 3, cdDisk: 0 } });
    const r2 = await run(b.bytes);
    expect(warnings(r2)).toEqual(expect.arrayContaining([expect.stringMatching(/multi-disk/)]));
    expect(has(r2.root, 'central_directory')).toBe(false);
  });

  it('T14: two entries that share a local header offset both open', async () => {
    const { bytes, layout } = buildZip([{ name: 'a.txt' }, { name: 'b.txt' }]);
    put32(bytes, layout.entries[1]!.cdh + 42, 0); // second entry points at the first one's header
    const r = await run(bytes);
    expect(refNode(r, 0).ref?.offset).toBe(0);
    expect(refNode(r, 1).ref?.offset).toBe(0);
    const [a, b] = [await open(r, 0), await open(r, 1)];
    expect(find(a, 'header.name').value).toBe('a.txt');
    expect(find(b, 'header.name').value).toBe('a.txt');
    expect(a).not.toBe(b);
    // the second entry has the same name_len, so there are no cross-check warnings
    expect(r.errors.filter((e) => e.severity === 'error')).toEqual([]);
  });

  it('a local header offset outside the file is a warning on the reference, not an error', async () => {
    const { bytes, layout } = T1();
    put32(bytes, layout.entries[0]!.cdh + 42, 0x7fffffff);
    const r = await run(bytes);
    expect(refNode(r, 0).ref).toBeUndefined();
    expect(refNode(r, 0).validation?.[0]).toMatch(/outside the file/);
    expect(errors(r)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ names and comments

describe('ZIP: names and comments', () => {
  it('T10: UTF-8 names with flag bit 11', async () => {
    const { bytes } = buildZip([{ name: 'héllo.txt', utf8: true }, { name: '日本.txt', utf8: true }]);
    const r = await run(bytes);
    expect(find(entry(r, 0), 'name').value).toBe('héllo.txt');
    expect(find(entry(r, 1), 'name').value).toBe('日本.txt');
    expect(has(entry(r, 0), 'name_cp437')).toBe(false);
    expect((await open(r, 1)).children!.length).toBeGreaterThan(0);
    expect(find(await open(r, 1), 'header.name').value).toBe('日本.txt');
    expect(r.errors).toEqual([]);
  });

  it('T10: without the flag the name is IBM code page 437', async () => {
    const { bytes } = buildZip([{ name: [0x82, 0x2e, 0x74, 0x78, 0x74] }, { name: [0xe1, 0xf8] }]);
    const r = await run(bytes);
    expect(find(entry(r, 0), 'name').value).toBe('é.txt');
    expect(find(entry(r, 1), 'name').value).toBe('ß°');
    expect(has(entry(r, 0), 'name_utf8')).toBe(false);
  });

  it('T10: hostile names are shown verbatim, nothing is sanitised or resolved', async () => {
    const win = 'C:' + String.fromCharCode(92) + 'x' + String.fromCharCode(92) + '..' + String.fromCharCode(92) + 'y';
    const { bytes } = buildZip([{ name: '../../etc/passwd' }, { name: '/abs/../x' }, { name: win }]);
    const r = await run(bytes);
    expect(find(entry(r, 0), 'name').value).toBe('../../etc/passwd');
    expect(find(entry(r, 1), 'name').value).toBe('/abs/../x');
    expect(find(entry(r, 2), 'name').value).toBe(win);
    expect(errors(r)).toEqual([]);
  });

  it('T10: invalid UTF-8 with the flag set decodes with replacement characters', async () => {
    const { bytes } = buildZip([{ name: [0xff, 0x41, 0xc3], utf8: true }]);
    const r = await run(bytes);
    expect(find(entry(r, 0), 'name').value).toBe('�A�');
  });

  it('control characters in a name are escaped in the node display', async () => {
    const { bytes } = buildZip([{ name: [0x61, 0, 0x62, 0x0a, 0x63] }]);
    const r = await run(bytes);
    expect(find(entry(r, 0), 'name_cp437').display).toBe('"a\\u0000b\\nc"');
    expect(find(entry(r, 0), 'name').value).toBe('a\u0000b\nc');
  });

  it('entry comments follow the same flag; the archive comment is code page 437', async () => {
    const { bytes } = buildZip([{ name: 'a', comment: 'ünï', utf8: true }, { name: 'b', comment: [0x82, 0x41] }], { comment: [0x82, 0x20, 0x68, 0x69] });
    const r = await run(bytes);
    expect(find(entry(r, 0), 'comment_utf8').value).toBe('ünï');
    expect(has(entry(r, 0), 'comment_cp437')).toBe(false);
    expect(find(entry(r, 1), 'comment_cp437').value).toBe('éA');
    expect(find(r.root, 'eocd.comment').value).toBe('é hi');
    expect(errors(r)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ extra fields

describe('ZIP: extra fields', () => {
  const ntfs = extraBlock(0x000a, [0, 0, 0, 0, ...le16(1), ...le16(24), ...le64(0x01d0000000000001n), ...le64(0x01d0000000000002n), ...le64(0x01d0000000000003n), ...le16(2), ...le16(3), 9, 8, 7]);
  const ut = extraBlock(0x5455, [7, ...le32(1_700_000_000), ...le32(1_700_000_001), ...le32(1_700_000_002)]);
  const utCd = extraBlock(0x5455, [7, ...le32(1_700_000_000)]);
  const ux = extraBlock(0x7875, [1, 4, ...le32(1000), 2, 0xe8, 0x03]);
  const up = extraBlock(0x7075, [1, ...le32(crc32(utf8('a.txt'))), ...utf8('ä.txt')]);
  const aes = extraBlock(0x9901, [2, 0, 0x41, 0x45, 3, ...le16(8)]);
  const unknown = extraBlock(0x1234, [1, 2, 3, 4, 5]);
  const cafe = extraBlock(0xcafe, []);
  const all = [...utCd, ...ux, ...ntfs, ...up, ...aes, ...unknown, ...cafe];

  it('T11: every known block is decoded in the central directory', async () => {
    const { bytes } = buildZip([{ name: 'a.txt', cdExtra: all }, { name: 'b.txt' }]);
    const r = await run(bytes);
    expect(errors(r)).toEqual([]);
    const blocks = find(entry(r, 0), 'extra.blocks');
    expect(blocks.children!.map((b) => find(b, 'id').enumLabel)).toEqual([
      'extended_timestamp', 'info_zip_unix_new', 'ntfs', 'info_zip_unicode_path', 'winzip_aes', undefined, 'java_jar_marker',
    ]);
    const at = (i: number, p: string) => find(blocks.children![i]!, p);
    expect(at(0, 'body.flags').value).toBe(7);
    expect(at(0, 'body.mtime').value).toBe(1_700_000_000);
    expect(has(at(0, 'body'), 'atime')).toBe(false); // the central directory block only carries mtime
    expect(at(1, 'body.uid_size').value).toBe(4);
    expect(at(1, 'body.uid').display).toBe('E8 03 00 00');
    expect(at(1, 'body.gid').display).toBe('E8 03');
    expect(at(2, 'body.attributes.attributes[0].tag').value).toBe(1);
    expect(at(2, 'body.attributes.attributes[0].body.mtime').value).toBe(0x01d0000000000001n);
    expect(at(2, 'body.attributes.attributes[0].body.ctime').value).toBe(0x01d0000000000003n);
    expect(at(2, 'body.attributes.attributes[1].body').display).toBe('09 08 07');
    expect(at(3, 'body.text').value).toBe('ä.txt');
    expect(at(3, 'body.name_crc32').value).toBe(crc32(utf8('a.txt')));
    expect(at(4, 'body.vendor_version').value).toBe(2);
    expect(at(4, 'body.vendor_id').value).toBe('AE');
    expect(at(4, 'body.strength').enumLabel).toBe('AES-256');
    expect(at(4, 'body.actual_method').enumLabel).toBe('deflate');
    expect(at(5, 'body').typeName).toBe('bytes'); // unknown id: raw
    expect(at(5, 'body').display).toBe('01 02 03 04 05');
    expect(at(5, 'size').value).toBe(5);
    expect(at(6, 'body')).toMatchObject({ typeName: 'bytes', size: 0, display: '(empty)' });
    expect(find(entry(r, 1), 'name').value).toBe('b.txt');
  });

  it('T11: the local header decodes the same blocks, with all three timestamps', async () => {
    const { bytes } = buildZip([{ name: 'a.txt', localExtra: [...ut, ...ux, ...cafe] }]);
    const r = await run(bytes);
    const t = await open(r, 0);
    const b = find(t, 'header.extra.blocks');
    expect(find(b.children![0]!, 'body.atime').value).toBe(1_700_000_001);
    expect(find(b.children![0]!, 'body.ctime').value).toBe(1_700_000_002);
    expect(find(b.children![1]!, 'body.uid').display).toBe('E8 03 00 00');
    expect(r.errors).toEqual([]);
    // extended timestamp with flag bits that promise more than the block holds: the extra values are simply absent
    const short = buildZip([{ name: 'a.txt', localExtra: extraBlock(0x5455, [7, ...le32(5)]) }]);
    const t2 = await open(await run(short.bytes), 0);
    expect(has(find(t2, 'header.extra.blocks.blocks[0].body'), 'atime')).toBe(false);
  });

  it('known extra ids are labelled even when the body is kept raw', async () => {
    const { bytes } = buildZip([{ name: 'a', cdExtra: [...extraBlock(0x0007, [1, 2]), ...extraBlock(0x0017, [3]), ...extraBlock(0x4453, [4]), ...extraBlock(0xd935, [0, 0]), ...extraBlock(0x6375, [1, 0, 0, 0, 0, 0x78])] }]);
    const r = await run(bytes);
    const labels = find(entry(r, 0), 'extra.blocks').children!.map((b) => find(b, 'id').enumLabel);
    expect(labels).toEqual(['av_info', 'strong_encryption_header', 'windows_nt_security_descriptor', 'android_zipalign', 'info_zip_unicode_comment']);
    expect(errors(r)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ robustness over a corpus

describe('ZIP: tiny limits truncate gracefully', () => {
  const fixtures: Record<string, Uint8Array> = {
    t1: T1().bytes,
    empty: buildZip([]).bytes,
    zip64: buildZip([{ name: 'a', zip64: true }, { name: 'b', zip64: true }], { zip64Eocd: true }).bytes,
    descriptor: buildZip([{ name: 'a', descriptor: 'sig' }, { name: 'b', descriptor: 'zip64' }]).bytes,
    stub: T1({ prefix: new Array(100).fill(1) }).bytes,
    extras: buildZip([{ name: 'a', cdExtra: [...extraBlock(1, [1, 2]), ...extraBlock(0x5455, [7, 1, 2, 3, 4]), ...extraBlock(0x000a, [0, 0, 0, 0, 1, 0, 24, 0])] }]).bytes,
    broken: (() => {
      const b = buildZip([{ name: 'a' }, { name: 'b' }]);
      put16(b.bytes, b.layout.eocd + 10, 0xffff);
      put16(b.bytes, b.layout.entries[0]!.cdh + 28, 0xffff);
      return b.bytes;
    })(),
    junk: Uint8Array.from({ length: 300 }, (_, i) => (i * 7 + 3) & 0xff),
  };
  const configs: Array<[string, Partial<Limits>]> = [
    ['maxNodes 50', { maxNodes: 50 }],
    ['maxNodes 5', { maxNodes: 5 }],
    ['maxSteps 20', { maxSteps: 20 }],
    ['maxReads 8', { maxReads: 8 }],
    ['maxBytesRead 100', { maxBytesRead: 100 }],
    ['maxProbeSteps 3', { maxProbeSteps: 3 }],
    ['maxLookupScan 0', { maxLookupScan: 0 }],
  ];
  for (const [name, bytes] of Object.entries(fixtures)) {
    for (const [label, limits] of configs) {
      it(`${name} with ${label}: a partial tree, no throw`, async () => {
        const r = await run(bytes, limits);
        expect(r.root.name).toBe('zip_file');
        if (name === 't1' && label === 'maxNodes 5') expect(r.stats.truncated).toBe(true);
        // opening references under the same limits never throws either
        const refs: Node[] = [];
        const walk = (n: Node) => {
          if (n.ref) refs.push(n);
          n.children?.forEach(walk);
        };
        walk(r.root);
        for (const n of refs) await expandRef(r, n.id);
      });
    }
  }
  it('with maxNodes 50 the T1 tree is cut and says so', async () => {
    const r = await run(fixtures.t1!, { maxNodes: 50 });
    expect(r.stats.truncated).toBe(true);
    expect(r.errors.some((e) => e.code === 'limit')).toBe(true);
    expect(r.stats.nodes).toBeLessThanOrEqual(50);
  });
});
