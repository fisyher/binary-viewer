/**
 * Random-access, read-only byte provider. Never assumes the data fits in memory.
 * Offsets and lengths are in bytes and always absolute from the start of the source.
 * Each read returns a fresh array the caller owns (never a view into internal state).
 */
export interface ByteSource {
  /** Total length in bytes, fixed at construction (a Blob is not re-measured later). */
  readonly size: number;
  /**
   * Read up to `length` bytes at `offset`. Rejects with RangeError for negative or
   * non-integer arguments, for `length` > MAX_READ, and for `offset` > size; clamps
   * `length` at EOF (offset === size yields an empty array). The result may therefore
   * be shorter than `length`; callers must check `.length`. Not cancellable.
   * Rejects with a plain Error if the underlying storage fails.
   */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Largest single read (bytes) accepted by the sources here and by EditBuffer; callers needing more must read in chunks. */
export const MAX_READ = 16 * 1024 * 1024;

function validateArgs(offset: number, length: number, size: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(`Invalid offset: ${offset}`);
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`Invalid length: ${length}`);
  }
  if (length > MAX_READ) {
    throw new RangeError(`Length ${length} exceeds MAX_READ (${MAX_READ})`);
  }
  if (offset > size) {
    throw new RangeError(`Offset ${offset} is past end of source (size ${size})`);
  }
}

/** In-memory source, for tests and newly created files. `read` returns copies; the wrapped array is not copied at construction. */
export class MemoryByteSource implements ByteSource {
  constructor(private readonly data: Uint8Array) {}

  get size(): number {
    return this.data.length;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    validateArgs(offset, length, this.size);
    const end = Math.min(this.size, offset + length);
    return this.data.slice(offset, end); // copy so callers cannot mutate the source
  }
}

export interface BlobByteSourceOptions {
  /** Bytes per page read from the Blob. Positive safe integer, else the constructor throws RangeError. Default 64 KiB. */
  pageSize?: number;
  /** Max pages kept in the LRU cache (default memory bound is about 4 MiB). Positive safe integer. Default 64. */
  maxPages?: number;
}

/**
 * Blob/File backed source: reads fixed-size pages on demand with an LRU cache, so only the touched
 * pages are ever in memory. `size` is captured at construction. Concurrent reads of the same page
 * share one Blob read. If the file shrank or became unreadable, `read` rejects (plain Error "Short read"
 * for a shrunk file) and the bad page is not cached.
 */
export class BlobByteSource implements ByteSource {
  readonly size: number;
  private readonly pageSize: number;
  private readonly maxPages: number;
  // Map preserves insertion order; we re-insert on hit so the first key is the LRU.
  private readonly cache = new Map<number, Uint8Array>();
  private readonly inflight = new Map<number, Promise<Uint8Array>>();

  constructor(
    private readonly blob: Blob,
    options: BlobByteSourceOptions = {},
  ) {
    const { pageSize = 64 * 1024, maxPages = 64 } = options;
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
      throw new RangeError(`Invalid pageSize: ${pageSize}`);
    }
    if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
      throw new RangeError(`Invalid maxPages: ${maxPages}`);
    }
    this.size = blob.size;
    this.pageSize = pageSize;
    this.maxPages = maxPages;
  }

  /** Number of pages currently cached (for tests/diagnostics). */
  get cachedPages(): number {
    return this.cache.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    validateArgs(offset, length, this.size);
    const end = Math.min(this.size, offset + length);
    if (end <= offset) return new Uint8Array(0);

    const firstPage = Math.floor(offset / this.pageSize);
    const lastPage = Math.floor((end - 1) / this.pageSize);
    const out = new Uint8Array(end - offset);

    for (let p = firstPage; p <= lastPage; p++) {
      const page = await this.getPage(p);
      const pageStart = p * this.pageSize;
      const from = Math.max(offset, pageStart);
      const to = Math.min(end, pageStart + page.length);
      if (to > from) out.set(page.subarray(from - pageStart, to - pageStart), from - offset);
    }
    return out;
  }

  private getPage(index: number): Promise<Uint8Array> {
    const hit = this.cache.get(index);
    if (hit) {
      this.cache.delete(index);
      this.cache.set(index, hit);
      return Promise.resolve(hit);
    }
    const pending = this.inflight.get(index);
    if (pending) return pending;

    const start = index * this.pageSize;
    const end = Math.min(this.size, start + this.pageSize);
    const promise = this.blob
      .slice(start, end)
      .arrayBuffer()
      .then((buf) => {
        const page = new Uint8Array(buf);
        // The file may have shrunk since it was opened; never zero-fill or cache a short page.
        if (page.length !== end - start) {
          throw new Error(`Short read at ${start}: expected ${end - start} bytes, got ${page.length}`);
        }
        this.cache.set(index, page);
        while (this.cache.size > this.maxPages) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.cache.delete(oldest);
        }
        return page;
      })
      .finally(() => this.inflight.delete(index));
    this.inflight.set(index, promise);
    return promise;
  }
}

/** Rejects if the blob cannot be read (e.g. a dropped folder). Reads at most one byte. */
export async function probeReadable(blob: Blob): Promise<void> {
  await blob.slice(0, 1).arrayBuffer();
}
