import { describe, expect, it, vi } from 'vitest';
import { BlobByteSource, MemoryByteSource, type ByteSource } from './byte-source';
import { COALESCE_MS, EditBuffer, EditStoreFullError } from './edit-buffer';

const u8 = (...b: number[]) => Uint8Array.from(b);
const seq = (n: number) => Uint8Array.from({ length: n }, (_, i) => i & 0xff);
const all = (b: EditBuffer) => b.read(0, b.size);
const mk = (n: number, opts = {}) => new EditBuffer(new MemoryByteSource(seq(n)), { chunkSize: 4, ...opts });

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('EditBuffer basics', () => {
  it('starts as the base', async () => {
    const b = mk(10);
    expect(b.size).toBe(10);
    expect(b.isDirty).toBe(false);
    expect(await all(b)).toEqual(seq(10));
    expect(b.pieces()).toEqual([{ kind: 'orig', start: 0, length: 10 }]);
  });

  it('overwrites, inserts and deletes', async () => {
    const b = mk(8);
    b.overwrite(2, u8(0xaa, 0xbb));
    expect([...(await all(b))]).toEqual([0, 1, 0xaa, 0xbb, 4, 5, 6, 7]);
    b.insert(4, u8(9, 9, 9));
    expect([...(await all(b))]).toEqual([0, 1, 0xaa, 0xbb, 9, 9, 9, 4, 5, 6, 7]);
    b.delete(1, 4);
    expect([...(await all(b))]).toEqual([0, 9, 9, 4, 5, 6, 7]);
    expect(b.size).toBe(7);
  });

  it('edits at 0 and at size (append)', async () => {
    const b = mk(3);
    b.insert(0, u8(0xf0));
    b.overwrite(4, u8(0xe0)); // offset == size appends
    b.insert(5, u8(0xd0));
    b.overwrite(0, u8(0x11));
    expect([...(await all(b))]).toEqual([0x11, 0, 1, 2, 0xe0, 0xd0]);
  });

  it('overwrite running past the end extends', async () => {
    const b = mk(3);
    b.overwrite(2, u8(7, 8, 9));
    expect([...(await all(b))]).toEqual([0, 1, 7, 8, 9]);
  });

  it('works from an empty base', async () => {
    const b = new EditBuffer(new MemoryByteSource(new Uint8Array(0)));
    expect(b.size).toBe(0);
    b.overwrite(0, u8(1, 2));
    b.overwrite(2, u8(3));
    expect([...(await all(b))]).toEqual([1, 2, 3]);
    b.delete(0, 3);
    expect(b.size).toBe(0);
    expect(b.pieces()).toEqual([]);
  });

  it('reads across many pieces with partial ranges', async () => {
    const b = mk(100);
    for (let i = 0; i < 50; i++) b.overwrite(i * 2, u8(0xff));
    const got = await b.read(10, 21);
    const want = seq(100).slice(10, 31);
    for (let i = 10; i < 31; i++) if (i % 2 === 0 && i < 100) want[i - 10] = 0xff;
    expect(got).toEqual(want);
    expect((await b.read(b.size, 5)).length).toBe(0);
    expect((await b.read(95, 50)).length).toBe(5);
  });

  it('merges contiguous pieces so typing does not explode the piece count', async () => {
    const b = mk(1000);
    for (let i = 0; i < 100; i++) b.overwrite(500 + i, u8(i), { coalesce: true });
    expect(b.pieces().length).toBe(3);
  });

  it('merges orig pieces back after a delete of an insertion', () => {
    const b = mk(10);
    b.insert(5, u8(1, 2));
    b.delete(5, 2);
    expect(b.pieces()).toEqual([{ kind: 'orig', start: 0, length: 10 }]);
  });
});

