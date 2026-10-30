/**
 * Persistent storage for the user's format specs. IndexedDB is the primary store; every access is wrapped so that a
 * failure (private mode, quota, blocked, no IndexedDB at all) switches to an in-memory store and raises a notice
 * instead of breaking the app. Nothing here trusts what it reads back: callers re-validate spec text.
 */

export interface StoredSpec {
  id: string;
  /** Raw JSON text, exactly as the user wrote it. */
  text: string;
  /** Epoch milliseconds of the last save. */
  updatedAt: number;
}

/** What the library needs from storage. `meta` holds small values such as the folder handle. */
export interface SpecStore {
  loadAll(): Promise<StoredSpec[]>;
  put(spec: StoredSpec): Promise<void>;
  remove(id: string): Promise<void>;
  getMeta(key: string): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;
  removeMeta(key: string): Promise<void>;
}

export function createMemoryStore(): SpecStore {
  const specs = new Map<string, StoredSpec>();
  const meta = new Map<string, unknown>();
  return {
    loadAll: async () => [...specs.values()].map((s) => ({ ...s })),
    put: async (s) => void specs.set(s.id, { ...s }),
    remove: async (id) => void specs.delete(id),
    getMeta: async (key) => meta.get(key),
    setMeta: async (key, value) => void meta.set(key, value),
    removeMeta: async (key) => void meta.delete(key),
  };
}

export const DB_NAME = 'binary-viewer';
const SPEC_STORE = 'specs';
const META_STORE = 'meta';

const request = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });

const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });

/** Shape check for a record read back from disk. */
function asStoredSpec(v: unknown): StoredSpec | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.text !== 'string' || typeof o.updatedAt !== 'number' || !Number.isFinite(o.updatedAt)) return null;
  return { id: o.id, text: o.text, updatedAt: o.updatedAt };
}

/**
 * Raw IndexedDB store. Methods throw on failure; wrap with `createResilientStore`.
 *
 * Schema migration: the database is version 1 (stores `specs` and `meta`). A future version must be handled in
 * `onupgradeneeded` by creating or reshaping stores based on `event.oldVersion` (never by deleting user data), and
 * records are shape-checked on read (`asStoredSpec`), so older or newer record shapes degrade to "ignored", not a crash.
 * Another tab that upgrades the database triggers `onversionchange`, where we close our connection so it can proceed.
 */
export function createIdbStore(factory: IDBFactory | null = typeof indexedDB === 'undefined' ? null : indexedDB): SpecStore {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (!factory) return Promise.reject(new Error('IndexedDB is not available'));
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      let settled = false;
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore(SPEC_STORE, { keyPath: 'id' });
        db.createObjectStore(META_STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        if (settled) return void db.close(); // we already gave up (blocked): do not leak the late connection
        settled = true;
        db.onversionchange = () => {
          db.close();
          dbPromise = null; // the next call reopens
        };
        resolve(db);
      };
      req.onerror = () => {
        settled = true;
        reject(req.error ?? new Error('cannot open IndexedDB'));
      };
      req.onblocked = () => {
        if (settled) return;
        settled = true;
        reject(new Error('IndexedDB is blocked'));
      };
    });
    dbPromise.catch(() => (dbPromise = null)); // allow a retry after a failed open
    return dbPromise;
  };
  async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open();
    const tx = db.transaction(store, mode);
    const done = txDone(tx);
    done.catch(() => {}); // observed below; this only prevents an unhandled rejection if the request fails first
    const r = await request(fn(tx.objectStore(store)));
    await done;
    return r;
  }
  return {
    async loadAll() {
      const all = await run(SPEC_STORE, 'readonly', (s) => s.getAll());
      return all.map(asStoredSpec).filter((s): s is StoredSpec => s !== null);
    },
    put: async (spec) => void (await run(SPEC_STORE, 'readwrite', (s) => s.put(spec))),
    remove: async (id) => void (await run(SPEC_STORE, 'readwrite', (s) => s.delete(id))),
    getMeta: (key) => run(META_STORE, 'readonly', (s) => s.get(key)),
    setMeta: async (key, value) => void (await run(META_STORE, 'readwrite', (s) => s.put(value, key))),
    removeMeta: async (key) => void (await run(META_STORE, 'readwrite', (s) => s.delete(key))),
  };
}

export interface ResilientStore extends SpecStore {
  /** Non-null once the primary store failed and data lives in memory only. */
  readonly notice: string | null;
}

/**
 * Wraps `primary`: the first failure of any call switches permanently to an in-memory store, sets `notice` and calls
 * `onNotice`. The failing call is retried against memory so callers never see storage errors.
 * A failing first `loadAll` is retried once (the open is attempted again) before giving up; in that case the notice
 * says that previously saved formats could not be loaded and that this session's changes will not be saved.
 */
export const LOAD_FAILED_NOTICE = "Saved formats could not be loaded from browser storage; changes this session won't be saved.";
export function createResilientStore(primary: SpecStore, onNotice: (notice: string) => void = () => {}): ResilientStore {
  const memory = createMemoryStore();
  let notice: string | null = null;
  let active: SpecStore = primary;
  function fallBack(message: string): void {
    active = memory;
    notice = message;
    onNotice(message);
  }
  async function call<T>(fn: (s: SpecStore) => Promise<T>): Promise<T> {
    if (active === primary) {
      try {
        return await fn(primary);
      } catch (e) {
        fallBack(`Browser storage is unavailable (${e instanceof Error ? e.message : String(e)}). Custom formats are kept in memory only and will be lost when you close this tab. Use Export or a synced folder to keep them.`);
      }
    }
    return fn(memory);
  }
  return {
    get notice() {
      return notice;
    },
    async loadAll() {
      if (active === primary) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            return await primary.loadAll();
          } catch {
            /* retry once, then fall back */
          }
        }
        fallBack(LOAD_FAILED_NOTICE);
      }
      return memory.loadAll();
    },
    put: (spec) => call((s) => s.put(spec)),
    remove: (id) => call((s) => s.remove(id)),
    getMeta: (key) => call((s) => s.getMeta(key)),
    setMeta: (key, value) => call((s) => s.setMeta(key, value)),
    removeMeta: (key) => call((s) => s.removeMeta(key)),
  };
}

/** The store the app uses: IndexedDB with the memory fallback. */
export function createDefaultStore(onNotice?: (notice: string) => void): ResilientStore {
  let primary: SpecStore;
  try {
    primary = createIdbStore();
  } catch (e) {
    const err = e;
    const failing = async (): Promise<never> => {
      throw err;
    };
    primary = { loadAll: failing, put: failing, remove: failing, getMeta: failing, setMeta: failing, removeMeta: failing };
  }
  return createResilientStore(primary, onNotice);
}
