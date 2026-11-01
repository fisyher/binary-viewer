/**
 * Folder sync via the File System Access API (Chromium only, feature-detected). The user picks a folder once; the
 * handle is persisted in the spec store and permission is re-requested on a click after a reload.
 *
 * Everything read from the folder is untrusted. File names are never used to build paths: names handed to the
 * File System Access API must match `SAFE_FILE_RE` (no separators), and new files are only ever `<id>.json` where
 * `id` passed `isUserId`.
 */
import type { SpecStore } from './spec-store';

/** Ids of user specs. Lower-case only so that `<id>.json` is unique on case-insensitive file systems. */
export const USER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Exact reserved Windows device names (they cannot be file names there, with or without an extension). */
const RESERVED_IDS = new Set(['con', 'prn', 'aux', 'nul', ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);

/** True for ids that are safe to use for a user spec and its `<id>.json` file: matches USER_ID_RE and is not a reserved Windows device name. Accepts `unknown` (it is used on data from files). */
export function isUserId(id: unknown): id is string {
  return typeof id === 'string' && USER_ID_RE.test(id) && !RESERVED_IDS.has(id);
}

/** File names the app is willing to pass to getFileHandle/removeEntry. No path separators possible. */
// Lower-case ".json" only: a ".JSON" file in the folder is listed in `names` but skipped as an unsupported name.
export const SAFE_FILE_RE = /^[A-Za-z0-9._-]{1,128}\.json$/;
/** Largest spec file read or written (UTF-8 bytes), same as the validator's default `maxSpecBytes`. */
export const MAX_SPEC_FILE_BYTES = 1_048_576;
/** Most `.json` files `readAll` examines before it stops and reports `truncated`. */
export const MAX_FOLDER_FILES = 500;

/** True when `text` certainly needs more than `cap` UTF-8 bytes, without encoding unless the answer is unclear. */
export function exceedsBytes(text: string, cap = MAX_SPEC_FILE_BYTES): boolean {
  if (text.length > cap) return true; // a UTF-16 unit takes at least one byte
  if (text.length * 3 <= cap) return false; // and at most three
  return new TextEncoder().encode(text).length > cap;
}

/** The only way a NEW file name is derived from data: from a validated id. Throws (Error) for an id that fails `isUserId`. */
export function specFileName(id: string): string {
  if (!isUserId(id)) throw new Error(`unsafe spec id for a file name: ${JSON.stringify(String(id).slice(0, 40))}`);
  return `${id}.json`;
}

function checkFileName(name: string): string {
  if (typeof name !== 'string' || !SAFE_FILE_RE.test(name)) throw new Error(`unsafe file name: ${JSON.stringify(String(name).slice(0, 40))}`);
  return name;
}

/** A file system call did not answer in time (e.g. a network drive went away). */
export class FolderTimeoutError extends Error {
  constructor(what: string) {
    super('the folder did not respond (' + what + ')');
    this.name = 'FolderTimeoutError';
  }
}

/** Default per-call timeout (ms) for file system calls. */
export const FS_TIMEOUT_MS = 30_000;

/**
 * Errors that mean "stop touching the folder": the permission was taken away, or the folder stopped answering.
 * Callers treat both the same way: abort, write nothing more, and mark the folder as needing a reconnect.
 */
export function isPermissionError(e: unknown): boolean {
  if (e instanceof FolderTimeoutError) return true;
  return e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
}

/** True when the text contains an unpaired UTF-16 surrogate (it cannot be written to a file faithfully). */
export function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
      else return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

// Minimal structural types of the parts of the File System Access API we use (so tests can mock them).
/** Writes a whole text file; `close()` commits it. `abort()` (optional) discards the pending write. */
export interface FsWritable {
  write(data: string): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}
export interface FsFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<{ size: number; lastModified: number; text(): Promise<string> }>;
  createWritable(): Promise<FsWritable>;
}
export interface FsDirHandle {
  readonly kind: 'directory';
  readonly name: string;
  values(): AsyncIterable<{ kind: string; name: string }>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle>;
  removeEntry(name: string): Promise<void>;
  queryPermission(desc: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(desc: { mode: 'readwrite' }): Promise<PermissionState>;
}

/**
 * `unsupported`: no directory picker in this browser. `none`: supported, nothing connected. `connected`: usable.
 * `needs-permission`: a handle is remembered but readwrite permission must be re-granted from a click (`reconnect`).
 */
export type FolderState = 'unsupported' | 'none' | 'connected' | 'needs-permission';

/** A spec file that was read in full. */
export interface FolderFile {
  /** File name in the folder (always matches SAFE_FILE_RE). */
  fileName: string;
  /** Raw file text, untrusted: validate before use. */
  text: string;
  /** Epoch milliseconds (0 if the browser gave no usable value). */
  lastModified: number;
}
/** A `.json` file that was seen but not read, with a human-readable reason. */
export interface SkippedFile {
  fileName: string;
  reason: string;
}
/** Outcome of `readAll`. */
export interface FolderReadResult {
  files: FolderFile[];
  skipped: SkippedFile[];
  /** Every `.json` file name seen (readable or not), so callers never create or overwrite one by accident. */
  names: string[];
  /** The folder has more than MAX_FOLDER_FILES `.json` files: what was read is NOT the whole folder. */
  truncated: boolean;
}

const HANDLE_KEY = 'folderHandle';
const PERM = { mode: 'readwrite' } as const;

export interface FolderSyncOptions {
  store: SpecStore;
  /** Directory picker; defaults to `window.showDirectoryPicker` when present. Undefined = unsupported. */
  picker?: (() => Promise<FsDirHandle>) | undefined;
  /** Per file-system-call timeout (default 30 s). */
  timeoutMs?: number;
}

/** The browser's `showDirectoryPicker` (readwrite) wrapped as a callable, or undefined where it is missing (non-Chromium, or no window). */
export function defaultPicker(): (() => Promise<FsDirHandle>) | undefined {
  const w = typeof window === 'undefined' ? undefined : (window as unknown as { showDirectoryPicker?: (o: object) => Promise<FsDirHandle> });
  const fn = w?.showDirectoryPicker;
  return typeof fn === 'function' ? () => fn.call(w, { mode: 'readwrite' }) : undefined;
}

function isDirHandle(v: unknown): v is FsDirHandle {
  const o = v as Partial<FsDirHandle> | null;
  return typeof o === 'object' && o !== null && o.kind === 'directory' && typeof o.values === 'function' && typeof o.getFileHandle === 'function' && typeof o.queryPermission === 'function';
}

/**
 * One synced folder of spec files. Main thread only (needs user gestures and the File System Access API). Every file
 * system call is bounded by a timeout and every file name is validated. Methods other than restore/connect/reconnect/
 * disconnect throw if the state is not `connected`. `state` is a plain field read by the UI; it changes only through the
 * methods here (and `markPermissionLost`).
 */
export class FolderSync {
  private handle: FsDirHandle | null = null;
  private readonly store: SpecStore;
  private readonly picker: (() => Promise<FsDirHandle>) | undefined;
  private readonly timeoutMs: number;
  state: FolderState;

