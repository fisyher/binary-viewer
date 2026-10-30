/**
 * The format library: read-only built-in specs plus the user's own specs.
 *
 * - User specs are kept as raw JSON text so that a half-finished draft can be saved. Each entry is validated on
 *   every change; an invalid draft is flagged and excluded from the specs handed to the engine, and is NEVER
 *   written to the synced folder (drafts live in browser storage only).
 * - Ids are the identity of a user spec and become file names, so they must satisfy `isUserId`, must not equal a
 *   built-in id, and must be unique.
 * - Text from storage, folders and imports is untrusted: size-capped, validated with `loadSpec`, never executed.
 * - Every mutation AND every folder sync runs through one serial queue, so a sync can never resurrect a spec that
 *   was deleted while it was reading, and a slow write cannot overtake a newer one.
 *
 * Folder safety rules (a folder file is only overwritten or deleted when that is certainly safe):
 * - `known` remembers, per id, the file name and content fingerprint at the last successful sync/write. It is
 *   persisted in store meta (and cleared when a different folder is connected or the folder is disconnected).
 * - A spec that was known in the folder but is absent now was removed outside the app: it is flagged
 *   (`removedFromFolder`) and never pushed back; the user chooses Keep (re-write) or Delete locally.
 * - Files skipped while reading (invalid, oversized, unreadable, odd names) are never overwritten, and neither is
 *   any existing file the app has no record of.
 * - A write or delete first re-reads the file and refuses when it changed since the last sync.
 * - When both sides changed since the last sync, the NEWER side stays the spec (an invalid local draft never
 *   wins) and the other side is kept as a local conflict copy `<id>-conflict-<n>`. Nothing is lost, and a
 *   folder file is only replaced after its content was saved as such a copy.
 */
import { generateHtml, generateMarkdown, loadSpec, type FormatSpec, type SpecIssue } from './engine';
import {
  FolderSync,
  MAX_FOLDER_FILES,
  MAX_SPEC_FILE_BYTES,
  SAFE_FILE_RE,
  USER_ID_RE,
  FolderTimeoutError,
  exceedsBytes,
  hasLoneSurrogate,
  isPermissionError,
  isUserId,
  specFileName,
  type FolderState,
  type SkippedFile,
} from './spec-folder';
import type { SpecStore } from './spec-store';
import { rewriteTopLevelStrings } from './spec-text';

export { USER_ID_RE };
export const MAX_IMPORT_FILES = MAX_FOLDER_FILES;
export const MAX_SPEC_BYTES = MAX_SPEC_FILE_BYTES;

export type SpecSource = 'builtin' | 'user';

export interface SpecEntry {
  id: string;
  source: SpecSource;
  /** Raw JSON text (for built-ins: the validated spec, pretty-printed). */
  text: string;
  /** Epoch ms of the last save; null for built-ins. */
  updatedAt: number | null;
  /** Bumped on every change of this entry's text; lets callers detect "this spec changed". */
  rev: number;
  /** Display name (best effort for invalid drafts, falls back to the id). */
  name: string;
  extensions: string[];
  valid: boolean;
  issues: SpecIssue[];
  /** Parsed spec when valid. */
  spec: FormatSpec | null;
  /** A file for this spec is known to exist in the connected folder. */
  inFolder: boolean;
  /** The file was in the folder at the last sync but is gone now (removed outside the app). */
  removedFromFolder: boolean;
  /** Name of a folder file that blocks syncing this spec (not a valid spec, or declares another id); else null. */
  folderBlocked: string | null;
}

export interface FolderStatus {
  supported: boolean;
  state: FolderState;
  name: string | null;
}

export interface LibrarySnapshot {
  entries: SpecEntry[];
  folder: FolderStatus;
  /** Set when storage fell back to memory or could not be loaded. */
  notice: string | null;
  /** Result of the last folder sync / import / failed write, for the status line. */
  message: string | null;
}

export type OpResult = { ok: true; id: string } | { ok: false; error: string };
export type SaveResult = { ok: true; id: string; valid: boolean; issues: SpecIssue[]; renamedFrom?: string } | { ok: false; error: string };

export interface SyncReport {
  added: string[];
  updated: string[];
  /** Local copies written to the folder. */
  pushed: string[];
  skipped: SkippedFile[];
  /** Both sides changed: `copyId` holds the side that lost. */
  conflicts: { id: string; copyId: string }[];
  /** Specs whose file is gone from the folder (not pushed back). */
  removedOutside: string[];
  /** The folder has more than 500 .json files; only the first 500 were read, so nothing was pushed or flagged. */
  truncated: boolean;
  /** This was the verify sync after a timed-out write: number of differing files kept as conflict copies. */
  verified?: { differing: number };
}
export interface ImportReport {
  imported: string[];
  replaced: string[];
  skipped: SkippedFile[];
}

/** What `importFiles` needs from a File. */
export interface ImportFile {
  name: string;
  size: number;
  text(): Promise<string>;
}

export interface LibraryOptions {
  store: SpecStore & { readonly notice?: string | null };
  builtins: readonly FormatSpec[];
  folder?: FolderSync;
  now?: () => number;
}

interface Internal {
  source: SpecSource;
  text: string;
  updatedAt: number | null;
  rev: number;
  name: string;
  extensions: string[];
  valid: boolean;
  issues: SpecIssue[];
  spec: FormatSpec | null;
}

/** What we remember about a spec's file in the folder. */
interface KnownFile {
  fileName: string;
  hash: string;
  syncedAt: number;
}
interface PendingDelete {
  fileName: string;
  hash: string;
}

const KNOWN_KEY = 'folderKnown';
const PENDING_KEY = 'folderPendingDeletes';
const VERIFY_KEY = 'folderNeedsVerify';
const OLD_KEYS = ['folderUntrusted', 'folderSuspect']; // earlier per-id mechanism; ignored and deleted
const TRUNCATED_MSG = "Folder has more than 500 .json files and can't be verified; saves stay local. Reduce the folder or disconnect it.";
const COPY_BLOCKED_MSG = 'Folder verification is incomplete: a differing folder file could not be kept as a local copy (browser storage failed or the copy is too large); saves stay local — free up storage and sync again.';

