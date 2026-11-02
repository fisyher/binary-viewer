<script lang="ts">
  import { untrack } from 'svelte';
  import type { Diagnostic, LazyArray, Node } from '../core/engine';
  import { findNodeAt } from '../core/engine/interpret';
  import { groupIdMap, rowGroups } from '../core/groups';
  import {
    MAX_TITLE_CHARS,
    PAGE_SIZE,
    defaultExpanded,
    flattenTree,
    followPath,
    formatNodeValue,
    linkByteRange,
    linkLabel,
    loadKey,
    matchNodeIds,
    navigateRows,
    nodeByteRange,
    nodeKey,
    pathById,
    problemMessages,
    refLoadKey,
    resolveNodePath,
    sanitizeText,
    virtualWindow,
    type NavKey,
    type Pages,
    type Row,
  } from '../core/tree-model';
  import { TREE_COLUMN_MAX, TREE_COLUMN_MIN, type TreeColumn } from './prefs';
  import Resizer from './shell/Resizer.svelte';

  // 24px: the twisty and the jump buttons are at least 24px tall targets, so a row is too.
  const ROW_HEIGHT = 24;
  const NAV_KEYS = new Set<string>(['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End']);

  export interface PageResult {
    nodes: Node[];
    lazy: LazyArray | null;
  }

  let {
    root,
    diagnostics = [],
    loadPage,
    loadRef,
    onSelect,
    onPath = undefined,
    onJump,
    preserveFor = null,
    nameWidth = null,
    valueWidth = null,
    onColumnWidth = undefined,
    onResetLayout = undefined,
  }: {
    root: Node | null;
    diagnostics?: Diagnostic[];
    /** Fetch `count` elements of lazy array `nodeId` starting at `start` (from the worker). */
    loadPage: (nodeId: number, start: number, count: number) => Promise<PageResult>;
    /** Open the `ref` of node `nodeId` (from the worker): resolves to the target node(s) to attach under it. */
    loadRef?: (nodeId: number) => Promise<Node[]>;
    /** `range` is the inclusive byte range of the node, or null for zero-size nodes. */
    onSelect: (node: Node, range: { start: number; end: number } | null) => void;
    /** The selected node's chain from the root (root first), reported with every selection: the breadcrumb bar's path. */
    onPath?: (chain: Node[]) => void;
    /** A node's `link` button was used: select `size` bytes at `offset` in the hex view (size 0 = just show the position). Without it no link buttons are shown. */
    onJump?: (offset: number, size: number) => void;
    /** When `root` is this exact tree (a re-parse of edited bytes), keep expansion and selection where node paths still match. */
    preserveFor?: Node | null;
    /** Widths (px) the user gave the Name and Value columns; null = the default, flexible width. */
    nameWidth?: number | null;
    valueWidth?: number | null;
    /** A header divider was dragged or used from the keyboard (px), or double-clicked (null = back to the default). Without it the dividers are not shown. */
    onColumnWidth?: (column: TreeColumn, px: number | null) => void;
    /** The dividers' context menu item "Reset layout" (see Resizer). */
    onResetLayout?: () => void;
  } = $props();

  let expanded = $state.raw<ReadonlySet<number>>(new Set());
  let pages = $state.raw<Pages>(new Map());
  let loading = $state.raw<ReadonlySet<string>>(new Set());
  let version = $state(0); // bumped when a variable-size lazy array appends children in place
  let selectedKey = $state<string | null>(null);
  let activeKey = $state<string | null>(null);
  let scrollTop = $state(0);
  let viewportHeight = $state(0);
  let loadError = $state<string | null>(null);
  let scroller: HTMLDivElement | undefined = $state();
  let nameCell = $state(0); // the header cells' current widths: where a divider starts from while the column is still flexible
  let valueCell = $state(0);
  // Fixed (dragged) columns make the row as wide as the sum of its columns; the scroller then scrolls sideways if that is more than fits.
  const minWide = $derived((nameWidth ?? 150) + (valueWidth ?? 90) + 70 + 80 + 50 + 22 + 5 * 6);
  const minNarrow = $derived((nameWidth ?? 100) + (valueWidth ?? 56) + 52 + 30 + 20 + 4 * 4);
  const uid = $props.id(); // row ids are unique per tree instance (the viewer and the Formats preview may both be mounted)
  const rowId = (key: string) => `${uid}-${key.replaceAll(':', '-')}`;
  // The row of the latest first click on a row: a double-click acts on it, wherever the rows have moved to. Cleared by any
  // other pointer action (twisty, buttons) and when the tree is replaced. Clicks on different rows reset the browser's click
  // count, so a double-click is always two clicks on the same row.
  let clickedKey: string | null = null;
  type Jump = { label: string; path: string };
  let jumpToken = 0; // bumped by every jump click (on any reference): only the newest click may select
  const wantedJump = new Map<number, { jump: Jump; token: number }>(); // ref node id -> newest jump click waiting for the open

  // New tree -> fresh view state (runs before the DOM updates).
  let prevRoot: Node | null = null;
  $effect.pre(() => {
    const r = root;
    const keep = r !== null && preserveFor === r;
    const old = prevRoot;
    prevRoot = r;
    clickedKey = null;
    if (keep && old) {
      untrack(() => {
        const ids = matchNodeIds(old, r);
        const mapId = (id: number) => ids.get(id);
        const carried = new Set<number>();
        for (const id of expanded) {
          const to = mapId(id);
          if (to !== undefined) carried.add(to);
        }
        const key = (k: string | null) => {
          const to = k && k.startsWith('n') ? mapId(Number(k.slice(1))) : undefined;
          return to === undefined ? null : nodeKey(to);
        };
        expanded = carried.size > 0 ? carried : defaultExpanded(r);
        selectedKey = key(selectedKey);
        activeKey = key(activeKey);
      });
      pages = new Map();
      loading = new Set();
      loadError = null;
      return; // scroll position stays
    }
    expanded = r ? defaultExpanded(r) : new Set();
    pages = new Map();
    loading = new Set();
    selectedKey = null;
    activeKey = null;
    loadError = null;
    wantedJump.clear();
    scrollTop = 0;
    untrack(() => {
      if (scroller) scroller.scrollTop = 0;
    });
  });

  const rows = $derived.by<Row[]>(() => {
    void version;
    return root ? flattenTree(root, { expanded, pages, loading }) : [];
  });
  // Colour groups, as the hex view and the minimap colour them: group nodes get a swatch, what is inside them a rule.
  const marks = $derived.by(() => {
    void version;
    return root ? rowGroups(rows.map((r) => ({ depth: r.depth, id: r.kind === 'node' ? r.node.id : null })), groupIdMap(root)) : [];
  });
  const win = $derived(virtualWindow(rows.length, scrollTop, viewportHeight, ROW_HEIGHT));
  const visible = $derived(rows.slice(win.start, win.end));
  // Only an active row that is rendered can be named; when it has scrolled out of the window the attribute is omitted.
  const activeId = $derived(activeKey !== null && visible.some((r) => r.key === activeKey) ? rowId(activeKey) : undefined);
  const severity = $derived.by(() => {
    const m = new Map<number, 'error' | 'warning'>();
    for (const d of diagnostics) {
      if (d.nodeId === undefined) continue;
      if (d.severity === 'error' || !m.has(d.nodeId)) m.set(d.nodeId, d.severity);
    }
    return m;
  });

  const hex = (n: number) => '0x' + n.toString(16).toUpperCase();

  function setScroll(top: number) {
    const t = Math.max(0, top);
    scrollTop = t;
    if (scroller) scroller.scrollTop = t;
  }

  function scrollToIndex(i: number, center: boolean) {
    const top = i * ROW_HEIGHT;
    if (top < scrollTop) setScroll(center ? top - viewportHeight / 2 : top);
    else if (top + ROW_HEIGHT > scrollTop + viewportHeight) setScroll(center ? top - viewportHeight / 2 : top + ROW_HEIGHT - viewportHeight);
  }

  /** `scroll` false for pointer selection: the clicked row is already (partly) visible and moving it would break a double-click. */
  function selectNode(node: Node, center = false, scroll = true) {
    const key = nodeKey(node.id);
    selectedKey = key;
    activeKey = key;
    const i = scroll ? rows.findIndex((r) => r.key === key) : -1;
    if (i >= 0) scrollToIndex(i, center);
    onSelect(node, nodeByteRange(node));
    onPath?.(chainTo(node));
  }

  /** The nodes from the root to `node`: through the visible rows (which include the unattached elements of fixed-size lazy arrays), else through the tree. */
  function chainTo(node: Node): Node[] {
    const at = new Map(rows.map((r, i) => [r.key, i] as const));
    const chain: Node[] = [];
    let i = at.get(nodeKey(node.id));
    for (let guard = 0; i !== undefined && guard < 10_000; guard++) {
      const r = rows[i]!;
      if (r.kind === 'node') chain.push(r.node);
      i = r.parentKey === null ? undefined : at.get(r.parentKey);
    }
    if (chain.length > 0) return chain.reverse();
    return (root && pathById(root, node.id)) || [node];
  }

  /** Move keyboard focus to the tree. */
  export function focus() {
    scroller?.focus();
  }

  async function load(array: Node, start: number): Promise<void> {
    const r0 = root;
    const k = loadKey(array.id, start);
    if (!r0 || loading.has(k)) return;
    loading = new Set(loading).add(k);
    loadError = null;
    try {
      const res = await loadPage(array.id, start, PAGE_SIZE);
      if (root !== r0) return;
      if (array.lazy?.elemSize !== null) {
        const next = new Map(pages);
        next.set(array.id, new Map(pages.get(array.id)).set(Math.floor(start / PAGE_SIZE), res.nodes));
        pages = next;
      } else {
        if ((array.children?.length ?? 0) === start) array.children = [...(array.children ?? []), ...res.nodes];
        if (res.lazy) array.lazy = res.lazy;
        version++;
      }
    } catch (e) {
      if (root === r0 && !(e instanceof Error && e.name === 'SupersededError')) {
        loadError = sanitizeText(`Could not load items: ${e instanceof Error ? e.message : String(e)}`, 300);
      }
    } finally {
      if (root === r0) {
        const n = new Set(loading);
        n.delete(k);
        loading = n;
      }
    }
  }

  /**
   * Fetch and attach the target of an unopened reference node. Resolves to the attached nodes, or null when nothing should
   * follow (already loading, tree replaced, superseded, or failed: the error is shown).
   */
  async function attachRef(node: Node, r0: Node): Promise<Node[] | null> {
    const k = refLoadKey(node.id);
    if (!loadRef || !node.ref || node.ref.loaded || loading.has(k)) return null;
    loading = new Set(loading).add(k);
    loadError = null;
    try {
      const nodes = await loadRef(node.id);
      if (root !== r0) return null;
      if (nodes.length === 0) {
        loadError = 'Could not open the reference (see Diagnostics).';
        return null;
      }
      if (!node.ref.loaded) {
        node.children = [...(node.children ?? []), ...nodes];
        node.ref = { ...node.ref, loaded: true };
        version++;
      }
      return nodes;
    } catch (e) {
      if (root === r0 && !(e instanceof Error && e.name === 'SupersededError')) {
        loadError = sanitizeText(`Could not open the reference: ${e instanceof Error ? e.message : String(e)}`, 300);
      }
      return null;
    } finally {
      if (root === r0) {
        const n = new Set(loading);
        n.delete(k);
        loading = n;
      }
    }
  }

  /** The reference `node` has just been attached: perform the jump wanted for it (if it is still the newest click), else select the target. */
  function settleRef(node: Node, nodes: Node[]) {
    const w = wantedJump.get(node.id);
    wantedJump.delete(node.id);
    const target = nodes[0]!;
    if (!w) {
      expanded = new Set([...expanded, node.id, target.id]);
      selectNode(target, true);
    } else if (w.token === jumpToken) performJump(node, target, w.jump);
    // else: a newer jump click (possibly on another reference) owns the selection; the ref stays attached
  }

  /** Open a reference node: attach its target as a child, expand and select it (or perform a jump clicked meanwhile). */
  async function openRef(node: Node): Promise<void> {
    const r0 = root;
    if (!r0 || loading.has(refLoadKey(node.id))) return;
    const nodes = await attachRef(node, r0);
    if (!nodes || root !== r0) {
      if (root === r0) wantedJump.delete(node.id); // a replaced tree already cleared its jumps; ids may be reused
      return;
    }
    settleRef(node, nodes);
  }

  /**
   * A `ref.jumps` button: open the reference if needed, then select the node at `jump.path` inside its target. Every click
   * takes a fresh token and replaces the wanted jump of its reference; whatever finishes opening acts on the wanted jump
   * only if its token is still the newest, so the newest click wins across references too. Superseded loads stay silent.
   */
  async function jumpRef(node: Node, jump: Jump): Promise<void> {
    const r0 = root;
    if (!r0 || !node.ref) return;
    wantedJump.set(node.id, { jump, token: ++jumpToken });
    if (node.ref.loaded) {
      const target = node.children?.find((c) => c.fromRef);
      wantedJump.delete(node.id);
      loadError = null;
      if (target) performJump(node, target, jump);
      else loadError = 'The reference has no opened target.';
      return;
    }
    if (loading.has(refLoadKey(node.id))) return; // the loader in flight (jump or Enter) settles with the newest wanted jump
    const nodes = await attachRef(node, r0);
    if (!nodes || root !== r0) {
      if (root === r0) wantedJump.delete(node.id); // a replaced tree already cleared its jumps; ids may be reused
      return;
    }
    settleRef(node, nodes);
  }

  function performJump(node: Node, target: Node, jump: Jump) {
    loadError = null;
    const chain = resolveNodePath(target, jump.path);
    const open = [node.id, target.id, ...(chain ?? []).slice(0, -1).map((n) => n.id)];
    expanded = new Set([...expanded, ...open]);
    if (!chain) {
      selectNode(target, true);
      loadError = sanitizeText(`"${jump.label}" is not available: ${jump.path} was not parsed in this ${node.ref?.typeName ?? 'target'} (see Diagnostics).`, 300);
      return;
    }
    selectNode(chain[chain.length - 1]!, true);
  }

  /** After a link or jump button, keyboard focus goes back to the tree so the arrow keys keep working (the row may unmount). */
  function refocus() {
    scroller?.focus({ preventScroll: true });
  }

  function useLink(node: Node) {
    const l = node.link;
    if (l && onJump) onJump(l.offset, linkByteRange(node) ? l.size : 0);
  }

  function ensureFirstPage(node: Node) {
    const lz = node.lazy;
    if (!lz) return;
    if (lz.elemSize !== null) {
      if (!pages.get(node.id)?.size) void load(node, 0);
    } else if ((node.children?.length ?? 0) === 0 && lz.resumeOffset !== null) {
      void load(node, 0);
    }
  }

  function setExpanded(node: Node, open: boolean) {
    const n = new Set(expanded);
    if (open) n.add(node.id);
    else n.delete(node.id);
    expanded = n;
    if (open) ensureFirstPage(node);
  }

  function onRowClick(row: Row, e: MouseEvent) {
    if (e.detail > 1) return; // the second click of a double-click: the first one already acted
    clickedKey = row.key;
    refocus(); // a focused row would drop focus to <body> when it scrolls out of the window
    activeKey = row.key;
    if (row.kind === 'more') void load(row.array, row.start);
    else if (row.kind === 'ref') void openRef(row.node);
    else selectNode(row.node, false, false);
  }

  function onRowDblClick(row: Row, e: MouseEvent) {
    const key = e.detail >= 2 && clickedKey ? clickedKey : row.key; // a dblclick without a click count (synthetic) acts on its own row
    clickedKey = null;
    const target = rows.find((r) => r.key === key);
    if (target?.kind === 'node' && target.expandable) setExpanded(target.node, !target.expanded);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.altKey || e.ctrlKey || e.metaKey || rows.length === 0) return;
    if ((e.key === 'Enter' || e.key === ' ') && (e.target as Element | null)?.closest?.('button')) return; // Enter / Space on a link or jump button activates that button
    const index = Math.max(0, rows.findIndex((r) => r.key === activeKey));
    const row = rows[index]!;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (row.kind === 'more') void load(row.array, row.start);
      else if (row.kind === 'ref') void openRef(row.node);
      else if (row.expandable) setExpanded(row.node, !row.expanded);
      return;
    }
    if (!NAV_KEYS.has(e.key)) return;
    e.preventDefault();
    const res = navigateRows(rows, index, e.key as NavKey);
    if (!res) return;
    if (res.toggle && row.kind === 'node') setExpanded(row.node, res.toggle.expand);
    const target = rows[res.index];
    if (!target) return;
    activeKey = target.key;
    if (target.kind === 'node') selectNode(target.node);
    else scrollToIndex(res.index, false);
  }

  /**
   * Expand every ancestor of the node at the end of `path` (ids from the root, as returned by the worker) and select it.
   * For fixed-size lazy arrays, `lazyIndex` + `offset` identify the element (and the node inside it) to load and reveal.
   */
  export async function reveal(path: number[], lazyIndex: number | null = null, offset: number | null = null): Promise<void> {
    const r = root;
    if (!r) return;
    const chain = followPath(r, path);
    if (chain.length === 0) return;
    let target = chain[chain.length - 1]!;
    const open = new Set<number>(chain.slice(0, -1).map((n) => n.id));
    if (target.lazy && lazyIndex !== null && target.lazy.elemSize !== null) {
      open.add(target.id);
      expanded = new Set([...expanded, ...open]);
      open.clear();
      const page = Math.floor(lazyIndex / PAGE_SIZE);
      if (!pages.get(target.id)?.has(page)) await load(target, page * PAGE_SIZE);
      if (root !== r) return;
      const elem = pages.get(target.id)?.get(page)?.[lazyIndex - page * PAGE_SIZE];
      if (elem) {
        const hit = offset !== null ? findNodeAt(elem, offset) : null;
        const sub = (hit && pathById(elem, hit.id)) || [elem];
        for (const n of sub.slice(0, -1)) open.add(n.id);
        target = sub[sub.length - 1]!;
      }
    }
    expanded = new Set([...expanded, ...open]);
    selectNode(target, true);
  }

  function onScroll() {
    if (scroller) scrollTop = scroller.scrollTop;
  }
