import { describe, expect, it, vi } from 'vitest';
import { BlobByteSource, MAX_READ, MemoryByteSource, probeReadable } from './byte-source';

function makeData(n: number): Uint8Array {
  const d = new Uint8Array(n);
  for (let i = 0; i < n; i++) d[i] = (i * 7 + 3) & 0xff;
  return d;
}

function spyBlob(data: Uint8Array) {
  const blob = new Blob([data as BlobPart]);
  const ranges: Array<[number, number]> = [];
  const orig = blob.slice.bind(blob);
  blob.slice = ((s?: number, e?: number) => {
    ranges.push([s ?? 0, e ?? blob.size]);
    return orig(s, e);
  }) as Blob['slice'];
  return { blob, ranges };
}

describe.each([
  ['MemoryByteSource', (d: Uint8Array) => new MemoryByteSource(d)],
  ['BlobByteSource', (d: Uint8Array) => new BlobByteSource(new Blob([d as BlobPart]), { pageSize: 16 })],
])('%s common behaviour', (_name, make) => {
  const data = makeData(100);

  it('reads a range', async () => {
    expect(await make(data).read(10, 5)).toEqual(data.slice(10, 15));
  });

  it('clamps reads past EOF', async () => {
    const src = make(data);
    expect(await src.read(95, 50)).toEqual(data.slice(95));
    expect(await src.read(0, 1_000_000)).toEqual(data);
  });

  it('returns empty at offset == size and for zero length', async () => {
    const src = make(data);
    expect((await src.read(100, 10)).length).toBe(0);
    expect((await src.read(5, 0)).length).toBe(0);
  });

  it('rejects invalid arguments', async () => {
    const src = make(data);
    for (const [o, l] of [
      [-1, 1],
      [0, -1],
      [1.5, 1],
      [0, 2.5],
      [NaN, 1],
      [0, Infinity],
      [101, 1],
    ] as const) {
      await expect(src.read(o, l)).rejects.toBeInstanceOf(RangeError);
    }
  });

  it('handles empty sources', async () => {
    const src = make(new Uint8Array(0));
    expect(src.size).toBe(0);
    expect((await src.read(0, 10)).length).toBe(0);
  });
});

describe('BlobByteSource paging', () => {
  it('stitches reads that span pages', async () => {
    const data = makeData(100);
    const src = new BlobByteSource(new Blob([data as BlobPart]), { pageSize: 16 });
    expect(await src.read(10, 60)).toEqual(data.slice(10, 70));
    expect(await src.read(96, 4)).toEqual(data.slice(96, 100)); // short last page
  });

  it('reads only the pages it needs, never the whole blob', async () => {
    const size = 10 * 1024 * 1024;
    const { blob, ranges } = spyBlob(new Uint8Array(size));
    const src = new BlobByteSource(blob); // 64 KiB pages
    await src.read(5 * 65536 + 10, 100);
    expect(ranges).toEqual([[5 * 65536, 6 * 65536]]);
    await src.read(size - 10, 100);
    const total = ranges.reduce((a, [s, e]) => a + (e - s), 0);
    expect(total).toBeLessThan(size / 10);
    expect(ranges.every(([s, e]) => e - s <= 65536)).toBe(true);
  });

  it('serves repeat reads from cache', async () => {
    const { blob, ranges } = spyBlob(makeData(64));
    const src = new BlobByteSource(blob, { pageSize: 16 });
    await src.read(0, 10);
    await src.read(2, 10);
    expect(ranges.length).toBe(1);
  });

  it('shares in-flight page loads between concurrent reads', async () => {
    const { blob, ranges } = spyBlob(makeData(64));
    const src = new BlobByteSource(blob, { pageSize: 16 });
    await Promise.all([src.read(0, 4), src.read(4, 4)]);
    expect(ranges.length).toBe(1);
  });

  it('evicts least recently used pages', async () => {
    const { blob, ranges } = spyBlob(makeData(64));
    const src = new BlobByteSource(blob, { pageSize: 16, maxPages: 2 });
    await src.read(0, 1); // page 0
    await src.read(16, 1); // page 1
    await src.read(0, 1); // touch page 0 -> page 1 is LRU
    await src.read(32, 1); // page 2 evicts page 1
    expect(src.cachedPages).toBe(2);
    expect(ranges.length).toBe(3);
    await src.read(0, 1); // still cached
    expect(ranges.length).toBe(3);
    await src.read(16, 1); // evicted, refetched
    expect(ranges.length).toBe(4);
  });

  it('validates constructor options', () => {
    const blob = new Blob([]);
    expect(() => new BlobByteSource(blob, { pageSize: 0 })).toThrow(RangeError);
    expect(() => new BlobByteSource(blob, { maxPages: 1.5 })).toThrow(RangeError);
  });

  it('propagates blob read failures without caching them', async () => {
    const blob = new Blob([makeData(32) as BlobPart]);
    const spy = vi.spyOn(blob, 'slice').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const src = new BlobByteSource(blob, { pageSize: 16 });
    await expect(src.read(0, 4)).rejects.toThrow('boom');
    spy.mockRestore();
    expect((await src.read(0, 4)).length).toBe(4);
  });
});