  constructor(opts: FolderSyncOptions) {
    this.store = opts.store;
    this.picker = opts.picker;
    this.timeoutMs = opts.timeoutMs ?? FS_TIMEOUT_MS;
    this.state = this.picker ? 'none' : 'unsupported';
  }

  /** The connected folder's display name (not a path), or null. */
  get name(): string | null {
    return this.handle?.name ?? null;
  }

  /** Whether this browser can pick a folder at all. */
  get supported(): boolean {
    return this.picker !== undefined;
  }

  /** Race a file system call against the timeout, so a hung drive cannot hold the library's queue forever. */
  private fs<T>(what: string, p: Promise<T>, onLate?: (value: T) => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new FolderTimeoutError(what));
      }, this.timeoutMs);
    });
    // A call that timed out is NOT cancelled: the browser may still complete it later. `onLate` lets the caller
    // abandon a result that arrives after we gave up (e.g. abort a writable), and callers of write() treat a
    // timed-out write as "unknown outcome" (see SpecLibrary: the whole folder goes into verify mode).
    if (onLate) p.then((v) => timedOut && onLate(v), () => {});
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  /** Load the persisted handle and query (never request) its permission. Never throws; any failure leaves state `none`. Needs no user gesture. */
  async restore(): Promise<void> {
    if (!this.picker) return;
    try {
      const h = await this.store.getMeta(HANDLE_KEY);
      if (!isDirHandle(h)) return;
      this.handle = h;
      this.state = (await h.queryPermission(PERM)) === 'granted' ? 'connected' : 'needs-permission';
    } catch {
      this.handle = null;
      this.state = 'none';
    }
  }

  /** Show the picker (needs a user gesture). Resolves false if the user cancelled. Throws on any other failure. The new handle is remembered in the store on a best-effort basis. */
  async connect(): Promise<boolean> {
    if (!this.picker) throw new Error('Folder sync is not supported in this browser');
    let h: FsDirHandle;
    try {
      h = await this.picker();
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return false;
      throw e;
    }
    if (!isDirHandle(h)) throw new Error('The browser returned an unusable folder handle');
    this.handle = h;
    this.state = 'connected';
    try {
      await this.store.setMeta(HANDLE_KEY, h);
    } catch {
      /* the connection works for this session even if it cannot be remembered */
    }
    return true;
  }

  /** Ask for permission again (must be called from a click). Resolves true when granted. */
  async reconnect(): Promise<boolean> {
    if (!this.handle) return false;
    try {
      if ((await this.handle.requestPermission(PERM)) === 'granted') {
        this.state = 'connected';
        return true;
      }
    } catch {
      /* fall through */
    }
    this.state = 'needs-permission';
    return false;
  }

  /** Forget the folder. Files in it are untouched. Never throws. */
  async disconnect(): Promise<void> {
    this.handle = null;
    this.state = this.picker ? 'none' : 'unsupported';
    try {
      await this.store.removeMeta(HANDLE_KEY);
    } catch {
      /* ignore */
    }
  }

  /** Call when an operation hit a permission error: connected -> needs-permission. No-op otherwise. */
  markPermissionLost(): void {
    if (this.handle && this.state === 'connected') this.state = 'needs-permission';
  }

  /**
   * Read every `*.json` file of the folder (not recursive), at most `MAX_FOLDER_FILES`, none larger than
   * `MAX_SPEC_FILE_BYTES`. Per-file failures are reported, never thrown, EXCEPT permission errors (incl. timeouts):
   * those abort the whole read (the caller must not act on a half-read folder). File names that fail SAFE_FILE_RE are
   * listed in `names` and `skipped` but never opened.
   */
  async readAll(): Promise<FolderReadResult> {
    const h = this.requireConnected();
    const files: FolderFile[] = [];
    const skipped: SkippedFile[] = [];
    const names: string[] = [];
    let seen = 0;
    let truncated = false;
    const it = h.values()[Symbol.asyncIterator]();
    for (;;) {
      const step = await this.fs('listing the folder', it.next());
      if (step.done) break;
      const entry = step.value;
      if (entry.kind !== 'file' || typeof entry.name !== 'string' || !/\.json$/i.test(entry.name)) continue;
      if (++seen > MAX_FOLDER_FILES) {
        skipped.push({ fileName: '(remaining files)', reason: `more than ${MAX_FOLDER_FILES} .json files; the rest were ignored` });
        truncated = true;
        break;
      }
      names.push(entry.name);
      if (!SAFE_FILE_RE.test(entry.name)) {
        skipped.push({ fileName: entry.name, reason: 'unsupported file name (use letters, digits, ".", "_" and "-")' });
        continue;
      }
      try {
        const fh = await this.fs('opening ' + entry.name, h.getFileHandle(entry.name));
        const f = await this.fs('reading ' + entry.name, fh.getFile());
        if (f.size > MAX_SPEC_FILE_BYTES) {
          skipped.push({ fileName: entry.name, reason: `too large (${f.size} > ${MAX_SPEC_FILE_BYTES} bytes)` });
          continue;
        }
        files.push({ fileName: entry.name, text: await this.fs('reading ' + entry.name, f.text()), lastModified: Number.isFinite(f.lastModified) ? f.lastModified : 0 });
      } catch (e) {
        if (isPermissionError(e)) throw e;
        skipped.push({ fileName: entry.name, reason: `unreadable (${e instanceof Error ? e.message : String(e)})` });
      }
    }
    return { files, skipped, names, truncated };
  }

  /** Read one file by name (checked against SAFE_FILE_RE, else throws). Null when it does not exist; throws when it is too large or unreadable. */
  async readOne(fileName: string): Promise<{ text: string; lastModified: number } | null> {
    const name = checkFileName(fileName);
    const h = this.requireConnected();
    let f;
    try {
      f = await this.fs('opening ' + name, h.getFileHandle(name).then((fh) => fh.getFile()));
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotFoundError') return null;
      throw e;
    }
    if (f.size > MAX_SPEC_FILE_BYTES) throw new Error(`${name} is too large to verify`);
    return { text: await this.fs('reading ' + name, f.text()), lastModified: f.lastModified };
  }

  /**
   * Write `fileName` (default `<id>.json`) with the whole `text`, replacing the file. Throws for an unsafe id or name, or when the write fails. If this call
   * had to create the file and the write then fails, the empty file it created is removed again, so a failed first
   * write never leaves a permanent empty `<id>.json` behind.
   */
  async write(id: string, text: string, fileName?: string): Promise<void> {
    const name = fileName === undefined ? specFileName(id) : checkFileName(fileName);
    const h = this.requireConnected();
    let created = false;
    let fh: FsFileHandle;
    try {
      fh = await this.fs('opening ' + name, h.getFileHandle(name));
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
      created = true;
      fh = await this.fs('creating ' + name, h.getFileHandle(name, { create: true }));
    }
    // After a TIMEOUT nothing further is awaited: the folder is not answering, so cleanup is fire-and-forget
    // (an empty leftover file is harmless: an empty file of unknown origin is treated as free to fill).
    // After any other failure, cleanup is awaited but time-limited too, so it can never stall the caller's queue.
    let w: FsWritable | undefined;
    try {
      w = await this.fs('writing ' + name, fh.createWritable(), (late) => void Promise.resolve(late.abort?.()).catch(() => {}));
      await this.fs('writing ' + name, w.write(text));
      await this.fs('writing ' + name, w.close());
    } catch (e) {
      const abort = w ? Promise.resolve(w.abort?.()) : Promise.resolve();
      if (e instanceof FolderTimeoutError) {
        void abort.catch(() => {});
      } else {
        await this.fs('aborting ' + name, abort).catch(() => {});
        if (created) await this.fs('removing ' + name, h.removeEntry(name)).catch(() => {});
      }
      throw e;
    }
  }

  /** Remove a file by name (checked against SAFE_FILE_RE, else throws); a file that does not exist is fine. */
  async remove(fileName: string): Promise<void> {
    const name = checkFileName(fileName);
    const h = this.requireConnected();
    try {
      await this.fs('removing ' + name, h.removeEntry(name));
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotFoundError') return;
      throw e;
    }
  }

  private requireConnected(): FsDirHandle {
    if (!this.handle || this.state !== 'connected') throw new Error('Folder is not connected');
    return this.handle;
  }
}
