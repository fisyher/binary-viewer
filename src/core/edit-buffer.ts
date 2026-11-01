/**
 * Piece-table edit overlay over a read-only ByteSource.
 *
 * The document is a list of pieces. An `orig` piece references a byte range of the base source (never copied);
 * an `added` piece references a range of an append-only store of user-typed bytes, kept in fixed-size chunks.
 * Pieces are immutable values; edits replace a contiguous run of pieces by splicing the array.
 *
 * Limits and complexity (documented, not enforced beyond the caps):
 * - `offs[i]` caches the logical start of piece i. Locating a piece is a binary search, O(log n). An edit splices
 *   the piece array and refreshes `offs` from the splice point on, O(n) in the number of pieces after it.
 *   That is fine up to ~100k pieces (a few hundred microseconds); beyond that edits get slower but stay correct.
 *   Adjacent mergeable pieces (contiguous in the same space) are merged to keep the count down while typing.
 * - read() is O(log n + pieces touched) plus the base reads for orig pieces.
 * - Each undo step is a list of splice records (removed pieces / inserted pieces), so history memory is
 *   proportional to the pieces touched, not to the file size. History is capped (default 10k steps).
 * - The added store is append-only (undo does not free it) and capped (default 256 MiB); when full, edits
 *   throw EditStoreFullError and nothing is changed.
 */
import { MAX_READ, type ByteSource } from './byte-source';

/** A run of the document: bytes `[start, start+length)` of the base source (`orig`) or of the added store (`added`). */
export type Piece = Readonly<{ kind: 'orig' | 'added'; start: number; length: number }>;

/** Bytes per chunk of the added store (the store grows chunk by chunk, never reallocating). */
export const ADDED_CHUNK = 64 * 1024;
/** Default cap (bytes) on the append-only added store; undo does not reclaim it. */
export const DEFAULT_MAX_ADDED = 256 * 1024 * 1024;
/** Default cap on undo steps; the oldest step is dropped past it. */
export const DEFAULT_MAX_HISTORY = 10_000;
/** Max gap (ms, measured from the previous edit) for a typed edit to join the open undo step. */
export const COALESCE_MS = 1000;

/**
 * Thrown by insert/overwrite when the added store would exceed `maxAddedBytes`. Thrown before any state changes,
 * so the document and history are intact. Only saving (rebase) frees the store.
 */
export class EditStoreFullError extends Error {
  constructor(limit: number) {
    super(`Edit buffer is full: more than ${limit} bytes of new data. Save the file to continue editing.`);
    this.name = 'EditStoreFullError';
  }
}

export interface EditBufferOptions {
  /** Cap on total bytes ever typed/pasted since construction or the last rebase. Default DEFAULT_MAX_ADDED. */
  maxAddedBytes?: number;
  /** Max undo steps kept. Default DEFAULT_MAX_HISTORY. */
  maxHistory?: number;
  /** Time source for coalescing; tests inject a fake. */
  now?: () => number;
  /** Added-store chunk size (tests use tiny chunks). */
  chunkSize?: number;
}

export interface EditOptions {
  /**
   * Typed input: merge into the open undo step when the edit starts inside that step's touched range
   * `[groupStart, groupEnd]`, within COALESCE_MS of the previous edit, and nothing is in the redo stack.
   * Ignored for deletes (they always start a new step). Call `breakGroup()` to force a new step.
   */
  coalesce?: boolean;
}

interface Splice {
  index: number;
  removed: Piece[];
  inserted: Piece[];
  /** Logical offset where the change begins (for placing the caret after undo/redo). */
  at: number;
}
interface Step {
  splices: Splice[];
}

function checkInt(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`Invalid ${name}: ${v}`);
}

/** Splice without spreading huge arrays into call arguments. */
function spliceArray<T>(arr: T[], index: number, del: number, items: readonly T[]): void {
  if (items.length < 5000) {
    arr.splice(index, del, ...items);
    return;
  }
  const tail = arr.slice(index + del);
  arr.length = index;
  for (const it of items) arr.push(it);
  for (const it of tail) arr.push(it);
}

