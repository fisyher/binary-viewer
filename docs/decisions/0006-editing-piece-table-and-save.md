# ADR-0006: Editing as a piece table over the base source; save in place or by download

## Status

Accepted

## Date

2026-10-30

## Context

Users edit bytes (overwrite, insert, delete) in files that may be too large to hold in memory, with undo/redo, and save the result. The File System Access API (in-place saving) exists only in Chromium. `docs/DESIGN.md` records the browser stance as Chromium-first with a graceful fallback.

## Decision

`EditBuffer` (`src/core/edit-buffer.ts`) is a piece table over the base `ByteSource`: `orig` pieces point into the base, `added` pieces into an append-only chunked store (capped at 256 MiB; undo history capped at 10,000 steps). Adjacent contiguous pieces are merged and an edit costs O(pieces after the edit), which `DESIGN.md` judges fine up to about 100,000 pieces. After edits the worker is re-opened on `editBuffer.toBlob(baseBlob)` (lazy slices, no copy).

Saving (`src/core/save.ts`) streams the pieces (Blob slices and byte chunks of at most 4 MiB):

- in place through a `FileSystemFileHandle` (`createWritable()` without `keepExistingData`, aborted on any error), after which the buffer is rebased onto the re-read file;
- Save As through `showSaveFilePicker` when there is no handle;
- a download when the API is unavailable.

Save is guarded: it waits for the HexView edit queue, locks editing, cancels the pending re-parse and blocks New/Open/drop until it ends. Failure modes after `close()` and the download-save caveats are listed in `DESIGN.md` ("Editing" and "Known risks").

## Alternatives considered

- An overlay of changed ranges ("sorted map of changed ranges over the original source"): this is what the first design notes, written before the editing phase, described. The editing commit (`2f2f8f0`) implemented the piece table instead. The documents do not record why; a piece table is the structure that supports inserts and deletes without rewriting the base.
- Holding the whole edited file in memory before saving: not adopted; saving streams from the pieces.

## Consequences

- Two I/O paths (Chromium and fallback) must be built and tested ("Known risks" in `DESIGN.md`).
- Saving a huge file is a full rewrite, and download-based saves in fallback browsers may not be memory-bounded.
- A download save counts as saved once the download starts; the browser reports no completion.
