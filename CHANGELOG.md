# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

This history was reconstructed from `git log`; the development phases are the ones named in the commit messages and in [`docs/DESIGN.md`](docs/DESIGN.md).

## [Unreleased]

Work in progress, not yet in a release:

- IDE-style window layout ([ADR-0011](docs/decisions/0011-ide-shell-and-editor-tabs.md)): a title bar with the file actions, an activity bar that switches the side bar between the structure tree and the format library, editor tabs for the open file and the spec being edited (replacing the Viewer/Formats modes), a resizable data inspector, a bottom Problems panel, and an always-visible status bar with the format name, byte order and theme.
- Several format specs can be open at once as editor tabs ([ADR-0012](docs/decisions/0012-preview-engine-worker.md)): picking a spec in the Formats side bar opens it in a new tab (or shows its tab) without any prompt. Each tab keeps its own unsaved text, view (Builder, JSON, Docs) and save status while another tab is showing, shows a modified dot, and closes with its ×, a middle click or the Delete key (asking first if it has unsaved changes; the neighbour tab takes over). The tab bar scrolls when there are many tabs, and the Formats list marks open and modified specs. The page warns before unload while any spec tab is modified. The Builder's undo history is not kept when you switch tabs.
- Live spec previews now run on their own engine worker, so the Structure side bar, the hex tints and click-to-locate stay live while a spec tab is showing (the "Paused while a format preview is running" state of the first redesign step is gone). The second worker exists only while spec tabs are open and shares the file with the first.
- Panels can be resized (mouse, or arrow keys on a focused divider; double-click resets) and collapsed; sizes and visibility are remembered. On screens narrower than 900 px the side bar and inspector start collapsed and open as drawers.
- Light and dark themes that follow the system, with a System / Light / Dark button in the status bar whose choice is remembered and applied before first paint.
- New look: "Bench" colour tokens (graphite chrome, one amber accent, four structure colours for decoded bytes), IBM Plex Sans Condensed and IBM Plex Mono bundled with the app (no network requests), sentence-case headings, a redesigned start screen.
- The spec editor's Save buttons are now named "Save spec" (the title bar keeps "Save" for the file); Duplicate, Delete and Export moved from the format list into the spec tab's header.
- Structure minimap: a 64 px strip beside the hex grid shows the whole file at a glance, with parsed regions in the structure colours, gaps as faint hairlines, the visible part as an amber frame and the selection as a tick. Click or drag on it to jump (the view centres there), scroll the wheel over it, or use PageUp/PageDown/Home/End when it is focused. It works on 64 MiB files and larger without extra memory (the format engine summarises the tree in under a millisecond), stays blank-but-useful when no format is parsed, hides below 600 px width and has a stored `showMinimap` preference. New worker request `overview`.
- Command palette: <kbd>Ctrl</kbd>+<kbd>K</kbd> or <kbd>F1</kbd> (<kbd>Cmd</kbd>+<kbd>K</kbd> on macOS), or the search button in the title bar, opens a searchable list of every command: open, new, save, go to offset, choose the format, show or hide the side bar, inspector, Problems panel and minimap, theme and byte order, switch between editor tabs, open a library spec, the keyboard shortcuts and About. Matching is fuzzy (letters in order, case-insensitive, matched letters underlined); commands that cannot run are dimmed with the reason; the last five commands used come first and are remembered. Go to offset and Choose format ask for their input inside the palette. <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> is not used because Firefox keeps it for a private window.
- The minimap can now be switched off and on again (palette commands "Hide minimap" / "Show minimap"); the choice is remembered.
- <kbd>Ctrl</kbd>+<kbd>S</kbd> now saves the open file when the file tab is shown (it used to open the browser's Save page dialog); in a spec tab it still saves the spec.
- UX refinement, stage 1:
  - A **breadcrumb bar** replaces the format row above the hex view: the path from the root to the node you clicked in the hex view or the tree, or to the byte under the caret as you move it with the keys (looked up 150 ms after the last key). Click a segment to select that node; long paths collapse their leading segments to "…". It reads "No structure" without a parse.
  - The **format controls moved to the status bar**: the format name (with "(extension only)" when the detection is weak) opens the format picker in the command palette; the parse state is "Parsing…" with a Cancel button, then a compact summary such as "22 nodes · 0 errors · 1 warning" that opens and focuses the Problems panel (the node count hides below 720 px); engine errors show there too. The format selector is gone.
  - Status bar items are buttons: the selection opens *Go to offset*, *Insert* / *Overwrite* switches the edit mode.
  - **F6 / Shift+F6** move focus between the regions of the window (activity bar, side bar, editor, Problems, inspector, status bar), skipping collapsed ones; palette commands *Focus side bar*, *Focus editor*, *Focus Problems* and *Focus inspector* open a collapsed region first.
  - Click targets are at least 24 x 24 px: the tree's twisty and jump buttons (tree rows are 24 px tall now), the panel and title bar buttons, the status bar buttons; the divider's hit area is 17 px wide and it shows a 2 px line while hovered or dragged.
  - Structure colours no longer rely on hue alone: the hex view and the minimap now colour a file whose root has a single child the same way, the tree marks top-level groups with an 8 px swatch and the nodes inside them with a coloured rule, the minimap tooltip names the region under the pointer ("name · 0xOFFSET"), a 1 px line separates neighbouring regions, and the four colours of both themes differ enough in lightness to be told apart. `overview` regions carry a `name`.
  - The light theme's focus ring and selection colour are darker (3:1 or more on every background); a test checks the contrast.
  - Activity bar items show their label as a tooltip on keyboard focus, and after a short delay on hover.
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