function mergeable(a: Piece, b: Piece): boolean {
  return a.kind === b.kind && a.start + a.length === b.start;
}

/**
 * A mutable document layered on a read-only base ByteSource; implements ByteSource itself, so readers need not
 * know whether they see edits. All offsets are absolute logical document offsets in bytes. Edits are synchronous;
 * only `read` is async (and only awaits base reads). The base is never modified, and the buffer does not copy it.
 * Arguments must be non-negative safe integers or RangeError is thrown; no state changes on a throw.
 * Single-threaded: use from one context (the main thread), not shared with the worker.
 */
export class EditBuffer implements ByteSource {
  private pieceList: Piece[];
  private offs: number[] = [];
  private total = 0;
  private chunks: Uint8Array[] = [];
  // Immutable Blob snapshot per added-store chunk (valid while `len` matches), so toBlob() copies each chunk once.
  private chunkBlobs: Array<{ len: number; blob: Blob } | undefined> = [];
  private blobBuilds = 0;
  private addedLen = 0;
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private savedDepth: number | null = 0;
  private ver = 0;
  private listeners = new Set<() => void>();
  // Open typing group
  private groupOpen = false;
  private groupStart = 0;
  private groupEnd = 0;
  private groupTime = 0;

  private readonly maxAdded: number;
  private readonly maxHistory: number;
  private readonly now: () => number;
  private readonly chunkSize: number;

  constructor(
    private base: ByteSource,
    options: EditBufferOptions = {},
  ) {
    this.maxAdded = options.maxAddedBytes ?? DEFAULT_MAX_ADDED;
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.now = options.now ?? Date.now;
    this.chunkSize = options.chunkSize ?? ADDED_CHUNK;
    this.pieceList = base.size > 0 ? [{ kind: 'orig', start: 0, length: base.size }] : [];
    this.refreshOffsets(0);
  }

  /** Current document length in bytes (changes with inserts and deletes). */
  get size(): number {
    return this.total;
  }
  /** Incremented by every content change (edit, undo, redo, rebase). */
  get version(): number {
    return this.ver;
  }
  /** True when the content differs from the last `markSaved()` state (or if that state fell off the history cap). */
  get isDirty(): boolean {
    return this.savedDepth === null || this.undoStack.length !== this.savedDepth;
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  /** How many chunk Blobs toBlob() has had to build (diagnostics/tests). */
  get chunkBlobBuilds(): number {
    return this.blobBuilds;
  }
  /** Bytes currently held in the added store. */
  get addedBytes(): number {
    return this.addedLen;
  }

  /** Subscribe to content changes. Callbacks run synchronously after the change, in subscription order. Returns an unsubscribe function. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Snapshot of the piece list in document order (pieces are immutable). */
  pieces(): readonly Piece[] {
    return this.pieceList.slice();
  }

  /** Copy `length` bytes of the added store starting at store offset `start`. */
  readAdded(start: number, length: number): Uint8Array {
    checkInt('start', start);
    checkInt('length', length);
    if (start + length > this.addedLen) throw new RangeError('Added range out of bounds');
    const out = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const pos = start + done;
      const ci = Math.floor(pos / this.chunkSize);
      const co = pos - ci * this.chunkSize;
      const n = Math.min(length - done, this.chunkSize - co);
      out.set(this.chunks[ci]!.subarray(co, co + n), done);
      done += n;
    }
    return out;
  }

  // ---- reading ----

