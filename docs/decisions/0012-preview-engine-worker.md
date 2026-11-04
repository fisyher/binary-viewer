# ADR-0012: Several spec tabs, and spec previews on their own engine worker

## Status

Accepted

## Date

2026-11-02

## Context

The engine worker holds one open document and one parse result ([ADR-0004](0004-parsing-in-a-web-worker.md)). A `parseDraft` request, the live preview of an unsaved spec, parses the open document with the draft and replaces that single result slot. While the app had two modes this did not matter: the viewer's structure tree was not on screen while a draft was being previewed. With editor tabs ([ADR-0011](0011-ide-shell-and-editor-tabs.md)) the structure tree stays in the side bar next to a spec tab, so a preview that takes the slot blanks the viewer's tree, its hex tints and the hex-to-tree lookups. Phase 1a worked around it: while a draft owned the worker the viewer's tree was inert with a "Paused while a format preview is running" note, every viewer call that needed the slot was refused, and returning to the file tab re-parsed the viewer's format. That bookkeeping (`draftOnWorker`, a count of viewer operations in flight, an epoch that restarted the preview) existed only because two consumers shared one result slot. At the same time the single spec tab, which replaced itself (with a discard prompt) whenever another spec was picked, was too restrictive for editing several formats side by side.

## Decision

**Preview worker.** Spec previews run on a second engine worker: a second `EngineClient`, created lazily by `App.svelte` the first time a preview is requested (from the `createPreviewClient` prop, which defaults to `createClient`). The viewer's worker is never sent `parseDraft`. The preview worker is given the same document Blob the viewer uses: `editor.toBlob(baseBlob)` (a lazy view, shared and not copied) is `open()`ed on it before a preview parse whenever the worker does not already have that exact state (same edit buffer, same base Blob, same edit version). A new file, an edit and a save that replaces the base Blob each therefore lead to one re-open, made when the next preview is requested. The preview worker is never sent `setSpecs`: a draft carries its own types and is validated by the worker, and the library's specs must not change what the viewer detects. The preview pane parses again when the document changes (an epoch counter) and when its tab becomes active.

**Lifecycle and failures.** The preview client is disposed when the last spec tab closes (its parse tree and the worker go away; the next preview starts a fresh one) and when the app is destroyed, together with the viewer's client. A dead preview worker is replaced by a fresh one on the next preview request (an edit, a tab switch or a document change; the pane never retries on its own, so there is no respawn loop), and a late fatal report from a client that was already replaced is ignored. An `open()` that is running for the current document state is shared by later requests instead of restarted, so continuous typing on a large file still gets a result. A fatal failure of either worker is local: a dead preview worker shows an error in the preview pane and nothing else; a dead viewer worker shows the existing banner and previews keep working. A preview result is dropped when a newer preview parse, a save or another document started (a `previewToken`); the viewer's `engineToken` rules are unchanged.

**Several spec tabs.** `FormatsState` keeps an ordered list of open spec tabs and the active one. Per-tab session state (unsaved draft, Builder/JSON/Docs view, last save outcome, error) lives in the store, not in a mounted editor, and "modified" is derived there from the draft and the saved text (a draft that is the same JSON value as the saved text is clean). Only the active spec tab has mounted editors and a preview pane; switching remounts them from the stored draft. The Builder's undo history is not kept across a switch. Picking a spec in the Formats side bar activates its tab or opens a new one after the active tab; closing a modified tab asks first; the page warns before unload while any tab is modified.

## Alternatives considered

- Keep one worker and hide or pause the viewer's tree during previews (what phase 1a did): rejected, it is the problem this change removes, and the viewer's tints and locate would stay disabled while a spec tab is open.
- Make the worker protocol hold several results (a result slot per client-chosen key): rejected for now. It touches every request, the supersede rules and the worker's memory accounting, to save one worker instance.
- Run each spec tab's preview on its own worker: rejected. Only the active tab previews, so one extra worker is enough, and switching tabs supersedes the previous preview parse.
- A single "preview tab" that other picks replace: not implemented (plain tabs are simpler and never lose work without asking).

## Consequences

- Two engine instances exist while spec tabs are open, so the memory for a second parse tree (up to the engine's node budget) is paid then; the file itself is shared as one Blob. With no spec tab open there is one worker.
- The preview worker re-opens the document after edits and saves; for a large file this is a cheap slice of the Blob, plus the detection sniff of `open`.
- The viewer tree, tints, hex-to-tree lookups and ranges stay live while a spec tab (and its preview) is active; the "paused" state, the inert tree and the re-parse on returning to the file tab are gone.
- Only one preview parse runs at a time; switching spec tabs supersedes the running one, and the new tab's pane starts its own after the usual debounce.
- Switching spec tabs remounts the editors. The tab's text, view (Builder/JSON/Docs), and last save status are kept. Lost: the JSON editor's caret, selection, native undo and scroll position, the Builder's undo history, the preview pane's "Preview on open file" and collapsed state, and the preview tree's expansion and selection. A "Saved." status is also lost if you switch away while the save is still running (the save itself completes).
- Saves are tracked per spec id, so saving one tab while another tab's save (possibly renaming it) is still running keeps both tabs.
