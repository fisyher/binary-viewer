# ADR-0004: Parse in a Web Worker, plain TypeScript, no WASM in v1

## Status

Accepted

## Date

2026-10-30

## Context

Detection and parsing walk the file through small reads and can take long on large or hostile input. The UI must stay responsive and a parse must be cancellable when the user opens another file or edits.

## Decision

The engine runs in a module Web Worker (`src/worker/engine.worker.ts`) with a typed request/response protocol (`src/worker/protocol.ts`). Opening or parsing supersedes and cancels the previous work through an `AbortController`; stale responses are dropped and fatal worker errors are latched and shown (commit `e70352b`). The engine is plain TypeScript. `docs/DESIGN.md` states no WASM in v1 because the interpreter works over small slices and "JS is fast enough".

## Alternatives considered

- WASM for the parsing core: deferred ("no WASM in v1"). No measurements are recorded.
- Parsing on the main thread: not discussed in the documents; the worker was introduced together with the first structure UI.

## Consequences

- The UI talks to the engine through messages (`open`, `parse`, `expandLazy`, `expandRef`, `setSpecs`, `parseDraft`, ...), so features that need engine data (lazy arrays, refs, live preview) add protocol requests.
- Engine code can only use APIs available in workers; the engine takes a `ByteSource` rather than a DOM object ([ADR-0005](0005-lazy-byte-access-and-custom-hex-grid.md)).
- Specs and files cross the worker boundary as untrusted data and are re-validated there ([ADR-0007](0007-untrusted-input-limits.md)).