  /**
   * Same contract as ByteSource.read, against the edited document: RangeError for invalid arguments,
   * `length` > MAX_READ or `offset` > size; clamps at the end. The piece list is resolved synchronously, so the
   * result is a consistent snapshot even if edits happen while base reads are pending.
   * Rejects with a plain Error if the base returns fewer bytes than asked.
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    checkInt('offset', offset);
    checkInt('length', length);
    if (length > MAX_READ) throw new RangeError(`Length ${length} exceeds MAX_READ (${MAX_READ})`);
    if (offset > this.total) throw new RangeError(`Offset ${offset} is past end (size ${this.total})`);
    const end = Math.min(this.total, offset + length);
    const out = new Uint8Array(end - offset);
    if (out.length === 0) return out;

    // Resolve everything synchronously (a consistent snapshot); only base reads are awaited.
    const jobs: Array<Promise<void>> = [];
    let i = this.findPiece(offset);
    let pos = offset;
    while (pos < end) {
      const p = this.pieceList[i]!;
      const pStart = this.offs[i]!;
      const skip = pos - pStart;
      const n = Math.min(p.length - skip, end - pos);
      const dst = pos - offset;
      if (p.kind === 'added') {
        out.set(this.readAdded(p.start + skip, n), dst);
      } else {
        jobs.push(
          this.base.read(p.start + skip, n).then((b) => {
            if (b.length !== n) throw new Error(`Short read from base at ${p.start + skip}`);
            out.set(b, dst);
          }),
        );
      }
      pos += n;
      i++;
    }
    await Promise.all(jobs);
    return out;
  }

  /** Half-open ranges within [start, end) covered by added (user-written) bytes, sorted and merged. */
  modifiedRanges(start: number, end: number): Array<[number, number]> {
    checkInt('start', start);
    checkInt('end', end);
    end = Math.min(end, this.total);
    const out: Array<[number, number]> = [];
    if (end <= start) return out;
    for (let i = this.findPiece(start); i < this.pieceList.length && this.offs[i]! < end; i++) {
      const p = this.pieceList[i]!;
      if (p.kind !== 'added') continue;
      const a = Math.max(start, this.offs[i]!);
      const b = Math.min(end, this.offs[i]! + p.length);
      const last = out[out.length - 1];
      if (last && last[1] === a) last[1] = b;
      else out.push([a, b]);
    }
    return out;
  }

  /**
   * A Blob of the whole document, built lazily: orig pieces are `baseBlob.slice()` references, added pieces are
   * copies of the (in-memory) added bytes. No orig data is read.
   */
  toBlob(baseBlob: Blob, type = ''): Blob {
    if (baseBlob.size !== this.base.size) {
      throw new RangeError(`Base blob size ${baseBlob.size} does not match the base source (${this.base.size})`);
    }
    const parts: BlobPart[] = [];
    for (const p of this.pieceList) {
      if (p.kind === 'orig') parts.push(baseBlob.slice(p.start, p.start + p.length));
      else {
        for (let done = 0; done < p.length; ) {
          const pos = p.start + done;
          const ci = Math.floor(pos / this.chunkSize);
          const co = pos - ci * this.chunkSize;
          const n = Math.min(p.length - done, this.chunkSize - co);
          parts.push(this.chunkBlob(ci).slice(co, co + n));
          done += n;
        }
      }
    }
    return new Blob(parts, { type });
  }

  /** Blob of the filled part of added chunk `ci`; rebuilt only if the chunk has grown since. */
  private chunkBlob(ci: number): Blob {
    const len = Math.min(this.chunkSize, this.addedLen - ci * this.chunkSize);
    const hit = this.chunkBlobs[ci];
    if (hit && hit.len === len) return hit.blob;
    const blob = new Blob([this.chunks[ci]!.slice(0, len) as Uint8Array<ArrayBuffer>]);
    this.chunkBlobs[ci] = { len, blob };
    this.blobBuilds++;
    return blob;
  }

  // ---- editing ----

  /**
   * Replace bytes [offset, offset+bytes.length) with `bytes`; extends the document past its end.
   * `offset` may equal `size` (append) but not exceed it (RangeError). Empty `bytes` is a no-op. Throws
   * EditStoreFullError if the added-store cap would be exceeded. One call is one undo step (unless coalesced).
   */
  overwrite(offset: number, bytes: Uint8Array, opts: EditOptions = {}): void {
    checkInt('offset', offset);
    if (offset > this.total) throw new RangeError(`Offset ${offset} is past end (size ${this.total})`);
    if (bytes.length === 0) return;
    this.edit(offset, Math.min(this.total, offset + bytes.length), bytes, opts);
  }

