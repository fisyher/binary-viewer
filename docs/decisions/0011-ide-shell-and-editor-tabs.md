# ADR-0011: IDE-style shell, editor tabs, light and dark themes

## Status

Accepted. The single spec tab and the rule that a draft preview blocks the viewer's tree were replaced by [ADR-0012](0012-preview-engine-worker.md) (several spec tabs, previews on their own worker); the rest stands.

## Date

2026-11-02

## Context

The app had two top-level modes, Viewer and Formats, switched from the toolbar. Formats replaced the whole window, so a user who was writing a format spec could not see the structure tree of the file it was meant to parse, and the live preview of a draft was a fixed-height strip at the bottom of the Formats mode. The user asked for an IDE-like document editor: an editor area with tabs that hold the open binary file and format specs, side panels that can be resized and collapsed, and light and dark themes that follow the system with a remembered override. Later phases add several spec tabs at once with a second engine worker for previews (1b), a structure minimap (2) and a command palette (3).

## Decision

**Shell.** One window-sized CSS grid with a title bar, a middle row and a status bar. The middle row has an activity bar (44 px), a side bar, the editor column, and the inspector on the right. The side bar shows one of two views, chosen from the activity bar: the structure tree of the open file, or the format library list. The editor column holds the tab bar, the editor header (format selector, parse status, go-to offset), the editor body and, for the file, a bottom Problems panel. The title bar is the one place for app-level actions (New, Open, Save, Save As, About); phase 3 puts the command palette there. The status bar is always present and carries the format name, byte order, selection, insert/overwrite, notices and the theme control.

**Tabs.** An editor tab is the open binary file or a format spec. There is one file tab, which cannot be closed, and in this phase one spec tab: picking a spec in the Formats side bar opens it there and replaces the previous spec tab, after the usual "discard unsaved changes?" prompt if that spec was modified. The spec tab shows the spec's Builder, JSON and Docs views and its live preview. The old Viewer/Formats mode is replaced by "a spec tab is the active editor tab"; the engine rules that went with it are unchanged: a draft preview owns the worker's single result slot, so the viewer's own tree is blocked while it does and is re-parsed when the file tab is shown again. Both tab panels stay mounted (the inactive one is hidden, not removed), so scroll position and unsaved drafts survive switching. The state shared by the library list and the spec tab lives in one class (`FormatsState`), so the list and the detail are separate components over the same logic.

**Panels.** Resizers are keyboard-operable separators (arrows move by 16 px, Home/End jump to the limits, double-click resets). Sizes and open/closed state are remembered in local storage. Below 900 px the side bar and inspector start collapsed and open as drawers over the editor.

**Themes.** Colours are CSS custom properties in `src/app.css`: three chrome surfaces, ink and rule colours, one accent (`--signal`) used sparingly, four structure colours for the bytes the format decodes, and status colours. Light is the base, dark applies through `prefers-color-scheme` or `<html data-theme="dark">`. The stored choice (`system`, `light`, `dark`) is applied by a small inline script in `index.html` before first paint; `system` means no attribute.

**Fonts.** IBM Plex Sans Condensed for the chrome and IBM Plex Mono for bytes, offsets and code, installed from the `@fontsource` npm packages (latin subset only) and imported in `src/main.ts`, so the font files are same-origin build assets. No font CDN, which keeps [ADR-0009](0009-no-network-requests.md) intact.

## Alternatives considered

- Keep the Viewer/Formats modes and only restyle: rejected, it keeps the cost that motivated the change (no file context while editing a spec).
- Several binary files as tabs: rejected for now. The open document, the edit buffer, the save state and the engine's single result slot all assume exactly one file; making them per-tab is a large refactor of `App.svelte`, the document state and the worker protocol, and is not needed for the spec-editing workflow.
- A layout or docking library: rejected. The layout is a grid with three resizable edges; a dependency would be larger than the code it replaces.
- Fonts from a CDN: rejected by ADR-0009.

## Consequences

- Phase 1b can add spec tabs by turning the single `selectedId` of `FormatsState` into a list; the tab bar, panels and `specActive` rule already treat the spec tab as one of several editors. It will also need a second engine worker so a preview no longer takes over the viewer's result slot.
- The command palette (phase 3) opens with Ctrl+K and F1 and from a title bar button; the window-level key handler skips keys a focused control already handled and everything while a dialog is open (see "Command palette and global keys" in `docs/DESIGN.md`). Ctrl+Shift+P is deliberately not bound because Firefox keeps it.
- The structure minimap fits in the empty column to the right of the hex grid (`data-slot="minimap"`).
- The bundle includes five font files (about 90 kB as woff2).
- The two side bar views and the two editor panels are stacked and hidden rather than unmounted, which keeps state but means hidden views stay in the DOM.
