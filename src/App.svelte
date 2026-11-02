<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { BlobByteSource, MemoryByteSource, probeReadable, type ByteSource } from './core/byte-source';
  import { selectionRange, type Selection } from './core/caret';
  import type { Diagnostic, Node } from './core/engine';
  import { createAppLibrary } from './core/app-library';
  import { EditBuffer } from './core/edit-buffer';
  import { suggestionHint, type ParseStatus } from './core/format-status';
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
  import { buildCommands, type CommandContext } from './ui/commands';
  import Diagnostics from './ui/Diagnostics.svelte';
  import FormatDetail from './ui/formats/FormatDetail.svelte';
  import FormatList from './ui/formats/FormatList.svelte';
  import { FormatsState } from './ui/formats/formats-state.svelte';
  import HexView from './ui/HexView.svelte';
  import Inspector from './ui/Inspector.svelte';
  import Minimap from './ui/Minimap.svelte';
  import { loadBuiltinSpecs } from './formats';
  import {
    applyTheme,
    applyUiScale,
    clampTreeColumn,
    clearSize,
    loadFlag,
    loadHexBanding,
    loadLittleEndian,
    loadRecentCommands,
    loadShowMinimap,
    loadSideView,
    loadSize,
    loadTheme,
    loadTreeColumn,
    loadUiScale,
    saveFlag,
    saveHexBanding,
    saveLittleEndian,
    saveRecentCommands,
    saveShowMinimap,
    saveSideView,
    saveSize,
    saveTheme,
    saveTreeColumn,
    saveUiScale,
    stepUiScale,
    TREE_COLUMNS,
    withRecentCommand,
    type SideView,
    type ThemePref,
    type TreeColumn,
    type UiScale,
  } from './ui/prefs';
  import ActivityBar from './ui/shell/ActivityBar.svelte';
  import BottomPanel from './ui/shell/BottomPanel.svelte';
  import Breadcrumb from './ui/shell/Breadcrumb.svelte';
  import { crumbsFromChain, crumbsFromLocation, keepDeeperCrumbs, type Crumb } from './ui/shell/breadcrumb';
  import CommandPalette from './ui/shell/CommandPalette.svelte';
  import EditorTabs, { tabDomId, type EditorTab } from './ui/shell/EditorTabs.svelte';
  import GoTo from './ui/shell/GoTo.svelte';
  import { globalKey } from './ui/shell/keys';
  import { firstFocusable, nextRegion, regionOf, visibleRegions, type RegionId } from './ui/shell/regions';
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
  import type { OverviewResult } from './worker/engine-client';

  let {
    createClient = createWorkerClient,
    createPreviewClient = undefined,
    createLibrary = createAppLibrary,
  }: {
    createClient?: () => EngineClient;
    /** Engine for the spec previews (a second worker); defaults to `createClient`, called a second time. */
    createPreviewClient?: () => EngineClient;
    createLibrary?: () => SpecLibrary;
  } = $props();

  // The shown editor tab: the binary file or the active spec tab. Both panels stay mounted (the hidden one is inert),
  // so the open document, its scroll position and the active spec's editors survive switching between them.
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

  // Command palette; the element that had focus gets it back when the palette closes (see closePalette).
  let paletteOpen = $state(false);
  let paletteOpener: HTMLElement | null = null;
  let paletteInitial = $state<string | undefined>(undefined); // a command to enter at once (the status bar's format and offset buttons)
  let recentCommands = $state.raw(loadRecentCommands());

  function openPalette(opener?: HTMLElement, initial?: string) {
    if (paletteOpen) return;
    const el = opener ?? document.activeElement;
    paletteOpener = el instanceof HTMLElement && el !== document.body ? el : null;
    paletteInitial = initial;
    paletteOpen = true;
  }

  /** Close the palette, give focus back, then run `then` (a chosen command), so the command decides where focus ends up. */
  async function closePalette(then?: () => void) {
    if (!paletteOpen) return;
    paletteOpen = false;
    await tick(); // the background stays inert until the palette is gone
    const opener = paletteOpener;
    paletteOpener = null;
    if (opener?.isConnected && !opener.closest('[inert]')) opener.focus();
    then?.();
    await tick();
    // The command may have removed the element that had focus (Close spec tab from inside that tab): land on the editor.
    const now = document.activeElement;
    if (!now || now === document.body || now.closest('[inert]')) focusEditor();
  }

  /** The active editor tab, else the editor column. */
  function focusEditor() {
    const tab = document.getElementById(tabDomId(activeEditorId));
    (tab ?? editorMain)?.focus();
  }

  function useCommand(id: string) {
    recentCommands = withRecentCommand(recentCommands, id);
    saveRecentCommands(recentCommands);
  }
  // The user's format library (IndexedDB + optional folder). Its valid specs are mirrored into the engine worker.
  const library: SpecLibrary = untrack(() => createLibrary());
  // The format library UI state (open spec tabs, their unsaved drafts, actions), shared by the side bar list and the spec tabs.
  const formats = new FormatsState(library);
  formats.onOpened = () => (activeTab = 'spec');
  $effect(() => formats.connect());
  // The active spec tab is mounted (its editors and preview); it is the shown editor exactly when it was last picked.
  const specOpen = $derived(formats.activeSpecId !== null && formats.selected !== undefined);
  const specActive = $derived(activeTab === 'spec' && specOpen);
  // When the last spec tab goes away (closed, deleted, removed by a folder sync) `specActive` turns false: the file shows.
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
  let editorMain: HTMLElement | undefined = $state();

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
  // The structure minimap: the worker's whole-file summary, the bytes on screen, and how many buckets the strip can show.
  let overview = $state.raw<OverviewResult | null>(null);
  let viewportBytes = $state.raw<{ start: number; end: number } | null>(null);
  let overviewBuckets = 0;
  let showMinimap = $state(loadShowMinimap());
  const minimapSelection = $derived(selection ? selectionRange(selection) : nodeRange);
  let engineToken = 0; // bumped by every viewer open/parse; results from older ones are ignored
  let needsDetect = false; // startEngine was started but its detection result has not been applied yet
  let locateToken = 0;
  // ---- Breadcrumb: the path to the node under the caret, or the one selected in the tree ----
  let crumbs = $state.raw<Crumb[]>([]); // snapshots (lazy loads mutate the tree in place); empty: nothing located yet
  let crumbToken = 0; // bumped by every breadcrumb update and by anything that clears it: a late nodeAt answer is dropped
  let caretTimer: ReturnType<typeof setTimeout> | undefined;
  let appSelection: Selection | null = null; // the selection this component set itself (tree select): not a caret move to look up
  const CARET_LOOKUP_MS = 150;
  // ---- Shell layout and theme (remembered in local storage) ----
  const SIDE_RANGE = { min: 200, max: 600, def: 300 };
  const INSPECTOR_RANGE = { min: 240, max: 520, def: 320 };
  const PROBLEMS = { min: 80, def: 180 };
  const clampTo = (r: { min: number; max: number }, v: number) => Math.min(r.max, Math.max(r.min, v));
  let uiScale = $state<UiScale>(loadUiScale());
  // The narrow layout (drawers) starts below 900 CSS px; under the UI zoom a CSS px is bigger, so the breakpoint is 900 * zoom screen pixels (exclusive).
  const narrowQuery = (scale: number) => `(max-width: ${Math.floor(900 * scale) - 1}px)`;
  const startsNarrow = typeof matchMedia === 'function' && matchMedia(narrowQuery(untrack(() => uiScale))).matches;
  let narrow = $state(startsNarrow);
  let theme = $state<ThemePref>(loadTheme());
  let hexBanding = $state(loadHexBanding());
  let treeWidths = $state<Record<TreeColumn, number | null>>(
    Object.fromEntries(TREE_COLUMNS.map((c) => [c, loadTreeColumn(c)])) as Record<TreeColumn, number | null>,
  );
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
  $effect(() => applyUiScale(uiScale));
  $effect(() => {
    if (typeof matchMedia !== 'function') return;
    const q = matchMedia(narrowQuery(uiScale));
    const on = () => {
      narrow = q.matches;
      if (narrow && sideOpen && inspectorOpen) inspectorOpen = false; // one drawer at a time
    };
    untrack(on); // the zoom changed the breakpoint: the layout may have to change right now
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  });

  function setUiScale(scale: UiScale) {
    uiScale = scale;
    saveUiScale(scale);
  }
  function toggleHexBanding() {
    hexBanding = !hexBanding;
    saveHexBanding(hexBanding);
  }
  function setTreeColumn(column: TreeColumn, px: number | null) {
    const v = px === null ? null : clampTreeColumn(column, px);
    treeWidths = { ...treeWidths, [column]: v };
    saveTreeColumn(column, v);
  }
  /**
   * Back to the layout of a first visit: side bar, inspector and Problems panel sizes and visibility, the tree's column widths and
   * the minimap. The theme, the zoom, the side bar view and the recent commands stay. On a narrow screen the drawers stay closed (as
   * they always start); what is saved is the wide-screen default.
   */
  function resetLayout() {
    sideWidth = SIDE_RANGE.def;
    inspectorWidth = INSPECTOR_RANGE.def;
    problemsHeight = PROBLEMS.def;
    for (const name of ['sideWidth', 'inspectorWidth', 'problemsHeight']) clearSize(name);
    sideOpen = !narrow;
    inspectorOpen = !narrow;
    problemsOpen = !narrow;
    for (const name of ['sideOpen', 'inspectorOpen', 'problemsOpen']) saveFlag(name, true);
    for (const c of TREE_COLUMNS) setTreeColumn(c, null);
    showMinimap = true;
    saveShowMinimap(true);
  }

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
  /**
   * App-wide keys, after the focused control had its turn (a control that handled the key called preventDefault, which
   * skips everything here). Nothing happens while a dialog or the palette is open.
   */
  function onWindowKeyDown(e: KeyboardEvent) {
    const key = globalKey(e);
    // The zoom keys are the page's everywhere, dialogs and the palette included (zooming then is harmless), so that the browser's own
    // zoom never stacks on top of the page's.
    if (key === 'zoom-in' || key === 'zoom-out' || key === 'zoom-reset') {
      e.preventDefault();
      if (!e.repeat) setUiScale(key === 'zoom-reset' ? 1 : stepUiScale(uiScale, key === 'zoom-in' ? 1 : -1));
      return;
    }
    if (e.defaultPrevented || aboutOpen || paletteOpen || confirm || formats.confirm) return;
    if (key === 'palette') {
      e.preventDefault();
      if (!e.repeat) openPalette(); // a held key repeats: keep the browser out of it, but do not act again
    } else if (key === 'save') {
      if (specActive) return; // a spec tab: its editors own Ctrl+S
      e.preventDefault(); // the viewer owns Ctrl+S: no "Save page" dialog
      if (canSave && !e.repeat) void save();
    } else if (key === 'region-next' || key === 'region-prev') {
      e.preventDefault(); // F6 would otherwise move focus to the browser's own chrome
      if (e.repeat) return;
      const next = nextRegion(visibleRegions(shownRegions()), regionOf(document.activeElement), key === 'region-prev');
      if (next) focusRegion(next);
    } else if (e.key === 'Escape' && drawerOpen) {
      e.preventDefault();
      closeDrawers();
    }
  }
  // ---- Region navigation (F6 / Shift+F6, and the Focus commands) ----
  /** Which regions are on screen and can take focus now: collapsed panels, closed drawers and the hidden file panel are not. */
  function shownRegions(): Record<RegionId, boolean> {
    return {
      activity: true,
      side: sideOpen,
      editor: !drawerOpen, // a drawer makes the editor inert
      bottom: !drawerOpen && !specActive && source !== null,
      inspector: inspectorOpen,
      status: true,
    };
  }

  const regionEl = (id: RegionId) => document.querySelector<HTMLElement>(`[data-region="${id}"]`);

  /** Move keyboard focus into a region: its main control (the tree, the hex grid, the active tab) or its first control. */
  function focusRegion(id: RegionId): boolean {
    let el: HTMLElement | null = null;
    switch (id) {
      case 'activity':
        el = regionEl('activity')?.querySelector<HTMLElement>('button.active') ?? firstFocusable(regionEl('activity'));
        break;
      case 'side':
        if (sideView === 'structure' && source && tree) {
          tree.focus();
          return true;
        }
        el = firstFocusable(regionEl('side')?.querySelector('.view:not(.hidden)') ?? null) ?? firstFocusable(regionEl('side'));
        break;
      case 'editor':
        if (!specActive && source && hexView) {
          hexView.focus();
          return true;
        }
        focusEditor();
        return true;
      case 'bottom':
        el = regionEl('bottom')?.querySelector<HTMLElement>('.title') ?? null;
        break;
      case 'inspector':
        el = firstFocusable(regionEl('inspector'));
        break;
      case 'status':
        el = firstFocusable(regionEl('status'));
        break;
    }
    el?.focus();
    return el !== null;
  }

  /** Open a collapsed region, wait for it to show, then focus it. */
  async function openAndFocus(id: RegionId) {
    if (id === 'side') {
      if (!sideOpen) setSideOpen(true);
    } else if (id === 'inspector') {
      if (!inspectorOpen) setInspectorOpen(true);
    } else if (id === 'bottom') {
      showFileTab();
      if (!problemsOpen) setProblemsOpen(true);
      if (drawerOpen) closeDrawers();
    } else if (id === 'editor') {
      if (drawerOpen) closeDrawers();
    }
    await tick();
    focusRegion(id);
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
  $effect(() => saveLittleEndian(littleEndian));

  // Warn before leaving the page with unsaved edits; the listener exists only while dirty.
  $effect(() => {
    if (!dirty && !formats.anyDirty) return;
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
    requestOverview.cancel();
    locate.cancel();
    clearTimeout(caretTimer);
    client?.dispose();
    previewClient?.dispose();
  });

  function resetStructure() {
    engineToken++;
    locateToken++;
    clearCrumbs();
    root = null;
    diagnostics = [];
    nodeRange = null;
    nodeInspectOffset = null;
    tints = [];
    overview = null;
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
      clearCrumbs();
      root = null;
      diagnostics = [];
      nodeRange = null;
      tints = [];
      overview = null;
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
      clearCrumbs(); // node ids belong to the tree that was replaced
      root = snap.root;
      diagnostics = snap.errors;
      status = summarize(snap);
      requestTints();
      requestOverview();
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

  // ---- Format preview ----
  // Spec previews run on their OWN engine worker (ADR-0012). parseDraft replaces a worker's single result slot, so on the
  // viewer's worker it would blank the viewer's tree, tints and hex-to-tree lookups. The preview client is created on
  // first use, opens the same document Blob as the viewer (shared, not copied), reopens it when the document changed,
  // and is released when the last spec tab closes. It never gets the library's specs: a draft carries its own types.
  let previewClient: EngineClient | null = null;
  let previewFatal: string | null = null; // the preview worker died (or could not start); the viewer's worker is unaffected
  type PreviewDoc = { ed: EditBuffer; base: Blob; version: number };
  let previewOpened: (PreviewDoc & { client: EngineClient }) | null = null; // the document the preview worker has open
  let previewOpening: (PreviewDoc & { client: EngineClient; done: Promise<void> }) | null = null; // an open() in flight, shared by later requests
  let previewToken = 0; // bumped by every preview parse and by anything that invalidates a running one
  let docEpoch = $state(0); // bumped when the open document changed: the preview parses it again

  /**
   * The preview worker. After a fatal failure the dead client is replaced by a fresh one on the next preview request;
   * requests only come from user actions and edits (the pane never retries by itself), so this cannot respawn in a loop.
   */
  function getPreviewClient(): EngineClient {
    if (previewFatal !== null) dropPreviewClient();
    if (previewClient) return previewClient;
    try {
      const c = (createPreviewClient ?? createClient)();
      c.onFatal((m) => {
        if (previewClient === c) previewFatal = m; // a late report of a client that was already replaced is ignored
      });
      previewClient = c;
    } catch (e) {
      previewFatal = e instanceof Error ? e.message : String(e);
      throw new EngineFatalError(previewFatal);
    }
    return previewClient;
  }

  function dropPreviewClient() {
    previewClient?.dispose();
    previewClient = null;
    previewOpened = null;
    previewOpening = null;
    previewFatal = null;
  }

  /** Free the preview worker and the parse tree it holds (the last spec tab closed). The next preview starts a fresh one. */
  function releasePreview() {
    previewToken++;
    dropPreviewClient();
  }

  $effect(() => {
    if (formats.tabIds.length === 0) untrack(releasePreview);
  });

  /**
   * Parse the open document with an unsaved draft on the preview worker. The worker gets the document's current Blob
   * first (`editor.toBlob(baseBlob)`) unless it already has this exact state. A result is dropped when anything newer
   * started (another preview parse, a save, another document). Refused while there is no document or a save is running
   * (the file the worker would read is being replaced); the pane then waits for its next trigger.
   */
  async function parseDraftPreview(text: string): Promise<ParseSnapshot | null> {
    const ed = editor;
    const base = baseBlob;
    if (!ed || !base || saving || unreadable || !specActive) throw new PreviewUnavailableError('no document is ready');
    const token = ++previewToken;
    try {
      const c = getPreviewClient();
      const same = (o: PreviewDoc & { client: EngineClient } | null) => o !== null && o.client === c && o.ed === ed && o.base === base && o.version === ed.version;
      if (!same(previewOpened)) {
        // Later requests wait for an open() that is already running for this exact state instead of restarting it
        // (typing must not keep a large file from ever getting a result).
        let op = previewOpening;
        if (!same(op)) {
          previewOpened = null;
          const mine: PreviewDoc & { client: EngineClient; done: Promise<void> } = { ed, base, version: ed.version, client: c, done: Promise.resolve() };
          mine.done = c.open(ed.toBlob(base), fileName ?? 'Untitled').then(() => {
            if (previewOpening === mine) {
              previewOpening = null;
              previewOpened = { ed: mine.ed, base: mine.base, version: mine.version, client: c };
            }
          });
          mine.done.catch(() => {
            if (previewOpening === mine) previewOpening = null;
          });
          previewOpening = op = mine;
        }
        await op!.done;
        if (token !== previewToken) throw new SupersededError();
      }
      const snap = await c.parseDraft(text);
      if (token !== previewToken) throw new SupersededError();
      return snap;
    } catch (e) {
      if (token !== previewToken) throw new SupersededError(); // overtaken (e.g. a save started): whatever failed is moot
      throw e;
    }
  }

  async function loadPreviewRef(nodeId: number) {
    if (!previewClient) throw new Error('the preview is out of date');
    return (await previewClient.expandRef(nodeId)).nodes;
  }

  async function loadPreviewPage(nodeId: number, start: number, count: number) {
    if (!previewClient) throw new Error('the preview is out of date');
    const r = await previewClient.expand(nodeId, start, count);
    return { nodes: r.nodes, lazy: r.lazy };
  }

  function showFileTab() {
    activeTab = 'file';
  }

  function selectEditorTab(id: string) {
    if (id === 'file') showFileTab();
    else formats.activate(id.slice(SPEC_TAB.length));
  }

  function closeEditorTab(id: string) {
    if (id.startsWith(SPEC_TAB)) formats.close(id.slice(SPEC_TAB.length));
  }

  /**
   * "Show in viewer" from the preview: the simpler of the two options. The viewer keeps its own format and tree; only the
   * byte range of the previewed node is selected and highlighted.
   */
  function showInViewer(range: { start: number; end: number } | null, offset: number) {
    showFileTab();
    const size = source?.size ?? 0;
    if (range && range.start < size) {
      const end = Math.min(range.end, size - 1);
      selection = { anchor: range.start, caret: end };
      appSelection = selection;
      nodeRange = { start: range.start, end };
      nodeInspectOffset = null;
      hexView?.reveal(range.start);
      void lookupCrumbs(range.start);
    } else if (Number.isSafeInteger(offset) && offset >= 0 && offset < size) {
      selection = null;
      nodeRange = null;
      nodeInspectOffset = offset;
      hexView?.reveal(offset);
      void lookupCrumbs(offset);
    }
  }

  onMount(() => {
    const off = library.subscribe(onLibraryChange);
    void library.init().finally(() => (initializing = false));
    return off;
  });

  async function loadPage(nodeId: number, start: number, count: number) {
    if (!client) throw new Error('format engine unavailable');
    const r = await client.expand(nodeId, start, count);
    if (r.newErrors.length > 0) diagnostics = [...diagnostics, ...r.newErrors];
    requestOverview(); // a variable-size expansion changes which bytes the tree covers (the worker answers from its cache otherwise)
    return { nodes: r.nodes, lazy: r.lazy };
  }

  async function loadRef(nodeId: number) {
    if (!client) throw new Error('format engine unavailable');
    const r = await client.expandRef(nodeId);
    if (r.newErrors.length > 0) diagnostics = [...diagnostics, ...r.newErrors];
    requestOverview();
    return r.nodes;
  }

  /** Select an inclusive byte range (clamped to the file) and scroll it into view; with no range, only show where `offset` is. */
  function selectBytes(range: { start: number; end: number } | null, offset: number) {
    const size = source?.size ?? 0;
    if (range && range.start < size) {
      const end = Math.min(range.end, size - 1);
      selection = { anchor: range.start, caret: end };
      appSelection = selection;
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

  function onTreeSelect(node: Node, range: { start: number; end: number } | null, opts?: { keepSelection: boolean }) {
    if (opts?.keepSelection) {
      // A hex click found this node: the clicked byte stays the selection (and the caret), the node's bytes are only highlighted.
      const size = source?.size ?? 0;
      nodeRange = range && range.start < size ? { start: range.start, end: Math.min(range.end, size - 1) } : null;
      nodeInspectOffset = null;
      return;
    }
    selectBytes(range, node.offset);
  }

  function clearCrumbs() {
    crumbToken++;
    clearTimeout(caretTimer);
    crumbs = [];
  }

  /** The tree selected a node (click, key, reveal): its chain from the root is the breadcrumb. */
  function onTreePath(chain: Node[]) {
    clearTimeout(caretTimer);
    crumbToken++;
    crumbs = crumbsFromChain(chain);
  }

  /** A breadcrumb segment was chosen: select that node in the tree (and so in the hex view). */
  function onCrumb(c: Crumb) {
    void tree?.reveal(c.reveal.path, c.reveal.lazyIndex, c.reveal.offset);
  }

  /** The caret moved by the keyboard: look up its node (the latest lookup wins; a click or a tree selection supersedes it). */
  async function lookupCrumbs(offset: number) {
    const c = client;
    const r = root;
    if (!c || !r) return;
    const t = ++crumbToken;
    try {
      const loc = await c.nodeAt(offset);
      if (t !== crumbToken || root !== r) return;
      const next = loc.path ? crumbsFromLocation(r, loc.path, loc.lazyIndex, offset) : [];
      if (!keepDeeperCrumbs(crumbs, next, offset)) crumbs = next;
    } catch {
      /* superseded, or the engine is gone: the path shown stays */
    }
  }

  // A failed parse that has an engine error beside it is shown once: the status bar's alert item carries the error, so the parse item stays quiet (see the `parse` prop below).
  // While a mouse button is held (a click or a drag) the selection changes are not caret moves: a click answers for itself
  // (onByteClick), and a drag is looked up once it ends.
  let pointerHeld = false;
  let clickHandled = false;

  function armCaretLookup() {
    clearTimeout(caretTimer);
    const sel = selection;
    const caret = sel?.caret;
    if (pointerHeld || caret === undefined || sel === appSelection || !root || !client) return;
    // The caret left the highlighted node (keys, typing at its end, a drag): the highlight no longer says where the caret is.
    if (nodeRange && (caret < nodeRange.start || caret > nodeRange.end)) nodeRange = null;
    caretTimer = setTimeout(() => void lookupCrumbs(caret), CARET_LOOKUP_MS);
  }

  $effect(() => {
    void selection;
    void selection?.caret;
    untrack(armCaretLookup);
  });

  function onWindowMouseDown() {
    pointerHeld = true;
    clickHandled = false;
  }

  function onWindowMouseUp() {
    pointerHeld = false;
    // After the hex view's own mouseup handling: a plain click was answered by locate, a drag-select was not.
    setTimeout(() => {
      if (!clickHandled) armCaretLookup();
    }, 0);
  }

  /** A structure-tree `link` button: select `size` bytes at `offset` (size 0: just show the position). */
  function onTreeJump(offset: number, size: number) {
    selectBytes(size > 0 ? { start: offset, end: offset + size - 1 } : null, offset);
    void lookupCrumbs(offset); // the tree did not select a node: the breadcrumb follows the jump target
  }

  // Hex -> tree: only on a plain click, throttled, latest wins.
  const locate = throttleLatest(async (offset: number) => {
    const c = client;
    if (!c || !root) return;
    const r = root;
    const t = ++locateToken;
    try {
      const loc = await c.nodeAt(offset);
      if (t !== locateToken || root !== r) return;
      if (!loc.path) {
        nodeRange = null; // a gap in the structure: the node of an earlier click is not this byte's
        return;
      }
      crumbToken++;
      crumbs = crumbsFromLocation(r, loc.path, loc.lazyIndex, offset); // the tree's own selection refines it below
      await tree?.reveal(loc.path, loc.lazyIndex, offset, true); // the clicked byte stays selected
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

  // Whole-file structure for the minimap; viewer worker only. Latest wins, and a new parse/open drops the answer.
  const requestOverview = throttleLatest(async () => {
    const c = client;
    const token = engineToken;
    if (!c || !root || overviewBuckets <= 0) return;
    try {
      const o = await c.overview(overviewBuckets);
      if (token === engineToken) overview = o;
    } catch {
      /* superseded, or the engine is gone */
    }
  }, 100);

  function onWantBuckets(n: number) {
    overviewBuckets = n;
    requestOverview();
  }

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
      docEpoch++;
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
    previewToken++; // a preview of the previous document must not land
    docEpoch++;
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
    previewToken++; // the preview worker reads the same file; its running parse is dropped, the pane waits for the save
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
    if (!aboutOpen && !paletteOpen && hasFiles(e)) dragDepth++; // the About dialog is modal: no drop overlay behind it
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
    if (aboutOpen || paletteOpen) return; // modal: swallow the drop (so the browser doesn't navigate) but load nothing
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
  // The breadcrumb: the located path, or just the root once there is a parse and nothing is located.
  const shownCrumbs = $derived(root ? (crumbs.length > 0 ? crumbs : crumbsFromChain([root])) : []);
  const errorCount = $derived(diagnostics.filter((d) => d.severity === 'error').length);
  const warningCount = $derived(diagnostics.length - errorCount);
  const SPEC_TAB = 'spec:'; // spec tab ids in the tab bar: SPEC_TAB + the spec id
  const tabs: EditorTab[] = $derived([
    ...(source !== null ? [{ id: 'file', label: fileName ?? 'Untitled', modified: dirty, modifiedLabel: 'Modified', closable: false, icon: selectedSpec === 'bmp' ? 'bmp' : selectedSpec === 'zip' ? 'zip' : 'file' } as EditorTab] : []),
    ...formats.openTabs.map((t) => ({ id: SPEC_TAB + t.id, label: sanitizeText(t.name, 60), modified: t.dirty, modifiedLabel: 'Modified', closable: true })),
  ]);
  const activeEditorId = $derived(specActive ? SPEC_TAB + formats.activeSpecId : 'file');
  const editorPanelId = (id: string) => (id === 'file' ? 'editor-panel-file' : 'editor-panel-spec');
  const hiddenAttrs = (hide: boolean) => (hide ? { inert: true, 'aria-hidden': 'true' as const } : {});
  // Same rule as the Save buttons in the title bar.
  const canSave = $derived(fileName !== null && editor !== null && !saving && !unreadable);

  function toggleMinimap() {
    showMinimap = !showMinimap;
    saveShowMinimap(showMinimap);
  }

  /** What the command palette may read and do; the getters keep it current while the palette is open. */
  const commandCtx: CommandContext = {
    get hasFile() {
      return editor !== null;
    },
    get canSave() {
      return canSave;
    },
    get fileSize() {
      return size;
    },
    get saving() {
      return saving;
    },
    get unreadable() {
      return unreadable;
    },
    get parsing() {
      return status.state === 'parsing';
    },
    get specActive() {
      return specActive;
    },
    get sideOpen() {
      return sideOpen;
    },
    get sideView() {
      return sideView;
    },
    get inspectorOpen() {
      return inspectorOpen;
    },
    get problemsOpen() {
      return problemsOpen;
    },
    get showMinimap() {
      return showMinimap;
    },
    get hexBanding() {
      return hexBanding;
    },
    get uiScale() {
      return uiScale;
    },
    get theme() {
      return theme;
    },
    get littleEndian() {
      return littleEndian;
    },
    get specs() {
      return specs;
    },
    get detections() {
      return detections;
    },
    get selectedSpec() {
      return selectedSpec;
    },
    get tabs() {
      return tabs.map((t) => ({ id: t.id, label: t.label, active: t.id === activeEditorId }));
    },
    get library() {
      return formats.snap.entries.map((e) => ({ id: e.id, name: e.name, custom: e.source === 'user' }));
    },
    actions: {
      newFile,
      openFile,
      save: () => void save(),
      saveAs: () => void saveAs(),
      goToOffset: (offset) => {
        showFileTab();
        gotoError = null;
        void tick().then(() => hexView?.goTo(offset));
      },
      chooseFormat: (id) => {
        showFileTab();
        rawChosen = id === null;
        void runParse(id);
      },
      cancelParse: () => client?.cancel(),
      toggleSide: () => setSideOpen(!sideOpen),
      showView: showSide,
      toggleInspector: () => setInspectorOpen(!inspectorOpen),
      toggleProblems: () => setProblemsOpen(!problemsOpen),
      toggleMinimap,
      toggleHexBanding,
      zoomIn: () => setUiScale(stepUiScale(uiScale, 1)),
      zoomOut: () => setUiScale(stepUiScale(uiScale, -1)),
      resetZoom: () => setUiScale(1),
      resetLayout,
      focusSide: () => void openAndFocus('side'),
      focusEditor: () => void openAndFocus('editor'),
      focusProblems: () => void openAndFocus('bottom'),
      focusInspector: () => void openAndFocus('inspector'),
      setTheme: (t) => {
        theme = t;
        saveTheme(t);
      },
      setLittleEndian: (le) => (littleEndian = le),
      selectTab: selectEditorTab,
      closeSpecTab: () => formats.close(),
      openSpec: (id) => formats.select(id),
      openAbout: () => openAbout(document.activeElement instanceof HTMLElement ? document.activeElement : document.body),
    },
  };
  const commands = $derived(buildCommands(commandCtx));
</script>

<svelte:head>
  <title>{(dirty ? '• ' : '') + (fileName !== null ? `${fileName} — Binary Viewer` : 'Binary Viewer')}</title>
</svelte:head>

<svelte:window onkeydown={onWindowKeyDown} onmousedown={onWindowMouseDown} onmouseup={onWindowMouseUp} ondragenter={onDragEnter} ondragleave={onDragLeave} ondragover={onDragOver} ondrop={onDrop} />

<input type="file" hidden bind:this={fileInput} onchange={onInputChange} />

<div class="app" class:drag-over={dragDepth > 0} {...(aboutOpen || paletteOpen ? { inert: true } : {})}>
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
    onPalette={openPalette}
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
      data-region="side"
      {...hiddenAttrs(!sideOpen)}
      style:width={narrow ? `min(${sideWidth}px, calc(100vw / var(--ui-scale) - 44px - 24px))` : !sideOpen ? `${sideWidth}px` : undefined}
    >
        <SideBar title={sideView === 'structure' ? 'Structure' : 'Formats'} onCollapse={() => setSideOpen(false)}>
          <div class="views">
            <div class="view" class:hidden={sideView !== 'structure'} {...hiddenAttrs(sideView !== 'structure')}>
              {#if source}
                <div class="tree-wrap">
                  <StructureTree
                    bind:this={tree}
                    {root}
                    {diagnostics}
                    {loadPage}
                    {loadRef}
                    onSelect={onTreeSelect}
                    onPath={onTreePath}
                    onJump={onTreeJump}
                    preserveFor={treeKeep}
                    widths={treeWidths}
                    onColumnWidth={setTreeColumn}
                    onResetLayout={resetLayout}
                  />
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
        onResetLayout={resetLayout}
      />
    {/if}
    {#if drawerOpen}
      <button type="button" class="scrim" aria-label="Close panel" onclick={closeDrawers}></button>
    {/if}

    <main class="editor" data-region="editor" tabindex="-1" bind:this={editorMain} bind:clientHeight={editorColumnHeight} {...(drawerOpen ? { inert: true } : {})}>
      <EditorTabs {tabs} activeId={activeEditorId} panelId={editorPanelId} onSelect={selectEditorTab} onClose={closeEditorTab} />
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
              <Breadcrumb crumbs={shownCrumbs} hasStructure={root !== null} onSelect={onCrumb} />
              <div class="goto-slot"><GoTo disabled={size === 0} error={gotoError} onGoTo={goTo} /></div>
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
                  banding={hexBanding}
                  {onViewChange}
                  onViewport={(start, end) => (viewportBytes = { start, end })}
                  onByteClick={(offset) => {
                    clearTimeout(caretTimer); // the click's own lookup (below) answers for this caret
                    clickHandled = true;
                    locate(offset);
                  }}
                  id="hex-grid"
                />
                {#if showMinimap}
                  <Minimap
                    {size}
                    {overview}
                    viewport={viewportBytes}
                    selection={minimapSelection}
                    controls="hex-grid"
                    onSeek={(offset, center) => hexView?.scrollToOffset(offset, center)}
                    onWheelBy={(px) => hexView?.scrollBy(px)}
                    {onWantBuckets}
                    scale={uiScale}
                  />
                {/if}
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
                onResetLayout={resetLayout}
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
          aria-labelledby={specOpen ? tabDomId(SPEC_TAB + formats.activeSpecId) : undefined}
        >
          {#if specOpen}
            <FormatDetail
              ctl={formats}
              previewDoc={editor ? (fileName ?? 'Untitled') : null}
              previewActive={specActive}
              previewBusy={saving}
              previewEpoch={docEpoch}
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
          onResetLayout={resetLayout}
        />
      {/if}
      <div class="inspector-slot" data-region="inspector" class:overlay={narrow} style:width={narrow ? `min(${inspectorWidth}px, calc(100vw / var(--ui-scale) - 44px - 24px))` : undefined}>
        <Inspector source={source && size > 0 ? source : null} hasFile={source !== null} empty={source !== null && size === 0} offset={inspectOffset} version={editVersion} bind:littleEndian onCollapse={() => setInspectorOpen(false)} />
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
    engineError={source && (engineError ?? specRejected) ? sanitizeText(engineError ?? specRejected ?? '', 400) : null}
    {notice}
    {info}
    insertMode={source ? insertMode : null}
    onToggleInsert={() => hexView?.toggleInsert()}
    onRetry={() => hexView?.retry()}
    formatName={source ? formatName : null}
    formatHint={source ? suggestionHint(detections, selectedSpec) : null}
    onChooseFormat={(opener) => openPalette(opener, 'format.choose')}
    parse={source && !(status.state === 'error' && (engineError ?? specRejected)) ? status : { state: 'idle' }}
    onCancelParse={() => client?.cancel()}
    onShowProblems={() => void openAndFocus('bottom')}
    canGoTo={source !== null && size > 0}
    onGoTo={(opener) => openPalette(opener, 'file.goTo')}
    {littleEndian}
    onToggleEndian={() => (littleEndian = !littleEndian)}
    size={source ? size : null}
    {saving}
    {theme}
    onCycleTheme={cycleTheme}
    {uiScale}
    onResetZoom={() => setUiScale(1)}
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
{#if paletteOpen}
  <CommandPalette {commands} recent={recentCommands} initial={paletteInitial} onUse={useCommand} onClose={(then) => void closePalette(then)} />
{/if}

<style>
  .app {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    /* CSS zoom on <html> scales viewport units as well: divide the zoom back out so the app is exactly as tall as the window */
    height: calc(100vh / var(--ui-scale, 1));
    height: calc(100dvh / var(--ui-scale, 1));
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
  /*
   * Drawers (narrow screens only): they fade and slide a few px in and out; opacity and transform only, and instant with reduced
   * motion (the tokens are 0ms). Collapsing a panel on a wide screen changes the layout, so it stays instant. The inspector drawer
   * is unmounted when closed, so it only animates in.
   */
  .shell.narrow .side-slot {
    transition:
      opacity var(--motion-out) var(--ease-in),
      transform var(--motion-out) var(--ease-in),
      visibility 0s linear var(--motion-out);
  }
  .shell.narrow .side-slot.closed {
    opacity: 0;
    transform: translateX(-12px);
  }
  .shell.narrow .side-slot.overlay {
    transition:
      opacity var(--motion-in) var(--ease-out),
      transform var(--motion-in) var(--ease-out),
      visibility 0s;
  }
  .inspector-slot.overlay {
    animation: drawer-in-right var(--motion-in) var(--ease-out);
  }
  .scrim {
    animation: fade-in var(--motion-in) var(--ease-out);
  }
  @keyframes drawer-in-right {
    from {
      opacity: 0;
      transform: translateX(12px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
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
    outline: none; /* focusable by script only (the fallback focus target) */
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
  /* One row: the breadcrumb takes what Go to offset leaves. */
  .editor-head {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 2px 12px;
    background: var(--ground);
    border-bottom: 1px solid var(--rule);
  }
  .goto-slot {
    flex: none;
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
