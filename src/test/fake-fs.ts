import type { FsDirHandle, FsFileHandle } from '../core/spec-folder';

export interface FakeFile {
  text: string;
  lastModified: number;
  /** Override the reported size (to simulate huge files without allocating them). */
  size?: number;
  failRead?: boolean;
}

/** In-memory stand-in for a FileSystemDirectoryHandle. Records writes and removals. */
export function fakeDir(files: Record<string, FakeFile> = {}, opts: { permission?: PermissionState; name?: string } = {}) {
  const store = new Map(Object.entries(files));
  const log: string[] = [];
  const state = { permission: opts.permission ?? 'granted', requested: 0, writeError: null as Error | null, gate: null as Promise<void> | null, attempts: 0, hang: false, hangWrite: false, hangAbort: false, hangRemove: false, abortIgnored: false, holdClose: null as Promise<void> | null, readError: null as Error | null };
  let clock = 1_000_000;
  const fileHandle = (name: string): FsFileHandle => ({
    kind: 'file',
    name,
    async getFile() {
      const f = store.get(name);
      if (!f) throw new DOMException('gone', 'NotFoundError');
      if (f.failRead) throw new Error('read failed');
      if (state.readError && state.readError.name === 'NotAllowedError') throw state.readError;
      return { size: f.size ?? f.text.length, lastModified: f.lastModified, text: async () => f.text };
    },
    async createWritable() {
      state.attempts++;
      if (state.writeError) throw state.writeError;
      let buf = '';
      let aborted = false;
      return {
        write: async (d: string) => {
          if (state.hangWrite) return new Promise<void>(() => {});
          buf += d;
        },
        close: async () => {
          if (state.holdClose) await state.holdClose; // the write completes late, after callers gave up
          if (aborted) return;
          store.set(name, { text: buf, lastModified: ++clock });
          log.push(`write:${name}`);
        },
        abort: async () => {
          if (state.hangAbort) return new Promise<void>(() => {});
          if (!state.abortIgnored) aborted = true;
        },
      };
    },
  });
  const dir: FsDirHandle = {
    kind: 'directory',
    name: opts.name ?? 'specs',
    async *values() {
      if (state.gate) await state.gate;
      for (const name of [...store.keys()]) yield { kind: 'file', name };
      yield { kind: 'directory', name: 'sub.json' }; // directories are ignored even if named like a spec
    },
    async getFileHandle(name, o) {
      if (state.hang) return new Promise<FsFileHandle>(() => {});
      if (!store.has(name)) {
        if (!o?.create) throw new DOMException('missing', 'NotFoundError');
        store.set(name, { text: '', lastModified: ++clock });
      }
      return fileHandle(name);
    },
    async removeEntry(name) {
      if (state.hangRemove) return new Promise<void>(() => {});
      if (!store.has(name)) throw new DOMException('missing', 'NotFoundError');
      store.delete(name);
      log.push(`remove:${name}`);
    },
    async queryPermission() {
      return state.permission;
    },
    async requestPermission() {
      state.requested++;
      return state.permission;
    },
  };
  return { dir, files: store, log, state };
}