describe('BlobByteSource robustness', () => {
  it('rejects reads longer than MAX_READ (both sources)', async () => {
    const mem = new MemoryByteSource(makeData(10));
    const blob = new BlobByteSource(new Blob([makeData(10) as BlobPart]));
    await expect(mem.read(0, MAX_READ + 1)).rejects.toBeInstanceOf(RangeError);
    await expect(blob.read(0, MAX_READ + 1)).rejects.toBeInstanceOf(RangeError);
    expect((await blob.read(0, MAX_READ)).length).toBe(10);
  });

  it('throws on a short page and does not cache or zero-fill it', async () => {
    const data = makeData(32);
    const blob = new Blob([data as BlobPart]);
    const src = new BlobByteSource(blob, { pageSize: 16 });
    const orig = blob.slice.bind(blob);
    const spy = vi.spyOn(blob, 'slice').mockImplementation((s?: number, e?: number) =>
      orig(s, Math.min(e ?? blob.size, (s ?? 0) + 4)),
    );
    await expect(src.read(0, 16)).rejects.toThrow(/Short read/);
    expect(src.cachedPages).toBe(0);
    spy.mockRestore();
    expect(await src.read(0, 16)).toEqual(data.slice(0, 16)); // retries cleanly
  });

  it('shares a rejected in-flight load, then retries on the next read', async () => {
    const data = makeData(32);
    const blob = new Blob([data as BlobPart]);
    const src = new BlobByteSource(blob, { pageSize: 16 });
    const orig = blob.slice.bind(blob);
    let calls = 0;
    const spy = vi.spyOn(blob, 'slice').mockImplementation((s?: number, e?: number) => {
      calls++;
      return {
        arrayBuffer: () => Promise.reject(new Error('io')),
      } as unknown as Blob;
    });
    const results = await Promise.allSettled([src.read(0, 4), src.read(4, 4)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(calls).toBe(1);
    spy.mockRestore();
    void orig;
    expect(await src.read(0, 8)).toEqual(data.slice(0, 8));
  });

  it('handles page sizes that do not divide the file size, at page boundaries', async () => {
    const data = makeData(100);
    const src = new BlobByteSource(new Blob([data as BlobPart]), { pageSize: 30 });
    expect(await src.read(30, 30)).toEqual(data.slice(30, 60));
    expect(await src.read(29, 2)).toEqual(data.slice(29, 31));
    expect(await src.read(90, 10)).toEqual(data.slice(90, 100)); // last page is 10 bytes
    expect(await src.read(89, 100)).toEqual(data.slice(89));
    expect((await src.read(100, 5)).length).toBe(0);
  });

  it('stays correct with maxPages = 1 under random reads', async () => {
    const data = makeData(500);
    const src = new BlobByteSource(new Blob([data as BlobPart]), { pageSize: 16, maxPages: 1 });
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    const reads = [];
    for (let i = 0; i < 200; i++) {
      const o = rnd() % 501;
      const l = rnd() % 100;
      reads.push(src.read(o, l).then((got) => expect(got).toEqual(data.slice(Math.min(o, 500), Math.min(o + l, 500)))));
    }
    await Promise.all(reads);
    expect(src.cachedPages).toBeLessThanOrEqual(1);
  });
});

describe('probeReadable', () => {
  it('resolves for readable and empty blobs', async () => {
    await expect(probeReadable(new Blob([]))).resolves.toBeUndefined();
    await expect(probeReadable(new Blob([makeData(3) as BlobPart]))).resolves.toBeUndefined();
  });
  it('rejects when the blob cannot be read', async () => {
    const bad = { slice: () => ({ arrayBuffer: () => Promise.reject(new Error('dir')) }) } as unknown as Blob;
    await expect(probeReadable(bad)).rejects.toThrow('dir');
  });
});
