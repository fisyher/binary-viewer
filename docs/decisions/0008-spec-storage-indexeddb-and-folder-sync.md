# ADR-0008: Store specs in IndexedDB, sync to a user-chosen folder, verify after timeouts

## Status

Accepted

## Date

2026-10-30

## Context

The requirement asks for built format specs and documentation to be saved in a local folder, with no backend. Browsers give a folder to a web page only through the File System Access API (`showDirectoryPicker()`, Chromium only), and a file-system call can stall (for example on a network drive).

## Decision

The spec library (`src/core/spec-library.ts`, commit `f02a62c`) keeps built-in specs read-only and user specs in IndexedDB (`spec-store.ts`, with a resilient fallback when IndexedDB is unavailable). On Chromium the user can connect a folder: the handle is persisted in IndexedDB and permission is re-requested on a user gesture. Elsewhere, specs are imported and exported as JSON.

Folder sync (`spec-folder.ts`) treats everything read from the folder as untrusted: only valid specs are written; file names must match a safe pattern and new names are derived only from validated lower-case ids; a file is never overwritten or deleted unless it is unchanged since the last sync; when both sides changed, a deduplicated conflict copy is saved; files over 1 MiB are refused, and so are folders with more than 500 `.json` files (see the verify-mode limit below).

Every file-system call has a 30 s timeout. A call that times out may still complete later, so after a timeout the library stops trusting what it remembers about the folder, and the next sync after the user reconnects runs in **verify mode**: it writes and deletes nothing, keeps local specs as they are, saves each differing folder file as a conflict copy, and records equal files as known. `docs/DESIGN.md` ("Known risks") describes the mode, its limits (a late write landing after the verify sync is an accepted residual risk) and the tombstone rule for deletes.

## Alternatives considered

- Folder only, with no IndexedDB: not adopted; non-Chromium browsers have no folder access, and the library needs a store that works without it.
- Trusting the folder state after a timeout: rejected because a stale write can land at any time.

## Consequences

- Specs exist in two places for Chromium users, and conflict handling is part of the product (conflict copies are ordinary specs).
- A folder with more than 500 `.json` files can never be verified; saves then stay local and the user is told.
- The sync code needs fake timers and fake file systems in tests (`spec-library-*.test.ts`).
