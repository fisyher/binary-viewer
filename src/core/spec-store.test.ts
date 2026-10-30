import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { DB_NAME, LOAD_FAILED_NOTICE, createIdbStore, createMemoryStore, createResilientStore, type SpecStore } from './spec-store';

describe('IndexedDB store', () => {
  it('persists specs across a reload (a new store over the same database)', async () => {
    const factory = new IDBFactory();
    const a = createIdbStore(factory);
    await a.put({ id: 'one', text: '{"a":1}', updatedAt: 5 });
    await a.put({ id: 'two', text: '{}', updatedAt: 6 });
    await a.remove('two');
    await a.setMeta('k', { hello: 'world' });
    const b = createIdbStore(factory); // "reload": fresh connection object, same data
    expect(await b.loadAll()).toEqual([{ id: 'one', text: '{"a":1}', updatedAt: 5 }]);
    expect(await b.getMeta('k')).toEqual({ hello: 'world' });
    await b.removeMeta('k');
    expect(await b.getMeta('k')).toBeUndefined();
  });

  it('drops malformed records instead of trusting them', async () => {
    const factory = new IDBFactory();
    const s = createIdbStore(factory);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await s.put({ id: 'bad', text: 5, updatedAt: 'x' } as any);
    await s.put({ id: 'ok', text: '{}', updatedAt: 1 });
    expect((await s.loadAll()).map((x) => x.id)).toEqual(['ok']);
  });

  it('rejects when IndexedDB is missing', async () => {
    await expect(createIdbStore(null).loadAll()).rejects.toThrow(/not available/);
  });
});

describe('resilient store', () => {
  const failing = (): SpecStore => {
    const boom = async (): Promise<never> => {
      throw new Error('quota exceeded');
    };
    return { loadAll: boom, put: boom, remove: boom, getMeta: boom, setMeta: boom, removeMeta: boom };
  };

  it('falls back to memory with a notice when IndexedDB throws', async () => {
    const onNotice = vi.fn();
    const s = createResilientStore(failing(), onNotice);
    expect(s.notice).toBeNull();
    expect(await s.loadAll()).toEqual([]);
    expect(onNotice).toHaveBeenCalledOnce();
    expect(s.notice).toBe(LOAD_FAILED_NOTICE);
    await s.put({ id: 'x', text: '{}', updatedAt: 1 });
    expect(await s.loadAll()).toEqual([{ id: 'x', text: '{}', updatedAt: 1 }]);
    await s.setMeta('m', 1);
    expect(await s.getMeta('m')).toBe(1);
    expect(onNotice).toHaveBeenCalledOnce(); // only the first failure raises the notice
  });

  it('retries the failing call against memory, and keeps using the primary while it works', async () => {
    const primary = createMemoryStore();
    const s = createResilientStore(primary);
    await s.put({ id: 'a', text: '{}', updatedAt: 1 });
    expect(await primary.loadAll()).toHaveLength(1);
    expect(s.notice).toBeNull();
    primary.put = async () => {
      throw new Error('disk full');
    };
    await s.put({ id: 'b', text: '{}', updatedAt: 2 }); // does not throw
    expect(s.notice).toMatch(/disk full/);
    expect((await s.loadAll()).map((x) => x.id)).toEqual(['b']);
  });
});

describe('IndexedDB connection hygiene', () => {
  it('closes its connection when another tab upgrades the database, so the upgrade is not blocked', async () => {
    const factory = new IDBFactory();
    const s = createIdbStore(factory);
    await s.put({ id: 'a', text: '{}', updatedAt: 1 });
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, 2);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked: our connection stayed open'));
    });
    expect(upgraded.version).toBe(2);
    upgraded.close();
  });

  it('a failing request does not leave an unhandled rejection behind', async () => {
    const factory = new IDBFactory();
    const s = createIdbStore(factory);
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    const proc = (globalThis as unknown as { process: { on(e: string, f: (x: unknown) => void): void; off(e: string, f: (x: unknown) => void): void } }).process;
    proc.on('unhandledRejection', onUnhandled);
    // A key that IndexedDB rejects (not a valid key) makes the request fail before the transaction completes.
    await expect(s.getMeta({} as unknown as string)).rejects.toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    proc.off('unhandledRejection', onUnhandled);
    expect(seen).toEqual([]);
  });
});
