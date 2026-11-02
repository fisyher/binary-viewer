<div align="center">

<img src="public/favicon.svg" alt="Binary Viewer logo" width="96" height="96">

# Binary Viewer

**Hex editor and binary format inspector that runs entirely in your browser.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Svelte 5](https://img.shields.io/badge/Svelte-5-ff3e00?logo=svelte&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white)

**[Open the app](https://fisyher.github.io/binary-viewer/)**

[Features](#features) • [Getting started](#getting-started) • [Usage](#usage) • [Format specs](#writing-a-format-spec) • [Development](#development)

</div>

Open any file, read and edit its bytes, and see its structure decoded field by field. Binary Viewer is a static web app: there is no server, files are read in small slices straight from disk, and nothing you open ever leaves your machine.

## Features

- **Hex/ASCII view for huge files.** A virtualized grid reads 64 KiB pages on demand, so multi-gigabyte files open instantly without being loaded into memory.
- **Editing and saving.** Overwrite or insert bytes in the hex or ASCII column, undo/redo, create new files, and save in place or with *Save As*.
- **Data Inspector.** Decodes the bytes at the caret as 8–64-bit integers (LE/BE), float16/32/64, binary, DOS date/time, FILETIME, Unix time, GUID, LEB128 and UTF-8/16 characters.
- **Structure minimap.** A strip beside the hex grid shows the whole file with its parsed regions in colour and the visible part framed; click or drag to jump anywhere, even in a multi-gigabyte file. Hovering it names the region under the pointer. The hex view, the minimap and the tree's swatches use the same four colours, and the tree marks each top-level group with a swatch so the colours are never the only cue.
- **Structure decoding.** Files are detected by magic bytes and extension and parsed in a Web Worker into a navigable tree. Selecting a node highlights its bytes.
- **Jump to data.** Offset fields carry *go to* buttons, and ZIP entries have *local header / data / descriptor* shortcuts that select an entry's compressed data in one click.
- **Built-in formats.** Windows Bitmap (BMP, all header versions) and ZIP (ZIP64, self-extracting stubs, data descriptors, large central directories loaded on demand).
- **Format builder.** Write your own formats as JSON specs, with a visual builder, a JSON editor with live preview against the open file, and generated documentation that you can export as Markdown or HTML.
- **Spec library.** Specs are stored in the browser and can be synced to a local folder of your choice, or imported and exported as JSON.
- **Comfortable to read.** A UI zoom (90–130%, <kbd>Ctrl</kbd>+<kbd>=</kbd> / <kbd>Ctrl</kbd>+<kbd>-</kbd>), faint banding of every other 8-byte group in the hex and ASCII columns, resizable tree columns with full values on hover, and motion that is off with *reduced motion*.
- **Document-editor layout.** An activity bar, a side bar (structure or format library), editor tabs for the open file and the spec you are editing, a data inspector and a Problems panel. Panels resize with the mouse or the arrow keys and collapse; a breadcrumb path above the hex view; a status bar whose items (format, parse summary, selection, edit mode, byte order, zoom, theme) are buttons; a search field in the title bar that opens the command palette; **Reset layout** in the palette; keyboard region navigation with F6; light and dark themes follow the system, with a remembered override in the status bar.

> [!NOTE]
> Every input file is treated as untrusted. Reads are bounds-checked, lengths from the file are never trusted, and parsing runs under strict node, step and I/O budgets, so a malformed or hostile file cannot hang or exhaust the app.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 20.19+ or 22.12+ (required by Vite 8) and npm
- A modern browser. Chromium-based browsers (Chrome, Edge) get the full feature set; see [Browser support](#browser-support).

### Run locally

```bash
git clone https://github.com/fisyher/binary-viewer.git
cd binary-viewer
npm install
npm run dev
```

Then open the URL that Vite prints, usually <http://localhost:5173/>.

### Build for production

```bash
npm run build
```

The output in `dist/` is a fully static site. It uses relative asset paths, so it can be served from any subpath.

### Deployment

Changes go through pull requests into `main`:

- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every pull request: type checks, unit tests, and the Playwright end-to-end tests against the production build.
- [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs on every push to `main` (a merged pull request): it runs the same CI, then publishes the build CI tested to the `gh-pages` branch, which GitHub Pages serves at <https://fisyher.github.io/binary-viewer/>.

Both workflows can also be started by hand from the **Actions** tab.

## Usage

1. Click **Open…** or drop a file anywhere on the window.
2. Browse the bytes in the hex view, or type an offset (hex or decimal) in **Go to**.
3. If the format is recognized, the **Structure** side bar shows the decoded tree, and the status bar names the format. Click a node to select its bytes (clicking a byte in the hex view puts the caret on that byte, so you can edit it, and finds and highlights the field it belongs to in the tree), and use the **→** buttons to jump to the data an offset points to. The **breadcrumb** above the hex view shows the path to the node you clicked, or to the byte under the caret as you move it with the keys; click a segment to select that node. In the status bar, the format name opens the format picker, the parse summary (for example "22 nodes · 0 errors · 1 warning") opens the **Problems** panel under the hex view, the selection opens *Go to offset*, and *Insert* / *Overwrite* switches the edit mode.
4. Type over bytes to edit them, then **Save** or **Save As…**.
5. Choose **Formats** in the activity bar (the left strip) to browse the built-in specs and your own. Picking one opens it in its own editor tab, next to the file, with its Builder, JSON and Docs views and a live preview on the open file. You can keep several spec tabs open: each remembers its unsaved text (a dot marks a modified tab, and the Formats list marks open and modified specs), and you can switch between them and the file, or keep using the Structure side bar, while a preview runs. Close a tab with its **×**, a middle click or <kbd>Delete</kbd> on the focused tab (it asks first if the spec has unsaved changes).
6. Drag the dividers (or focus one and press the arrow keys) to resize the side bar, the inspector and the Problems panel; double-click a divider to reset it, or right-click it (or press <kbd>Shift</kbd>+<kbd>F10</kbd>) for **Reset layout**, which also restores the tree columns and the minimap. Every column of the structure tree (Name, Value, Type, Offset, Size) has a divider in the tree's header. Click the active activity bar item to hide the side bar. The theme button at the right of the status bar cycles System, Light and Dark.
7. Press <kbd>F6</kbd> (<kbd>Shift</kbd>+<kbd>F6</kbd> to go back) to move the keyboard focus from one region of the window to the next: activity bar, side bar, editor, Problems panel, inspector, status bar. Collapsed panels are skipped; the palette has *Focus side bar / editor / Problems / inspector* commands that also open a collapsed panel.
8. Press <kbd>Ctrl</kbd>+<kbd>K</kbd> or <kbd>F1</kbd> (<kbd>Cmd</kbd>+<kbd>K</kbd> on macOS), or click the search field in the title bar, to open the **command palette**: type a few letters of any command (the letters you typed are underlined, and they need not be next to each other), use <kbd>↑</kbd> / <kbd>↓</kbd> to choose and <kbd>Enter</kbd> to run it, <kbd>Esc</kbd> to close. It can open, save and create files, go to an offset, choose the format, show or hide the side bar, inspector, Problems panel and minimap, switch the theme and byte order, switch between and open editor tabs and format specs, and show the keyboard shortcuts. Commands that cannot run right now are dimmed with the reason. The last few commands you used are listed first.
9. Make everything larger or smaller with <kbd>Ctrl</kbd>+<kbd>=</kbd> and <kbd>Ctrl</kbd>+<kbd>-</kbd> (90%, 100%, 115%, 130%; <kbd>Ctrl</kbd>+<kbd>0</kbd> goes back to 100%, as does the zoom button the status bar shows while it is not 100%). This zooms the page's own interface, not the browser. "Toggle hex row banding" in the palette turns the faint stripes in the hex view off and on.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>K</kbd> / <kbd>F1</kbd> | Open the command palette (<kbd>Cmd</kbd>+<kbd>K</kbd> on macOS) |
| <kbd>F6</kbd> / <kbd>Shift</kbd>+<kbd>F6</kbd> | Move focus to the next / previous region (activity bar, side bar, editor, Problems, inspector, status bar) |
| <kbd>Insert</kbd> | Toggle insert / overwrite mode |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> | Undo / redo |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> | Copy the selection as hex |
| <kbd>Ctrl</kbd>+<kbd>Home</kbd> / <kbd>Ctrl</kbd>+<kbd>End</kbd> | Go to the start / end of the file |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Save the file, or the format spec in a spec tab |
| <kbd>Ctrl</kbd>+<kbd>=</kbd> / <kbd>Ctrl</kbd>+<kbd>-</kbd> | Zoom the interface in / out (90%, 100%, 115%, 130%) |
| <kbd>Ctrl</kbd>+<kbd>0</kbd> | Reset the zoom to 100% |
| <kbd>Shift</kbd>+<kbd>F10</kbd> / <kbd>Menu</kbd> | On a focused divider: open its context menu (Reset layout) |

### Browser support

| Feature | Chromium (Chrome, Edge) | Firefox, Safari |
|---|---|---|
| View, inspect, decode, edit | ✅ | ✅ |
| Save in place | ✅ File System Access API | Downloads a copy |
| Sync specs to a local folder | ✅ | Import / export JSON |

## Writing a format spec

Formats are declarative JSON documents interpreted by the app's own engine; specs never run code. The schema borrows naming and semantics from [Kaitai Struct](https://kaitai.io/): types are lists of fields, with explicit byte order for every multi-byte integer.

```json
{
  "schemaVersion": 1,
  "id": "example",
  "name": "Example Format",
  "endian": "le",
  "extensions": ["exm"],
  "detect": [{ "at": 0, "bytes": "45 58 4D 21" }],
  "root": "file",
  "types": {
    "file": {
      "fields": [
        { "name": "magic", "type": "str", "size": 4, "encoding": "ascii", "expect": "EXM!" },
        { "name": "count", "type": "u4" },
        { "name": "data_offset", "type": "u4be",
          "link": { "at": "_", "label": "data" } },
        { "name": "records", "type": "record", "repeat": { "count": "count" } }
      ]
    },
    "record": {
      "fields": [
        { "name": "id", "type": "u2" },
        { "name": "name", "type": "str", "size": 16, "encoding": "ascii" }
      ]
    }
  }
}
```

The engine supports conditional fields, `switch` types, enums and bit fields, absolute placement (`at`), bounded signature search (`find`), computed `value` fields, deferred pointers (`ref`) and navigation links. The full language is documented in the [spec language reference](docs/SPEC-LANGUAGE.md). The **Docs** view of a spec documents every field of it, and [`docs/DESIGN.md`](docs/DESIGN.md) describes the engine in detail. [`src/formats/`](src/formats/) holds the built-in BMP and ZIP specs as complete examples.

> [!TIP]
> Open a sample file before editing a spec: the live preview in the spec tab parses that file as you type.

## Development

| Command | Description |
|---|---|
| `npm run dev` | Start the Vite dev server |
| `npm test` | Run the Vitest suite (unit and jsdom component tests) |
| `npm run check` | Type check with `svelte-check` |
| `npm run build` | Build the static site into `dist/` |
| `npm run e2e` | Run the Playwright end-to-end tests in real browsers |

### Project layout

```
src/
  core/      framework-free logic: byte sources, edit buffer, save, spec library
    engine/  format schema, expression parser, interpreter, docs generator
  worker/    Web Worker that hosts detection and parsing
  ui/        Svelte components (hex view, inspector, structure tree, builder)
    shell/   window layout: title bar, activity bar, side bar, editor tabs, resizers
  formats/   built-in format specs (bmp.json, zip.json)
docs/        design notes, spec language reference, decisions/ (ADRs)
```

Design decisions, engine semantics and known limitations are recorded in [`docs/DESIGN.md`](docs/DESIGN.md). Individual decisions have their own [architecture decision records](docs/decisions/README.md), the spec language is described in [`docs/SPEC-LANGUAGE.md`](docs/SPEC-LANGUAGE.md), and releases are listed in the [changelog](CHANGELOG.md).

> [!IMPORTANT]
> The privacy promise is a design rule: the app makes no network requests at runtime. Keep it that way. New features must work offline and must not send file contents or metadata anywhere.
