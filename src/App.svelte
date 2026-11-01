<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { BlobByteSource, MemoryByteSource, probeReadable, type ByteSource } from './core/byte-source';
  import { selectionRange, type Selection } from './core/caret';
  import type { Diagnostic, Node } from './core/engine';
  import { createAppLibrary } from './core/app-library';
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
  import type { SpecLibrary } from './core/spec-library';
  import { throttleLatest } from './core/tree-model';
  import AboutDialog from './ui/AboutDialog.svelte';
  import ConfirmDialog from './ui/ConfirmDialog.svelte';
  import Diagnostics from './ui/Diagnostics.svelte';
  import FormatBar from './ui/FormatBar.svelte';
  import FormatDetail from './ui/formats/FormatDetail.svelte';
  import FormatList from './ui/formats/FormatList.svelte';
  import { FormatsState } from './ui/formats/formats-state.svelte';
  import HexView from './ui/HexView.svelte';
  import Inspector from './ui/Inspector.svelte';
  import { loadBuiltinSpecs } from './formats';
  import {
    applyTheme,
    loadFlag,
    loadLittleEndian,
    loadSideView,
    loadSize,
    loadTheme,
    saveFlag,
    saveLittleEndian,
    saveSideView,
    saveSize,
    saveTheme,
    type SideView,
    type ThemePref,
  } from './ui/prefs';
  import ActivityBar from './ui/shell/ActivityBar.svelte';
  import BottomPanel from './ui/shell/BottomPanel.svelte';
  import EditorTabs, { type EditorTab } from './ui/shell/EditorTabs.svelte';
  import GoTo from './ui/shell/GoTo.svelte';
  import Resizer from './ui/shell/Resizer.svelte';
  import SideBar from './ui/shell/SideBar.svelte';
  import TitleBar from './ui/shell/TitleBar.svelte';
  import Welcome from './ui/shell/Welcome.svelte';
  import StatusBar from './ui/StatusBar.svelte';
  import StructureTree from './ui/StructureTree.svelte';
  import { sanitizeText } from './core/tree-model';
  import { PreviewUnavailableError } from './ui/formats/preview';
  import { EngineFatalError, createWorkerClient, SupersededError, type EngineClient } from './worker/engine-client';
  import type { DetectionInfo, ParseSnapshot, RangeSegment, SpecInfo } from './worker/protocol';

  let {
    createClient = createWorkerClient,
    createLibrary = createAppLibrary,
  }: { createClient?: () => EngineClient; createLibrary?: () => SpecLibrary } = $props();

  // The active editor tab: the binary file or the spec being edited. Both panels stay mounted (the inactive one is
  // hidden), so the open document, its scroll position and any unsaved spec draft survive switching.
  let activeTab = $state<'file' | 'spec'>('file');
  // About dialog; the opener button gets focus back when it closes.
  let aboutOpen = $state(false);
  let aboutOpener: HTMLElement | null = null;
  const builtinNames = loadBuiltinSpecs().specs.map((s) => s.name);

  function openAbout(opener: HTMLElement) {
    aboutOpener = opener;
    aboutOpen = true;
  }

  async function closeAbout() {
    aboutOpen = false;
    await tick(); // the background stays inert until the dialog is gone
    aboutOpener?.focus();
    aboutOpener = null;
  }
  // The user's format library (IndexedDB + optional folder). Its valid specs are mirrored into the engine worker.
  const library: SpecLibrary = untrack(() => createLibrary());
  // The format library UI state (open spec, unsaved draft, actions), shared by the side bar list and the spec tab.
  const formats = new FormatsState(library);
  formats.onOpened = () => (activeTab = 'spec');
  formats.onClosed = () => showFileTab();
  $effect(() => formats.connect());
  // A spec tab is open while a spec is selected; it is the active editor exactly when it was last picked. The Formats
  // preview (parseDraft) and the draft-on-worker blocking below key off this.
  const specOpen = $derived(formats.selected !== undefined);
  const specActive = $derived(activeTab === 'spec' && specOpen);
  let rawChosen = false; // the user explicitly picked "None (raw)": library changes must not auto-select a format
  // What the worker already has: `id:rev` of the custom specs last sent (rev changes whenever a spec's text does).
  let sentSpecsKey = '';
  let sentRevs = new Map<string, number>();
  let initializing = true; // the library is still loading: a first spec sync is startup, not a user change
  let specsDirty = false; // the library changed while a save blocked the reparse; resumeEngine catches up
  let specRejected = $state<string | null>(null);

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
  // ---- Shell layout and theme (remembered in local storage) ----
  const SIDE_RANGE = { min: 200, max: 600, def: 300 };
  const INSPECTOR_RANGE = { min: 240, max: 520, def: 320 };
  const PROBLEMS = { min: 80, def: 180 };
  const clampTo = (r: { min: number; max: number }, v: number) => Math.min(r.max, Math.max(r.min, v));
  const startsNarrow = typeof matchMedia === 'function' && matchMedia('(max-width: 899px)').matches;
  let narrow = $state(startsNarrow);
  let theme = $state<ThemePref>(loadTheme());
  let sideView = $state<SideView>(loadSideView());
  // On a narrow screen the side bar and inspector are drawers: they always start closed, whatever was saved.
  let sideOpen = $state(startsNarrow ? false : loadFlag('sideOpen', true));
  let sideWidth = $state(clampTo(SIDE_RANGE, loadSize('sideWidth', SIDE_RANGE.def)));
  let inspectorOpen = $state(startsNarrow ? false : loadFlag('inspectorOpen', true));
  let inspectorWidth = $state(clampTo(INSPECTOR_RANGE, loadSize('inspectorWidth', INSPECTOR_RANGE.def)));
  let problemsOpen = $state(loadFlag('problemsOpen', !startsNarrow));
  let problemsHeight = $state(Math.max(PROBLEMS.min, loadSize('problemsHeight', PROBLEMS.def)));
  let editorColumnHeight = $state(0);
  const problemsMax = $derived(Math.max(PROBLEMS.min, Math.floor(editorColumnHeight * 0.6)));
  const problemsPx = $derived(Math.min(problemsHeight, problemsMax));

  $effect(() => applyTheme(theme));
  $effect(() => {
    if (typeof matchMedia !== 'function') return;
    const q = matchMedia('(max-width: 899px)');
    const on = () => {
      narrow = q.matches;
      if (narrow && sideOpen && inspectorOpen) inspectorOpen = false; // one drawer at a time
    };
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  });

  const THEME_ORDER: ThemePref[] = ['system', 'light', 'dark'];
  function cycleTheme() {
    theme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]!;
    saveTheme(theme);
  }
  function setSideOpen(v: boolean) {
    sideOpen = v;
    if (narrow) {
      if (v) inspectorOpen = false; // drawers: only one at a time, and never persisted
    } else saveFlag('sideOpen', v);
  }
  function showSide(view: SideView) {
    sideView = view;
    saveSideView(view);
    setSideOpen(true);
  }
  /** Activity bar: the active item collapses/expands the side bar, the other one switches the view. */
  function onActivity(view: SideView) {
    if (sideOpen && sideView === view) setSideOpen(false);
    else showSide(view);
  }
  function setSideWidth(px: number) {
    sideWidth = clampTo(SIDE_RANGE, px);
    saveSize('sideWidth', sideWidth);
  }
  function setInspectorOpen(v: boolean) {
    inspectorOpen = v;
    if (narrow) {
      if (v) sideOpen = false;
    } else saveFlag('inspectorOpen', v);
  }
  const drawerOpen = $derived(narrow && (sideOpen || inspectorOpen));
  function closeDrawers() {
    sideOpen = false;
    inspectorOpen = false;
  }
  function onWindowKeyDown(e: KeyboardEvent) {
    if (e.defaultPrevented || e.key !== 'Escape' || !drawerOpen || aboutOpen || confirm || formats.confirm) return;
    e.preventDefault();
    closeDrawers();
  }
  function setInspectorWidth(px: number) {
    inspectorWidth = clampTo(INSPECTOR_RANGE, px);
    saveSize('inspectorWidth', inspectorWidth);
  }
  function setProblemsOpen(v: boolean) {
    problemsOpen = v;
    saveFlag('problemsOpen', v);
  }
  function setProblemsHeight(px: number) {
    problemsHeight = Math.max(PROBLEMS.min, px);
    saveSize('problemsHeight', problemsHeight);
  }
  // Live preview of a format draft (Formats view). parseDraft REPLACES the worker's single result slot, so the viewer's
  // own tree is no longer backed by the worker while `draftOnWorker` is true: every viewer call that needs the slot
  // is blocked until the viewer re-parses (on switching back to it, or after any viewer engine operation).
  let draftOnWorker = false;
  let draftActive = $state(false); // reactive mirror of draftOnWorker, for the "paused" note
  let viewerOps = 0; // viewer engine operations (open/parse) in flight; a draft parse never starts while > 0
  let previewEpoch = $state(0); // bumped when the last viewer operation finishes: the preview then re-parses
  const opStart = () => {
    viewerOps++;
    draftOnWorker = false;
    draftActive = false;
  };
  const opEnd = () => {
    if (--viewerOps === 0) previewEpoch++;
  };

  $effect(() => saveLittleEndian(littleEndian));

  // Warn before leaving the page with unsaved edits; the listener exists only while dirty.
  $effect(() => {
    if (!dirty && !formats.editorDirty) return;
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
    opStart();
    try {
      await startEngineInner(file, name);
    } finally {
      opEnd();
    }
  }

  async function startEngineInner(file: Blob, name: string) {
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
    opStart();
    try {
      await runParseInner(specId, keepView);
    } finally {
      opEnd();
    }
  }

  async function runParseInner(specId: string | null, keepView: boolean) {
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
    opStart();
    try {
      await reparseInner(redetect);
    } finally {
      opEnd();
    }
  }

  async function reparseInner(redetect: boolean) {
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
      // Keep the chosen format while it still exists. A custom one that was deleted or became invalid falls back
      // to "None (raw)" (never to another format) with a notice.
      const top = o.detections[0]?.specId ?? null;
      specsDirty = false;
      let target: string | null;
      if (selectedSpec === null) target = redetect ? top : null;
      else if (o.specs.some((s) => s.id === selectedSpec)) target = selectedSpec;
      else {
        notice = 'Format "' + selectedSpec + '" was removed; showing raw bytes.';
        target = null;
      }
      await runParse(target, true);
    } catch (e) {
      if (e instanceof EngineFatalError) markFatal(e.message);
      else if (token === engineToken && !(e instanceof SupersededError)) {
        // Never leave a stale 'parsing' status behind.
        status = { state: 'error', message: `Format engine error: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
  }

  // ---- Custom formats: mirror the library's valid specs into the worker, then re-detect for the open file ----
  function onLibraryChange() {
    const key = library.validUserKey();
    if (key === sentSpecsKey) return;
    const prev = sentRevs;
    const next = new Map(library.list().filter((e) => e.source === 'user' && e.valid).map((e) => [e.id, e.rev] as const));
    sentSpecsKey = key;
    sentRevs = next;
    void applySpecs(library.validUserTexts(), key, prev, next, initializing);
  }

  /**
   * Hand the library's valid specs to the worker. The open document is only re-parsed when that matters: at startup
   * (a file opened before the library loaded), when the selected spec's text changed, or when it disappeared (then
   * the view falls back to raw bytes with a notice). A library change never switches the open file to another
   * format; new specs just show up in the list.
   */
  async function applySpecs(texts: string[], key: string, prev: Map<string, number>, next: Map<string, number>, initial: boolean) {
    const c = getClient();
    if (!c) return;
    try {
      const oldSpecs = specs;
      const r = await c.setSpecs(texts);
      if (key !== sentSpecsKey) return; // a newer change is already on its way
      specs = r.specs;
      detections = detections.filter((d) => r.specs.some((s) => s.id === d.specId));
      specRejected = r.rejected.length > 0 ? ('Some custom formats were rejected by the engine: ' + r.rejected.join('; ')).slice(0, 300) : null;
      if (!editor || !baseBlob) return;
      const sel = selectedSpec;
      const gone = sel !== null && !r.specs.some((s) => s.id === sel);
      const changed = sel !== null && !gone && prev.get(sel) !== next.get(sel);
      if (!initial && !gone && !changed) return;
      if (saving || unreadable) {
        specsDirty = true; // resumeEngine / the save's own reparse catches up
        return;
      }
      if (gone && !initial) {
        notice = 'Format "' + (oldSpecs.find((s) => s.id === sel)?.name ?? sel) + '" was removed; showing raw bytes.';
        await runParse(null);
      } else {
        await reparse(initial && !rawChosen);
      }
    } catch (e) {
      if (e instanceof EngineFatalError) markFatal(e.message);
      else if (!(e instanceof SupersededError)) specRejected = ('Format engine error: ' + (e instanceof Error ? e.message : String(e))).slice(0, 300);
    }
  }

  // ---- Format preview (see draftOnWorker above) ----
  /**
   * Parse the open document with an unsaved draft. Goes through the same engineToken machinery as the viewer: it bumps
   * the token (so a viewer result arriving later is ignored) and its own result is dropped if anything newer started.
   * Refused (the pane waits for the next trigger) while there is no document, a save is running, or the viewer's own
   * engine work is in flight, so a preview and a viewer parse can never interleave into a wrong tree.
   */
  async function parseDraftPreview(text: string): Promise<ParseSnapshot | null> {
    const c = client;
    if (!c || !editor || saving || unreadable || viewerOps > 0 || !specActive) throw new PreviewUnavailableError('the viewer is busy');
    const token = ++engineToken;
    draftOnWorker = true;
    draftActive = true;
    try {
      const snap = await c.parseDraft(text);
      if (token !== engineToken) throw new SupersededError();
      return snap;
    } catch (e) {
      if (e instanceof EngineFatalError) markFatal(e.message);
      else if (token !== engineToken) throw new SupersededError(); // overtaken (e.g. a save started): whatever failed is moot
      throw e;
    }
  }

  async function loadPreviewRef(nodeId: number) {
    if (!client || !draftOnWorker || viewerOps > 0) throw new Error('the preview is out of date');
    return (await client.expandRef(nodeId)).nodes;
  }

  async function loadPreviewPage(nodeId: number, start: number, count: number) {
    if (!client || !draftOnWorker || viewerOps > 0) throw new Error('the preview is out of date');
    const r = await client.expand(nodeId, start, count);
    return { nodes: r.nodes, lazy: r.lazy };
  }

  /**
   * Show the file tab. Returning to it after a draft preview ran re-parses the viewer's own format (or raw bytes), so
   * the worker, the tree and the FormatBar agree again. The draft's tree is never shown in the viewer.
   */
  function showFileTab() {
    activeTab = 'file';
    reparseAfterDraft();
  }

  function reparseAfterDraft() {
    if (draftOnWorker && !saving && !unreadable && client) void runParse(selectedSpec);
  }

  // Safety net for a spec tab that vanished without going through showFileTab (e.g. the spec was removed by a folder sync).
  $effect(() => {
    if (!specActive) untrack(reparseAfterDraft);
  });

  /**
   * "Show in viewer" from the preview: the simpler of the two options. The viewer keeps its own format and tree (re-parsed
   * as above); only the byte range of the previewed node is selected and highlighted.
   */
  function showInViewer(range: { start: number; end: number } | null, offset: number) {
    showFileTab(); // clears nodeRange synchronously when it re-parses, so select afterwards
    const size = source?.size ?? 0;
    if (range && range.start < size) {
      const end = Math.min(range.end, size - 1);
      selection = { anchor: range.start, caret: end };
      nodeRange = { start: range.start, end };
      nodeInspectOffset = null;
      hexView?.reveal(range.start);
    } else if (Number.isSafeInteger(offset) && offset >= 0 && offset < size) {
      selection = null;
      nodeRange = null;
      nodeInspectOffset = offset;
      hexView?.reveal(offset);
    }
  }

  onMount(() => {
    const off = library.subscribe(onLibraryChange);
    void library.init().finally(() => (initializing = false));
    return off;
  });

  async function loadPage(nodeId: number, start: number, count: number) {
    if (!client) throw new Error('format engine unavailable');
    if (draftOnWorker) throw new Error('the structure is being refreshed');
    const r = await client.expand(nodeId, start, count);
    if (r.newErrors.length > 0) diagnostics = [...diagnostics, ...r.newErrors];
    return { nodes: r.nodes, lazy: r.lazy };
  }

  async function loadRef(nodeId: number) {
    if (!client) throw new Error('format engine unavailable');
    if (draftOnWorker) throw new Error('the structure is being refreshed');
    const r = await client.expandRef(nodeId);
    if (r.newErrors.length > 0) diagnostics = [...diagnostics, ...r.newErrors];
    return r.nodes;
  }

  /** Select an inclusive byte range (clamped to the file) and scroll it into view; with no range, only show where `offset` is. */
  function selectBytes(range: { start: number; end: number } | null, offset: number) {
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
      const ok = Number.isSafeInteger(offset) && offset >= 0 && offset < size;
      nodeInspectOffset = ok ? offset : null;
      if (ok) hexView?.reveal(offset);
    }
  }

  function onTreeSelect(node: Node, range: { start: number; end: number } | null) {
    selectBytes(range, node.offset);
  }

  /** A structure-tree `link` button: select `size` bytes at `offset` (size 0: just show the position). */
  function onTreeJump(offset: number, size: number) {
    selectBytes(size > 0 ? { start: offset, end: offset + size - 1 } : null, offset);
  }

  // Hex -> tree: only on a plain click, throttled, latest wins.
  const locate = throttleLatest(async (offset: number) => {
    const c = client;
    if (!c || !root || draftOnWorker) return;
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
    if (!c || !root || draftOnWorker) return;
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
    if (!c || !root || !w || w.end <= w.start || draftOnWorker) return;
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
    rawChosen = false;
    activeTab = 'file';
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
    if (!aboutOpen && hasFiles(e)) dragDepth++; // the About dialog is modal: no drop overlay behind it
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
    if (aboutOpen) return; // modal: swallow the drop (so the browser doesn't navigate) but load nothing
    const item = e.dataTransfer?.items[0];
    const entry = item?.webkitGetAsEntry?.();
    const file = e.dataTransfer?.files[0];
    if (entry?.isDirectory) {
      loadError = `Cannot open "${entry.name}": folders are not supported`;
    } else if (file) {
      guardDirty(() => void load(file));
    }
  }

  // ---- Derived shell state ----
  const formatName = $derived(
    selectedSpec === null ? null : sanitizeText(specs.find((s) => s.id === selectedSpec)?.name ?? selectedSpec, 80),
  );
  const errorCount = $derived(diagnostics.filter((d) => d.severity === 'error').length);
  const warningCount = $derived(diagnostics.length - errorCount);
  const tabs: EditorTab[] = $derived([
    ...(source !== null
      ? [{ id: 'file' as const, label: fileName ?? 'Untitled', modified: dirty, modifiedLabel: 'Modified', closable: false }]
      : []),
    ...(formats.selected
      ? [{ id: 'spec' as const, label: sanitizeText(formats.selected.name, 60), modified: formats.editorDirty, modifiedLabel: 'Unsaved changes', closable: true }]
      : []),
  ]);
  const hiddenAttrs = (hide: boolean) => (hide ? { inert: true, 'aria-hidden': 'true' as const } : {});
</script>

<svelte:head>
  <title>{(dirty ? '• ' : '') + (fileName !== null ? `${fileName} — Binary Viewer` : 'Binary Viewer')}</title>
</svelte:head>

<svelte:window onkeydown={onWindowKeyDown} ondragenter={onDragEnter} ondragleave={onDragLeave} ondragover={onDragOver} ondrop={onDrop} />

<input type="file" hidden bind:this={fileInput} onchange={onInputChange} />

<div class="app" class:drag-over={dragDepth > 0} {...(aboutOpen ? { inert: true } : {})}>
  <TitleBar
    hasName={fileName !== null}
    {saving}
    {unreadable}
    {loadError}
    onNew={newFile}
    onOpen={openFile}
    onSave={() => void save()}
    onSaveAs={() => void saveAs()}
    onAbout={openAbout}
  />
  <div
    class="shell"
    class:narrow
    style:grid-template-columns="44px {sideOpen && !narrow ? `${sideWidth}px 1px ` : ''}minmax(0, 1fr){inspectorOpen ? (narrow ? '' : ` 1px ${inspectorWidth}px`) : ' 28px'}"
  >
    <ActivityBar view={sideView} open={sideOpen} onSelect={onActivity} />

    <!-- Stays mounted while collapsed (hidden, inert) so the tree keeps its expansion, scroll and active row, and hex clicks can still reveal nodes. -->
    <div
      class="side-slot"
      class:overlay={narrow && sideOpen}
      class:closed={!sideOpen}
      class:hidden={!sideOpen}
      {...hiddenAttrs(!sideOpen)}
      style:width={narrow ? `min(${sideWidth}px, calc(100vw - 44px - 24px))` : !sideOpen ? `${sideWidth}px` : undefined}
    >
        <SideBar title={sideView === 'structure' ? 'Structure' : 'Formats'} onCollapse={() => setSideOpen(false)}>
          <div class="views">
            <div class="view" class:hidden={sideView !== 'structure'} {...hiddenAttrs(sideView !== 'structure')}>
              {#if source}
                {#if specActive && draftActive}<p class="quiet" role="status">Paused while a format preview is running</p>{/if}
                <div class="tree-wrap" {...(specActive && draftActive ? { inert: true } : {})}>
                  <StructureTree bind:this={tree} {root} {diagnostics} {loadPage} {loadRef} onSelect={onTreeSelect} onJump={onTreeJump} preserveFor={treeKeep} />
                </div>
              {:else}
                <p class="quiet">Open a file to see its structure.</p>
              {/if}
            </div>
            <div class="view" class:hidden={sideView !== 'formats'} {...hiddenAttrs(sideView !== 'formats')}>
              <FormatList ctl={formats} />
            </div>
          </div>
        </SideBar>
    </div>
    {#if sideOpen && !narrow}
      <Resizer
        orientation="vertical"
        label="Resize side bar"
        value={sideWidth}
        min={SIDE_RANGE.min}
        max={SIDE_RANGE.max}
        onResize={setSideWidth}
        onReset={() => setSideWidth(SIDE_RANGE.def)}
      />
    {/if}
    {#if drawerOpen}
      <button type="button" class="scrim" aria-label="Close panel" onclick={closeDrawers}></button>
    {/if}

    <main class="editor" bind:clientHeight={editorColumnHeight} {...(drawerOpen ? { inert: true } : {})}>
      <EditorTabs {tabs} activeId={specActive ? 'spec' : 'file'} onSelect={(id) => (id === 'spec' ? (activeTab = 'spec') : showFileTab())} onClose={() => formats.close()} />
      <div class="panels">
        <div
          class="panel"
          class:hidden={specActive}
          {...hiddenAttrs(specActive)}
          id="editor-panel-file"
          role="tabpanel"
          aria-labelledby={source ? 'editor-tab-file' : undefined}
          aria-label={source ? undefined : 'Welcome'}
        >
          {#if source && editor}
            <div class="editor-head">
              <FormatBar
                {specs}
                {detections}
                selected={selectedSpec}
                {status}
                errorText={engineError ?? specRejected}
                onSelect={(id) => {
                  rawChosen = id === null;
                  void runParse(id);
                }}
                onCancel={() => client?.cancel()}
              />
              <GoTo disabled={size === 0} error={gotoError} onGoTo={goTo} />
            </div>
            <div class="hexcol">
              {#if size === 0}<div class="empty-note"><p>Empty file (0 bytes)</p></div>{/if}
              <div class="hexrow">
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
                <!-- Reserved for the structure minimap (phase 2): a narrow column right of the hex grid. -->
                <div class="minimap-slot" data-slot="minimap"></div>
              </div>
            </div>
            {#if problemsOpen}
              <Resizer
                orientation="horizontal"
                label="Resize problems panel"
                invert
                value={problemsPx}
                min={PROBLEMS.min}
                max={problemsMax}
                onResize={setProblemsHeight}
                onReset={() => setProblemsHeight(PROBLEMS.def)}
              />
            {/if}
            <div class="bottom" style:height={problemsOpen ? `${problemsPx}px` : '28px'}>
              <BottomPanel open={problemsOpen} errors={errorCount} warnings={warningCount} onToggle={() => setProblemsOpen(!problemsOpen)}>
                <Diagnostics {diagnostics} alwaysOpen onJump={(d) => void jumpToDiagnostic(d)} />
              </BottomPanel>
            </div>
          {:else}
            <Welcome formatNames={builtinNames} onBrowse={() => showSide('formats')} />
          {/if}
        </div>
        <div
          class="panel"
          class:hidden={!specActive}
          {...hiddenAttrs(!specActive)}
          id="editor-panel-spec"
          role="tabpanel"
          aria-labelledby="editor-tab-spec"
        >
          {#if specOpen}
            <FormatDetail
              ctl={formats}
              previewDoc={editor ? (fileName ?? 'Untitled') : null}
              previewActive={specActive}
              previewBusy={saving}
              previewEpoch={previewEpoch}
              parseDraft={parseDraftPreview}
              loadPreviewPage={loadPreviewPage}
              loadPreviewRef={loadPreviewRef}
              onShowInViewer={showInViewer}
            />
          {/if}
        </div>
      </div>
    </main>

    {#if inspectorOpen}
      {#if !narrow}
        <Resizer
          orientation="vertical"
          label="Resize inspector"
          invert
          value={inspectorWidth}
          min={INSPECTOR_RANGE.min}
          max={INSPECTOR_RANGE.max}
          onResize={setInspectorWidth}
          onReset={() => setInspectorWidth(INSPECTOR_RANGE.def)}
        />
      {/if}
      <div class="inspector-slot" class:overlay={narrow} style:width={narrow ? `min(${inspectorWidth}px, calc(100vw - 44px - 24px))` : undefined}>
        <Inspector source={source && size > 0 ? source : null} offset={inspectOffset} version={editVersion} bind:littleEndian onCollapse={() => setInspectorOpen(false)} />
      </div>
    {:else}
      <button type="button" class="rail" aria-label="Show data inspector" title="Show data inspector" aria-expanded="false" onclick={() => setInspectorOpen(true)}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
        <span>Inspector</span>
      </button>
    {/if}
  </div>
  <StatusBar
    {selection}
    error={readError}
    {notice}
    {info}
    insertMode={source ? insertMode : null}
    onRetry={() => hexView?.retry()}
    formatName={source ? formatName : null}
    {littleEndian}
    onToggleEndian={() => (littleEndian = !littleEndian)}
    size={source ? size : null}
    {saving}
    {theme}
    onCycleTheme={cycleTheme}
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
{#if formats.confirm}
  {@const pending = formats.confirm}
  <ConfirmDialog
    message={pending.message}
    confirmLabel={pending.label}
    onCancel={() => (formats.confirm = null)}
    onConfirm={() => {
      const run = pending.run;
      formats.confirm = null;
      run();
    }}
  />
{/if}
{#if aboutOpen}
  <AboutDialog onClose={() => void closeAbout()} />
{/if}

<style>
  .app {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    height: 100vh;
    height: 100dvh;
    min-width: 0;
  }
  .app.drag-over {
    outline: 2px dashed var(--signal);
    outline-offset: -4px;
  }
  .shell {
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    min-height: 0;
    min-width: 0;
    position: relative;
  }
  .side-slot {
    min-width: 0;
    min-height: 0;
    background: var(--chrome);
  }
  .overlay {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 5;
    border: 0 solid var(--rule);
  }
  .side-slot.overlay {
    left: 44px;
    border-right-width: 1px;
  }
  .side-slot.closed {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 44px;
  }
  .scrim {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 44px;
    right: 0;
    z-index: 4;
    padding: 0;
    border: none;
    border-radius: 0;
    background: var(--scrim);
  }
  .scrim:hover:not(:disabled) {
    background: var(--scrim);
  }
  .tree-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .inspector-slot {
    min-width: 0;
    min-height: 0;
    background: var(--chrome);
  }
  .inspector-slot.overlay {
    right: 0;
    border-left-width: 1px;
  }
  .views {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .view {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .hidden {
    visibility: hidden;
    pointer-events: none;
  }
  .quiet {
    margin: 0;
    padding: 10px 12px;
    color: var(--ink-quiet);
    font-size: var(--fs-sm);
  }
  .editor {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--ground);
  }
  .panels {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .panel {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }
  .editor-head {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 4px 16px;
    padding: 4px 12px;
    background: var(--ground);
    border-bottom: 1px solid var(--rule);
  }
  .hexcol {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .hexrow {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .minimap-slot {
    flex: none;
    width: 0;
  }
  .empty-note {
    padding: 6px 12px;
    color: var(--ink-quiet);
    border-bottom: 1px solid var(--rule);
  }
  .empty-note p {
    margin: 0;
  }
  .bottom {
    flex: none;
    min-height: 28px;
    border-top: 1px solid var(--rule);
  }
  .rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 10px 0;
    border: none;
    border-left: 1px solid var(--rule);
    border-radius: 0;
    background: var(--chrome);
    color: var(--ink-quiet);
    font-size: var(--fs-sm);
  }
  .rail span {
    writing-mode: vertical-rl;
  }
</style>