  /** Insert `bytes` before `offset` (`offset <= size`, else RangeError). Empty `bytes` is a no-op. Throws EditStoreFullError at the cap. */
  insert(offset: number, bytes: Uint8Array, opts: EditOptions = {}): void {
    checkInt('offset', offset);
    if (offset > this.total) throw new RangeError(`Offset ${offset} is past end (size ${this.total})`);
    if (bytes.length === 0) return;
    this.edit(offset, offset, bytes, opts);
  }

  /** Remove `length` bytes at `offset`. Unlike read, a range extending past the end throws RangeError instead of clamping. Never coalesces. */
  delete(offset: number, length: number): void {
    checkInt('offset', offset);
    checkInt('length', length);
    if (offset + length > this.total) {
      throw new RangeError(`Range ${offset}+${length} is past end (size ${this.total})`);
    }
    if (length === 0) return;
    this.edit(offset, offset + length, null, {});
  }

  /** End the current typing group so the next typed edit starts a new undo step (call on caret jumps). */
  breakGroup(): void {
    this.groupOpen = false;
  }

  /** Undo one step. Returns the offset where it happened (for the caret), or null if nothing to undo. */
  undo(): number | null {
    const step = this.undoStack.pop();
    if (!step) return null;
    this.groupOpen = false;
    let at = 0;
    for (let k = step.splices.length - 1; k >= 0; k--) {
      const s = step.splices[k]!;
      this.applySplice(s.index, s.inserted.length, s.removed);
      at = s.at;
    }
    this.redoStack.push(step);
    this.changed();
    return Math.min(at, this.total);
  }

  /** Redo one step; same return as `undo()`. Any new edit clears the redo stack. */
  redo(): number | null {
    const step = this.redoStack.pop();
    if (!step) return null;
    this.groupOpen = false;
    let at = 0;
    for (const s of step.splices) {
      this.applySplice(s.index, s.removed.length, s.inserted);
      at = s.at;
    }
    this.undoStack.push(step);
    this.changed();
    return Math.min(at, this.total);
  }

  /** The current state is the saved state (isDirty becomes false until the next change). Also ends the typing group. */
  markSaved(): void {
    this.savedDepth = this.undoStack.length;
    this.groupOpen = false;
  }

  /**
   * Point the buffer at a new base with identical content (after a save). Clears pieces, the added store and the
   * undo history; the result is clean. The new base must have the same size as the current document.
   */
  rebase(base: ByteSource): void {
    if (base.size !== this.total) {
      throw new RangeError(`New base size ${base.size} does not match the document size ${this.total}`);
    }
    this.base = base;
    this.pieceList = base.size > 0 ? [{ kind: 'orig', start: 0, length: base.size }] : [];
    this.chunks = [];
    this.chunkBlobs = [];
    this.addedLen = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.savedDepth = 0;
    this.groupOpen = false;
    this.refreshOffsets(0);
    this.changed();
  }

  // ---- internals ----

  private changed(): void {
    this.ver++;
    for (const cb of [...this.listeners]) cb();
  }

  private refreshOffsets(from: number): void {
    let pos = from > 0 ? this.offs[from - 1]! + this.pieceList[from - 1]!.length : 0;
    this.offs.length = this.pieceList.length;
    for (let i = from; i < this.pieceList.length; i++) {
      this.offs[i] = pos;
      pos += this.pieceList[i]!.length;
    }
    this.total = pos;
  }

