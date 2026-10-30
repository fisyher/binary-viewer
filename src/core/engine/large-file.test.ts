import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../byte-source';
import { MAX_READ } from '../byte-source';
import { detect } from './detect';
import { expandLazy, findNodeAt, parse } from './interpret';
import { find, mkSpec } from './test-helpers';

const SIZE = 4 * 1024 ** 3; // 4 GiB, never materialised

/** A fake 4 GiB source: header at 0, everything else is a deterministic pattern. Records every read. */
function fakeHuge() {
  const reads: Array<{ offset: number; length: number }> = [];
  const header = [0x4d, 0x59, 0x46, 0x54, /* tbl_off = 0xC0000000 */ 0x00, 0x00, 0x00, 0xc0, /* count = 1000 */ 0xe8, 0x03, 0x00, 0x00];
  const byteAt = (i: number): number => (i < header.length ? header[i]! : (i * 31 + 7) & 0xff);
  const source: ByteSource = {
    size: SIZE,
    async read(offset, length) {
      reads.push({ offset, length });
      if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || length > MAX_READ || offset > SIZE) throw new RangeError('bad read');
      const n = Math.min(length, SIZE - offset);
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = byteAt(offset + i);
      return out;
    },
  };
  return { source, reads };
}

const LAST_BYTE_HEX = (((SIZE - 1) * 31 + 7) & 0xff).toString(16).padStart(2, '0');

const spec = () =>
  mkSpec(
    {
      root: {
        fields: [
          { name: 'magic', type: 'u4' },
          { name: 'tbl_off', type: 'u4' },
          { name: 'count', type: 'u4' },
          { name: 'big', type: 'u4', at: 16, repeat: { count: 100_000_000 } },
          { name: 'blob', type: 'bytes', at: 256, size: 'eos' },
          { name: 'table', type: 'u4', at: 'tbl_off', repeat: { count: 'count' } },
          { name: 'footer', type: 'u1', at: SIZE - 1 },
        ],
      },
    },
    { detect: [{ at: 0, bytes: '4D 59 46 54' }, { at: -1, bytes: LAST_BYTE_HEX }] },
  );

describe('4 GiB source', () => {
  it('parses touching only small ranges', async () => {
    const { source, reads } = fakeHuge();
    const r = await parse(spec(), source);
    expect(r.errors).toEqual([]);
    expect(find(r.root, 'magic').value).toBe(0x5446594d);
    expect(find(r.root, 'tbl_off').value).toBe(0xc0000000);
    expect(find(r.root, 'blob').size).toBe(SIZE - 256);
    expect(find(r.root, 'blob').offset).toBe(256);
    expect(find(r.root, 'big').lazy?.count).toBe(100_000_000);
    expect(find(r.root, 'big').children).toEqual([]);
    expect(find(r.root, 'table').children).toHaveLength(1000);
    expect(find(r.root, 'table').children![999]!.offset).toBe(0xc0000000 + 999 * 4);
    expect(find(r.root, 'footer').offset).toBe(SIZE - 1);

    // The proof: nothing large was ever read.
    expect(Math.max(...reads.map((x) => x.length))).toBeLessThanOrEqual(16);
    expect(reads.reduce((a, x) => a + x.length, 0)).toBeLessThan(16_000);
    expect(r.stats.bytesRead).toBe(reads.reduce((a, x) => a + x.length, 0));
    for (const x of reads) expect(x.offset + x.length).toBeLessThanOrEqual(SIZE);
  });

  it('expandLazy reads just the requested window; findNodeAt does no I/O', async () => {
    const { source, reads } = fakeHuge();
    const r = await parse(spec(), source);
    const before = reads.length;
    const big = find(r.root, 'big');
    const nodes = await expandLazy(r, big.id, { start: 90_000_000, count: 5 });
    expect(nodes.map((n) => n.offset)).toEqual([0, 1, 2, 3, 4].map((i) => 16 + (90_000_000 + i) * 4));
    const newReads = reads.slice(before);
    expect(newReads).toHaveLength(5);
    expect(newReads.every((x) => x.length === 4)).toBe(true);

    const hit = findNodeAt(r.root, 200_000_000);
    expect(hit?.name).toBe('big'); // inside the lazy range, no expansion needed
    expect(reads.length).toBe(before + 5);
  });

  it('detection reads only the magic bytes', async () => {
    const { source, reads } = fakeHuge();
    const out = await detect([spec()], 'huge.bin', source);
    expect(out[0]?.magicMatched).toBe(true);
    expect(reads.map((x) => x.length)).toEqual([4, 1]);
    expect(reads[1]!.offset).toBe(SIZE - 1);
  });
});
