import { describe, expect, it } from 'vitest';
import { detect } from './detect';
import { mem, mkSpec } from './test-helpers';

const spec = (id: string, extra: Record<string, unknown>) => mkSpec({ root: { fields: [{ name: 'a', type: 'u1' }] } }, { id, ...extra });

const magicA = spec('magic-a', { detect: [{ at: 0, bytes: '89 50 4E 47' }], extensions: ['png'] });
const extOnly = spec('ext-only', { extensions: ['dat'] });
const extWrongMagic = spec('ext-wrong', { detect: [{ at: 0, bytes: 'FF FF' }], extensions: ['dat'] });
const trailer = spec('trailer', { detect: [{ at: -4, bytes: 'DE AD BE EF' }] });
const masked = spec('masked', { detect: [{ at: 1, bytes: 'A0', mask: 'F0' }] });
const multi = spec('multi', { detect: [{ at: 0, bytes: '52 49' }, { at: 4, bytes: '57 41' }] });

describe('detect', () => {
  it('magic match outranks extension match', async () => {
    const r = await detect([extOnly, magicA], 'file.dat', mem([0x89, 0x50, 0x4e, 0x47, 0]));
    expect(r.map((x) => x.specId)).toEqual(['magic-a', 'ext-only']);
    expect(r[0]!.magicMatched).toBe(true);
    expect(r[0]!.reasons[0]).toMatch(/magic 89 50 4E 47 at offset 0/);
    expect(r[1]!.reasons).toEqual(['extension .dat']);
  });

  it('a magic mismatch with extension match ranks below a magic match and below a plain extension match', async () => {
    const r = await detect([extWrongMagic, extOnly, magicA], 'x.dat', mem([0x89, 0x50, 0x4e, 0x47]));
    expect(r.map((x) => x.specId)).toEqual(['magic-a', 'ext-only', 'ext-wrong']);
    expect(r[2]!.magicMatched).toBe(false);
  });

  it('specs without evidence are omitted', async () => {
    expect(await detect([magicA, trailer], 'noext', mem([1, 2, 3, 4, 5]))).toEqual([]);
  });

  it('supports end-relative magic', async () => {
    const r = await detect([trailer], 'x', mem([0, 0, 0xde, 0xad, 0xbe, 0xef]));
    expect(r[0]!.specId).toBe('trailer');
    expect(r[0]!.reasons[0]).toMatch(/4 bytes before end/);
  });

  it('bounds-checks: short files and out-of-range offsets are mismatches, not errors', async () => {
    expect(await detect([trailer, magicA, masked, multi], 'x', mem([0xde, 0xbd]))).toEqual([]);
    expect(await detect([trailer], 'x', mem([]))).toEqual([]);
    const huge = spec('huge', { detect: [{ at: 9007199254740991, bytes: '00' }, ], extensions: ['q'] });
    const r = await detect([huge], 'a.q', mem([0, 0]));
    expect(r[0]!.magicMatched).toBe(false);
    expect(r[0]!.reasons.join()).toMatch(/out of bounds/);
  });

  it('applies masks', async () => {
    expect((await detect([masked], 'x', mem([0, 0xa7])))[0]?.specId).toBe('masked');
    expect(await detect([masked], 'x', mem([0, 0xb7]))).toEqual([]);
  });

  it('multiple rules must all match', async () => {
    expect((await detect([multi], 'x', mem([0x52, 0x49, 0, 0, 0x57, 0x41])))[0]?.magicMatched).toBe(true);
    expect(await detect([multi], 'x', mem([0x52, 0x49, 0, 0, 0, 0]))).toEqual([]);
  });

  it('extension matching is case-insensitive and uses the last dot', async () => {
    expect((await detect([extOnly], 'ARCHIVE.tar.DAT', mem([1])))[0]?.specId).toBe('ext-only');
    expect(await detect([extOnly], 'dat', mem([1]))).toEqual([]);
    expect((await detect([extOnly], 'C:\\dir.dat\\file', mem([1])))).toEqual([]);
  });

  it('reads only the magic ranges', async () => {
    const reads: Array<[number, number]> = [];
    const inner = mem(new Uint8Array(100));
    const src = {
      size: inner.size,
      read: (o: number, l: number) => (reads.push([o, l]), inner.read(o, l)),
    };
    await detect([magicA, trailer], 'x', src);
    expect(reads).toEqual([[0, 4], [96, 4]]);
  });
});

describe('detect: hostile masks', () => {
  it('an all-zero mask (unvalidated spec) never matches and scores nothing', async () => {
    const evil = { ...spec('evil', {}), detect: [{ at: 0, bytes: 'FF FF FF FF', mask: '00 00 00 00' }] };
    expect(await detect([evil], 'x.bin', mem([1, 2, 3, 4]))).toEqual([]);
  });

  it('scores by the number of significant (non-zero mask) bytes', async () => {
    const wide = spec('wide', { detect: [{ at: 0, bytes: '01 02 03 04 05 06 07 08' }] });
    const sneaky = spec('sneaky', { detect: [{ at: 0, bytes: '01 02 03 04 05 06 07 08', mask: '01 00 00 00 00 00 00 00' }] });
    const r = await detect([sneaky, wide], 'x', mem([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(r.map((x) => x.specId)).toEqual(['wide', 'sneaky']);
    expect(r[0]!.score).toBe(108);
    expect(r[1]!.score).toBe(101);
  });
});
