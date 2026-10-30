<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { BlobByteSource, MemoryByteSource, probeReadable, type ByteSource } from './core/byte-source';
  import { selectionRange, type Selection } from './core/caret';
  import type { Diagnostic, Node } from './core/engine';
  import { EditBuffer } from './core/edit-buffer';
  import type { ParseStatus } from './core/format-status';
  import { parseOffset, type OffsetMode } from './core/parse-offset';
  import {
    SavePermissionError,
    SavedButUnreadableError,
    downloadTarget,
    ensureWritePermission,
    saveTo,
    writeToHandle,
    type SaveHandle,
  } from './core/save';
  import { throttleLatest } from './core/tree-model';
  import ConfirmDialog from './ui/ConfirmDialog.svelte';
  import Diagnostics from './ui/Diagnostics.svelte';
  import FormatBar from './ui/FormatBar.svelte';
  import HexView from './ui/HexView.svelte';
  import Inspector from './ui/Inspector.svelte';
  import { loadLittleEndian, saveLittleEndian } from './ui/prefs';
  import StatusBar from './ui/StatusBar.svelte';
  import StructureTree from './ui/StructureTree.svelte';
  import Toolbar from './ui/Toolbar.svelte';
  import { EngineFatalError, createWorkerClient, SupersededError, type EngineClient } from './worker/engine-client';
  import type { DetectionInfo, ParseSnapshot, RangeSegment, SpecInfo } from './worker/protocol';

  let { createClient = createWorkerClient }: { createClient?: () => EngineClient } = $props();

  // The document: an EditBuffer over the opened file (or an empty buffer for "New"). `baseBlob` is the file the
  // buffer's orig pieces refer to; the engine worker gets `editor.toBlob(baseBlob)` after edits.
  let editor = $state.raw<EditBuffer | null>(null);
  let baseBlob: Blob | null = null;
  let editVersion = $state(0);
  const source: ByteSource | null = $derived(editor);
  // The buffer's size is not reactive; editVersion changes whenever it may have.
  const size = $derived.by(() => {
    void editVersion;
    return editor?.size ?? 0;
  });
  let dirty = $state(false);
  let insertMode = $state(false);
  let notice = $state<string | null>(null);
  let saving = $state(false);
  // After a save whose re-read failed the base is unreadable: the document is frozen until another file is opened.
  let unreadable = $state(false);
  let info = $state<string | null>(null);
  let fileHandle: SaveHandle | null = null; // write-back target; null for dropped/<input> files and new documents
  let confirm = $state<{ message: string; run: () => void } | null>(null);
  let offEditor: (() => void) | null = null;
  let reparseTimer: ReturnType<typeof setTimeout> | undefined;
  let treeKeep = $state.raw<Node | null>(null); // root of an edit re-parse: the tree keeps its view state
  let fileName = $state<string | null>(null);
  let selection = $state<Selection | null>(null);
  let gotoError = $state<string | null>(null);
  let littleEndian = $state(loadLittleEndian());
  // Zero-size tree nodes select nothing but still point the inspector at their offset.
  let nodeInspectOffset = $state<number | null>(null);
  const rawInspectOffset = $derived(selection ? selectionRange(selection).start : nodeInspectOffset);
  // The append slot at offset == size has no byte to inspect.
  const inspectOffset = $derived(rawInspectOffset !== null && rawInspectOffset >= size ? null : rawInspectOffset);
  let readError = $state<string | null>(null);
  let loadError = $state<string | null>(null);
  let dragDepth = $state(0);
  let hexView: ReturnType<typeof HexView> | undefined = $state();
  let tree: ReturnType<typeof StructureTree> | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();

  // ---- Format engine (runs in a worker) ----
  let client: EngineClient | null = null;
  let clientFailed = false;
  let engineError = $state<string | null>(null);
  // Once the worker dies it stays dead: this survives resetStructure() so every later open/parse reports it.
  let fatalMessage: string | null = null;
  let specs = $state.raw<SpecInfo[]>([]);
  let detections = $state.raw<DetectionInfo[]>([]);
  let selectedSpec = $state<string | null>(null);
  let status = $state<ParseStatus>({ state: 'idle' });
  let root = $state.raw<Node | null>(null); // raw: up to 100k nodes must not be proxied
  let diagnostics = $state.raw<Diagnostic[]>([]);
  let nodeRange = $state.raw<{ start: number; end: number } | null>(null);
  let tints = $state.raw<RangeSegment[]>([]);
  let viewWindow: { start: number; end: number } | null = null;
  let engineToken = 0; // bumped by every open/parse; results from older ones are ignored
  let needsDetect = false; // startEngine was started but its detection result has not been applied yet
  let locateToken = 0;
  let treeWidth = $state(460);
  let treeCollapsed = $state(false);
  let resizing = false;

  $effect(() => saveLittleEndian(littleEndian));

  // Warn before leaving the page with unsaved edits; the listener exists only while dirty.
  $effect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = true;
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  });

  function getClient(): EngineClient | null {
    if (client || clientFailed) return client;
    try {
      client = createClient();
      client.onFatal((m) => markFatal(m));
    } catch (e) {
      clientFailed = true;
      markFatal(e instanceof Error ? e.message : String(e));
    }
    return client;
  }

  function markFatal(message: string) {
    fatalMessage = `Format engine unavailable: ${message}`;
    engineError = fatalMessage;
    status = { state: 'idle' };
  }

  onDestroy(() => {
    clearTimeout(reparseTimer);
    offEditor?.();
    requestTints.cancel();
    locate.cancel();
    client?.dispose();
  });

  function resetStructure() {
    engineToken++;
    locateToken++;
    root = null;
    diagnostics = [];
    nodeRange = null;
    nodeInspectOffset = null;
    tints = [];
    detections = [];
    specs = [];
    selectedSpec = null;
    status = { state: 'idle' };
    engineError = fatalMessage;
  }

  async function startEngine(file: Blob, name: string) {
    resetStructure();
    needsDetect = true;
    const token = engineToken;
    const c = getClient();
    if (!c) return;
    try {
      const o = await c.open(file, name);
      if (token !== engineToken) return;
      needsDetect = false;
      specs = o.specs;
      detections = o.detections;
      if (o.specErrors.length > 0) engineError = `Built-in format spec invalid: ${o.specErrors.join('; ')}`;
      // Magic or extension evidence: parse the top-ranked format (extension-only is shown as a suggestion).
      await runParse(o.detections[0]?.specId ?? null);
    } catch (e) {
      if (e instanceof EngineFatalError) markFatal(e.message);
      else if (token === engineToken && !(e instanceof SupersededError)) {
        engineError = `Format engine error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  function summarize(snap: ParseSnapshot): ParseStatus {
    const errors = snap.errors.filter((d) => d.severity === 'error').length;
    const state = snap.stats.aborted ? 'aborted' : snap.stats.truncated ? 'truncated' : 'done';
    return { state, nodes: snap.stats.nodes, errors, warnings: snap.errors.length - errors };
  }

  /** `keepView`: a re-parse of edited bytes; the old tree stays up until the new one arrives and keeps its view state. */
  async function runParse(specId: string | null, keepView = false) {
    const token = ++engineToken;
    selectedSpec = specId;
    if (!keepView || specId === null) {
      root = null;
      diagnostics = [];
      nodeRange = null;
      tints = [];
    }
    const c = client;
    if (!c) return;
    if (specId === null) {
      status = { state: 'idle' };
      c.parse(null).catch(() => {}); // drop the worker's result too
      return;
    }
    status = { state: 'parsing' };
    try {
      const snap = await c.parse(specId);
      if (token !== engineToken) return;
      if (!snap) {
        status = { state: 'idle' };
        return;
      }
      treeKeep = keepView ? snap.root : null;
      root = snap.root;
      diagnostics = snap.errors;
      status = summarize(snap);
      requestTints();
    } catch (e) {
      if (e instanceof EngineFatalError) return markFatal(e.message);
      if (token !== engineToken || e instanceof SupersededError) return;
      status = { state: 'error', message: `Parse failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // ---- Re-parse after edits ----
  // Debounced; the worker is re-opened on a lazy Blob view of the edited document (no copy), then the chosen
  // spec is parsed again. Each step bumps engineToken, so rapid typing supersedes older runs instead of queueing.
  const REPARSE_DELAY_MS = 300;

  function scheduleReparse() {
    clearTimeout(reparseTimer);
    if (saving || unreadable) return; // a save re-opens the worker itself once the new file exists
    // needsDetect: an edit made before the first open() returned superseded it; detection must still happen.
    reparseTimer = setTimeout(() => void reparse(needsDetect), REPARSE_DELAY_MS);
  }

  /** `redetect`: the file was just saved under a (possibly new) name, so format detection may now apply. */
  async function reparse(redetect = false) {
    clearTimeout(reparseTimer);
    const ed = editor;
    const base = baseBlob;
    const c = getClient();
    if (!ed || !base || !c) return;
    const token = ++engineToken;
    try {
      const o = await c.open(ed.toBlob(base), fileName ?? 'Untitled');
      if (token !== engineToken) return;
      needsDetect = false;
      specs = o.specs;
      detections = o.detections;
      await runParse(selectedSpec ?? (redetect ? (o.detections[0]?.specId ?? null) : null), true);
    } catch (e) {
      if (e instanceof EngineFatalError) markFatal(e.message);
      else if (token === engineToken && !(e instanceof SupersededError)) {
        // Never leave a stale 'parsing' status behind.
        status = { state: 'error', message: `Format engine error: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
  }

  async function loadPage(nodeId: number, start: number, count: number) {
    if (!client) throw new Error('format engine unavailable');
    const r = await client.expand(nodeId, start, count);
    if (r.newErrors.length > 0) diagnostics = [...diagnostics, ...r.newErrors];
    return { nodes: r.nodes, lazy: r.lazy };
  }

  function onTreeSelect(node: Node, range: { start: number; end: number } | null) {
    const size = source?.size ?? 0;
    if (range && range.start < size) {
      const end = Math.min(range.end, size - 1);
      selection = { anchor: range.start, caret: end };
      nodeRange = { start: range.start, end };
      nodeInspectOffset = null;
      hexView?.reveal(range.start);
    } else {
      // Zero-size node: select nothing, but show where it sits.
      selection = null;
      nodeRange = null;
      const ok = Number.isSafeInteger(node.offset) && node.offset >= 0 && node.offset < size;
      nodeInspectOffset = ok ? node.offset : null;
      if (ok) hexView?.reveal(node.offset);
    }
  }

  // Hex -> tree: only on a plain click, throttled, latest wins.
  const locate = throttleLatest(async (offset: number) => {
    const c = client;
    if (!c || !root) return;
    const t = ++locateToken;
    try {
      const loc = await c.nodeAt(offset);
      if (t !== locateToken || !loc.path) return;
      await tree?.reveal(loc.path, loc.lazyIndex, offset);
    } catch {
      /* superseded or engine gone: nothing to reveal */
    }
  }, 80);

  async function jumpToDiagnostic(d: Diagnostic) {
    const c = client;
    if (!c || !root) return;
    const t = ++locateToken;
    try {
      if (d.nodeId !== undefined) {
        const loc = await c.nodeById(d.nodeId);
        if (t !== locateToken) return;
        if (loc.path) return await tree?.reveal(loc.path);
      }
      if (d.offset !== undefined && source && d.offset < source.size) {
        hexView?.goTo(d.offset);
        const loc = await c.nodeAt(d.offset);
        if (t === locateToken && loc.path) await tree?.reveal(loc.path, loc.lazyIndex, d.offset);
      }
    } catch {
      /* ignore */
    }
  }

  // Tint only the rendered byte window; ask the worker for the leaf ranges inside it.
  const requestTints = throttleLatest(async () => {
    const c = client;
    const w = viewWindow;
    const token = engineToken;
    if (!c || !root || !w || w.end <= w.start) return;
    try {
      const segs = await c.ranges(w.start, w.end);
      if (token === engineToken) tints = segs;
    } catch {
      /* superseded */
    }
  }, 60);

  function onViewChange(start: number, end: number) {
    viewWindow = { start, end };
    requestTints();
  }

  function startResize(e: MouseEvent) {
    e.preventDefault();
    resizing = true;
  }

  function onWindowMouseMove(e: MouseEvent) {
    if (resizing) treeWidth = Math.min(900, Math.max(240, e.clientX));
  }

  function onWindowMouseUp() {
    resizing = false;
  }

  let loadToken = 0;

  /**
   * `baseline` is the document state the caller's dirty check (guardDirty) was made against. If the document got
   * new edits while we were reading the file, ask again instead of silently replacing it.
   */
  async function load(
    file: File,
    handle: SaveHandle | null = null,
    baseline: { ed: EditBuffer | null; version: number } = { ed: editor, version: editor?.version ?? 0 },
  ) {
    if (saving) return;
    const token = ++loadToken; // a later load supersedes this one
    // Folders and unreadable entries show up as odd empty/4096-byte "files"; refuse them.
    try {
      await probeReadable(file);
    } catch {
      if (token !== loadToken) return;
      loadError = `Cannot open "${file.name}" (folder or unreadable file)`;
      return;
    }
    if (token !== loadToken || saving) return;
    const proceed = () => {
      if (token !== loadToken || saving) return;
      loadError = null;
      installEditor(new BlobByteSource(file), file, file.name, handle);
      void startEngine(file, file.name);
    };
    const editedSince = editor !== null && editor.isDirty && (editor !== baseline.ed || editor.version !== baseline.version);
    if (editedSince) guardDirty(proceed);
    else proceed();
  }

  /** Make `base` (backed by `blob`) the open document. */
  function installEditor(base: ByteSource, blob: Blob, name: string, handle: SaveHandle | null) {
    clearTimeout(reparseTimer);
    offEditor?.();
    const ed = new EditBuffer(base);
    offEditor = ed.onChange(() => {
      editVersion = ed.version;
      dirty = ed.isDirty;
      scheduleReparse();
    });
    editor = ed;
    baseBlob = blob;
    editVersion = ed.version;
    dirty = false;
    fileHandle = handle;
    fileName = name;
    selection = null;
    gotoError = null;
    readError = null;
    notice = null;
    info = null;
    unreadable = false;
    treeKeep = null;
  }

  /** Run `action` now, or after the user agrees to discard unsaved edits. Never while a save is running. */
  function guardDirty(action: () => void) {
    const go = () => {
      if (saving) {
        notice = 'Wait for the save to finish.';
        return;
      }
      action();
    };
    if (saving) return go();
    if (editor?.isDirty) {
      confirm = { message: `"${fileName ?? 'Untitled'}" has unsaved changes. Discard them?`, run: go };
    } else {
      go();
    }
  }

  function newFile() {
    guardDirty(() => {
      loadToken++; // supersede any load still reading
      loadError = null;
      const blob = new Blob([]);
      installEditor(new MemoryByteSource(new Uint8Array(0)), blob, 'Untitled', null);
      void startEngine(blob, 'Untitled');
      void tick().then(() => hexView?.focus());
    });
  }

  // ---- Save ----
  type SavePickerWindow = Window & {
    showSaveFilePicker?: (opts?: object) => Promise<SaveHandle>;
  };

  const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

  /** Save: write back to the file's handle when there is one, otherwise behave as Save As. */
  async function save() {
    if (!editor || saving) return;
    if (fileHandle) await saveToHandle(fileHandle);
    else await saveAs();
  }

  async function saveAs() {
    const ed = editor;
    if (!ed || saving || unreadable) return;
    const w = window as SavePickerWindow;
    if (!w.showSaveFilePicker) return saveByDownload();
    let handle: SaveHandle;
    try {
      handle = await w.showSaveFilePicker({ suggestedName: fileName ?? 'Untitled.bin' });
    } catch (e) {
      if (!isAbort(e)) notice = `Save failed: ${e instanceof Error ? e.message : String(e)}`;
      return; // cancelling the picker is not an error
    }
    if (editor !== ed) return;
    await saveToHandle(handle);
  }

  /** Lock the document for a save: flush queued edits, then block editing/reparse. Returns false if it cannot start. */
  async function beginSave(ed: EditBuffer): Promise<boolean> {
    await hexView?.settled(); // an edit queued a moment ago must be in the file
    if (editor !== ed || saving) return false;
    saving = true; // HexView ignores input from here on
    clearTimeout(reparseTimer); // never re-parse against a base that is about to be replaced
    engineToken++;
    if (status.state === 'parsing') status = { state: 'idle' }; // that parse's result will now be ignored
    notice = null;
    info = null;
    return true;
  }

  /**
   * beginSave() cancelled the pending re-parse and superseded any in flight, so a save that did not end in
   * reparse(true) (failed, cancelled, download) must bring the structure view back in line with the document.
   * Also finishes a detection run that the save interrupted.
   */
  function resumeEngine(ed: EditBuffer) {
    if (editor !== ed || unreadable) return;
    void reparse(needsDetect);
  }

  /**
   * In-place write. The new File must replace the base before anything else reads (the old one is unreadable
   * after close). Everything after an await is guarded by `editor === ed`; New/Open/drop are blocked while
   * `saving`, so that only fails if something is badly wrong.
   */
  async function saveToHandle(handle: SaveHandle) {
    const ed = editor;
    const base = baseBlob;
    if (!ed || !base || !(await beginSave(ed))) return;
    const startVersion = ed.version;
    const savedName = fileName ?? 'Untitled';
    let reparsed = false;
    try {
      await ensureWritePermission(handle);
      let file: File;
      try {
        file = await writeToHandle(handle, ed, base);
      } catch (e) {
        if (e instanceof SavedButUnreadableError && editor === ed) {
          // Data is on disk but our base is gone: freeze the document rather than keep a dirty buffer over nothing.
          ed.markSaved();
          dirty = false;
          fileHandle = handle;
          unreadable = true;
        }
        throw e;
      }
      if (editor !== ed) return;
      let reload: string | null = null;
      if (ed.version !== startVersion) {
        // Editing is locked and queued edits were flushed first, so this should be impossible.
        reload = 'Edits made during the save were not included; the file was saved without them.';
      } else {
        baseBlob = file;
        try {
          ed.rebase(new BlobByteSource(file));
        } catch {
          reload = `The file on disk (${file.size} bytes) differs from what was written (${ed.size} bytes); it was reloaded from disk.`;
        }
      }
      if (reload) installEditor(new BlobByteSource(file), file, file.name, handle);
      fileHandle = handle;
      fileName = file.name || handle.name;
      dirty = editor?.isDirty ?? false;
      if (reload) notice = reload;
      reparsed = true;
      void reparse(true); // the worker still holds the old, now unreadable, file
    } catch (e) {
      if (isAbort(e)) return;
      if (e instanceof SavedButUnreadableError && editor !== ed) {
        // A different document is open by now: say which file this is about.
        notice = `"${savedName}" was saved, but could not be re-read (${e.cause instanceof Error ? e.cause.message : String(e.cause)}).`;
      } else {
        notice =
          e instanceof SavePermissionError || e instanceof SavedButUnreadableError
            ? e.message
            : `Save failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    } finally {
      saving = false;
      if (!reparsed) resumeEngine(ed);
    }
  }

  /**
   * Download save. The browser gives no completion signal, so the document counts as saved once the download
   * starts (even if the user then cancels it). The buffer is rebased onto a lazy Blob of the saved content so
   * the added-byte store is released.
   */
  async function saveByDownload() {
    const ed = editor;
    const base = baseBlob;
    if (!ed || !base || !(await beginSave(ed))) return;
    try {
      await saveTo(downloadTarget(fileName && fileName !== 'Untitled' ? fileName : 'Untitled.bin'), ed, base);
      if (editor !== ed) return;
      const snapshot = ed.toBlob(base);
      baseBlob = snapshot;
      ed.rebase(new BlobByteSource(snapshot));
      dirty = ed.isDirty;
      info = 'Download started — the file is considered saved.';
    } catch (e) {
      notice = `Save failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      saving = false;
      resumeEngine(ed);
    }
  }

  type PickerWindow = Window & {
    showOpenFilePicker?: (opts?: object) => Promise<SaveHandle[]>;
  };

  function openFile() {
    guardDirty(() => void doOpenFile());
  }

  async function doOpenFile() {
    const w = window as PickerWindow;
    if (w.showOpenFilePicker) {
      try {
        const baseline = { ed: editor, version: editor?.version ?? 0 };
        const [handle] = await w.showOpenFilePicker({ multiple: false });
        if (handle) await load(await handle.getFile(), handle, baseline); // keep the handle so Save can write back
      } catch (e) {
        if (!(e instanceof DOMException && e.name === 'AbortError')) console.error(e);
      }
    } else {
      fileInput?.click();
    }
  }

  function onInputChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) guardDirty(() => void load(file));
    input.value = ''; // allow re-opening the same file
  }

  function goTo(text: string, mode: OffsetMode) {
    if (!source) return;
    const r = parseOffset(text, source.size, mode);
    if (!r.ok) {
      gotoError = r.error;
      return;
    }
    gotoError = null;
    hexView?.goTo(r.offset);
  }

  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;

  // enter/leave fire for every child element, so count them to avoid overlay flicker.
  function onDragEnter(e: DragEvent) {
    if (hasFiles(e)) dragDepth++;
  }

  function onDragLeave(e: DragEvent) {
    if (hasFiles(e)) dragDepth = Math.max(0, dragDepth - 1);
  }

  function onDragOver(e: DragEvent) {
    if (hasFiles(e)) e.preventDefault();
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragDepth = 0;
    const item = e.dataTransfer?.items[0];
    const entry = item?.webkitGetAsEntry?.();
    const file = e.dataTransfer?.files[0];
    if (entry?.isDirectory) {
      loadError = `Cannot open "${entry.name}": folders are not supported`;
    } else if (file) {
      guardDirty(() => void load(file));
    }
  }
</script>

<svelte:window
  ondragenter={onDragEnter}
  ondragleave={onDragLeave}
  ondragover={onDragOver}
  ondrop={onDrop}
  onmousemove={onWindowMouseMove}
  onmouseup={onWindowMouseUp}
/>

<input type="file" hidden bind:this={fileInput} onchange={onInputChange} />

<div class="app" class:drag-over={dragDepth > 0}>
  <Toolbar
    {fileName}
    {size}
    hasFile={source !== null && size > 0}
    {dirty}
    {saving}
    {unreadable}
    onNew={newFile}
    onOpen={openFile}
    onSave={() => void save()}
    onSaveAs={() => void saveAs()}
    onGoTo={goTo}
    {gotoError}
    {loadError}
  />
  {#if source}
    <FormatBar
      {specs}
      {detections}
      selected={selectedSpec}
      {status}
      errorText={engineError}
      onSelect={(id) => void runParse(id)}
      onCancel={() => client?.cancel()}
    />
  {/if}
  <div class="main">
    {#if source}
      {#if treeCollapsed}
        <button type="button" class="expand-tree" onclick={() => (treeCollapsed = false)} title="Show structure" aria-label="Show structure">&#9656;</button>
      {:else}
        <aside class="side" style:width="{treeWidth}px" aria-label="Structure panel">
          <div class="side-head">
            <span>Structure</span>
            <button type="button" onclick={() => (treeCollapsed = true)} title="Hide structure" aria-label="Hide structure">&#9666;</button>
          </div>
          <StructureTree bind:this={tree} {root} {diagnostics} {loadPage} onSelect={onTreeSelect} preserveFor={treeKeep} />
          <Diagnostics {diagnostics} onJump={(d) => void jumpToDiagnostic(d)} />
        </aside>
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div class="resizer" role="separator" aria-orientation="vertical" aria-label="Resize structure panel" onmousedown={startResize}></div>
      {/if}
    {/if}
    {#if source && editor}
      <div class="hexcol">
        {#if size === 0}<div class="empty-note"><p>Empty file (0 bytes)</p></div>{/if}
        <HexView
          bind:this={hexView}
          {source}
          bind:selection
          bind:error={readError}
          bind:insertMode
          {editor}
          {editVersion}
          locked={saving || unreadable}
          onNotice={(m) => (notice = m)}
          {nodeRange}
          {tints}
          {onViewChange}
          onByteClick={locate}
        />
      </div>
    {:else}
      <div class="empty">
        <p>No file open</p>
        <p class="hint">Click <strong>Open…</strong> or drop a file anywhere on this window.</p>
      </div>
    {/if}
    <Inspector source={source && size > 0 ? source : null} offset={inspectOffset} version={editVersion} bind:littleEndian />
  </div>
  <StatusBar
    {selection}
    error={readError}
    {notice}
    {info}
    insertMode={source ? insertMode : null}
    onRetry={() => hexView?.retry()}
  />
</div>
{#if confirm}
  {@const pending = confirm}
  <ConfirmDialog
    message={pending.message}
    onCancel={() => (confirm = null)}
    onConfirm={() => {
      const run = pending.run; // `pending` re-derives once confirm is cleared
      confirm = null;
      run();
    }}
  />
{/if}

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .app.drag-over {
    outline: 2px dashed var(--accent);
    outline-offset: -4px;
  }
  .main {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .side {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: none;
    border-right: 1px solid var(--border);
    background: var(--bg);
  }
  .side-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 2px 8px;
    font-weight: 600;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .side-head button,
  .expand-tree {
    padding: 0 6px;
    border: none;
    background: none;
  }
  .expand-tree {
    flex: none;
    border-right: 1px solid var(--border);
    border-radius: 0;
  }
  .resizer {
    flex: none;
    width: 5px;
    margin-left: -3px;
    cursor: col-resize;
    z-index: 1;
  }
  .resizer:hover {
    background: var(--accent);
    opacity: 0.4;
  }
  .hexcol {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .empty-note {
    padding: 6px 12px;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
  }
  .empty-note p {
    margin: 0;
  }
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--muted);
  }
  .empty p {
    margin: 4px;
  }
  .empty :first-child {
    font-size: 1.4rem;
  }
  .hint {
    font-size: 0.9rem;
  }
</style>
