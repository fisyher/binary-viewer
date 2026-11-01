# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

This history was reconstructed from `git log`; the development phases are the ones named in the commit messages and in [`docs/DESIGN.md`](docs/DESIGN.md).

## [Unreleased]

Work in progress, not yet in a release:

- Real-browser end-to-end tests with Playwright (`npm run e2e`).
- Pull-request workflow: CI (type checks, unit and end-to-end tests) runs on every pull request into `main`; deployment runs only on pushes to `main` and publishes the build CI tested.
- Svelte 5 best-practice cleanup of the UI components.
- JSDoc comments on the core APIs.
- Documentation: architecture decision records in [`docs/decisions/`](docs/decisions/README.md), the spec language reference [`docs/SPEC-LANGUAGE.md`](docs/SPEC-LANGUAGE.md), this changelog, and a slimmer [`docs/DESIGN.md`](docs/DESIGN.md).

### Fixed

- Format engine client: requests made after the client is disposed now reject at once instead of never settling (they could leave a structure-tree row stuck on "Loading…"); disposing twice is harmless.
- Generated format documentation (Markdown, HTML and the in-app view) no longer misdescribes field positions: computed `value` fields show "computed (no bytes)" instead of a bogus offset, `at` fields are labelled as absolute file offsets, data-dependent positions say "variable (depends on earlier data)", and the header sentence and the reference and link wording say what offsets are relative to. The wording is shared by all three renderers.
- Structure tree: a double-click acts on the row that was clicked first. Clicking a row no longer scrolls the tree (a partly clipped row stays put), the second click of a double-click is ignored, and double-clicking a jump or link button runs it once. Keyboard focus now stays in the tree when the active row scrolls out of the rendered window, so the arrow keys keep working after a click.

## [0.1.0] - 2026-10-31

First version, built in six phases between 2026-10-30 and 2026-10-31.

### Added

- **Hex viewer (phase 1).** Virtualized hex/ASCII grid with selection (click, shift-click, drag), keyboard navigation and go-to-offset (hex or decimal). Files are read lazily through `BlobByteSource`: bounds-checked, paged and LRU-cached, so large files are not loaded into memory. Open with a picker or by drag and drop; read errors are shown with a retry.
- **Data Inspector (phase 2).** Decoders for 8- to 64-bit integers (LE/BE), float16/32/64, binary/octal, ASCII/Latin-1, strict UTF-8 and UTF-16, DOS date/time, FILETIME, 32- and 64-bit Unix time, GUID (Microsoft and RFC 9562 layouts) and LEB128. Untrusted text is shown with visible escapes.
- **Format engine and BMP (phase 3).** Declarative JSON format schema with Kaitai Struct naming, a validator, a hand-written expression language, an asynchronous interpreter with limits and cancellation, lazy arrays, magic-byte and extension detection, and a generated Markdown documentation. Built-in BMP spec covering the core, info, V2-V5 headers, colour masks, palette, pixel data and ICC profile references.
- **Structure tree (phase 3).** The engine runs in a Web Worker; the format bar offers ranked detection with manual override; a virtualized tree supports lazy array paging, keyboard navigation, error and warning badges, jump to and from the hex view, and a diagnostics list.
- **Editing and saving (phase 4).** Overwrite and insert modes, hex and ASCII typing, Delete/Backspace, hex copy and paste, undo/redo with coalescing, new file, dirty indicator and discard confirmation. Save in place or Save As through the File System Access API, with a download fallback in other browsers. The structure is re-parsed after edits.
- **Format library and builder (phase 5).** Spec library with built-in (read-only) and user specs (create, duplicate, rename, delete, import, export) stored in IndexedDB; optional sync to a local folder with conflict copies and a verify mode after timed-out writes. JSON editor with live validation, a documentation view with Markdown and HTML export, a visual builder with 16 building blocks and undo/redo, and a live preview of a draft spec against the open file.
- **ZIP (phase 6).** Engine features for ZIP (`find` signature search with acceptance tiers, `ifMagic`, computed `value` fields, `_start`, `lookup()`, deferred `ref` pointers opened on demand, `fatal` expectations, the `cp437` encoding) and the built-in ZIP spec: end-of-central-directory search, ZIP64, data before the archive, a lazily loaded central directory, local headers, data descriptors and extra fields. Nothing is decompressed or checked for CRC.
- **Jump links.** `link` fields and `ref.jumps` shortcuts select the data an offset points to. ZIP entries get "local header", "data" and "descriptor" buttons; ZIP and BMP offset fields link to the structures they point at.
- **Branding.** The app is named "Binary Viewer": toolbar brand, About dialog (version, build commit and date, privacy and storage, built-in formats, shortcuts), SVG favicon, a start screen, a document title that follows the open file, and an MIT licence.
- **README** with features, usage, browser support, a spec example and development commands.
- **GitHub Pages deployment.** A workflow on push to `main` type checks, tests and builds, then publishes `dist/` to the `gh-pages` branch.

### Changed

- Structs with a declared `size` are self-delimiting: a failure inside one no longer stops the parent struct or ends the parent array (phase 6b). Specs that combine `size` with `repeat`, or name a field `lookup`, no longer validate (phase 6a). Format `extensions` may list up to 64 entries instead of 32 (phase 6b).
- Validator hardening and builder blocks and generated documentation for the new spec keys (phase 6a).