describe('EditBuffer bounds', () => {
  it('rejects bad arguments with RangeError', async () => {
    const b = mk(10);
    expect(() => b.overwrite(11, u8(1))).toThrow(RangeError);
    expect(() => b.overwrite(-1, u8(1))).toThrow(RangeError);
    expect(() => b.overwrite(1.5, u8(1))).toThrow(RangeError);
    expect(() => b.insert(11, u8(1))).toThrow(RangeError);
    expect(() => b.insert(NaN, u8(1))).toThrow(RangeError);
    expect(() => b.delete(5, 6)).toThrow(RangeError);
    expect(() => b.delete(-1, 1)).toThrow(RangeError);
    expect(() => b.delete(0, 1.2)).toThrow(RangeError);
    await expect(b.read(11, 1)).rejects.toThrow(RangeError);
    await expect(b.read(0, -1)).rejects.toThrow(RangeError);
    await expect(b.read(0.5, 1)).rejects.toThrow(RangeError);
    expect(b.isDirty).toBe(false);
    expect(b.version).toBe(0);
  });

  it('empty edits are no-ops', () => {
    const b = mk(4);
    b.insert(0, new Uint8Array(0));
    b.overwrite(0, new Uint8Array(0));
    b.delete(2, 0);
    expect(b.version).toBe(0);
    expect(b.canUndo).toBe(false);
  });

  it('errors clearly when the added store is full and changes nothing', async () => {
    const b = mk(10, { maxAddedBytes: 6 });
    b.insert(0, u8(1, 2, 3, 4));
    expect(() => b.insert(0, u8(1, 2, 3))).toThrow(EditStoreFullError);
    expect(() => b.insert(0, u8(1, 2, 3))).toThrow(/full/);
    expect(b.size).toBe(14);
    b.overwrite(4, u8(9, 9));
    expect(b.addedBytes).toBe(6);
  });

  it('caps history', async () => {
    const b = mk(10, { maxHistory: 3 });
    for (let i = 0; i < 5; i++) b.overwrite(i, u8(0xee));
    let n = 0;
    while (b.undo() !== null) n++;
    expect(n).toBe(3);
    expect(b.isDirty).toBe(true); // the saved state is no longer reachable
  });
});

