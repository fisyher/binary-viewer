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
