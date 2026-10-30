import { describe, expect, it } from 'vitest';
import zipJson from '../../formats/zip.json';
import { MemoryByteSource } from '../byte-source';
import { buildZip, extraBlock, le64, put32, type ZipEntry } from '../../test/zip-builder';
import type { Node, ParseResult } from './interpret';
import { expandRef, parse } from './interpret';
import { find } from './test-helpers';
import { formatIssues, validateSpec } from './validate';

const v = validateSpec(zipJson);
if (!v.ok) throw new Error(formatIssues(v.errors));
const zip = v.spec;
const run = (bytes: Uint8Array) => parse(zip, new MemoryByteSource(bytes));
const rootVal = (r: ParseResult, name: string) => find(r.root, name).value;
const has = (n: Node, name: string) => (n.children ?? []).some((c) => c.name === name);
const entry = (r: ParseResult, i: number) => find(r.root, `central_directory.entries.entries[${i}]`);
const open = async (r: ParseResult, i: number) => (await expandRef(r, find(entry(r, i), 'local_header').id))[0]!;
const stub = [0x4d, 0x5a, ...new Array(510).fill(0x90)];
const sev = (r: ParseResult, s: 'error' | 'warning') => r.errors.filter((e) => e.severity === s).map((e) => e.message);

describe('ZIP hardening', () => {
  it('a streamed ZIP64 entry has 8-byte descriptor sizes even without a local ZIP64 extra', async () => {
    const { bytes } = buildZip([{ name: 'a.txt', data: 'hi', descriptor: 'zip64', zip64: 'sizes', localZip64: false }]);
    const r = await run(bytes);
    const t = await open(r, 0);
    expect(has(find(t, 'header'), 'extra')).toBe(false);
    const d = find(t, 'descriptor');
    expect(find(d, 'is64').display).toBe('true');
    expect(find(d, 'comp_size64').value).toBe(2n);
    expect(find(d, 'uncomp_size64').value).toBe(2n);
    expect(has(d, 'comp_size')).toBe(false);
    expect(sev(r, 'error')).toEqual([]);
    // a plain streamed entry (no ZIP64 anywhere) keeps 4-byte sizes
    const plain = await run(buildZip([{ name: 'a.txt', descriptor: 'nosig' }]).bytes);
    expect(find(find(await open(plain, 0), 'descriptor'), 'is64').display).toBe('false');
  });

  it('stub + ZIP64 whose record has extensible data: the record is found by the backward scan and the stub is detected', async () => {
    const e: ZipEntry[] = [{ name: 'one.txt', zip64: true }, { name: 'two.txt', zip64: true }];
    const { bytes, layout } = buildZip(e, { prefix: stub, zip64Eocd: { extensible: [1, 2, 3, 4, 5, 6, 7, 8, 9] } });
    const r = await run(bytes);
    expect(has(r.root, 'z64_adjacent')).toBe(false);
    expect(has(r.root, 'z64_by_offset')).toBe(false);
    expect(find(r.root, 'z64_scan').offset).toBe(layout.z64eocd);
    expect(find(r.root, 'z64_scan.extensible_data').size).toBe(9);
    expect(rootVal(r, 'delta')).toBe(512);
    expect(find(r.root, 'central_directory.entries').children).toHaveLength(2);
    expect(find(await open(r, 1), 'header.name').value).toBe('two.txt');
    expect(sev(r, 'error')).toEqual([]);
    expect(sev(r, 'warning')).toEqual([expect.stringMatching(/bytes precede/)]);
  });

  it('a locator whose record is missing is a find error on the scan (the locator promises one)', async () => {
    const { bytes, layout } = buildZip([{ name: 'a', zip64: true }], { zip64Eocd: true });
    put32(bytes, layout.z64eocd!, 0);
    const r = await run(bytes);
    expect(find(r.root, 'z64_scan').error).toMatch(/not found|accepted/);
    expect(r.stats.truncated).toBe(false);
  });

  it('a stub that is itself an archive does not fool the stored-offset check', async () => {
    const inner = buildZip([{ name: 'stub.txt' }]).bytes;
    const { bytes } = buildZip([{ name: 'real.txt' }], { prefix: [...inner] });
    const r = await run(bytes);
    expect(rootVal(r, 'delta')).toBe(inner.length);
    expect(find(entry(r, 0), 'name').value).toBe('real.txt');
    expect(find(await open(r, 0), 'header.name').value).toBe('real.txt');
    expect(sev(r, 'error')).toEqual([]);
  });

  it('a signed archive (signature record before the EOCD) still has delta 0, offsets that are right are trusted', async () => {
    const { bytes } = buildZip([{ name: 'a' }], { signature: [0x50, 0x4b, 5, 5, 2, 0, 9, 9] });
    expect(rootVal(await run(bytes), 'delta')).toBe(0);
  });

  it('a local ZIP64 block holds both sizes even when the header sizes are not the sentinel (streaming writers)', async () => {
    const zeroed = extraBlock(1, [...le64(0), ...le64(0)]);
    const { bytes } = buildZip([{ name: 'a', data: 'hi', localExtra: zeroed }, { name: 'b', data: 'hi', localExtra: extraBlock(1, le64(7)) }]);
    const r = await run(bytes);
    const body = find(await open(r, 0), 'header.extra.blocks.blocks[0].body');
    expect(find(body, 'uncomp_size').value).toBe(0n);
    expect(find(body, 'comp_size').value).toBe(0n);
    const one = find(await open(r, 1), 'header.extra.blocks.blocks[0].body');
    expect(find(one, 'uncomp_size').value).toBe(7n);
    expect(has(one, 'comp_size')).toBe(false);
    expect(sev(r, 'error')).toEqual([]);
  });
});