describe('EditBuffer undo/redo and dirty state', () => {
  it('undoes and redoes each operation kind', async () => {
    const b = mk(6);
    b.overwrite(1, u8(0xaa));
    b.insert(3, u8(0xbb, 0xcc));
    b.delete(0, 2);
    const states = [await all(b)];
    expect(b.undo()).toBe(0);
    expect([...(await all(b))]).toEqual([0, 0xaa, 2, 0xbb, 0xcc, 3, 4, 5]);
    expect(b.undo()).toBe(3);
    expect([...(await all(b))]).toEqual([0, 0xaa, 2, 3, 4, 5]);
    expect(b.undo()).toBe(1);
    expect(await all(b)).toEqual(seq(6));
    expect(b.undo()).toBeNull();
    expect(b.redo()).toBe(1);
    expect(b.redo()).toBe(3);
    expect(b.redo()).toBe(0);
    expect(await all(b)).toEqual(states[0]);
    expect(b.redo()).toBeNull();
  });

  it('a new edit invalidates redo', async () => {
    const b = mk(4);
    b.overwrite(0, u8(1));
    b.undo();
    expect(b.canRedo).toBe(true);
    b.overwrite(1, u8(2));
    expect(b.canRedo).toBe(false);
    expect(b.redo()).toBeNull();
  });

  it('isDirty tracks the saved state', async () => {
    const b = mk(4);
    expect(b.isDirty).toBe(false);
    b.overwrite(0, u8(1));
    expect(b.isDirty).toBe(true);
    b.undo();
    expect(b.isDirty).toBe(false);
    b.redo();
    b.markSaved();
    expect(b.isDirty).toBe(false);
    b.overwrite(1, u8(2));
    expect(b.isDirty).toBe(true);
    b.undo();
    expect(b.isDirty).toBe(false);
    b.undo(); // before the saved state
    expect(b.isDirty).toBe(true);
    b.overwrite(2, u8(3)); // diverged: saved state unreachable even at the same depth
    expect(b.isDirty).toBe(true);
    b.undo();
    expect(b.isDirty).toBe(true);
  });

  it('coalesces adjacent typed edits, and breaks on a jump, pause or breakGroup', () => {
    let t = 0;
    const b = mk(100, { now: () => t });
    const type = (o: number) => b.overwrite(o, u8(0x11), { coalesce: true });
    const steps = () => {
      let n = 0;
      while (b.undo() !== null) n++;
      return n;
    };
    type(10);
    type(10); // second nibble, same byte
    t += 100;
    type(11);
    type(11);
    type(12);
    expect(steps()).toBe(1);
    // jump
    type(10);
    type(50);
    expect(steps()).toBe(2);
    // pause of >= 1s
    type(10);
    t += COALESCE_MS;
    type(11);
    expect(steps()).toBe(2);
    // just under the threshold still joins
    type(10);
    t += COALESCE_MS - 1;
    type(11);
    expect(steps()).toBe(1);
    // explicit break (caret moved)
    type(10);
    b.breakGroup();
    type(11);
    expect(steps()).toBe(2);
  });

  it('does not coalesce edits that are not marked typed', () => {
    const b = mk(10);
    b.overwrite(0, u8(1));
    b.overwrite(1, u8(1));
    b.undo();
    expect(b.canUndo).toBe(true);
  });

  it('a coalesced step undoes fully and restores content', async () => {
    const b = mk(20);
    b.insert(5, u8(0xa0), { coalesce: true });
    b.overwrite(5, u8(0xa1), { coalesce: true });
    b.insert(6, u8(0xb0), { coalesce: true });
    b.overwrite(6, u8(0xb1), { coalesce: true });
    expect([...(await b.read(4, 5))]).toEqual([4, 0xa1, 0xb1, 5, 6]);
    b.undo();
    expect(await all(b)).toEqual(seq(20));
    b.redo();
    expect([...(await b.read(4, 5))]).toEqual([4, 0xa1, 0xb1, 5, 6]);
  });

  it('rebase resets to a clean state on a same-size base', async () => {
    const b = mk(4);
    b.overwrite(0, u8(9));
    const content = await all(b);
    b.rebase(new MemoryByteSource(content));
    expect(b.isDirty).toBe(false);
    expect(b.canUndo).toBe(false);
    expect(b.pieces()).toEqual([{ kind: 'orig', start: 0, length: 4 }]);
    expect(b.modifiedRanges(0, 4)).toEqual([]);
    expect(() => b.rebase(new MemoryByteSource(new Uint8Array(3)))).toThrow(RangeError);
  });

  it('notifies listeners and bumps version on every change', () => {
    const b = mk(4);
    let n = 0;
    const off = b.onChange(() => n++);
    b.overwrite(0, u8(1));
    b.undo();
    b.redo();
    expect(n).toBe(3);
    expect(b.version).toBe(3);
    off();
    b.delete(0, 1);
    expect(n).toBe(3);
  });
});

describe('modifiedRanges', () => {
  it('only added bytes count, clipped to the window', () => {
    const b = mk(100);
    b.overwrite(10, u8(1, 2, 3));
    b.insert(50, u8(4, 4));
    b.overwrite(52, u8(5));
    expect(b.modifiedRanges(0, 100)).toEqual([
      [10, 13],
      [50, 53],
    ]);
    expect(b.modifiedRanges(11, 51)).toEqual([
      [11, 13],
      [50, 51],
    ]);
    expect(b.modifiedRanges(60, 90)).toEqual([]);
    expect(b.modifiedRanges(5, 5)).toEqual([]);
  });
});

describe('toBlob', () => {
  it('equals the document and does not read the base', async () => {
    let reads = 0;
    const data = seq(300);
    const base: ByteSource = { size: 300, read: async (o, l) => (reads++, data.slice(o, o + l)) };
    const b = new EditBuffer(base, { chunkSize: 4 });
    b.overwrite(10, u8(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));
    b.insert(100, u8(0xaa));
    b.delete(200, 50);
    const blob = b.toBlob(new Blob([data]));
    expect(reads).toBe(0);
    expect(blob.size).toBe(b.size);
    const model = Uint8Array.from([...data]);
    model.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10);
    const want = [...model.subarray(0, 100), 0xaa, ...model.subarray(100, 199), ...model.subarray(249)];
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual(want);
  });

  it('rejects a base blob of the wrong size', () => {
    expect(() => mk(10).toBlob(new Blob([new Uint8Array(9)]))).toThrow(RangeError);
  });
});

