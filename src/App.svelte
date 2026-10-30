<script lang="ts">
  import { onDestroy } from 'svelte';
  import { BlobByteSource, probeReadable, type ByteSource } from './core/byte-source';
  import { selectionRange, type Selection } from './core/caret';
  import type { Diagnostic, Node } from './core/engine';
  import type { ParseStatus } from './core/format-status';
  import { parseOffset, type OffsetMode } from './core/parse-offset';
  import { throttleLatest } from './core/tree-model';
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

  let source = $state<ByteSource | null>(null);
  let fileName = $state<string | null>(null);
  let selection = $state<Selection | null>(null);
  let gotoError = $state<string | null>(null);
  let littleEndian = $state(loadLittleEndian());
  // Zero-size tree nodes select nothing but still point the inspector at their offset.
  let nodeInspectOffset = $state<number | null>(null);
  const inspectOffset = $derived(selection ? selectionRange(selection).start : nodeInspectOffset);
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
  let locateToken = 0;
  let treeWidth = $state(460);
  let treeCollapsed = $state(false);
  let resizing = false;

  $effect(() => saveLittleEndian(littleEndian));

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

  async function startEngine(file: File) {
    resetStructure();
    const token = engineToken;
    const c = getClient();
    if (!c) return;
    try {
      const o = await c.open(file, file.name);
      if (token !== engineToken) return;
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

  async function runParse(specId: string | null) {
    const token = ++engineToken;
    selectedSpec = specId;
    root = null;
    diagnostics = [];
    nodeRange = null;
    tints = [];
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

  async function load(file: File) {
    const token = ++loadToken; // a later load supersedes this one
    // Folders and unreadable entries show up as odd empty/4096-byte "files"; refuse them.
    try {
      await probeReadable(file);
    } catch {
      if (token !== loadToken) return;
      loadError = `Cannot open "${file.name}" (folder or unreadable file)`;
      return;
    }
    if (token !== loadToken) return;
    loadError = null;
    source = new BlobByteSource(file);
    fileName = file.name;
    selection = null;
    gotoError = null;
    readError = null;
    void startEngine(file);
  }

  type PickerWindow = Window & {
    showOpenFilePicker?: (opts?: object) => Promise<Array<{ getFile(): Promise<File> }>>;
  };

  async function openFile() {
    const w = window as PickerWindow;
    if (w.showOpenFilePicker) {
      try {
        const [handle] = await w.showOpenFilePicker({ multiple: false });
        if (handle) await load(await handle.getFile());
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
    if (file) void load(file);
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
      void load(file);
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
    size={source?.size ?? 0}
    hasFile={source !== null && source.size > 0}
    onOpen={openFile}
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
          <StructureTree bind:this={tree} {root} {diagnostics} {loadPage} onSelect={onTreeSelect} />
          <Diagnostics {diagnostics} onJump={(d) => void jumpToDiagnostic(d)} />
        </aside>
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div class="resizer" role="separator" aria-orientation="vertical" aria-label="Resize structure panel" onmousedown={startResize}></div>
      {/if}
    {/if}
    {#if source && source.size === 0}
      <div class="empty"><p>Empty file (0 bytes)</p></div>
    {:else if source}
      <HexView
        bind:this={hexView}
        {source}
        bind:selection
        bind:error={readError}
        {nodeRange}
        {tints}
        {onViewChange}
        onByteClick={locate}
      />
    {:else}
      <div class="empty">
        <p>No file open</p>
        <p class="hint">Click <strong>Open…</strong> or drop a file anywhere on this window.</p>
      </div>
    {/if}
    <Inspector source={source && source.size > 0 ? source : null} offset={inspectOffset} bind:littleEndian />
  </div>
  <StatusBar {selection} error={readError} onRetry={() => hexView?.retry()} />
</div>

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