  /** Index of the piece containing `offset` (offset < size), or pieces.length when offset >= size. */
  private findPiece(offset: number): number {
    if (offset >= this.total) return this.pieceList.length;
    let lo = 0;
    let hi = this.pieceList.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offs[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private applySplice(index: number, deleteCount: number, items: readonly Piece[]): void {
    spliceArray(this.pieceList, index, deleteCount, items);
    this.refreshOffsets(Math.max(0, index));
  }

  private append(bytes: Uint8Array): Piece[] {
    if (this.addedLen + bytes.length > this.maxAdded) throw new EditStoreFullError(this.maxAdded);
    const start = this.addedLen;
    let done = 0;
    while (done < bytes.length) {
      const ci = Math.floor(this.addedLen / this.chunkSize);
      const co = this.addedLen - ci * this.chunkSize;
      if (!this.chunks[ci]) this.chunks[ci] = new Uint8Array(this.chunkSize);
      const n = Math.min(bytes.length - done, this.chunkSize - co);
      this.chunks[ci]!.set(bytes.subarray(done, done + n), co);
      this.addedLen += n;
      done += n;
    }
    return [{ kind: 'added', start, length: bytes.length }];
  }

  private edit(start: number, end: number, bytes: Uint8Array | null, opts: EditOptions): void {
    if (!Number.isSafeInteger(this.total - (end - start) + (bytes?.length ?? 0))) {
      throw new RangeError('Document would be too large');
    }
    // Locate the run of pieces to replace.
    let i = this.findPiece(start);
    let j: number; // exclusive
    if (end > start) j = this.findPiece(end - 1) + 1;
    else j = i < this.pieceList.length && this.offs[i]! < start ? i + 1 : i;
    if (end === start && i < this.pieceList.length && this.offs[i] === start) j = i; // insert at a boundary

    let inserted: Piece[] = [];
    if (i < j) {
      const first = this.pieceList[i]!;
      const left = start - this.offs[i]!;
      if (left > 0) inserted.push({ kind: first.kind, start: first.start, length: left });
    }
    const added = bytes ? this.append(bytes) : []; // may throw before anything changed
    inserted.push(...added);
    if (i < j) {
      const last = this.pieceList[j - 1]!;
      const lastEnd = this.offs[j - 1]! + last.length;
      const right = lastEnd - end;
      if (right > 0) inserted.push({ kind: last.kind, start: last.start + last.length - right, length: right });
    }

    // Merge with neighbours where contiguous, widening the replaced run.
    const merged: Piece[] = [];
    for (const p of inserted) {
      const prev = merged[merged.length - 1];
      if (prev && mergeable(prev, p)) merged[merged.length - 1] = { ...prev, length: prev.length + p.length };
      else merged.push(p);
    }
    if (merged.length > 0 && i > 0 && mergeable(this.pieceList[i - 1]!, merged[0]!)) {
      const prev = this.pieceList[i - 1]!;
      merged[0] = { ...prev, length: prev.length + merged[0]!.length };
      i--;
    }
    if (merged.length > 0 && j < this.pieceList.length && mergeable(merged[merged.length - 1]!, this.pieceList[j]!)) {
      const last = merged[merged.length - 1]!;
      merged[merged.length - 1] = { ...last, length: last.length + this.pieceList[j]!.length };
      j++;
    } else if (merged.length === 0 && i > 0 && j < this.pieceList.length && mergeable(this.pieceList[i - 1]!, this.pieceList[j]!)) {
      // A pure delete leaves two contiguous neighbours.
      const prev = this.pieceList[i - 1]!;
      merged.push({ ...prev, length: prev.length + this.pieceList[j]!.length });
      i--;
      j++;
    }
    inserted = merged;

    const splice: Splice = { index: i, removed: this.pieceList.slice(i, j), inserted, at: start };
    const typed = opts.coalesce === true && bytes !== null;
    const t = this.now();
    const joinable =
      typed &&
      this.groupOpen &&
      this.redoStack.length === 0 &&
      this.undoStack.length > 0 &&
      t - this.groupTime < COALESCE_MS &&
      start >= this.groupStart &&
      start <= this.groupEnd;

    this.applySplice(i, j - i, inserted);

    if (joinable) {
      this.undoStack[this.undoStack.length - 1]!.splices.push(splice);
      this.groupStart = Math.min(this.groupStart, start);
      this.groupEnd = Math.max(this.groupEnd, start + bytes!.length);
    } else {
      if (this.savedDepth !== null && this.savedDepth > this.undoStack.length) this.savedDepth = null;
      this.redoStack = [];
      this.undoStack.push({ splices: [splice] });
      if (this.undoStack.length > this.maxHistory) {
        this.undoStack.shift();
        if (this.savedDepth !== null) this.savedDepth = this.savedDepth > 0 ? this.savedDepth - 1 : null;
      }
      this.groupOpen = typed;
      if (typed) {
        this.groupStart = start;
        this.groupEnd = start + bytes!.length;
      }
    }
    this.groupTime = t;
    this.changed();
  }
}