describe('large base', () => {
  it('only reads the small ranges it needs from a 4 GB source', async () => {
    const SIZE = 4 * 1024 ** 3;
    const reads: Array<[number, number]> = [];
    const base: ByteSource = {
      size: SIZE,
      read: async (o, l) => {
        reads.push([o, l]);
        return Uint8Array.from({ length: Math.min(l, SIZE - o) }, (_, i) => (o + i) & 0xff);
      },
    };
    const b = new EditBuffer(base);
    b.overwrite(SIZE - 2, u8(1, 2, 3)); // extends past the end
    b.insert(SIZE / 2, u8(9));
    b.delete(1000, 1_000_000);
    expect(b.size).toBe(SIZE + 1 - 1_000_000 + 1);
    const got = await b.read(b.size - 4, 4);
    expect([...got.subarray(1)]).toEqual([1, 2, 3]);
    expect(reads.every(([, l]) => l <= 4)).toBe(true);
    expect(b.pieces().length).toBeLessThan(10);
  });
});

describe('property test against a reference model', () => {
  it('10k random ops (with undo/redo) match a Uint8Array model', async () => {
    const rnd = prng(12345);
    const int = (n: number) => Math.floor(rnd() * n);
    const b = new EditBuffer(new MemoryByteSource(seq(500)), { chunkSize: 16, maxHistory: 100_000 });
    let model: Uint8Array = seq(500);
    const history: Uint8Array[] = [model];
    let cursor = 0; // index into history
    const rnd8 = (n: number) => Uint8Array.from({ length: n }, () => int(256));

    for (let k = 0; k < 10_000; k++) {
      const r = rnd();
      if (r < 0.3) {
        const off = int(model.length + 1);
        const bytes = rnd8(1 + int(6));
        b.overwrite(off, bytes);
        const next = new Uint8Array(Math.max(model.length, off + bytes.length));
        next.set(model);
        next.set(bytes, off);
        model = next;
      } else if (r < 0.6) {
        const off = int(model.length + 1);
        const bytes = rnd8(1 + int(6));
        b.insert(off, bytes);
        const next = new Uint8Array(model.length + bytes.length);
        next.set(model.subarray(0, off));
        next.set(bytes, off);
        next.set(model.subarray(off), off + bytes.length);
        model = next;
      } else if (r < 0.85) {
        if (model.length === 0) continue;
        const off = int(model.length);
        const len = Math.min(1 + int(20), model.length - off);
        b.delete(off, len);
        const next = new Uint8Array(model.length - len);
        next.set(model.subarray(0, off));
        next.set(model.subarray(off + len), off);
        model = next;
      } else if (r < 0.93) {
        if (b.undo() === null) continue;
        cursor--;
        model = history[cursor]!;
        expect(b.size).toBe(model.length);
        continue;
      } else {
        if (b.redo() === null) continue;
        cursor++;
        model = history[cursor]!;
        expect(b.size).toBe(model.length);
        continue;
      }
      history.length = cursor + 1; // new edit drops the redo tail
      history.push(model);
      cursor++;
      if (k % 250 === 0) expect(await all(b)).toEqual(model);
    }
    expect(await all(b)).toEqual(model);
    // Random windowed reads
    for (let i = 0; i < 200; i++) {
      const off = int(model.length + 1);
      const len = int(300);
      expect(await b.read(off, len)).toEqual(model.slice(off, off + len));
    }
    expect(new Uint8Array(await b.toBlob(new Blob([seq(500)])).arrayBuffer())).toEqual(model);
    // Undo everything: back to the base.
    while (b.undo() !== null);
    expect(await all(b)).toEqual(seq(500));
    expect(b.isDirty).toBe(false);
  });
});

