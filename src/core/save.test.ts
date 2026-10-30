// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryByteSource } from './byte-source';
import { EditBuffer } from './edit-buffer';
import {
  SavePermissionError,
  SavedButUnreadableError,
  downloadTarget,
  ensureWritePermission,
  saveTo,
  streamPieces,
  writeToHandle,
  type SaveHandle,
  type WritableLike,
} from './save';

const u8 = (...b: number[]) => Uint8Array.from(b);
const seq = (n: number) => Uint8Array.from({ length: n }, (_, i) => i & 0xff);

async function bytesOf(chunk: Blob | Uint8Array): Promise<Uint8Array> {
  return chunk instanceof Blob ? new Uint8Array(await chunk.arrayBuffer()) : chunk;
}

function setup(n = 100) {
  const data = seq(n);
  const eb = new EditBuffer(new MemoryByteSource(data), { chunkSize: 8 });
  eb.overwrite(10, u8(1, 2, 3));
  eb.insert(50, new Uint8Array(30).fill(7));
  eb.delete(90, 5);
  return { eb, blob: new Blob([data]) };
}

afterEach(() => vi.useRealTimers());

describe('streamPieces', () => {
  it('yields the document in order with bounded chunks', async () => {
    const { eb, blob } = setup();
    const out: number[] = [];
    let max = 0;
    for await (const c of streamPieces(eb, blob, 16)) {
      const b = await bytesOf(c);
      max = Math.max(max, b.length);
      out.push(...b);
    }
    expect(max).toBeLessThanOrEqual(16);
    expect(out).toEqual([...(await eb.read(0, eb.size))]);
  });

  it('never reads the whole file: base data stays as lazy slices', async () => {
    const size = 64 * 1024 * 1024; // sparse blob made of one big part
    const slices: Array<[number, number]> = [];
    const fake = {
      size,
      slice: (a: number, b: number) => {
        slices.push([a, b]);
        return new Blob([]);
      },
    } as unknown as Blob;
    const eb = new EditBuffer({ size, read: async () => new Uint8Array(0) });
    eb.overwrite(5, u8(1));
    const chunks: Array<Blob | Uint8Array> = [];
    for await (const c of streamPieces(eb, fake, 4 * 1024 * 1024)) chunks.push(c);
    expect(slices.every(([a, b]) => b - a <= 4 * 1024 * 1024)).toBe(true);
    expect(slices.reduce((n, [a, b]) => n + (b - a), 0)).toBe(size - 1);
    expect(chunks.filter((c) => c instanceof Uint8Array)).toHaveLength(1);
  });

  it('saves an empty document as no chunks and validates chunkSize', async () => {
    const eb = new EditBuffer(new MemoryByteSource(new Uint8Array(0)));
    const out: unknown[] = [];
    for await (const c of streamPieces(eb, new Blob([]))) out.push(c);
    expect(out).toEqual([]);
    await expect(streamPieces(eb, new Blob([]), 0).next()).rejects.toThrow(RangeError);
  });
});

function mockHandle(opts: { failAtWrite?: number; closeFails?: boolean; perm?: string[] } = {}) {
  const written: Array<Blob | Uint8Array> = [];
  const state = { closed: false, aborted: false, writes: 0 };
  const writable: WritableLike = {
    async write(d) {
      if (opts.failAtWrite !== undefined && state.writes++ === opts.failAtWrite) throw new Error('disk full');
      written.push(d);
    },
    async close() {
      if (opts.closeFails) throw new Error('close failed');
      state.closed = true;
    },
    async abort() {
      state.aborted = true;
    },
  };
  const perms = [...(opts.perm ?? [])];
  const handle: SaveHandle = {
    name: 'x.bin',
    createWritable: async () => writable,
    getFile: async () => new File([await Promise.all(written.map(bytesOf)).then((p) => Uint8Array.from(p.flatMap((x) => [...x])))], 'x.bin'),
    queryPermission: async () => perms.shift() ?? 'granted',
    requestPermission: async () => perms.shift() ?? 'granted',
  };
  return { handle, state, written };
}

describe('writeToHandle', () => {
  it('writes everything, closes, and returns the re-read file', async () => {
    const { eb, blob } = setup();
    const { handle, state } = mockHandle();
    const file = await writeToHandle(handle, eb, blob);
    expect(state.closed).toBe(true);
    expect(state.aborted).toBe(false);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(await eb.read(0, eb.size));
  });

  it('aborts on a mid-write failure and leaves the edits intact', async () => {
    const { eb, blob } = setup();
    const { handle, state } = mockHandle({ failAtWrite: 2 });
    await expect(writeToHandle(handle, eb, blob)).rejects.toThrow('disk full');
    expect(state.aborted).toBe(true);
    expect(state.closed).toBe(false);
    expect(eb.isDirty).toBe(true);
  });

  it('aborts when close() fails', async () => {
    const { eb, blob } = setup();
    const { handle, state } = mockHandle({ closeFails: true });
    await expect(writeToHandle(handle, eb, blob)).rejects.toThrow('close failed');
    expect(state.aborted).toBe(true);
  });
});

describe('writeToHandle: re-read failure', () => {
  it('reports SavedButUnreadableError (not a plain failure) when getFile rejects after a successful close', async () => {
    const { eb, blob } = setup();
    const { handle, state } = mockHandle();
    handle.getFile = async () => {
      throw new Error('NotReadableError');
    };
    const err = await writeToHandle(handle, eb, blob).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SavedButUnreadableError);
    expect((err as Error).message).toMatch(/Saved, but the file could not be re-read/);
    expect(state.closed).toBe(true); // the data was written
    expect(state.aborted).toBe(false);
  });
});

describe('ensureWritePermission', () => {
  it('passes when granted, requests when prompt, throws when denied', async () => {
    await expect(ensureWritePermission(mockHandle().handle)).resolves.toBeUndefined();
    await expect(ensureWritePermission(mockHandle({ perm: ['prompt', 'granted'] }).handle)).resolves.toBeUndefined();
    await expect(ensureWritePermission(mockHandle({ perm: ['prompt', 'denied'] }).handle)).rejects.toBeInstanceOf(
      SavePermissionError,
    );
  });
});

describe('downloadTarget', () => {
  it('offers a download and revokes the object URL only after a delay', async () => {
    vi.useFakeTimers();
    const created: Blob[] = [];
    const revoked: string[] = [];
    URL.createObjectURL = (b: Blob | MediaSource) => (created.push(b as Blob), 'blob:test');
    URL.revokeObjectURL = (u: string) => void revoked.push(u);
    const clicks: string[] = [];
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
    const { eb, blob } = setup();
    await saveTo(downloadTarget('out.bin', 5000), eb, blob);
    expect(clicks).toEqual(['out.bin']);
    expect(created).toHaveLength(1);
    expect(new Uint8Array(await created[0]!.arrayBuffer())).toEqual(await eb.read(0, eb.size));
    expect(revoked).toEqual([]); // not right after click()
    vi.advanceTimersByTime(4999);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(revoked).toEqual(['blob:test']);
    spy.mockRestore();
  });
});