/** Cheap content fingerprint (FNV-1a over UTF-16 units + length). Used to detect "changed since last sync". */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length}:${h.toString(16)}`;
}

const NEW_SPEC = (id: string, name: string) =>
  JSON.stringify(
    {
      schemaVersion: 1,
      id,
      name,
      endian: 'le',
      extensions: [],
      root: 'root',
      types: { root: { fields: [{ name: 'magic', type: 'u4' }] } },
    },
    null,
    2,
  ) + '\n';

/** `JSON.parse` that never throws; null unless the text is a JSON object. */
function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function declaredId(text: string): string | null {
  const o = !exceedsBytes(text) ? parseObject(text) : null;
  return o && typeof o.id === 'string' ? o.id : null;
}

/** Turn arbitrary text into a safe, unused-looking id candidate. */
export function sanitizeId(base: string): string {
  const s = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 56);
  return s.length > 0 ? s : 'format';
}

const ID_RULES = 'Id must be 1-64 characters: lower-case letters, digits, "_" or "-", starting with a letter or digit, and not a reserved device name (con, prn, aux, nul, com1-9, lpt1-9).';

export class SpecLibrary {
  private readonly store: LibraryOptions['store'];
  private readonly builtins: Map<string, Internal>;
  private readonly builtinOrder: string[];
  private users = new Map<string, Internal>();
  private readonly folderSync: FolderSync | undefined;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private known = new Map<string, KnownFile>();
  private pending = new Map<string, PendingDelete>();
  private removedOutside = new Set<string>();
  private blocked = new Map<string, string>(); // id -> folder file name that stops it from syncing
  // Set when a folder call timed out. A timed-out write may still land later, so after that nothing we remember about
  // the folder can be trusted: `known` is cleared, and the next sync runs in VERIFY MODE (it pushes nothing, deletes
  // nothing, and keeps every differing folder file as a local conflict copy). Persisted, so a reload does not forget.
  // Residual risk, accepted and documented in docs/DESIGN.md: a write that lands AFTER the verify sync.
  private needsVerify = false;
  // Why verification could not finish (kept in state so every message derives from it): the listing was truncated, or
  // a conflict copy could not be saved. Not persisted; the next verify sync recomputes it. Connecting or
  // disconnecting a folder clears the flag altogether: that is the escape hatch for a folder that cannot be verified.
  private verifyBlock: 'truncated' | 'copy' | null = null;
  private message: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private snap: LibrarySnapshot | null = null;
  private revCounter = 0;

  constructor(opts: LibraryOptions) {
    this.store = opts.store;
    this.folderSync = opts.folder;
    this.now = opts.now ?? Date.now;
    this.builtins = new Map();
    this.builtinOrder = [];
    for (const spec of opts.builtins) {
      this.builtinOrder.push(spec.id);
      this.builtins.set(spec.id, {
        source: 'builtin',
        text: JSON.stringify(spec, null, 2) + '\n',
        updatedAt: null,
        rev: 0,
        name: spec.name,
        extensions: spec.extensions ?? [],
        valid: true,
        issues: [],
        spec,
      });
    }
  }

  // ---- reading ----

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    this.snap = null;
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch {
        /* a broken listener must not break the library */
      }
    }
  }

  private toEntry(id: string, e: Internal): SpecEntry {
    const user = e.source === 'user';
    return {
      id,
      ...e,
      inFolder: user && this.known.has(id) && !this.removedOutside.has(id),
      removedFromFolder: user && this.removedOutside.has(id),
      folderBlocked: user ? (this.blocked.get(id) ?? null) : null,
    };
  }

  list(): SpecEntry[] {
    return [
      ...this.builtinOrder.map((id) => this.toEntry(id, this.builtins.get(id)!)),
      ...[...this.users].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, e]) => this.toEntry(id, e)),
    ];
  }

  get(id: string): SpecEntry | undefined {
    const e = this.builtins.get(id) ?? this.users.get(id);
    return e ? this.toEntry(id, e) : undefined;
  }

  snapshot(): LibrarySnapshot {
    return (this.snap ??= {
      entries: this.list(),
      folder: this.folderStatus(),
      notice: this.store.notice ?? null,
      message: this.message,
    });
  }

  private folderStatus(): FolderStatus {
    const f = this.folderSync;
    return f ? { supported: f.supported, state: f.state, name: f.name } : { supported: false, state: 'unsupported', name: null };
  }

  /** Raw texts of the valid user specs, for the engine worker (which validates them again). */
  validUserTexts(): string[] {
    return this.list()
      .filter((e) => e.source === 'user' && e.valid)
      .map((e) => e.text);
  }

  /** `id:rev` of every valid user spec: changes exactly when what the engine would receive changes. */
  validUserKey(): string {
    return this.list()
      .filter((e) => e.source === 'user' && e.valid)
      .map((e) => `${e.id}:${e.rev}`)
      .join(',');
  }

  /** Resolves when all queued work (mutations, writes, syncs) is done. */
  async settled(): Promise<void> {
    await this.chain;
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.chain.then(op, op);
    this.chain = run.catch(() => {});
    return run;
  }

  // ---- validation ----

  private idProblem(id: string, ignore?: string): string | null {
    if (!isUserId(id)) return ID_RULES;
    if (this.builtins.has(id)) return `Id "${id}" is used by a built-in format.`;
    if (id !== ignore && this.users.has(id)) return `Id "${id}" is already used by another format.`;
    return null;
  }

  private analyze(key: string, text: string, source: SpecSource, updatedAt: number | null): Internal {
    const r = loadSpec(text);
    const issues: SpecIssue[] = r.ok ? [] : [...r.errors];
    if (source === 'user' && hasLoneSurrogate(text)) {
      issues.push({ path: '$', message: 'the text contains an unpaired surrogate character (invalid Unicode); remove it' });
    }
    if (source === 'user') {
      const spec = r.ok ? r.spec : null;
      if (spec) {
        if (!isUserId(spec.id)) issues.push({ path: '$.id', message: 'user format ids must be lower-case letters, digits, "_" or "-" (1-64 characters) and not a reserved device name' });
        else if (this.builtins.has(spec.id)) issues.push({ path: '$.id', message: `id "${spec.id}" is used by a built-in format` });
        else if (spec.id !== key) issues.push({ path: '$.id', message: `id must equal "${key}" (this library entry)` });
      } else if (this.builtins.has(key)) {
        issues.push({ path: '$.id', message: `id "${key}" is used by a built-in format` });
      }
    }
    const obj = r.ok ? null : !exceedsBytes(text) ? parseObject(text) : null;
    const name = r.ok ? r.spec.name : obj && typeof obj.name === 'string' && obj.name.trim() ? obj.name.slice(0, 120) : key;
    const extensions = r.ok
      ? (r.spec.extensions ?? [])
      : Array.isArray(obj?.extensions)
        ? (obj.extensions as unknown[]).filter((x): x is string => typeof x === 'string' && x.length <= 16).slice(0, 16)
        : [];
    const valid = issues.length === 0 && r.ok;
    return { source, text, updatedAt, rev: ++this.revCounter, name, extensions, valid, issues, spec: valid && r.ok ? r.spec : null };
  }

  // ---- loading ----

  /** Load user specs from storage, restore the folder connection and sync it. Never throws. */
  async init(): Promise<void> {
    await this.enqueue(async () => {
      let stored: Awaited<ReturnType<SpecStore['loadAll']>> = [];
      try {
        stored = await this.store.loadAll();
      } catch {
        /* the store reports its own failures */
      }
      const dropped: string[] = [];
      for (const s of stored) {
        if (!isUserId(s.id) || typeof s.text !== 'string' || exceedsBytes(s.text)) {
          dropped.push(String(s.id).slice(0, 40));
          continue;
        }
        this.users.set(s.id, this.analyze(s.id, s.text, 'user', s.updatedAt));
      }
      if (dropped.length > 0) this.message = `Ignored ${dropped.length} stored format(s) with an unusable id or size.`;
      await this.loadFolderMeta();
      this.notify();
    });
    const f = this.folderSync;
    if (f) {
      await this.enqueue(async () => {
        await f.restore();
        this.notify();
      });
      if (f.state === 'connected') await this.syncFromFolder();
    }
  }

  private async loadFolderMeta(): Promise<void> {
    try {
      this.needsVerify = (await this.store.getMeta(VERIFY_KEY)) === true; // first, in its own try: it must survive other failures
    } catch {
      /* unknown: stay unflagged */
    }
    try {
      const k = await this.store.getMeta(KNOWN_KEY);
      if (typeof k === 'object' && k !== null) {
        for (const [id, v] of Object.entries(k as Record<string, unknown>)) {
          const o = v as Partial<KnownFile> | null;
          if (isUserId(id) && o && typeof o.fileName === 'string' && SAFE_FILE_RE.test(o.fileName) && typeof o.hash === 'string' && typeof o.syncedAt === 'number') {
            this.known.set(id, { fileName: o.fileName, hash: o.hash, syncedAt: o.syncedAt });
          }
        }
      }
      for (const k of OLD_KEYS) await this.store.removeMeta(k);
      const p = await this.store.getMeta(PENDING_KEY);
      if (typeof p === 'object' && p !== null) {
        for (const [id, v] of Object.entries(p as Record<string, unknown>)) {
          const o = v as Partial<PendingDelete> | null;
          if (isUserId(id) && o && typeof o.fileName === 'string' && SAFE_FILE_RE.test(o.fileName) && typeof o.hash === 'string') this.pending.set(id, { fileName: o.fileName, hash: o.hash });
        }
      }
    } catch {
      /* no remembered folder state: the next sync starts from scratch */
    }
  }

  private async saveFolderMeta(): Promise<void> {
    try {
      await this.store.setMeta(VERIFY_KEY, this.needsVerify); // first: the most important bit to persist
    } catch {
      /* ignore */
    }
    try {
      await this.store.setMeta(KNOWN_KEY, Object.fromEntries(this.known));
      await this.store.setMeta(PENDING_KEY, Object.fromEntries(this.pending));
    } catch {
      /* ignore: worst case the next sync re-learns it */
    }
  }

  // ---- editing (all through the queue) ----

  private uniqueId(base: string): string {
    const root = sanitizeId(base);
    let id = root;
    for (let n = 2; this.idProblem(id) !== null; n++) id = `${root.slice(0, 60)}-${n}`;
    return id;
  }

  create(id?: string, name = 'New format'): Promise<OpResult> {
    return this.enqueue(async () => {
      if (id !== undefined) {
        const p = this.idProblem(id);
        if (p) return { ok: false, error: p } as const;
      }
      const newId = id ?? this.uniqueId('new-format');
      this.users.set(newId, this.analyze(newId, NEW_SPEC(newId, name), 'user', this.now()));
      this.pending.delete(newId);
      this.notify();
      await this.persistNow(newId);
      return { ok: true, id: newId } as const;
    });
  }

  duplicate(id: string): Promise<OpResult> {
    return this.enqueue(async () => {
      const src = this.builtins.get(id) ?? this.users.get(id);
      if (!src) return { ok: false, error: `Unknown format "${id}".` } as const;
      const newId = this.uniqueId(`${id}-copy`);
      const obj = parseObject(src.text);
      let text = src.text;
      if (obj) {
        obj.id = newId;
        if (typeof obj.name === 'string') obj.name = `${obj.name} (copy)`;
        text = JSON.stringify(obj, null, 2) + '\n';
      }
      this.users.set(newId, this.analyze(newId, text, 'user', this.now()));
      this.pending.delete(newId);
      this.notify();
      await this.persistNow(newId);
      return { ok: true, id: newId } as const;
    });
  }

  /**
   * Save the text of user spec `id`. Invalid specs are saved as drafts (flagged, not used for detection, never
   * written to the folder). If the text declares a different valid id, the spec is renamed to it.
   */
  save(id: string, text: string): Promise<SaveResult> {
    return this.enqueue(async (): Promise<SaveResult> => {
      const cur = this.users.get(id);
      if (!cur) return { ok: false, error: this.builtins.has(id) ? 'Built-in formats are read-only. Duplicate one to edit it.' : `Unknown format "${id}".` };
      if (typeof text !== 'string') return { ok: false, error: 'Spec text must be a string.' };
      if (exceedsBytes(text)) return { ok: false, error: `Spec is too large (limit ${MAX_SPEC_BYTES} bytes).` };
      if (hasLoneSurrogate(text)) return { ok: false, error: 'The text contains an unpaired surrogate character (invalid Unicode); remove it.' };
      let newId = id;
      const declared = declaredId(text);
      if (declared !== null && declared !== id && isUserId(declared)) {
        const p = this.idProblem(declared);
        if (p) return { ok: false, error: p };
        newId = declared;
      }
      if (newId !== id) this.users.delete(id);
      const e = this.analyze(newId, text, 'user', this.now());
      this.users.set(newId, e);
      this.removedOutside.delete(id);
      this.blocked.delete(id);
      this.pending.delete(newId); // a spec saved under this id is wanted: any older pending delete is void
      this.notify();
      await this.persistNow(newId, newId !== id ? id : undefined);
      return { ok: true, id: newId, valid: e.valid, issues: e.issues, ...(newId !== id ? { renamedFrom: id } : {}) };
    });
  }

  /** Change a user spec's id (and the `id` inside its JSON when the text is a JSON object). */
  rename(id: string, newId: string): Promise<OpResult> {
    return this.enqueue(async (): Promise<OpResult> => {
      const cur = this.users.get(id);
      if (!cur) return { ok: false, error: this.builtins.has(id) ? 'Built-in formats cannot be renamed.' : `Unknown format "${id}".` };
      if (newId === id) return { ok: true, id };
      const p = this.idProblem(newId);
      if (p) return { ok: false, error: p };
      const obj = parseObject(cur.text);
      if (!obj) return { ok: false, error: 'The spec is not a valid JSON object; fix it before renaming.' };
      obj.id = newId;
      this.users.delete(id);
      this.users.set(newId, this.analyze(newId, JSON.stringify(obj, null, 2) + '\n', 'user', this.now()));
      this.removedOutside.delete(id);
      this.blocked.delete(id);
      this.pending.delete(newId);
      this.notify();
      await this.persistNow(newId, id);
      return { ok: true, id: newId };
    });
  }

  delete(id: string): Promise<OpResult> {
    return this.enqueue(async (): Promise<OpResult> => {
      if (!this.users.has(id)) return { ok: false, error: this.builtins.has(id) ? 'Built-in formats cannot be deleted.' : `Unknown format "${id}".` };
      this.users.delete(id);
      this.removedOutside.delete(id);
      this.blocked.delete(id);
      this.notify();
      await this.persistNow(undefined, id);
      return { ok: true, id };
    });
  }

  /**
   * Store the current state of `id` (new entry) and remove `removedId` (old entry). The old entry is only removed
   * after the new one was stored successfully, separately in browser storage and in the folder, so a failure
   * never leaves the user with neither.
   */
  private async persistNow(id?: string, removedId?: string): Promise<void> {
    const entry = id !== undefined ? this.users.get(id) : undefined;
    const oldKnown = removedId !== undefined ? this.known.get(removedId) : undefined; // a timeout clears `known`
    const problems: string[] = [];
    let stored = entry === undefined; // nothing to store counts as "fine to remove the old one"
    if (entry && id !== undefined) {
      try {
        await this.store.put({ id, text: entry.text, updatedAt: entry.updatedAt ?? this.now() });
        stored = true;
      } catch (e) {
        problems.push(`Could not store the format (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    if (removedId !== undefined && stored) {
      try {
        await this.store.remove(removedId);
      } catch (e) {
        problems.push(`Could not remove the old entry (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    const f = this.folderSync;
    if (f && this.needsVerify) {
      problems.push(this.verifyMessage()); // saves stay local until the folder was verified
      if (removedId !== undefined && stored) this.deferRemoval(removedId, oldKnown, problems);
    } else if (f && f.state === 'connected') {
      try {
        let written = entry === undefined; // delete: nothing to write first
        if (entry && id !== undefined && entry.valid) {
          const r = await this.writeSafe(f, id, entry.text, false);
          if (r.ok) written = true;
          else problems.push(r.reason);
        } else if (entry && !entry.valid) {
          written = false; // drafts stay in browser storage; the old file (if any) stays too
        }
        if (removedId !== undefined && written) {
          const r = await this.removeSafe(f, removedId);
          if (!r.ok) problems.push(r.reason);
        } else if (removedId !== undefined && stored && oldKnown) {
          // The new version could not go into the folder (invalid draft, or a refused/failed write). The old file
          // must not come back as a duplicate spec: delete it at the next sync, if it is still unchanged by then.
          this.addPending(removedId, oldKnown);
          problems.push('The old folder file ' + oldKnown.fileName + ' is kept for now and removed at the next sync.');
        }
      } catch (e) {
        this.folderFailed(f, e);
        problems.push(`Folder not updated (${e instanceof Error ? e.message : String(e)})`);
        if (removedId !== undefined && (entry === undefined || stored)) {
          this.addPending(removedId, oldKnown);
          if (entry !== undefined && oldKnown) problems.push('The old folder file ' + oldKnown.fileName + ' is kept for now and removed at the next sync.');
        }
      }
    } else if (removedId !== undefined && f && f.state === 'needs-permission') {
      if (stored) this.deferRemoval(removedId, oldKnown, problems); // applied after reconnecting, if the file is unchanged
    } else if (removedId !== undefined && stored) {
      this.addPending(removedId, oldKnown);
    }
    await this.saveFolderMeta();
    this.message = problems.length > 0 ? problems.join('; ') : null;
    this.notify();
  }

  private addPending(id: string, k: KnownFile | undefined = this.known.get(id)): void {
    if (k) this.pending.set(id, { fileName: k.fileName, hash: k.hash });
  }

  /**
   * A spec was deleted/renamed but its folder file cannot be removed right now. With a record of the file's last
   * content a pending delete is kept (applied after a normal sync, only if the file still has that content).
   * Without a record nothing is deleted; the user is told to remove the file by hand.
   */
  private deferRemoval(id: string, k: KnownFile | undefined, problems: string[]): void {
    if (k) {
      this.addPending(id, k);
      problems.push('The folder file ' + k.fileName + ' will be removed the next time the folder is connected (if it is unchanged then).');
    } else {
      // A tombstone: no content to verify against (hash ''), so the file is never deleted. It only stops a sync from
      // bringing the deleted spec back; creating or importing the id again clears it.
      this.pending.set(id, { fileName: specFileName(id), hash: '' });
      problems.push('The folder file ' + specFileName(id) + ' (if it exists) was kept; delete it manually.');
    }
  }

  /** A folder call failed: permission loss disconnects it; a timeout additionally puts the library in verify mode. */
  private folderFailed(f: FolderSync, e: unknown): void {
    if (!isPermissionError(e)) return;
    f.markPermissionLost();
    if (e instanceof FolderTimeoutError) {
      this.known.clear();
      this.needsVerify = true;
      this.verifyBlock = null;
    }
  }

  /** The message saves show while the folder awaits verification, derived from the reason and the folder state. */
  private verifyMessage(): string {
    if (this.verifyBlock === 'truncated') return TRUNCATED_MSG;
    if (this.verifyBlock === 'copy') return COPY_BLOCKED_MSG;
    const base = 'Folder needs verification after a folder operation timed out';
    return base + (this.folderSync?.state === 'none' ? ' — connect the folder again to verify it.' : ' — reconnect/sync.');
  }

  /**
   * Write `<known file name | id.json>` only when that is certainly safe: the file must be absent, or unchanged
   * since we last synced it. An existing file we have no record of, or one that changed, is never overwritten.
   */
  private async writeSafe(f: FolderSync, id: string, text: string, recreate: boolean): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.needsVerify) return { ok: false, reason: this.verifyMessage() };
    const k = this.known.get(id);
    const name = k?.fileName ?? specFileName(id);
    let cur: { text: string } | null;
    try {
      cur = await f.readOne(name);
    } catch (e) {
      if (isPermissionError(e)) throw e;
      return { ok: false, reason: `${name} could not be checked (${e instanceof Error ? e.message : String(e)}); not written` };
    }
    if (cur && recreate && k && cur.text.length === 0) cur = null; // a known file truncated to nothing counts as gone
    if (cur) {
      if (!k) {
        if (cur.text.length !== 0) return { ok: false, reason: `${name} already exists in the folder; it was not overwritten` };
        // An empty file holds no data (typically left by an interrupted first write): safe to fill.
      } else if (fingerprint(cur.text) !== k.hash) return { ok: false, reason: `${name} changed in the folder since the last sync; it was not overwritten (sync to resolve)` };
    } else if (k && !recreate) {
      return { ok: false, reason: `${name} was removed from the folder outside the app; it was not re-created` };
    }
    await f.write(id, text, name); // a timeout propagates; folderFailed() then switches to verify mode
    this.known.set(id, { fileName: name, hash: fingerprint(text), syncedAt: this.now() });
    return { ok: true };
  }

  /** Delete the spec's known file, only if it still has the content we last saw. */
  private async removeSafe(f: FolderSync, id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const k = this.known.get(id);
    if (!k) {
      // No record of a file for this spec. Never delete on a guess; if a file with its name exists, say so.
      let cur: { text: string } | null = null;
      try {
        cur = await f.readOne(specFileName(id));
      } catch (e) {
        if (isPermissionError(e)) throw e;
      }
      return cur ? { ok: false, reason: 'The folder file ' + specFileName(id) + ' was kept (no record of it); delete it manually.' } : { ok: true };
    }
    let cur: { text: string } | null;
    try {
      cur = await f.readOne(k.fileName);
    } catch (e) {
      if (isPermissionError(e)) throw e;
      return { ok: false, reason: `${k.fileName} could not be checked (${e instanceof Error ? e.message : String(e)}); not deleted` };
    }
    if (cur && fingerprint(cur.text) !== k.hash) {
      this.known.delete(id);
      return { ok: false, reason: `${k.fileName} changed in the folder since the last sync; it was not deleted` };
    }
    if (cur) await f.remove(k.fileName);
    this.known.delete(id);
    return { ok: true };
  }

  // ---- import / export ----

  /** Import one spec from file text. Must be a valid spec with a user-style id. The save time is "now". */
  importText(text: string): Promise<{ ok: true; id: string; replaced: boolean } | { ok: false; reason: string }> {
    return this.enqueue(async () => {
      const r = this.checkImport(text);
      if (!r.ok) return r;
      const { spec } = r;
      const replaced = this.users.has(spec.id);
      this.users.set(spec.id, this.analyze(spec.id, text, 'user', this.now()));
      this.pending.delete(spec.id);
      this.removedOutside.delete(spec.id);
      this.blocked.delete(spec.id);
      this.notify();
      await this.persistNow(spec.id);
      return { ok: true, id: spec.id, replaced } as const;
    });
  }

  private checkImport(text: string): { ok: true; spec: FormatSpec } | { ok: false; reason: string } {
    if (typeof text !== 'string') return { ok: false, reason: 'not text' };
    if (hasLoneSurrogate(text)) return { ok: false, reason: 'the text contains an unpaired surrogate character (invalid Unicode)' };
    const r = loadSpec(text);
    if (!r.ok) return { ok: false, reason: r.errors.slice(0, 3).map((i) => (i.path === '$' ? i.message : `${i.path}: ${i.message}`)).join('; ') };
    if (!isUserId(r.spec.id)) return { ok: false, reason: `id "${r.spec.id}" is not allowed (lower-case letters, digits, "_", "-"; 1-64 characters; not a reserved device name)` };
    if (this.builtins.has(r.spec.id)) return { ok: false, reason: `id "${r.spec.id}" is used by a built-in format` };
    return { ok: true, spec: r.spec };
  }

  /** Import several files (e.g. from an `<input type=file multiple>`), applying the size and count caps. */
  async importFiles(files: readonly ImportFile[]): Promise<ImportReport> {
    const report: ImportReport = { imported: [], replaced: [], skipped: [] };
    const list = files.slice(0, MAX_IMPORT_FILES);
    if (files.length > MAX_IMPORT_FILES) report.skipped.push({ fileName: '(remaining files)', reason: `more than ${MAX_IMPORT_FILES} files; the rest were ignored` });
    for (const f of list) {
      if (f.size > MAX_SPEC_BYTES) {
        report.skipped.push({ fileName: f.name, reason: `too large (${f.size} > ${MAX_SPEC_BYTES} bytes)` });
        continue;
      }
      let text: string;
      try {
        text = await f.text();
      } catch (e) {
        report.skipped.push({ fileName: f.name, reason: `unreadable (${e instanceof Error ? e.message : String(e)})` });
        continue;
      }
      const r = await this.importText(text);
      if (!r.ok) report.skipped.push({ fileName: f.name, reason: r.reason });
      else (r.replaced ? report.replaced : report.imported).push(r.id);
    }
    this.message = describeImport(report);
    this.notify();
    return report;
  }

  /** The spec's JSON as a Blob (built-ins included). */
  export(id: string): Blob | null {
    const e = this.builtins.get(id) ?? this.users.get(id);
    return e ? new Blob([e.text], { type: 'application/json' }) : null;
  }

  /** Generated documentation. Null when the spec is unknown or invalid. */
  exportDoc(id: string, kind: 'md' | 'html'): { fileName: string; blob: Blob } | null {
    const e = this.get(id);
    if (!e?.spec) return null;
    return kind === 'md'
      ? { fileName: `${id}.md`, blob: new Blob([generateMarkdown(e.spec)], { type: 'text/markdown' }) }
      : { fileName: `${id}.html`, blob: new Blob([generateHtml(e.spec)], { type: 'text/html' }) };
  }

  // ---- folder ----

  /** Read the folder and merge it into the library by id. See the file comment for the safety rules. */
  syncFromFolder(): Promise<SyncReport | null> {
    const f = this.folderSync;
    if (!f || f.state !== 'connected') return Promise.resolve(null);
    return this.enqueue(() => this.doSync(f));
  }

  private async doSync(f: FolderSync): Promise<SyncReport | null> {
    if (f.state !== 'connected') return null;
    const report: SyncReport = { added: [], updated: [], pushed: [], skipped: [], conflicts: [], removedOutside: [], truncated: false };
    let read;
    try {
      read = await f.readAll();
    } catch (e) {
      // A half-read folder must never drive writes.
      this.folderFailed(f, e);
      await this.saveFolderMeta();
      this.message = `Could not read the folder (${e instanceof Error ? e.message : String(e)}); nothing was changed`;
      this.notify();
      return null;
    }
    report.truncated = read.truncated;
    const verify = this.needsVerify;
    let copyFailed = false; // a verify copy could not be kept: verification is incomplete
    if (verify) report.verified = { differing: 0 };
    report.skipped.push(...read.skipped);
    this.blocked = new Map();
    const occupied = new Set(read.names.map((n) => n.toLowerCase())); // every .json name that exists, valid or not
    const skippedNames = new Set(read.skipped.map((s) => s.fileName));

    interface Seen {
      text: string;
      lastModified: number;
      fileName: string;
      hash: string;
    }
    const inFolder = new Map<string, Seen>();
    for (const file of read.files) {
      if (file.text.length === 0) {
        occupied.delete(file.fileName.toLowerCase()); // empty: no data to protect, a spec may be written there
        continue;
      }
      const c = this.checkImport(file.text);
      if (!c.ok) {
        report.skipped.push({ fileName: file.fileName, reason: c.reason });
        skippedNames.add(file.fileName);
        continue;
      }
      const prev = inFolder.get(c.spec.id);
      if (prev) {
        const keepNew = file.lastModified > prev.lastModified;
        const dropped = keepNew ? prev.fileName : file.fileName;
        report.skipped.push({ fileName: dropped, reason: `duplicate id "${c.spec.id}"; the newer file was used` });
        skippedNames.add(dropped);
        if (!keepNew) continue;
      }
      inFolder.set(c.spec.id, { text: file.text, lastModified: file.lastModified, fileName: file.fileName, hash: fingerprint(file.text) });
    }

    try {
      // 1. Deletions that were requested while the folder was unreachable: only for files that are unchanged.
      for (const [id, p] of read.truncated || verify ? [] : [...this.pending]) {
        if (p.hash === '') {
          // Tombstone (deleted while the folder was unverified): never delete; forget it once the file is gone.
          if (!occupied.has(p.fileName.toLowerCase())) this.pending.delete(id);
          continue;
        }
        const seen = [...inFolder.entries()].find(([, s]) => s.fileName === p.fileName);
        if (seen) {
          if (seen[1].hash === p.hash) {
            await f.remove(p.fileName);
            inFolder.delete(seen[0]);
            occupied.delete(p.fileName.toLowerCase());
          } else {
            report.skipped.push({ fileName: p.fileName, reason: 'not deleted: it changed in the folder after the spec was deleted' });
          }
        } else if (occupied.has(p.fileName.toLowerCase())) {
          report.skipped.push({ fileName: p.fileName, reason: 'not deleted: the file could not be verified' });
        }
        this.pending.delete(id);
        this.known.delete(id);
      }

      // 2. Merge files that exist in the folder.
      this.removedOutside = new Set();
      const toStore: string[] = [];
      const toPush: string[] = [];
      for (const [id, ff] of inFolder) {
        const pd = this.pending.get(id);
        if (pd) {
          // Deleted here, file still to be removed (or never to be, for a tombstone): do not bring it back.
          if (pd.hash === '') report.skipped.push({ fileName: ff.fileName, reason: 'kept in folder; deleted locally — remove the file manually' });
          continue;
        }
        const local = this.users.get(id);
        const k = this.known.get(id);
        const synced: KnownFile = { fileName: ff.fileName, hash: ff.hash, syncedAt: this.now() };
        if (!local) {
          this.users.set(id, this.analyze(id, ff.text, 'user', ff.lastModified));
          report.added.push(id);
          toStore.push(id);
          this.known.set(id, synced);
          continue;
        }
        if (fingerprint(local.text) === ff.hash) {
          this.known.set(id, synced);
          continue;
        }
        if (verify) {
          // Verify mode: the folder may hold anything (a timed-out write can land at any time). Keep the local spec,
          // keep the folder's version as a local copy, write nothing. Recording the file as known means the next
          // normal sync sees "local changed, folder unchanged" and may then push, with the folder version safe.
          const kept = await this.keepCopy(id, ff.text, ' (conflict copy)');
          if ('error' in kept) {
            report.skipped.push({ fileName: ff.fileName, reason: kept.error });
            copyFailed = true;
            continue;
          }
          report.verified!.differing++;
          if (kept.created) report.conflicts.push({ id, copyId: kept.copyId });
          this.known.set(id, synced);
          continue;
        }
        const localChanged = k ? fingerprint(local.text) !== k.hash : true;
        const folderChanged = k ? ff.hash !== k.hash : true;
        if (folderChanged && !localChanged) {
          this.users.set(id, this.analyze(id, ff.text, 'user', ff.lastModified));
          report.updated.push(id);
          toStore.push(id);
          this.known.set(id, synced);
        } else if (localChanged && !folderChanged) {
          if (local.valid) toPush.push(id); // known still matches the file, so the safe write goes through
          else report.skipped.push({ fileName: ff.fileName, reason: `local draft "${id}" is invalid; the folder file was kept` });
        } else {
          // Both sides changed (or we cannot tell): the newer side stays, the other becomes a conflict copy.
          const folderWins = !local.valid || ff.lastModified > (local.updatedAt ?? 0);
          const kept = await this.keepCopy(id, folderWins ? local.text : ff.text, ' (conflict copy)');
          if ('error' in kept) {
            report.skipped.push({ fileName: ff.fileName, reason: kept.error }); // neither side is touched
            continue;
          }
          if (kept.created) report.conflicts.push({ id, copyId: kept.copyId });
          if (folderWins) {
            this.users.set(id, this.analyze(id, ff.text, 'user', ff.lastModified));
            toStore.push(id);
          } else {
            toPush.push(id); // the folder's version now lives on in the copy, so replacing the file loses nothing
          }
          this.known.set(id, synced);
        }
      }

      // 3. Local specs that have no file. Skipped when the folder was only partly read: a missing file is then not
      // evidence of anything, and a "free" name may be taken by a file we never saw.
      for (const [id, local] of read.truncated || verify ? [] : [...this.users]) {
        if (inFolder.has(id)) continue;
        const k = this.known.get(id);
        if (k) {
          if (occupied.has(k.fileName.toLowerCase())) {
            this.blocked.set(id, k.fileName);
            const hint = 'it is not a valid spec for "' + id + '" any more (invalid, or it now declares another id); fix or remove it in the folder, or use "Overwrite folder file"';
            const already = report.skipped.find((s) => s.fileName === k.fileName);
            if (already) already.reason += '; ' + hint;
            else report.skipped.push({ fileName: k.fileName, reason: hint });
            continue; // the file exists but is not readable as a spec: never overwrite it
          }
          this.removedOutside.add(id); // known here before, gone now: removed outside the app, so do NOT push it back
          report.removedOutside.push(id);
          continue;
        }
        if (!local.valid) continue; // invalid drafts stay in browser storage
        if (occupied.has(specFileName(id).toLowerCase())) {
          this.blocked.set(id, specFileName(id));
          report.skipped.push({ fileName: specFileName(id), reason: 'a file with this name exists in the folder and was not overwritten; rename or remove it, or use "Overwrite folder file"' });
          continue;
        }
        toPush.push(id);
      }

      for (const id of toStore) {
        const e = this.users.get(id);
        if (!e) continue;
        try {
          await this.store.put({ id, text: e.text, updatedAt: e.updatedAt ?? this.now() });
        } catch {
          /* the store reports its own failures */
        }
      }
      for (const id of read.truncated || verify ? [] : toPush) {
        const e = this.users.get(id);
        if (!e?.valid) continue;
        const r = await this.writeSafe(f, id, e.text, false); // permission errors propagate and end the sync
        if (r.ok) report.pushed.push(id);
        else report.skipped.push({ fileName: specFileName(id), reason: r.reason });
      }
      for (const id of [...this.known.keys()]) if (!this.users.has(id) && !this.pending.has(id)) this.known.delete(id);
      if (verify) {
        // Verified only if the whole folder was read and every differing file was kept as a copy.
        if (read.truncated) this.verifyBlock = 'truncated';
        else if (copyFailed) this.verifyBlock = 'copy';
        else {
          this.needsVerify = false;
          this.verifyBlock = null;
        }
      }
    } catch (e) {
      this.folderFailed(f, e);
      this.message = `Folder sync stopped (${e instanceof Error ? e.message : String(e)})`;
      await this.saveFolderMeta();
      this.notify();
      return null;
    }
    await this.saveFolderMeta();
    // Never report "verified" while the flag is still set: the reason (truncated listing, copy failure) drives it.
    this.message = this.needsVerify && this.verifyBlock !== null ? this.verifyMessage() : describeSync(f.name, report);
    this.notify();
    return report;
  }

  /**
   * Replace the folder file that blocks syncing `id` with this spec. The file's current content is first saved as a
   * local conflict copy. If it cannot be read, nothing is overwritten unless `allowLoss` is set (the UI asks first).
   */
  overwriteFolderFile(id: string, allowLoss = false): Promise<OpResult & { needsConfirm?: boolean }> {
    return this.enqueue(async (): Promise<OpResult & { needsConfirm?: boolean }> => {
      const f = this.folderSync;
      const e = this.users.get(id);
      const name = this.blocked.get(id);
      if (!f || f.state !== 'connected') return { ok: false, error: 'The folder is not connected.' };
      if (!e) return { ok: false, error: `Unknown format "${id}".` };
      if (!name) return { ok: false, error: 'No folder file is blocking this format.' };
      if (!e.valid) return { ok: false, error: 'Fix the validation errors first: invalid drafts are not written to the folder.' };
      if (this.needsVerify) return { ok: false, error: this.verifyMessage() };
      try {
        let old: { text: string } | null = null;
        let readable = true;
        try {
          old = await f.readOne(name);
        } catch (err) {
          if (isPermissionError(err)) throw err;
          readable = false;
        }
        if (!readable && !allowLoss) {
          return { ok: false, needsConfirm: true, error: name + ' cannot be read, so its current contents would not be preserved.' };
        }
        if (old && old.text.length > 0) {
          const kept = await this.keepCopy(id, old.text, ' (replaced folder file)');
          if ('error' in kept && !allowLoss) {
            return { ok: false, needsConfirm: true, error: 'A copy of ' + name + ' could not be saved (' + kept.error + '), so its current contents would not be preserved.' };
          }
        }
        await f.write(id, e.text, name);
        this.known.set(id, { fileName: name, hash: fingerprint(e.text), syncedAt: this.now() });
        this.blocked.delete(id);
        this.removedOutside.delete(id);
      } catch (err) {
        this.folderFailed(f, err);
        await this.saveFolderMeta();
        this.notify();
        return { ok: false, error: 'Folder not updated (' + (err instanceof Error ? err.message : String(err)) + ')' };
      }
      await this.saveFolderMeta();
      this.message = name + ' was replaced; its previous content is kept as a local copy.';
      this.notify();
      return { ok: true, id };
    });
  }

  /**
   * Keep `loserText` as a local spec `<id>-conflict-<n>`. An identical earlier copy (same text once retargeted to its
   * id) is reused, so repeating a sync against the same differing folder content never piles up copies. The copy is
   * stored BEFORE the caller adopts or overwrites anything; if that fails, the caller leaves both sides untouched.
   */
  private async keepCopy(id: string, loserText: string, suffix: string): Promise<{ copyId: string; created: boolean } | { error: string }> {
    for (const [cid, e] of this.users) {
      if (cid.startsWith(id.slice(0, 50) + '-conflict-') && retarget(loserText, cid, suffix) === e.text) return { copyId: cid, created: false };
    }
    const copyId = this.conflictId(id);
    const copyText = retarget(loserText, copyId, suffix);
    if (exceedsBytes(copyText)) return { error: 'the copy would be too large to keep; nothing was changed' };
    try {
      await this.store.put({ id: copyId, text: copyText, updatedAt: this.now() });
    } catch {
      return { error: 'could not save a local copy of the conflicting version; nothing was changed' };
    }
    this.users.set(copyId, this.analyze(copyId, copyText, 'user', this.now()));
    return { copyId, created: true };
  }

  private conflictId(id: string): string {
    const root = id.slice(0, 50);
    for (let n = 1; ; n++) {
      const c = `${root}-conflict-${n}`;
      if (!this.users.has(c) && !this.builtins.has(c)) return c;
    }
  }

  /** Show the folder picker, remember the folder and merge its specs. A different folder forgets the old one's state. */
  async connectFolder(): Promise<SyncReport | null> {
    const f = this.folderSync;
    if (!f) return null;
    try {
      if (!(await f.connect())) return null;
    } catch (e) {
      this.message = `Could not connect the folder (${e instanceof Error ? e.message : String(e)})`;
      this.notify();
      return null;
    }
    await this.enqueue(async () => {
      this.known.clear();
      this.pending.clear();
      this.removedOutside.clear();
      this.blocked.clear();
      this.needsVerify = false;
      this.verifyBlock = null;
      await this.saveFolderMeta();
      this.notify();
    });
    return this.syncFromFolder();
  }

  /** Re-request permission for the remembered folder (call from a click) and sync. */
  async reconnectFolder(): Promise<SyncReport | null> {
    const f = this.folderSync;
    if (!f) return null;
    const ok = await f.reconnect();
    this.notify();
    return ok ? this.syncFromFolder() : null;
  }

  async disconnectFolder(): Promise<void> {
    await this.enqueue(async () => {
      await this.folderSync?.disconnect();
      this.known.clear();
      this.pending.clear();
      this.removedOutside.clear();
      this.blocked.clear();
      this.needsVerify = false;
      this.verifyBlock = null;
      this.message = null;
      await this.saveFolderMeta();
      this.notify();
    });
  }

  /** A spec whose file vanished from the folder: write it back. */
  keepRemoved(id: string): Promise<OpResult> {
    return this.enqueue(async (): Promise<OpResult> => {
      const f = this.folderSync;
      const e = this.users.get(id);
      if (!f || f.state !== 'connected') return { ok: false, error: 'The folder is not connected.' };
      if (!e) return { ok: false, error: `Unknown format "${id}".` };
      if (!e.valid) return { ok: false, error: 'Fix the validation errors first: invalid drafts are not written to the folder.' };
      try {
        const r = await this.writeSafe(f, id, e.text, true);
        if (!r.ok) return { ok: false, error: r.reason };
      } catch (err) {
        this.folderFailed(f, err);
        await this.saveFolderMeta();
        this.notify();
        return { ok: false, error: `Folder not updated (${err instanceof Error ? err.message : String(err)})` };
      }
      this.removedOutside.delete(id);
      this.blocked.delete(id);
      await this.saveFolderMeta();
      this.notify();
      return { ok: true, id };
    });
  }

  /** A spec whose file vanished from the folder: delete it here too (nothing to remove in the folder). */
  deleteRemoved(id: string): Promise<OpResult> {
    return this.enqueue(async (): Promise<OpResult> => {
      if (!this.users.has(id)) return { ok: false, error: `Unknown format "${id}".` };
      this.users.delete(id);
      this.removedOutside.delete(id);
      this.blocked.delete(id);
      this.known.delete(id);
      try {
        await this.store.remove(id);
      } catch {
        /* the store reports its own failures */
      }
      await this.saveFolderMeta();
      this.notify();
      return { ok: true, id };
    });
  }
}

/**
 * Give JSON text a new id (and a name suffix). Only the top-level `id` and `name` string values are rewritten
 * textually, every other byte is preserved. If the text cannot be handled that way, it is re-serialised
 * (`JSON.stringify`, 2-space indent), which keeps the data but not the formatting; non-JSON text is returned as is.
 */
function retarget(text: string, id: string, nameSuffix: string): string {
  const obj = !exceedsBytes(text) ? parseObject(text) : null;
  if (!obj) return text;
  const direct = rewriteTopLevelStrings(text, id, (n) => n + nameSuffix);
  if (direct !== null) return direct;
  obj.id = id;
  if (typeof obj.name === 'string') obj.name = obj.name + nameSuffix;
  return JSON.stringify(obj, null, 2) + String.fromCharCode(10);
}

export function describeImport(r: ImportReport): string {
  const parts = [`Imported ${r.imported.length}`];
  if (r.replaced.length > 0) parts.push(`replaced ${r.replaced.length}`);
  if (r.skipped.length > 0) parts.push(`skipped ${r.skipped.length} (${r.skipped.slice(0, 3).map((s) => `${s.fileName}: ${s.reason}`).join('; ')}${r.skipped.length > 3 ? '; …' : ''})`);
  return parts.join(', ') + '.';
}

export function describeSync(folderName: string | null, r: SyncReport): string {
  if (r.verified) {
    const v = 'Folder verified after a timed-out write; ' + r.verified.differing + ' differing file(s) were kept as conflict copies.';
    return r.truncated ? v + ' (The folder has more than ' + MAX_FOLDER_FILES + ' .json files, so it still needs verification.)' : v;
  }
  const parts = r.truncated ? ['Folder has more than ' + MAX_FOLDER_FILES + ' .json files; only the first ' + MAX_FOLDER_FILES + ' were read, so nothing was pushed, deleted or flagged'] : [];
  parts.push(`Folder "${folderName ?? '?'}" synced: ${r.added.length} added, ${r.updated.length} updated from newer files, ${r.pushed.length} written`);
  if (r.conflicts.length > 0) parts.push(`${r.conflicts.length} conflict(s) kept as copies (${r.conflicts.slice(0, 3).map((c) => c.copyId).join(', ')})`);
  if (r.removedOutside.length > 0) parts.push(`${r.removedOutside.length} removed from the folder outside the app (${r.removedOutside.slice(0, 3).join(', ')})`);
  if (r.skipped.length > 0) parts.push(`skipped ${r.skipped.length} (${r.skipped.slice(0, 3).map((s) => `${s.fileName}: ${s.reason}`).join('; ')}${r.skipped.length > 3 ? '; …' : ''})`);
  return parts.join(', ') + '.';
}
