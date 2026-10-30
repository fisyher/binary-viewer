/**
 * Saving an EditBuffer: a lazy chunk stream plus the places it can be written to.
 *
 * Order matters for in-place saves (Chromium): `createWritable()` buffers into a swap file and atomically replaces
 * the target only on `close()`, so the original base File can be sliced while writing. After `close()` that File
 * becomes unreadable, so the caller must immediately rebase onto the File returned by `writeToHandle`.
 */
import type { EditBuffer } from './edit-buffer';

export const SAVE_CHUNK = 4 * 1024 * 1024;

/** Where saved bytes go. Chunks arrive in document order; implementations must not buffer more than they need. */
export interface SaveTarget {
  write(chunks: AsyncIterable<Blob | Uint8Array>): Promise<void>;
}

/**
 * The document as an ordered stream of pieces no larger than `chunkSize`: lazy `Blob` slices of the base for
 * unmodified ranges, `Uint8Array`s for edited bytes. Never reads base data itself.
 */
export async function* streamPieces(
  editBuffer: EditBuffer,
  baseBlob: Blob,
  chunkSize = SAVE_CHUNK,
): AsyncGenerator<Blob | Uint8Array> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new RangeError(`Invalid chunkSize: ${chunkSize}`);
  for (const p of editBuffer.pieces()) {
    for (let done = 0; done < p.length; done += chunkSize) {
      const n = Math.min(chunkSize, p.length - done);
      if (p.kind === 'orig') {
        const a = p.start + done;
        if (a + n > baseBlob.size) throw new RangeError('Piece lies outside the base file');
        yield baseBlob.slice(a, a + n);
      } else {
        yield editBuffer.readAdded(p.start + done, n);
      }
    }
  }
}

// ---- Download fallback ----

export const REVOKE_DELAY_MS = 10_000;

/**
 * Collects the chunks into one Blob and offers it as a download. `new Blob([...slices, ...bytes])` keeps base
 * slices as references in Chromium; whether Firefox/Safari keep them lazy or copy them is undocumented, so a
 * download of a huge file may use memory there. The object URL is revoked only after a delay: revoking right
 * after click() breaks downloads in Firefox.
 */
export function downloadTarget(fileName: string, revokeDelayMs = REVOKE_DELAY_MS): SaveTarget {
  return {
    async write(chunks) {
      const parts: BlobPart[] = [];
      for await (const c of chunks) parts.push(c as BlobPart);
      const url = URL.createObjectURL(new Blob(parts));
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), revokeDelayMs);
      }
    },
  };
}

// ---- File System Access (in place) ----

export interface WritableLike {
  write(data: Blob | Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface SaveHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<WritableLike>;
  queryPermission?(desc: { mode: 'readwrite' }): Promise<string>;
  requestPermission?(desc: { mode: 'readwrite' }): Promise<string>;
}

export class SavePermissionError extends Error {
  constructor() {
    super('Permission to write the file was denied.');
    this.name = 'SavePermissionError';
  }
}

/** The bytes were written and closed, but the file could not be re-read afterwards. The old base is unusable. */
export class SavedButUnreadableError extends Error {
  constructor(cause: unknown) {
    super(`Saved, but the file could not be re-read (${cause instanceof Error ? cause.message : String(cause)}). Please reopen it.`, { cause });
    this.name = 'SavedButUnreadableError';
  }
}

/** Check (and if needed request, so call from a click handler) readwrite permission. Throws SavePermissionError. */
export async function ensureWritePermission(handle: SaveHandle): Promise<void> {
  if (!handle.queryPermission) return; // browsers without the API grant it at picker time
  if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return;
  if (handle.requestPermission && (await handle.requestPermission({ mode: 'readwrite' })) === 'granted') return;
  throw new SavePermissionError();
}

/**
 * The single in-place write path. Streams the document into `handle` without `keepExistingData` (which would
 * copy the whole file first), aborts the writable on any failure (leaving the original untouched), and on
 * success returns the freshly read File, which the caller must rebase onto before reading anything else.
 * If that re-read fails after a successful close, SavedButUnreadableError is thrown (the data is on disk).
 */
export async function writeToHandle(handle: SaveHandle, editBuffer: EditBuffer, baseBlob: Blob): Promise<File> {
  const writable = await handle.createWritable();
  try {
    for await (const chunk of streamPieces(editBuffer, baseBlob)) {
      await writable.write(chunk);
    }
    await writable.close();
  } catch (e) {
    try {
      await writable.abort?.();
    } catch {
      /* the original error is the useful one */
    }
    throw e;
  }
  try {
    return await handle.getFile();
  } catch (e) {
    throw new SavedButUnreadableError(e); // the write itself succeeded
  }
}

/** Write the document to any SaveTarget. */
export function saveTo(target: SaveTarget, editBuffer: EditBuffer, baseBlob: Blob): Promise<void> {
  return target.write(streamPieces(editBuffer, baseBlob));
}
