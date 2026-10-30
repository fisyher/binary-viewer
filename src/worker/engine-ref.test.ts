import { describe, expect, it } from 'vitest';
import { MemoryByteSource } from '../core/byte-source';
import { find, mkSpec } from '../core/engine/test-helpers';
import { createInlineClient } from './inline-client';
import { SupersededError } from './engine-client';

// root: ptr (u1) holds the offset of a `blob`; the substream trick is not needed here: the point is the protocol.
const spec = () =>
  mkSpec(
    {
      blob: { fields: [{ name: 'b0', type: 'u1' }, { name: 'next', type: 'u1', ref: { type: 'blob', at: '0' } }] },
      root: { fields: [{ name: 'ptr', type: 'u1', ref: { type: 'blob', at: 'ptr' } }, { name: 'pad', type: 'bytes', size: 5 }] },
    },
    { id: 'refs', name: 'Refs' },
  );
const BYTES = Uint8Array.from([6, 0, 0, 0, 0, 0, 0xb0, 0xb1]);

function client() {
  return createInlineClient({ specs: [spec()], specErrors: [], makeSource: () => new MemoryByteSource(BYTES) });
}

describe('expandRef over the worker protocol', () => {
  it('round-trips: the target comes back cloned, and the worker tree can then locate nodes inside it', async () => {
    const c = client();
    await c.open(null, 'x.bin');
    const snap = (await c.parse('refs'))!;
    const ptr = find(snap.root, 'ptr');
    expect(ptr.ref).toEqual({ typeName: 'blob', offset: 6 });

    const res = await c.expandRef(ptr.id);
    expect(res.nodes).toHaveLength(1);
    expect(res.nodes[0]).toMatchObject({ typeName: 'blob', offset: 6, size: 2 });
    expect(find(res.nodes[0]!, 'next').value).toBe(0xb1);
    expect(res.newErrors).toEqual([]);
    // the client's tree copy is separate (structured clone): the caller attaches the nodes itself
    expect(ptr.children).toBeUndefined();

    // the worker attached the subtree: a hex click at offset 7 resolves through the ref node
    const loc = await c.nodeAt(7);
    expect(loc.path).not.toBeNull();
    expect(loc.path!.slice(0, 2)).toEqual([snap.root.id, ptr.id]);
    expect(loc.path![loc.path!.length - 1]).toBe(res.nodes[0]!.children![1]!.id);
    // ranges see the expanded subtree too
    const segs = await c.ranges(6, 8);
    expect(segs.map((s) => [s.start, s.end])).toEqual([[6, 7], [7, 8]]);

    // opening twice returns the same nodes
    const again = await c.expandRef(ptr.id);
    expect(again.nodes[0]!.id).toBe(res.nodes[0]!.id);
  });

  it('nested refs are not followed: the new ref nodes are only opened on request', async () => {
    const c = client();
    await c.open(null, 'x.bin');
    const snap = (await c.parse('refs'))!;
    const res = await c.expandRef(find(snap.root, 'ptr').id);
    const next = find(res.nodes[0]!, 'next');
    expect(next.ref).toEqual({ typeName: 'blob', offset: 0 });
    expect(next.children).toBeUndefined();
    const inner = await c.expandRef(next.id);
    expect(inner.nodes[0]).toMatchObject({ typeName: 'blob', offset: 0 });
  });

  it('two concurrent expandRef calls on the same node share one expansion', async () => {
    const c = client();
    await c.open(null, 'x.bin');
    const snap = (await c.parse('refs'))!;
    const id = find(snap.root, 'ptr').id;
    const [a, b] = await Promise.all([c.expandRef(id), c.expandRef(id)]);
    expect(a.nodes).toHaveLength(1);
    expect(a.nodes[0]!.id).toBe(b.nodes[0]!.id);
    // the worker tree holds exactly one attached target
    const loc = await c.nodeAt(7);
    expect(loc.path!.filter((x) => x === a.nodes[0]!.id)).toHaveLength(1);
  });

  it('bad requests answer with errors; a re-parse supersedes a pending expandRef', async () => {
    const c = client();
    await expect(c.expandRef(1)).rejects.toThrow(/no parse result/);
    await c.open(null, 'x.bin');
    const snap = (await c.parse('refs'))!;
    await expect(c.expandRef(-1)).rejects.toThrow(/invalid reference/);
    const res = await c.expandRef(123456);
    expect(res.nodes).toEqual([]);
    expect(res.newErrors.map((e) => e.code)).toEqual(['ref']);

    const pending = c.expandRef(find(snap.root, 'ptr').id);
    const reparse = c.parse('refs');
    await expect(pending).rejects.toBeInstanceOf(SupersededError);
    await reparse;
    // ids of the old tree are gone with it
    const fresh = (await c.parse('refs'))!;
    expect((await c.expandRef(find(fresh.root, 'ptr').id)).nodes).toHaveLength(1);
  });
});
