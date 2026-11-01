# Architecture decision records

Decisions that shaped Binary Viewer, in the order they were made. Each record states what the evidence (design notes, code, commit history) shows; where a reason was not written down, the record says so. Dates are commit dates from `git log`.

Format: `NNNN-short-title.md` with the sections Status, Date, Context, Decision, Alternatives considered, Consequences. To change a decision, add a new record and mark the old one "Superseded by ADR-NNNN" instead of rewriting it.

| ADR | Decision | Date |
|---|---|---|
| [0001](0001-client-side-static-app.md) | Fully client-side static app, hosted on GitHub Pages from the `gh-pages` branch | 2026-10-30 |
| [0002](0002-svelte-typescript-vite.md) | Svelte 5, TypeScript (strict) and Vite | 2026-10-30 |
| [0003](0003-own-declarative-format-language.md) | Own declarative JSON format language with Kaitai-style naming and our own interpreter | 2026-10-30 |
| [0004](0004-parsing-in-a-web-worker.md) | Parse in a Web Worker; plain TypeScript, no WASM in v1 | 2026-10-30 |
| [0005](0005-lazy-byte-access-and-custom-hex-grid.md) | Lazy byte access via `ByteSource` (Blob paging + LRU) and a custom windowed hex grid | 2026-10-30 |
| [0006](0006-editing-piece-table-and-save.md) | Editing as a piece table; save in place or by download | 2026-10-30 |
| [0007](0007-untrusted-input-limits.md) | Treat files and specs as untrusted; limits and budgets in the engine | 2026-10-30 |
| [0008](0008-spec-storage-indexeddb-and-folder-sync.md) | Specs in IndexedDB, optional folder sync, verify mode after timeouts | 2026-10-30 |
| [0009](0009-no-network-requests.md) | No network requests at runtime | 2026-10-31 |
| [0010](0010-deferred-refs-and-navigation-links.md) | Deferred refs and navigation links | 2026-10-31 |
| [0011](0011-ide-shell-and-editor-tabs.md) | IDE-style shell, editor tabs, light and dark themes, bundled fonts | 2026-11-02 |
