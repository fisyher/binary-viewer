import { describe, expect, it } from 'vitest';
import { MemoryByteSource } from '../core/byte-source';
import * as realEngine from '../core/engine';
import { le16, le32 } from '../core/engine/test-helpers';
import { EngineFatalError, SupersededError, createClient, type Transport } from './engine-client';
import { createInlineClient } from './inline-client';
import type { EngineRequest, EngineResponse } from './protocol';

function manualTransport() {
  const sent: EngineRequest[] = [];
  let deliver!: (r: EngineResponse) => void;
  let fail!: (m: string) => void;
  const closed = { count: 0 };
  const t: Transport = {
    post: (r) => sent.push(r),
    onMessage: (cb) => (deliver = cb),
    onError: (cb) => (fail = cb),
    close: () => void closed.count++,
  };
  return { t, sent, closed, deliver: (r: EngineResponse) => deliver(r), fail: (m: string) => fail(m) };
}

describe('engine client', () => {
  it('assigns increasing request ids and routes responses by id', async () => {
    const { t, sent, deliver } = manualTransport();
    const c = createClient(t);
    const a = c.nodeAt(1);
    const b = c.nodeAt(2);
    expect(sent.map((r) => r.id)).toEqual([1, 2]);
    deliver({ id: 2, type: 'located', path: [9], lazyIndex: null });
    deliver({ id: 1, type: 'located', path: [7], lazyIndex: 3 });
    expect(await a).toEqual({ path: [7], lazyIndex: 3 });
    expect(await b).toEqual({ path: [9], lazyIndex: null });
  });

  it('a new parse rejects the old one with SupersededError and ignores its late response', async () => {
    const { t, deliver } = manualTransport();
    const c = createClient(t);
    const old = c.parse('bmp');
    const oldAssert = expect(old).rejects.toBeInstanceOf(SupersededError);
    const fresh = c.parse('bmp');
    await oldAssert;
    deliver({ id: 1, type: 'parse', snapshot: null }); // stale: dropped
    deliver({ id: 2, type: 'parse', snapshot: null });
    expect(await fresh).toBeNull();
  });

  it('a new open rejects every pending request', async () => {
    const { t } = manualTransport();
    const c = createClient(t);
    const p = c.ranges(0, 10);
    const check = expect(p).rejects.toBeInstanceOf(SupersededError);
    void c.open(null, 'x');
    await check;
  });

  it('overview does not supersede anything; a new parse rejects a pending one', async () => {
    const { t, sent, deliver } = manualTransport();
    const c = createClient(t);
    const parse = c.parse('bmp');
    const ov = c.overview(300);
    expect(sent.map((r) => r.type)).toEqual(['parse', 'overview']);
    expect(sent[1]).toMatchObject({ type: 'overview', buckets: 300 });
    deliver({ id: 2, type: 'overview', size: 99, buckets: Uint8Array.of(0, 1, 2), regions: [{ start: 0, end: 5, group: 1, name: 'header' }], truncated: false });
    expect(await ov).toEqual({ size: 99, buckets: Uint8Array.of(0, 1, 2), regions: [{ start: 0, end: 5, group: 1, name: 'header' }], truncated: false });
    deliver({ id: 1, type: 'parse', snapshot: null });
    expect(await parse).toBeNull(); // the overview request did not supersede the parse
    const late = c.overview(16);
    const check = expect(late).rejects.toBeInstanceOf(SupersededError);
    void c.parse('bmp');
    await check;
  });

  it('overview round-trips through the inline client (structured clone both ways)', async () => {
    const c = createInlineClient({ makeSource: () => new MemoryByteSource(new Uint8Array(64)) });
    await c.open(null, 'a.bin');
    await expect(c.overview(16)).rejects.toThrow('no parse result'); // nothing parsed yet
    await c.parse('bmp');
    const after = await c.overview(16);
    expect(after.size).toBe(64);
    expect(after.buckets).toBeInstanceOf(Uint8Array);
    expect(after.regions).toEqual(expect.any(Array));
    c.dispose();
  });

  it('a parse supersedes a pending open: open rejects instead of hanging', async () => {
    const { t, deliver } = manualTransport();
    const c = createClient(t);
    const open = c.open(null, 'x');
    const check = expect(open).rejects.toBeInstanceOf(SupersededError);
    const parse = c.parse('bmp');
    await check;
    deliver({ id: 2, type: 'parse', snapshot: null });
    expect(await parse).toBeNull();
  });

  it('a fatal error before any request is latched: later requests reject at once and onFatal fires', async () => {
    const { t, sent, fail } = manualTransport();
    const c = createClient(t);
    fail('script failed to load');
    const seen: string[] = [];
    c.onFatal((m) => seen.push(m)); // registered late: still delivered
    await expect(c.open(null, 'x')).rejects.toBeInstanceOf(EngineFatalError);
    await expect(c.parse('bmp')).rejects.toThrow('script failed to load');
    expect(sent).toEqual([]);
    expect(seen).toEqual(['script failed to load']);
  });

  it('a fatal error rejects everything pending', async () => {
    const { t, fail } = manualTransport();
    const c = createClient(t);
    const p = c.nodeAt(1);
    const check = expect(p).rejects.toBeInstanceOf(EngineFatalError);
    fail('boom');
    await check;
  });

  it('error responses reject with the message', async () => {
    const { t, deliver } = manualTransport();
    const c = createClient(t);
    const p = c.expand(1, 0, 10);
    deliver({ id: 1, type: 'error', message: 'boom' });
    await expect(p).rejects.toThrow('boom');
  });

  it('dispose rejects everything pending with SupersededError and closes the transport once', async () => {
    const { t, closed } = manualTransport();
    const c = createClient(t);
    const checks = [c.open(null, 'x'), c.setSpecs([]), c.nodeAt(1), c.expandRef(3)].map((p) => expect(p).rejects.toBeInstanceOf(SupersededError));
    c.dispose();
    await Promise.all(checks);
    c.dispose(); // idempotent
    expect(closed.count).toBe(1);
  });

  it('requests after dispose reject at once with SupersededError and post nothing', async () => {
    const { t, sent, deliver } = manualTransport();
    const c = createClient(t);
    c.dispose();
    await expect(c.open(null, 'x')).rejects.toBeInstanceOf(SupersededError);
    await expect(c.parse('bmp')).rejects.toBeInstanceOf(SupersededError);
    await expect(c.parseDraft('{}')).rejects.toBeInstanceOf(SupersededError);
    await expect(c.setSpecs([])).rejects.toBeInstanceOf(SupersededError);
    await expect(c.expand(1, 0, 10)).rejects.toBeInstanceOf(SupersededError);
    await expect(c.nodeAt(1)).rejects.toBeInstanceOf(SupersededError);
    await expect(c.nodeById(1)).rejects.toBeInstanceOf(SupersededError);
    await expect(c.ranges(0, 10)).rejects.toBeInstanceOf(SupersededError);
    expect(() => c.cancel()).not.toThrow();
    expect(sent).toEqual([]);
    deliver({ id: 1, type: 'located', path: [1], lazyIndex: null }); // a late response is ignored
  });

  it('a fatal error still wins over dispose for later requests', async () => {
    const { t, fail } = manualTransport();
    const c = createClient(t);
    fail('boom');
    c.dispose();
    await expect(c.nodeAt(1)).rejects.toBeInstanceOf(EngineFatalError);
  });

  it('inline client runs the real handler end to end with cloned messages', async () => {
    const dib = [...le32(40), ...le32(1), ...le32(1), ...le16(1), ...le16(24), ...le32(0), ...le32(4), ...le32(0), ...le32(0), ...le32(0), ...le32(0)];
    const bytes = Uint8Array.from([0x42, 0x4d, ...le32(58), 0, 0, 0, 0, ...le32(54), ...dib, 1, 2, 3, 0]);
    const c = createInlineClient({ makeSource: () => new MemoryByteSource(bytes), engine: realEngine });
    const o = await c.open(null, 'a.bmp');
    expect(o.detections[0]?.specId).toBe('bmp');
    const snap = await c.parse('bmp');
    expect(snap?.root.children?.[0]?.name).toBe('file_header');
    expect(snap?.stats.aborted).toBe(false);
  });
});