</script>

<div
  class="tree"
  style:--c-name={nameWidth !== null ? `${nameWidth}px` : undefined}
  style:--c-value={valueWidth !== null ? `${valueWidth}px` : undefined}
  style:--min-wide="{minWide}px"
  style:--min-narrow="{minNarrow}px"
>
  <!-- The column titles are decoration for sighted users (the rows say what each value is); the dividers are real, focusable separators. -->
  <div class="head">
    <span class="h-name" bind:clientWidth={nameCell}>
      <span aria-hidden="true">Name</span>
      {#if onColumnWidth}
        <span class="grip">
          <Resizer
            orientation="vertical"
            label="Resize Name column"
            value={nameWidth ?? nameCell}
            min={TREE_COLUMN_MIN.name}
            max={TREE_COLUMN_MAX}
            onResize={(px) => onColumnWidth('name', px)}
            onReset={() => onColumnWidth('name', null)}
            {onResetLayout}
          />
        </span>
      {/if}
    </span>
    <span class="h-value" bind:clientWidth={valueCell}>
      <span aria-hidden="true">Value</span>
      {#if onColumnWidth}
        <span class="grip">
          <Resizer
            orientation="vertical"
            label="Resize Value column"
            value={valueWidth ?? valueCell}
            min={TREE_COLUMN_MIN.value}
            max={TREE_COLUMN_MAX}
            onResize={(px) => onColumnWidth('value', px)}
            onReset={() => onColumnWidth('value', null)}
            {onResetLayout}
          />
        </span>
      {/if}
    </span>
    <span aria-hidden="true">Type</span><span aria-hidden="true">Offset</span><span class="num" aria-hidden="true">Size</span><span></span>
  </div>
  <div
    class="scroller"
    bind:this={scroller}
    bind:clientHeight={viewportHeight}
    onscroll={onScroll}
    onkeydown={onKeyDown}
    tabindex="0"
    role="tree"
    aria-label="Structure"
    aria-activedescendant={activeId}
  >
    {#if !root}
      <p class="empty">No structure</p>
    {:else}
      <div class="spacer" style:height="{rows.length * ROW_HEIGHT}px">
        <div class="window" style:transform="translateY({win.start * ROW_HEIGHT}px)">
          {#each visible as row, vi (row.key)}
            {@const mark = marks[win.start + vi]}
            {#if row.kind === 'node'}
              {@const node = row.node}
              {@const problems = problemMessages(node)}
              {@const shownValue = formatNodeValue(node)}
              {@const fullValue = formatNodeValue(node, MAX_TITLE_CHARS)}
              <div
                class="row"
                class:selected={row.key === selectedKey}
                class:active={row.key === activeKey}
                style:height="{ROW_HEIGHT}px"
                role="treeitem"
                tabindex="-1"
                aria-level={row.depth + 1}
                aria-expanded={row.expandable ? row.expanded : undefined}
                aria-selected={row.key === selectedKey}
                {...(fullValue !== shownValue ? { 'aria-description': fullValue } : {})}
                id={rowId(row.key)}
                data-key={row.key}
                onclick={(e) => onRowClick(row, e)}
                onkeydown={() => {}}
                ondblclick={(e) => onRowDblClick(row, e)}
              >
                <span class="name" style:padding-left="{row.depth * 14}px">
                  {#if mark?.kind === 'inside'}<span class="grp-rule" data-group={mark.group} aria-hidden="true" style:left="{row.depth * 14}px"></span>{/if}
                  <span
                    class="twisty"
                    role="presentation"
                    data-twisty
                    ondblclick={(e) => e.stopPropagation()}
                    onclick={(e) => {
                      e.stopPropagation();
                      clickedKey = null;
                      if (e.detail > 1) return;
                      refocus();
                      if (row.expandable) setExpanded(node, !row.expanded);
                    }}>{row.expandable ? (row.expanded ? '▾' : '▸') : ''}</span
                  >
                  {#if mark?.kind === 'self'}<span class="swatch" data-group={mark.group} aria-hidden="true"></span>{/if}
                  <span class="nm" title={sanitizeText(node.name, 500)}>{sanitizeText(node.name)}</span>
                  {#if node.ref}<span class="refmark" title="Points to {sanitizeText(node.ref.typeName, 64)} at {hex(node.ref.offset)}" aria-hidden="true">↗</span>{/if}
                  {#each node.ref?.jumps ?? [] as jump, ji (ji)}
                    <button
                      type="button"
                      class="jump"
                      data-jump
                      title="Open {sanitizeText(node.ref?.typeName ?? '', 64)} and select {sanitizeText(jump.path, 100)}"
                      aria-label="Jump to {sanitizeText(jump.label, 60)} of {sanitizeText(node.name, 60)}"
                      onclick={(e) => {
                        e.stopPropagation();
                        clickedKey = null;
                        if (e.detail > 1) return; // a double-click runs the jump once
                        void jumpRef(node, jump);
                        refocus();
                      }}
                      ondblclick={(e) => e.stopPropagation()}>{sanitizeText(jump.label, 30)}</button
                    >
                  {/each}
                </span>
                <span class="val" title={fullValue}>
                  <span class="vt">{shownValue}</span>
                  {#if node.link && onJump}
                    <button
                      type="button"
                      class="jump link"
                      data-link
                      title="Select {node.link.size} byte(s) at {hex(node.link.offset)} in the hex view"
                      aria-label="Go to {sanitizeText(node.link.label ?? hex(node.link.offset), 60)} (offset {hex(node.link.offset)}) from {sanitizeText(node.name, 60)}"
                      onclick={(e) => {
                        e.stopPropagation();
                        clickedKey = null;
                        if (e.detail > 1) return; // a double-click runs the link once
                        useLink(node);
                        refocus();
                      }}
                      ondblclick={(e) => e.stopPropagation()}>{linkLabel(node)}</button
                    >
                  {/if}
                </span>
                <span class="type">{sanitizeText(node.typeName, 60)}</span>
                <span class="off">{hex(node.offset)}</span>
                <span class="num">{node.size}</span>
                <span class="badge-cell">
                  {#if problems.length > 0}
                    {@const sev = node.error ? 'error' : (severity.get(node.id) ?? 'warning')}
                    <span class="badge {sev}" title={problems.map((p) => sanitizeText(p, 500)).join('\n')} data-badge={sev}>!</span>
                  {/if}
                </span>
              </div>
            {:else if row.kind === 'ref'}
              <div
                class="row more"
                class:active={row.key === activeKey}
                style:height="{ROW_HEIGHT}px"
                role="treeitem"
                tabindex="-1"
                aria-selected="false"
                aria-level={row.depth + 1}
                id={rowId(row.key)}
                data-key={row.key}
                data-ref
                onclick={(e) => onRowClick(row, e)}
                onkeydown={() => {}}
              >
                <span class="name" style:padding-left="{row.depth * 14 + 24}px">
                  {#if mark?.kind === 'inside'}<span class="grp-rule" data-group={mark.group} aria-hidden="true" style:left="{row.depth * 14}px"></span>{/if}
                  {row.loading || !row.node.ref ? 'Opening…' : `▸ open ${sanitizeText(row.node.ref.typeName, 64)} @ ${hex(row.node.ref.offset)}`}
                </span>
              </div>
            {:else}
              <div
                class="row more"
                class:active={row.key === activeKey}
                style:height="{ROW_HEIGHT}px"
                role="treeitem"
                tabindex="-1"
                aria-selected="false"
                aria-level={row.depth + 1}
                id={rowId(row.key)}
                data-key={row.key}
                onclick={(e) => onRowClick(row, e)}
                onkeydown={() => {}}
              >
                <span class="name" style:padding-left="{row.depth * 14 + 24}px">
                  {#if mark?.kind === 'inside'}<span class="grp-rule" data-group={mark.group} aria-hidden="true" style:left="{row.depth * 14}px"></span>{/if}
                  {row.loading ? 'Loading…' : `Load more…${row.remaining !== null ? ` (${row.remaining} items)` : ''}`}
                </span>
              </div>
            {/if}
          {/each}
        </div>
      </div>
    {/if}
  </div>
  {#if loadError}<div class="err" role="alert">{loadError}</div>{/if}
</div>

<style>
  .tree {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    font-size: var(--fs-sm);
    container: tree / inline-size;
  }
  .head,
  .row {
    display: grid;
    grid-template-columns: var(--c-name, minmax(150px, 1.5fr)) var(--c-value, minmax(90px, 1fr)) 70px 80px 50px 22px;
    align-items: center;
    min-width: var(--min-wide, 470px);
    box-sizing: border-box;
  }
  /* In a narrow side bar the Type column gives way, so the default width needs no horizontal scrolling. */
  @container tree (max-width: 469px) {
    .tree .head,
    .tree .row {
      grid-template-columns: var(--c-name, minmax(100px, 2fr)) var(--c-value, minmax(56px, 1fr)) 52px 30px 20px;
      gap: 4px;
      min-width: var(--min-narrow, 280px);
    }
    .head > :nth-child(3),
    .row > :nth-child(3) {
      display: none;
    }
    .scroller .spacer {
      min-width: var(--min-narrow, 280px);
    }
    .tree .grip {
      right: -3px;
    }
  }
  .head {
    color: var(--ink-quiet);
    background: var(--chrome);
    border-bottom: 1px solid var(--rule);
    padding: 3px 0;
    gap: 6px;
  }
  .head > span:first-child {
    padding-left: 26px;
  }
  .head > span {
    position: relative;
    white-space: nowrap;
  }
  /* A divider sits in the gap to the right of its column title; its 17px hit area is the Resizer's own. */
  .grip {
    position: absolute;
    top: -3px;
    bottom: -3px;
    right: -4px;
    display: flex;
  }
  .scroller {
    flex: 1;
    min-height: 0;
    overflow: auto;
    outline: none;
    user-select: none;
  }
  /* Quiet frame on the container; the keyboard cue is the active row. */
  .scroller:focus-visible {
    outline: 1px solid color-mix(in srgb, var(--signal) 55%, transparent);
    outline-offset: -1px;
  }
  .scroller:focus-visible .row.active {
    outline: 2px solid var(--signal);
    outline-offset: -2px;
  }
  .spacer {
    position: relative;
    min-width: var(--min-wide, 470px);
  }
  .window {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
  }
  .row {
    gap: 6px;
    cursor: default;
    white-space: nowrap;
  }
  .row:hover {
    background: var(--hover);
  }
  .row.active {
    outline: 1px dotted var(--ink-quiet);
    outline-offset: -1px;
  }
  .row.selected {
    background: var(--sel-bg);
    color: var(--sel-fg);
  }
  .row > span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name {
    position: relative;
    display: flex;
    align-items: center;
  }
  /* Colour groups (the same colours as the hex view and the minimap): a swatch on a group node, a rule inside it. */
  .swatch {
    flex: none;
    width: 8px;
    height: 8px;
    margin-right: 6px;
  }
  .grp-rule {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
  }
  .swatch[data-group='0'],
  .grp-rule[data-group='0'] {
    background: var(--struct-1);
  }
  .swatch[data-group='1'],
  .grp-rule[data-group='1'] {
    background: var(--struct-2);
  }
  .swatch[data-group='2'],
  .grp-rule[data-group='2'] {
    background: var(--struct-3);
  }
  .swatch[data-group='3'],
  .grp-rule[data-group='3'] {
    background: var(--struct-4);
  }
  .nm {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* A 24 x 24 target (the whole row height); the glyph keeps its size. */
  .twisty {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    color: var(--ink-quiet);
    cursor: pointer;
  }
  .val,
  .off,
  .num {
    font-family: var(--mono);
  }
  .val {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .vt {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The button is 24px tall (a full row); only a 17px pill is drawn, by ::before, so it looks as before. */
  .jump {
    position: relative;
    isolation: isolate;
    flex: none;
    margin-left: 6px;
    padding: 0 5px;
    height: 24px;
    min-width: 24px;
    line-height: 24px;
    font-size: 11px;
    font-family: inherit;
    color: var(--ink);
    background: transparent;
    border: none;
    border-radius: 0;
    cursor: pointer;
  }
  .jump::before {
    content: '';
    position: absolute;
    inset: 3px 0;
    z-index: -1;
    border: 1px solid var(--ink-quiet);
    border-radius: var(--radius);
  }
  .val .jump {
    margin-left: 0;
  }
  .jump:hover:not(:disabled) {
    background: transparent;
  }
  .jump:hover::before {
    background: var(--hover);
  }
  .jump:focus-visible {
    outline: none;
  }
  .jump:focus-visible::before {
    outline: 2px solid var(--signal);
    outline-offset: 1px;
  }
  .row.selected .jump {
    color: var(--sel-fg);
  }
  .row.selected .jump::before {
    border-color: var(--sel-fg);
  }
  .type {
    color: var(--ink-quiet);
  }
  .off {
    color: var(--ink-quiet);
  }
  .num {
    text-align: right;
    padding-right: 4px;
  }
  .more {
    color: var(--ink-quiet);
    text-decoration: underline;
    cursor: pointer;
  }
  .refmark {
    flex: none;
    margin-left: 4px;
    color: var(--ink-quiet);
  }
  .empty {
    color: var(--ink-quiet);
    margin: 16px 12px;
  }
  .badge {
    display: inline-block;
    width: 16px;
    height: 16px;
    line-height: 16px;
    text-align: center;
    border-radius: 50%;
    font-weight: 700;
    font-size: 11px;
    color: var(--ground);
  }
  .badge.error {
    background: var(--error);
  }
  .badge.warning {
    background: var(--warn);
  }
  .err {
    color: var(--error);
    padding: 4px 8px;
    border-top: 1px solid var(--rule);
  }
</style>
