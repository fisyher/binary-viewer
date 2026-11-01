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
- **Structure decoding.** Files are detected by magic bytes and extension and parsed in a Web Worker into a navigable tree. Selecting a node highlights its bytes.
- **Jump to data.** Offset fields carry *go to* buttons, and ZIP entries have *local header / data / descriptor* shortcuts that select an entry's compressed data in one click.
- **Built-in formats.** Windows Bitmap (BMP, all header versions) and ZIP (ZIP64, self-extracting stubs, data descriptors, large central directories loaded on demand).
- **Format builder.** Write your own formats as JSON specs, with a visual builder, a JSON editor with live preview against the open file, and generated documentation that you can export as Markdown or HTML.
- **Spec library.** Specs are stored in the browser and can be synced to a local folder of your choice, or imported and exported as JSON.

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

Every push to `main` runs [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml): it type checks, runs the tests, builds, and publishes `dist/` to the `gh-pages` branch, which GitHub Pages serves at <https://fisyher.github.io/binary-viewer/>. The workflow can also be started by hand from the **Actions** tab.

## Usage

1. Click **Open…** or drop a file anywhere on the window.
2. Browse the bytes in the hex view, or type an offset (hex or decimal) in **Go to**.
3. If the format is recognized, the **Structure** panel shows the decoded tree. Click a node to select its bytes, and use the **→** buttons to jump to the data an offset points to.
4. Type over bytes to edit them, then **Save** or **Save As…**.
5. Switch to **Formats** to browse the built-in specs, read their documentation, or create your own.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| <kbd>Insert</kbd> | Toggle insert / overwrite mode |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> | Undo / redo |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> | Copy the selection as hex |
| <kbd>Ctrl</kbd>+<kbd>Home</kbd> / <kbd>Ctrl</kbd>+<kbd>End</kbd> | Go to the start / end of the file |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Save the format spec (Formats tab) |

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

The engine supports conditional fields, `switch` types, enums and bit fields, absolute placement (`at`), bounded signature search (`find`), computed `value` fields, deferred pointers (`ref`) and navigation links. The full language is documented in the [spec language reference](docs/SPEC-LANGUAGE.md). The **Formats** tab documents every field of a spec, and [`docs/DESIGN.md`](docs/DESIGN.md) describes the engine in detail. [`src/formats/`](src/formats/) holds the built-in BMP and ZIP specs as complete examples.

> [!TIP]
> Open a sample file in the viewer before editing a spec in the Formats tab: the live preview parses that file as you type.

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
  formats/   built-in format specs (bmp.json, zip.json)
docs/        design notes, spec language reference, decisions/ (ADRs)
```

Design decisions, engine semantics and known limitations are recorded in [`docs/DESIGN.md`](docs/DESIGN.md). Individual decisions have their own [architecture decision records](docs/decisions/README.md), the spec language is described in [`docs/SPEC-LANGUAGE.md`](docs/SPEC-LANGUAGE.md), and releases are listed in the [changelog](CHANGELOG.md).

> [!IMPORTANT]
> The privacy promise is a design rule: the app makes no network requests at runtime. Keep it that way. New features must work offline and must not send file contents or metadata anywhere.