describe('toBlob caching', () => {
  it('builds one Blob per added chunk and reuses it while the chunk is unchanged', async () => {
    const b = new EditBuffer(new MemoryByteSource(seq(10)), { chunkSize: 8 });
    b.insert(5, new Uint8Array(20).fill(7)); // spans chunks 0..2
    const readAdded = vi.spyOn(b, 'readAdded');
    const first = b.toBlob(new Blob([seq(10)]));
    const builds = b.chunkBlobBuilds;
    expect(builds).toBe(3);
    const second = b.toBlob(new Blob([seq(10)]));
    expect(b.chunkBlobBuilds).toBe(builds); // nothing rebuilt
    expect(readAdded).not.toHaveBeenCalled();
    expect(await second.arrayBuffer()).toEqual(await first.arrayBuffer());
    // appending grows only the last (partial) chunk; full earlier chunks stay cached
    b.overwrite(b.size, u8(1));
    b.toBlob(new Blob([seq(10)]));
    expect(b.chunkBlobBuilds).toBe(builds + 1);
    const want = [...seq(10).subarray(0, 5), ...new Array(20).fill(7), ...seq(10).subarray(5), 1];
    expect([...new Uint8Array(await b.toBlob(new Blob([seq(10)])).arrayBuffer())]).toEqual(want);
  });
});

describe('model test with coalescing, markSaved, eviction and a full store', () => {
  it('matches a history model: content, undo/redo, isDirty and store-full errors', async () => {
    const rnd = prng(987);
    const int = (n: number) => Math.floor(rnd() * n);
    const MAX_HISTORY = 25;
    const MAX_ADDED = 600;
    let t = 0; // fake clock: advanced so typed runs sometimes pause >= COALESCE_MS
    let baseBlob = new Blob([seq(200)]);
    const b = new EditBuffer(new MemoryByteSource(seq(200)), {
      chunkSize: 8,
      maxHistory: MAX_HISTORY,
      maxAddedBytes: MAX_ADDED,
      now: () => t,
    });
    // Model: content snapshot per history state; `cur` = number of undo steps available.
    let states: Uint8Array[] = [seq(200)];
    let cur = 0;
    let saved: number | null = 0;
    let groupOpen = false;
    let groupTime = 0;
    let fullErrors = 0;
    let rebases = 0;

    const pushStep = (content: Uint8Array) => {
      if (saved !== null && saved > cur) saved = null;
      states = states.slice(0, cur + 1);
      states.push(content);
      cur++;
      if (cur > MAX_HISTORY) {
        states.shift();
        cur--;
        saved = saved !== null && saved > 0 ? saved - 1 : null;
      }
    };
    const withBytes = (m: Uint8Array, off: number, bytes: Uint8Array) => {
      const n = new Uint8Array(Math.max(m.length, off + bytes.length));
      n.set(m);
      n.set(bytes, off);
      return n;
    };
    const rnd8 = (n: number) => Uint8Array.from({ length: n }, () => int(256));

    for (let k = 0; k < 3000; k++) {
      const m = states[cur]!;
      const r = rnd();
      if (r < 0.2) {
        // a typed run: single-byte overwrites at adjacent offsets, each position written twice (two nibbles)
        b.breakGroup();
        groupOpen = false;
        let pos = int(m.length + 1);
        let runFull = false;
        for (let i = 0; i < 1 + int(6); i++) {
          for (let nib = 0; nib < 2; nib++) {
            t += 1 + int(50);
            if (int(10) === 0) t += COALESCE_MS; // a pause: the next write starts a new step
            const bytes = rnd8(1);
            const cs = states[cur]!;
            if (b.addedBytes + 1 > MAX_ADDED) {
              expect(() => b.overwrite(pos, bytes, { coalesce: true })).toThrow(EditStoreFullError);
              fullErrors++;
              runFull = true; // the rest of the run would fail the same way (and positions would drift past the end)
              break;
            }
            b.overwrite(pos, bytes, { coalesce: true });
            const next = withBytes(cs, pos, bytes);
            if (groupOpen && cur === states.length - 1 && t - groupTime < COALESCE_MS) states[cur] = next; // joins the open step
            else pushStep(next);
            groupOpen = true;
            groupTime = t;
          }
          if (runFull) break;
          pos++;
        }
      } else if (r < 0.35) {
        const off = int(m.length + 1);
        const bytes = rnd8(1 + int(5));
        groupOpen = false;
        if (b.addedBytes + bytes.length > MAX_ADDED) {
          expect(() => b.insert(off, bytes)).toThrow(EditStoreFullError);
          fullErrors++;
        } else {
          b.insert(off, bytes);
          const n = new Uint8Array(m.length + bytes.length);
          n.set(m.subarray(0, off));
          n.set(bytes, off);
          n.set(m.subarray(off), off + bytes.length);
          pushStep(n);
        }
      } else if (r < 0.5) {
        if (m.length === 0) continue;
        const off = int(m.length);
        const len = Math.min(1 + int(10), m.length - off);
        b.delete(off, len);
        groupOpen = false;
        const n = new Uint8Array(m.length - len);
        n.set(m.subarray(0, off));
        n.set(m.subarray(off + len), off);
        pushStep(n);
      } else if (r < 0.7) {
        groupOpen = false;
        if (cur > 0) {
          expect(b.undo()).not.toBeNull();
          cur--;
        } else expect(b.undo()).toBeNull();
      } else if (r < 0.85) {
        groupOpen = false;
        if (cur < states.length - 1) {
          expect(b.redo()).not.toBeNull();
          cur++;
        } else expect(b.redo()).toBeNull();
      } else if (r < 0.852) {
        // rebase onto a Blob of the current content (what a download save does): history and store reset
        const content = states[cur]!;
        baseBlob = new Blob([content as Uint8Array<ArrayBuffer>]);
        b.rebase(new BlobByteSource(baseBlob));
        states = [content];
        cur = 0;
        saved = 0;
        groupOpen = false;
        rebases++;
        expect(b.addedBytes).toBe(0);
      } else {
        b.markSaved();
        groupOpen = false;
        saved = cur;
      }
      expect(b.size).toBe(states[cur]!.length);
      expect(b.isDirty).toBe(saved === null || saved !== cur);
      if (k % 20 === 0) expect(await b.read(0, b.size)).toEqual(states[cur]);
      if (k % 50 === 0) expect(new Uint8Array(await b.toBlob(baseBlob).arrayBuffer())).toEqual(states[cur]);
    }
    expect(fullErrors).toBeGreaterThan(0); // the store did fill up
    expect(rebases).toBeGreaterThan(0);
    expect(await b.read(0, b.size)).toEqual(states[cur]);
    let steps = 0;
    while (b.undo() !== null) steps++;
    expect(steps).toBe(cur);
    expect(await b.read(0, b.size)).toEqual(states[0]);
  });
});

