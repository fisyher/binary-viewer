# BinaryViewer — Design

Source requirement: [`requirements/2026-10-30_135401.md`](../requirements/2026-10-30_135401.md)

A fully client-side hex editor + binary format builder, hostable as static files (GitHub Pages).

## Decisions

| Area | Choice | Why |
|---|---|---|
| UI | Svelte 5 + TypeScript, Vite | Small runtime, fine-grained reactivity for a fast-updating grid/inspector |
| Tests | Vitest (unit), Playwright (E2E: Chromium + Firefox/WebKit fallback path) | Every behaviour change ships with a test |
| Browsers | Chromium-first, graceful fallback | File System Access API is Chromium-only |
| Parsing core | Plain TS in a Web Worker; no WASM in v1 | Interpreter over small slices; JS is fast enough |
| Format language | Own JSON schema using Kaitai Struct (KSY) semantics/naming, own interpreter | Kaitai JS runtime needs the whole file in memory, has no byte-range tracking; compiler is GPL-3 |
| Hex grid | Custom fixed-row-height DOM windowing | Rows are uniform; no library needed |

## Architecture

```
src/
  core/        framework-free, fully unit-tested
    byte-source.ts   ByteSource interface; BlobByteSource (Blob.slice + LRU page cache)
    edit-overlay.ts  patch layer over a ByteSource (Phase 4)
    hex-format.ts    offset/byte/ASCII formatting helpers
    inspector/       Data Inspector decoders (Phase 2)
    engine/          format schema, expression parser, interpreter (Phase 3)
  worker/      Web Worker hosting parsing/detection/search (Phase 3)
  ui/          Svelte components (HexView, Inspector, StructureTree, Builder)
  formats/     built-in specs (bmp.json, zip.json)
```

### Byte access (all phases)

- `ByteSource { size: number; read(offset, length): Promise<Uint8Array> }`.
- Reads are bounds-checked: negative, non-integer, or past-EOF requests are clamped or rejected — never trusted.
- `BlobByteSource` reads via `Blob.slice(...).arrayBuffer()` in fixed pages (default 64 KiB) with an LRU cache. The whole file is never loaded.
- Edits (Phase 4) are an overlay: sorted map of changed ranges over the original source. Save streams original chunks + patches to `createWritable()` (Chromium) or a download (fallback).

### Hex view

- Fixed row height; visible rows = `floor(scrollTop / rowHeight)` + overscan. Only ~50–100 DOM rows exist.
- Browsers cap element height (~16–33M px); for files whose row count exceeds that, scroll position is mapped proportionally onto a capped spacer.
- 16 bytes/row; offsets in hex; ASCII column renders non-printables as `.`.
- Selection: click / shift-click / drag over bytes; anchor + caret model.

### Format engine (Phase 3)

- Schema: `types` of `fields`; primitives `u1..u8`/`s1..s8` with explicit `le`/`be` (spec default resolved at load time, never host order), `f4`/`f8`, `str`, `bytes`, `bits`, `enum`; composites `struct`, `array` (`count`/`size`/`until`/`eos`), `chunks` (TLV), `switch`, `if`; positioning `at`, `rel`, `ptr`, `align`, `scanBackFrom: "eof"`, substream `size`.
- Expressions: hand-written parser (never `eval`), BigInt-safe, checked arithmetic.
- Output: tree of `{ name, type, offset, size, value, children | lazy }` → drives highlighting, jump-to, and structure tree.
- Untrusted-input limits: recursion depth, node budget, array count bounded by remaining bytes, pointer cycle detection, forward-progress checks, cancellable via `AbortSignal`. Specs themselves are untrusted too (size/depth caps, JSON-schema validation).
- Detection: magic bytes (incl. end-relative) outrank extension; ranked list, user override.
- Documentation is generated from the same schema (fields, magic, offsets, `doc` strings).

### Storage of format specs

- Chromium: `showDirectoryPicker()`, handle persisted in IndexedDB, permission re-requested on a user gesture.
- Fallback: JSON import/export.

### Editing (Phase 4)

- `EditBuffer` (src/core/edit-buffer.ts) is a piece table over the base `ByteSource`: `orig` pieces point into the base, `added` pieces into an append-only chunked store (cap 256 MiB; history cap 10k steps). Piece lookup is a binary search over cached offsets; an edit costs O(pieces after the edit), fine to ~100k pieces. Adjacent contiguous pieces are merged.
- Keyboard: hex digits edit nibbles (first = high, second = low, then advance); the ASCII column writes printable ASCII; Insert toggles Overwrite/Insert (shown in the status bar). **Delete always deletes** (selection, or the byte at the caret) in both modes, and Backspace deletes the selection or the byte before the caret; this has not been checked against HxD. Pastes go to the start of the selection and do not replace the rest of it. Copy is hex text only.
- Undo steps: typed edits at adjacent positions within 1 s coalesce; arrows, clicks and go-to break the group. Saving clears the history (the base is replaced).
- After edits the worker is re-opened (debounced 300 ms) on `editBuffer.toBlob(baseBlob)` (lazy slices, no copy) and the chosen spec is parsed again; the tree keeps expansion/selection for nodes whose name path still matches.
- Save (src/core/save.ts): `streamPieces` yields Blob slices / byte chunks (4 MiB max). In-place via a `FileSystemFileHandle` (`createWritable()` without `keepExistingData`; aborted on any error; after `close()` the buffer is rebased onto `handle.getFile()` at once because the old File becomes unreadable). Without a handle: Save As via `showSaveFilePicker`; without the API: a download.
- Save safety: Save first awaits the HexView edit queue (`settled()`), then locks editing, cancels the pending re-parse and blocks New/Open/drop until it ends; queued edits that run after the lock are dropped. If the re-read after `close()` fails, the data is on disk but the document is frozen read-only with a notice (reopen the file); if the new file's size differs from what was written, the file is reloaded from disk with a notice. Download saves rebase onto a lazy Blob of the saved content (releasing the added store) and count as saved once the download starts: the browser reports no completion, so cancelling the download in the browser leaves the document marked clean. `toBlob` caches one Blob per added-store chunk. After a download save the typed bytes live in the browser's Blob storage (the rebase base is a lazy Blob of the saved content, which references them), so memory is not freed, but the 256 MiB added-store cap applies per save cycle.

## Roadmap

1. **Core + Hex view** — scaffold, `ByteSource`, formatting helpers, virtualized read-only hex/ASCII grid, open via picker or `<input type=file>`, selection, go-to-offset.
2. **Data Inspector** — int8–64 (LE/BE), float16/32/64, binary, DOS date/time, FILETIME, Unix time, GUID, LEB128, UTF-8/16 char.
3. **Format engine + BMP** — schema, interpreter in worker, detection, structure tree, range highlighting, jump-to.
4. **Editing & save** — edit overlay, byte typing, undo, new file, save/save-as.
5. **Format builder + docs generator** — visual editor over the JSON schema, local-folder persistence, HTML/Markdown docs.
6. **ZIP** — EOCD back-scan, ZIP64, lazy central directory.

## Known risks

- Two I/O code paths (Chromium vs fallback) to build and test.
- Saving a huge file is a full rewrite.
- Download-based save in fallback browsers may not be memory-bounded.
