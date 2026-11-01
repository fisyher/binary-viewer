# ADR-0005: Lazy byte access through ByteSource, and a custom windowed hex grid

## Status

Accepted

## Date

2026-10-30

## Context

The project rules require that very large files are handled without loading them fully into memory, and that every read is bounds-checked. The viewer needs a scrollable hex/ASCII grid over files that can be gigabytes long.

## Decision

All byte access goes through `ByteSource { size; read(offset, length): Promise<Uint8Array> }` (`src/core/byte-source.ts`). Reads are bounds-checked: negative, non-integer or past-EOF requests are clamped or rejected, and one read is capped at 16 MiB (`MAX_READ`). `BlobByteSource` reads with `Blob.slice(...).arrayBuffer()` in fixed pages (64 KiB by default) behind an LRU cache (64 pages by default); the whole file is never loaded. `MemoryByteSource` serves tests and new files.

The hex grid is custom DOM windowing with a fixed row height: only the visible rows plus overscan exist in the DOM (about 50-100 rows). Browsers cap element height (about 16-33 million px), so for files whose row count exceeds that, scroll position is mapped proportionally onto a capped spacer. `docs/DESIGN.md` gives the reason for not using a library: rows are uniform.

## Alternatives considered

- Reading the file into one `ArrayBuffer`: contradicts the project rule above.
- A virtual-list library for the grid: not adopted; DESIGN.md says none is needed because rows are uniform.

## Consequences

- Every consumer (inspector, engine, edit buffer, save) works with asynchronous, range-limited reads.
- The proportional scroll mapping for very large files is extra code that needs its own tests (`virtual-scroll.ts`).
