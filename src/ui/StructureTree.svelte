<script lang="ts">
  import { untrack } from 'svelte';
  import type { Diagnostic, LazyArray, Node } from '../core/engine';
  import { findNodeAt } from '../core/engine/interpret';
  import {
    PAGE_SIZE,
    defaultExpanded,
    flattenTree,
    followPath,
    formatNodeValue,
    loadKey,
    matchNodeIds,
    navigateRows,
    nodeByteRange,
    nodeKey,
    pathById,
    problemMessages,
    sanitizeText,
    virtualWindow,
    type NavKey,
    type Pages,
    type Row,
  } from '../core/tree-model';

  const ROW_HEIGHT = 22;
  const NAV_KEYS = new Set<string>(['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End']);

  export interface PageResult {
    nodes: Node[];
    lazy: LazyArray | null;
  }

  let {
    root,
    diagnostics = [],
    loadPage,
    onSelect,
    preserveFor = null,
  }: {
    root: Node | null;
    diagnostics?: Diagnostic[];
    /** Fetch `count` elements of lazy array `nodeId` starting at `start` (from the worker). */
    loadPage: (nodeId: number, start: number, count: number) => Promise<PageResult>;
    /** `range` is the inclusive byte range of the node, or null for zero-size nodes. */
    onSelect: (node: Node, range: { start: number; end: number } | null) => void;
    /** When `root` is this exact tree (a re-parse of edited bytes), keep expansion and selection where node paths still match. */
    preserveFor?: Node | null;
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

  // New tree -> fresh view state (runs before the DOM updates).
  let prevRoot: Node | null = null;
  $effect.pre(() => {
    const r = root;
    const keep = r !== null && preserveFor === r;
    const old = prevRoot;
    prevRoot = r;
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
    scrollTop = 0;
    untrack(() => {
      if (scroller) scroller.scrollTop = 0;
    });
  });

  const rows = $derived.by<Row[]>(() => {
    void version;
    return root ? flattenTree(root, { expanded, pages, loading }) : [];
  });
  const win = $derived(virtualWindow(rows.length, scrollTop, viewportHeight, ROW_HEIGHT));
  const visible = $derived(rows.slice(win.start, win.end));
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

  function selectNode(node: Node, center = false) {
    const key = nodeKey(node.id);
    selectedKey = key;
    activeKey = key;
    const i = rows.findIndex((r) => r.key === key);
    if (i >= 0) scrollToIndex(i, center);
    onSelect(node, nodeByteRange(node));
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

  function onRowClick(row: Row) {
    activeKey = row.key;
    if (row.kind === 'more') void load(row.array, row.start);
    else selectNode(row.node);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.altKey || e.ctrlKey || e.metaKey || rows.length === 0) return;
    const index = Math.max(0, rows.findIndex((r) => r.key === activeKey));
    const row = rows[index]!;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (row.kind === 'more') void load(row.array, row.start);
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

<div class="tree">
  <div class="head" aria-hidden="true">
    <span>Name</span><span>Value</span><span>Type</span><span>Offset</span><span class="num">Size</span><span></span>
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
  >
    {#if !root}
      <p class="empty">No structure</p>
    {:else}
      <div class="spacer" style:height="{rows.length * ROW_HEIGHT}px">
        <div class="window" style:transform="translateY({win.start * ROW_HEIGHT}px)">
          {#each visible as row (row.key)}
            {#if row.kind === 'node'}
              {@const node = row.node}
              {@const problems = problemMessages(node)}
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
                data-key={row.key}
                onclick={() => onRowClick(row)}
                onkeydown={() => {}}
                ondblclick={() => row.expandable && setExpanded(node, !row.expanded)}
              >
                <span class="name" style:padding-left="{row.depth * 14 + 4}px">
                  <span
                    class="twisty"
                    role="presentation"
                    data-twisty
                    onclick={(e) => {
                      e.stopPropagation();
                      if (row.expandable) setExpanded(node, !row.expanded);
                    }}>{row.expandable ? (row.expanded ? '▾' : '▸') : ''}</span
                  >
                  <span class="nm" title={sanitizeText(node.name, 500)}>{sanitizeText(node.name)}</span>
                </span>
                <span class="val" title={formatNodeValue(node)}>{formatNodeValue(node)}</span>
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
            {:else}
              <div
                class="row more"
                class:active={row.key === activeKey}
                style:height="{ROW_HEIGHT}px"
                role="treeitem"
                tabindex="-1"
                aria-selected="false"
                aria-level={row.depth + 1}
                data-key={row.key}
                onclick={() => onRowClick(row)}
                onkeydown={() => {}}
              >
                <span class="name" style:padding-left="{row.depth * 14 + 4}px">
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
    font-size: 12px;
  }
  .head,
  .row {
    display: grid;
    grid-template-columns: minmax(150px, 1.5fr) minmax(90px, 1fr) 70px 80px 50px 22px;
    align-items: center;
    min-width: 470px;
    box-sizing: border-box;
  }
  .head {
    color: var(--muted);
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    padding: 3px 0;
    gap: 6px;
  }
  .head > span:first-child {
    padding-left: 22px;
  }
  .scroller {
    flex: 1;
    min-height: 0;
    overflow: auto;
    outline: none;
    user-select: none;
  }
  .scroller:focus-visible {
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .spacer {
    position: relative;
    min-width: 470px;
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
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .row.active {
    outline: 1px dotted var(--muted);
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
    display: flex;
    align-items: center;
  }
  .nm {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .twisty {
    flex: none;
    width: 14px;
    text-align: center;
    color: var(--muted);
    cursor: pointer;
  }
  .val,
  .off,
  .num {
    font-family: var(--mono);
  }
  .type {
    color: var(--muted);
  }
  .off {
    color: var(--muted);
  }
  .num {
    text-align: right;
    padding-right: 4px;
  }
  .more {
    color: var(--accent);
    cursor: pointer;
  }
  .empty {
    color: var(--muted);
    text-align: center;
    margin: 16px;
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
    color: #fff;
  }
  .badge.error {
    background: var(--error);
  }
  .badge.warning {
    background: #d97706;
  }
  .err {
    color: var(--error);
    padding: 4px 8px;
    border-top: 1px solid var(--border);
  }
</style>