describe('toBlob after undo and chained rebases', () => {
  it('undo, then a new append, then toBlob is correct (cached chunk Blobs are not stale)', async () => {
    const base = new Blob([seq(10)]);
    const b = new EditBuffer(new MemoryByteSource(seq(10)), { chunkSize: 4 });
    b.overwrite(10, u8(1, 2, 3));
    expect([...new Uint8Array(await b.toBlob(base).arrayBuffer())]).toEqual([...seq(10), 1, 2, 3]);
    b.undo();
    b.overwrite(10, u8(9));
    expect([...new Uint8Array(await b.toBlob(base).arrayBuffer())]).toEqual([...seq(10), 9]);
    b.overwrite(11, u8(8, 7, 6, 5, 4));
    expect([...new Uint8Array(await b.toBlob(base).arrayBuffer())]).toEqual([...seq(10), 9, 8, 7, 6, 5, 4]);
  });

  it('repeated download-style saves (toBlob then rebase onto it) keep content right and reset the store each time', async () => {
    let blob = new Blob([seq(20)]);
    const b = new EditBuffer(new BlobByteSource(blob), { chunkSize: 4 });
    let model = [...seq(20)];
    for (let i = 0; i < 6; i++) {
      b.insert(i, u8(100 + i));
      model.splice(i, 0, 100 + i);
      b.overwrite(b.size, u8(200 + i));
      model.push(200 + i);
      b.delete(10, 1);
      model.splice(10, 1);
      expect(b.isDirty).toBe(true);
      const next = b.toBlob(blob);
      expect([...new Uint8Array(await next.arrayBuffer())]).toEqual(model);
      b.rebase(new BlobByteSource(next));
      blob = next;
      expect(b.addedBytes).toBe(0);
      expect(b.isDirty).toBe(false);
      expect(b.canUndo).toBe(false);
      expect(b.pieces()).toHaveLength(1);
      expect([...(await b.read(0, b.size))]).toEqual(model);
    }
  });
});
