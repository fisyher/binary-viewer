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

### Format engine (Phase 3, extended in Phase 6a)

What the declarative engine (`src/core/engine/`) implements. Everything here is generic; nothing is format-specific.

- **Types and fields.** `types` map names to ordered `fields`. Field types: primitives `u1..u8`/`s1..s8` with explicit `le`/`be` (the spec-level `endian` is the default for suffix-less multi-byte types; the host byte order is never used), `f4`/`f8`, `str`, `bytes`, user types (structs), `{ switch, cases, default }` and the computed `value` type. Modifiers: `size` (a substream for user types, the length for `str`/`bytes`), `terminator`/`encoding` (`ascii`, `latin1`, `cp437`, `utf8`, `utf16le`, `utf16be`), `repeat` (`count`, `until`, `eos`), `enum`, `bits`, `expect`, `assert`, `doc`. `size` together with `repeat` is rejected (the size would be ignored): wrap the sized element in its own type and repeat that. Compatibility note: specs that combined `size` with `repeat`, or named a field `lookup` (now a reserved word like `min`/`max`), no longer validate.
- **Positioning.** Fields are sequential by default. `at` (absolute offset, inside the enclosing substream) and `find` (below) place a field without moving the parent cursor and are mutually exclusive; a failing sequential field stops the struct, placed fields still parse. Not implemented, and not planned: relative/pointer sugar (`rel`, `ptr`), `align`, TLV `chunks` and `scanBackFrom`. They are expressed with `at`, `find`, `switch` and `repeat`.
- **Guards.** `if` (boolean expression) and `ifMagic` (`{ at, bytes, mask? }`, at most 64 bytes): the field is skipped (reads as `null`) when the condition fails; both must pass and `if` is evaluated first. `ifMagic` is a quiet guard: a position that is negative, unsafe, `null`, outside the enclosing stream, or a short read (the bytes are not there) all mean "no". A real source I/O failure and an expression that cannot be evaluated are reported on the field like a bad `if`; a budget stop still ends the parse.
- **Signature search (`find`).** `{ bytes, mask?, from, window, direction, accept? }`. The window is `[from - window, from)` (`backward`) or `[from, from + window)` (`forward`), clipped to the enclosing stream; a signature must lie wholly inside it. The window is read in chunks of at most 64 KiB (overlapping by `bytes - 1`) through the normal read budget, so a hit near the end of a multi-GiB file costs about one window. Candidates are ordered nearest-to-`from` first. Without `accept` the nearest candidate wins. With `accept` (tiers of expressions, tried in order) each candidate is probe-parsed as the field's own type in a throw-away run (no nodes, no diagnostics, private node ids, at most `maxProbeSteps` steps and min(1 MiB, remaining budget) of reads / 1000 reads; its reads, bytes and steps are charged to the real run, and it spends the real run's `lookup` budget) and a tier is evaluated in that probe's scope (the probed type's fields, `_start`, `_io`, `_parent`); the first candidate a tier accepts wins, a failing or non-boolean expression rejects the candidate. No (accepted) candidate is a field error like a failed `at`. More than one hit adds a warning "N other matches in search window"; hitting `maxFindCandidates` is reported too. `find` cannot be combined with `at` or `repeat`.
- **Struct scope.** Every struct scope exposes `_start` (the absolute offset where the struct begins), also through member access (`eocd._start`). Other context names: `_io.size/start/end/pos/eof`, `_parent` (one level), `_root`, `_index`, `_` (the field's own value in `assert`/`until`/`ref.at`).
- **Computed fields.** `{ "type": "value", "value": "<expr>" }` consumes no bytes, defines its name (integer, string, boolean, struct, `null`) and produces a size-0 node at the current cursor. An expression error is reported on that node and the value is `null`; it never fails the struct. `if`, `ifMagic`, `assert` and `ref` work on it; `size`, `repeat`, `at`, `find` and friends do not apply.
- **Expressions.** Hand-written parser (never `eval`), BigInt-safe, checked arithmetic, C-style conditional `c ? a : b` (short-circuit, lowest precedence), `&&`/`||`/`and`/`or`/`not`, `==` on `null`, `min`, `max` and `lookup(list, "member", value)`: the first element (a struct) of an array whose member equals the value, or `null`; the member must be a string literal. `lookup` only searches elements the interpreter kept (parsed eagerly, at most `eagerElements` per array); lazy and skimmed elements are not searched. All lookups of one parse (including `find` probes) or of one `expandLazy` / `expandRef` call together may examine `maxLookupScan` elements (the budget is per call, like the other per-call budgets, not cumulative across calls); the scan checks for abort every 1024 elements.
- **Deferred pointers (`ref`).** `{ type, at, doc? }` on any field: during parse `at` is evaluated (a safe offset no larger than the file size, else a warning and no ref) and the node records `ref: { typeName, offset }`; nothing is parsed. `expandRef(result, nodeId)` (worker request `expandRef`) parses the target type at that offset over the whole file, so it may leave the substream the ref was found in, with the owning struct's scope as `_parent` (so target expressions can read `_parent.some_field`), then attaches the subtree under the node (`ref.loaded`, target flagged `fromRef`) and returns it; opening twice (even concurrently) returns the same nodes. Per-call budgets (nodes, steps, I/O, lookup scan) are fresh per expansion, but all expansions of one parse result together may create at most `maxRefNodesTotal` nodes (1,000,000; a clear error when exhausted), refs inside an expanded target are only opened on demand, nothing is ever followed automatically. The structure tree shows "open <type> @ 0x..." under such a node. Retained refs are keyed by tree path, so reloading a lazy page replaces them instead of accumulating (`maxRefs` caps distinct refs; the nodes of a replaced page are no longer openable, which is fine because the UI replaces them on reload). `findNodeAt` prefers the primary tree where it really owns the byte: a hit that is the ref node or one of its ancestors (a container that merely encloses the target) loses to the expanded target, an unrelated sibling or leaf wins; the byte ranges include expanded targets.
- **Strict expectations.** `expect` records a validation message and parsing continues; with `"fatal": true` a mismatch fails the field like a read error (the struct stops, a repeat ends at that element) with an "expected X, found Y" message.
- Output: tree of `{ name, type, offset, size, value, children | lazy, ref }` that drives highlighting, jump-to and the structure tree. Large arrays are lazy: elements beyond `eagerElements` are parsed on demand (`expandLazy`).
- Untrusted-input limits (`DEFAULT_LIMITS`): recursion depth, node/skim/step budgets, total I/O bytes and read count, array counts bounded by the bytes that remain, (type, offset) cycle detection, forward-progress checks, `maxFindWindow` (1 MiB; the validator also rejects larger literal windows), `maxFindCandidates` (256 probes), `maxProbeSteps`, `maxLookupScan`, `maxRefs`; cancellable via `AbortSignal`. Specs themselves are untrusted too (size/depth caps, validator with JSON paths).
- Detection: magic bytes (incl. end-relative) outrank extension; ranked list, user override.
- Documentation is generated from the same schema (fields, magic, offsets, `find`/`ifMagic`/`value`/`ref`/`fatal`, `doc` strings).

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
- **Folder sync and timed-out writes.** A file-system call that does not answer within 30 s is abandoned, but the browser may still complete it later (a stale write can land at any time). After any folder *timeout* the library therefore stops trusting everything it remembers about the folder: the folder is marked "needs permission", the remembered per-file state (`known`) is cleared, and a persisted flag `folderNeedsVerify` is set. Until the user reconnects, saves stay local (message "Folder needs verification after a timed-out write"). The first sync after reconnecting runs in *verify mode*: it writes nothing and deletes nothing, keeps pending deletes, keeps every local spec as is, saves each *differing* folder file as a local conflict copy `<id>-conflict-<n>` (identical copies are reused, never duplicated), records equal files as known, and adds files that have no local spec. Afterwards the flag is cleared and later syncs are normal (so a local version that differs from the folder may then be pushed, with the folder's version safe in the copy). Residual risk, accepted: a timed-out write that lands *after* the verify sync. Writes realistically land within seconds, and the verify sync only runs once the user reconnects, so no further machinery is built for that window. Deleting a spec while verification is pending, or whose file has no remembered content, never deletes the file: the user is told to delete it manually.
- **Verify mode keeps the local spec.** The verify sync never decides in favour of the folder: if a file differs, the local spec stays the spec and the folder's version is saved as a conflict copy. A legitimate external edit made during the timeout window therefore ends up as the conflict copy, and the next normal sync pushes the local version over the folder file. Conflict copies are ordinary specs and are not pinned: editing or deleting a copy before that next sync is a user action and can discard that version. Verification only completes when the whole folder was read and every differing file was kept as a copy; otherwise the flag stays set (a folder with more than 500 `.json` files can never be verified: saves stay local and a persistent message says so). Connecting or disconnecting a folder clears the flag, which is the escape hatch. A spec deleted while verification is pending leaves a tombstone (a pending delete without content hash): the file is never deleted, a sync will not bring the spec back, the user is told to remove the file manually, and creating or importing the id again clears the tombstone.
