/**
 * Pure helpers behind StructureTree: flattening the expanded tree into rows, the virtual window, key navigation,
 * value formatting and text sanitising. No DOM, no Svelte.
 */
import type { LazyArray, Node } from './engine';

/** Elements requested per page of a lazy array. */
export const PAGE_SIZE = 200;
/** Longest display string rendered in a cell. */
export const MAX_CELL_CHARS = 200;

/** Loaded pages of fixed-size lazy arrays: array node id -> page index (element index / PAGE_SIZE) -> that page's nodes. */
export type Pages = ReadonlyMap<number, ReadonlyMap<number, readonly Node[]>>;

/** UI state `flattenTree` needs; all keyed by `Node.id`. Not mutated by the helpers here. */
export interface TreeState {
  /** Ids of nodes the user has opened. */
  expanded: ReadonlySet<number>;
  /** Fixed-size lazy arrays only: arrayId -> pageIndex -> element nodes (cached). */
  pages: Pages;
  /** `${arrayId}:${start}` of page requests in flight. */
  loading?: ReadonlySet<string>;
}

/** A visible tree node. `key` is stable per node (see nodeKey) and `parentKey` is the key of the row above it in the hierarchy. */
export interface NodeRow {
  kind: 'node';
  key: string;
  node: Node;
  depth: number;
  parentKey: string | null;
  expandable: boolean;
  expanded: boolean;
}

/** A "load more" affordance for a lazy array: a gap of elements that are not loaded yet. */
export interface MoreRow {
  kind: 'more';
  key: string;
  depth: number;
  parentKey: string;
  array: Node;
  /** First element index to request. */
  start: number;
  /** Elements still not loaded in this gap (null = unknown). */
  remaining: number | null;
  loading: boolean;
}

/** "Open <type> @ offset" affordance under a node that carries an unopened `ref`. */
export interface RefRow {
  kind: 'ref';
  key: string;
  depth: number;
  parentKey: string;
  node: Node;
  loading: boolean;
}

export type Row = NodeRow | MoreRow | RefRow;

/** Row keys; the prefixes keep node, load-request and ref-request keys from colliding. */
export const nodeKey = (id: number) => `n${id}`;
export const loadKey = (arrayId: number, start: number) => `${arrayId}:${start}`;
export const refLoadKey = (nodeId: number) => `ref:${nodeId}`;

const isFixed = (lz: LazyArray) => lz.elemSize !== null;

/** True when the node can be expanded (has children, is a lazy array with elements, or has a reference to open). */
export function isExpandable(node: Node): boolean {
  if (node.children && node.children.length > 0) return true;
  if (node.ref !== undefined && !node.ref.loaded) return true;
  const lz = node.lazy;
  return lz !== undefined && (lz.count === null || lz.count > 0);
}

function appendNode(out: Row[], node: Node, depth: number, parentKey: string | null, st: TreeState): void {
  const key = nodeKey(node.id);
  const expandable = isExpandable(node);
  const expanded = expandable && st.expanded.has(node.id);
  out.push({ kind: 'node', key, node, depth, parentKey, expandable, expanded });
  if (!expanded || depth > 256) return;

  for (const c of node.children ?? []) appendNode(out, c, depth + 1, key, st);
  if (node.ref !== undefined && !node.ref.loaded) {
    out.push({ kind: 'ref', key: `r${node.id}`, depth: depth + 1, parentKey: key, node, loading: st.loading?.has(refLoadKey(node.id)) ?? false });
  }
  const lz = node.lazy;
  if (!lz) return;

  const loadingSet = st.loading;
  if (!isFixed(lz)) {
    // Variable-size: loaded elements are already in `children`; offer to resume after them.
    if (lz.resumeOffset !== null && (lz.count === null || lz.loaded < lz.count)) {
      const start = node.children?.length ?? 0;
      out.push({
        kind: 'more',
        key: `m${node.id}:${start}`,
        depth: depth + 1,
        parentKey: key,
        array: node,
        start,
        remaining: lz.count === null ? null : lz.count - start,
        loading: loadingSet?.has(loadKey(node.id, start)) ?? false,
      });
    }
    return;
  }

  // Fixed-size: show cached pages in order, with one "load" row per gap of missing pages.
  const total = lz.count ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const pages = st.pages.get(node.id);
  const loaded = pages ? [...pages.keys()].filter((p) => p >= 0 && p < totalPages).sort((a, b) => a - b) : [];
  const gap = (fromPage: number, toPage: number): void => {
    // Missing pages are [fromPage, toPage).
    if (toPage <= fromPage) return;
    const start = fromPage * PAGE_SIZE;
    out.push({
      kind: 'more',
      key: `m${node.id}:${start}`,
      depth: depth + 1,
      parentKey: key,
      array: node,
      start,
      remaining: Math.min(total, toPage * PAGE_SIZE) - start,
      loading: loadingSet?.has(loadKey(node.id, start)) ?? false,
    });
  };
  let next = 0;
  for (const p of loaded) {
    gap(next, p);
    for (const c of pages!.get(p)!) appendNode(out, c, depth + 1, key, st);
    next = p + 1;
  }
  gap(next, totalPages);
}

/**
 * Flatten the expanded part of the tree into display rows (pre-order). Only expanded nodes are descended, so the cost
 * is proportional to what is visible, not to the file. Fixed-size lazy arrays show their cached pages (`st.pages`) plus
 * a MoreRow per gap; variable-size ones show their loaded `children` plus one MoreRow to resume. Depth is capped at 256.
 * Returns rows that reference (do not copy) the nodes.
 */
export function flattenTree(root: Node, st: TreeState): Row[] {
  const out: Row[] = [];
  appendNode(out, root, 0, null, st);
  return out;
}

/** Half-open row index range `[start, end)`. */
export interface VirtualWindow {
  /** First rendered row index. */
  start: number;
  /** One past the last rendered row index. */
  end: number;
}

/** Rows to render for a scroll position (pixels): the visible rows plus `overscan` on both sides, clamped. */
export function virtualWindow(rowCount: number, scrollTop: number, viewportHeight: number, rowHeight: number, overscan = 6): VirtualWindow {
  if (rowCount <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const top = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const first = Math.min(rowCount - 1, Math.floor(top / rowHeight));
  const last = Math.ceil((top + Math.max(0, viewportHeight)) / rowHeight);
  return { start: Math.max(0, first - overscan), end: Math.min(rowCount, Math.max(first + 1, last) + overscan) };
}

/** Initial expanded set: the root, plus those direct children that are non-lazy and already have children. */
export function defaultExpanded(root: Node): Set<number> {
  const s = new Set<number>([root.id]);
  for (const c of root.children ?? []) if (!c.lazy && c.children && c.children.length > 0) s.add(c.id);
  return s;
}

/** Keys handled by `navigateRows` (tree-view keyboard model: Right expands then enters, Left collapses then goes to parent). */
export type NavKey = 'ArrowDown' | 'ArrowUp' | 'ArrowRight' | 'ArrowLeft' | 'Home' | 'End';

export interface NavResult {
  /** Row index to make active. */
  index: number;
  /** Node id whose expansion changes, with the new state. */
  toggle?: { id: number; expand: boolean };
}

/** Result of a navigation key on the row at `index` (null when nothing changes). */
export function navigateRows(rows: readonly Row[], index: number, key: NavKey): NavResult | null {
  if (rows.length === 0) return null;
  const i = Math.min(rows.length - 1, Math.max(0, index));
  const row = rows[i]!;
  switch (key) {
    case 'ArrowDown':
      return i + 1 < rows.length ? { index: i + 1 } : null;
    case 'ArrowUp':
      return i > 0 ? { index: i - 1 } : null;
    case 'Home':
      return { index: 0 };
    case 'End':
      return { index: rows.length - 1 };
    case 'ArrowRight':
      if (row.kind === 'node' && row.expandable) {
        if (!row.expanded) return { index: i, toggle: { id: row.node.id, expand: true } };
        return i + 1 < rows.length && rows[i + 1]!.parentKey === row.key ? { index: i + 1 } : null;
      }
      return null;
    case 'ArrowLeft':
      if (row.kind === 'node' && row.expandable && row.expanded) return { index: i, toggle: { id: row.node.id, expand: false } };
      if (row.parentKey !== null) {
        const p = rows.findIndex((r) => r.key === row.parentKey);
        return p >= 0 ? { index: p } : null;
      }
      return null;
  }
}

/** Inclusive byte range `[start, end]` (absolute offsets) of a node, or null for zero-size or nonsensical (negative / non-integer) nodes. Note `end` is the last byte, not one past it. */
export function nodeByteRange(node: Node): { start: number; end: number } | null {
  if (!Number.isSafeInteger(node.offset) || !Number.isSafeInteger(node.size) || node.offset < 0 || node.size <= 0) return null;
  return { start: node.offset, end: node.offset + node.size - 1 };
}

/** Inclusive byte range `[start, end]` a node's `link` selects (absolute offsets), or null for a caret-only (zero-size) or absent link. */
export function linkByteRange(node: Node): { start: number; end: number } | null {
  const l = node.link;
  if (!l || !Number.isSafeInteger(l.offset) || !Number.isSafeInteger(l.size) || l.offset < 0 || l.size <= 0) return null;
  return { start: l.offset, end: l.offset + l.size - 1 };
}

/** Button text of a node's `link`: "→ label" (sanitised, shortened) or "→ 0xOFFSET". Empty when there is no link. */
export function linkLabel(node: Node): string {
  const l = node.link;
  if (!l) return '';
  const label = l.label !== undefined && l.label.trim() !== '' ? sanitizeText(l.label, 40) : `0x${l.offset.toString(16).toUpperCase()}`;
  return `→ ${label}`;
}

/**
 * Node reached from `start` by following `path` (dotted child names, as validated for `ref.jumps`), or null when a step is
 * missing (the field was skipped by `if`, or parsing stopped before it). Only attached children are followed.
 * Returns the chain of nodes after `start` (the last is the target).
 */
export function resolveNodePath(start: Node, path: string): Node[] | null {
  const out: Node[] = [];
  let cur: Node = start;
  for (const seg of path.split('.')) {
    const next: Node | undefined = cur.children?.find((c) => c.name === seg && c.typeName !== 'bits');
    if (!next) return null;
    out.push(next);
    cur = next;
  }
  return out.length > 0 ? out : null;
}

/**
 * Chain of nodes from `root` down to the node with `id`, following attached `children` only; null if absent.
 * Used to expand every ancestor of a node found by the worker.
 */
export function pathById(root: Node, id: number): Node[] | null {
  if (root.id === id) return [root];
  for (const c of root.children ?? []) {
    const p = pathById(c, id);
    if (p) return [root, ...p];
  }
  return null;
}

/**
 * Follow a worker-provided id path (root first, as in `Located.path`) through the client's copy of the tree. Returns the
 * nodes found, stopping early if a node is not attached yet (e.g. the array page is not loaded); empty if `ids[0]` is not `root`.
 */
export function followPath(root: Node, ids: readonly number[]): Node[] {
  const out: Node[] = [];
  let cur: Node | undefined = root;
  if (ids[0] !== root.id) return out;
  out.push(root);
  for (let k = 1; k < ids.length; k++) {
    cur = cur?.children?.find((c) => c.id === ids[k]);
    if (!cur) break;
    out.push(cur);
  }
  return out;
}

const HEX = '0123456789abcdef';

// Characters sanitizeText makes visible: controls, format (bidi, zero-width, BOM), surrogates, line/paragraph separators.
const INVISIBLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]$/u;

/**
 * Make untrusted text safe to show: invisible/format characters (controls, bidi marks and overrides, zero-width
 * characters, BOM, line/paragraph separators, lone surrogates) become a visible \u{XXXX} escape; letters and
 * combining marks are kept. Output is at most `max` UTF-16 units plus an ellipsis, and a surrogate pair is never
 * cut. With `escapeQuoted`, `"` and `\` are backslash-escaped too (for text shown inside quotes), so data that
 * looks like one of our escapes stays distinguishable. (Rendering is always as text; this only keeps the display honest.)
 */
export function sanitizeText(s: string, max = MAX_CELL_CHARS, escapeQuoted = false): string {
  let out = '';
  for (const ch of s) {
    const piece = escapeQuoted && (ch === '"' || ch === '\\') ? '\\' + ch : INVISIBLE.test(ch) ? `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}}` : ch;
    if (out.length + piece.length > max) return out + '\u2026';
    out += piece;
  }
  return out;
}

function bytesPreview(b: Uint8Array): string {
  const n = Math.min(b.length, 16);
  let s = '';
  for (let i = 0; i < n; i++) s += (i ? ' ' : '') + HEX[b[i]! >> 4] + HEX[b[i]! & 15];
  return b.length > n ? `${s} … (${b.length} bytes)` : s;
}

/** Text of the value cell (always passed through sanitizeText, at most MAX_CELL_CHARS): lazy array summary, enum label (+ display), display, or the formatted raw value. */
export function formatNodeValue(node: Node): string {
  if (node.lazy) {
    const lz = node.lazy;
    return lz.count === null ? `[${lz.loaded}+] items` : `[${lz.count}] items`;
  }
  const base =
    node.display !== undefined
      ? node.display
      : node.value === undefined
        ? ''
        : typeof node.value === 'string'
          ? `"${sanitizeText(node.value, MAX_CELL_CHARS - 3, true)}"` // quotes added after truncation so the closing one survives
          : node.value instanceof Uint8Array
            ? bytesPreview(node.value)
            : String(node.value);
  if (node.enumLabel !== undefined) return sanitizeText(base === '' ? node.enumLabel : `${node.enumLabel} (${base})`);
  return sanitizeText(base);
}

/** Messages for the error/warning badge (`error` first, then `expect`/`assert` validation messages); empty when the node has no problems. */
export function problemMessages(node: Node): string[] {
  const out: string[] = [];
  if (node.error) out.push(node.error);
  for (const v of node.validation ?? []) out.push(v);
  return out;
}

/** Latest-wins throttle (uses Date.now/setTimeout, so main-thread/UI use): first call runs now; calls within `ms` collapse into one trailing call with the last args. */
export function throttleLatest<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRun = -Infinity;
  let queued: A | null = null;
  const run = (a: A) => {
    lastRun = Date.now();
    fn(...a);
  };
  const throttled = (...a: A) => {
    const wait = lastRun + ms - Date.now();
    if (wait <= 0 && timer === null) {
      run(a);
      return;
    }
    queued = a;
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        const q = queued;
        queued = null;
        if (q) run(q);
      }, Math.max(0, wait));
    }
  };
  throttled.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    queued = null;
  };
  return throttled;
}

/**
 * Stable path key for every loaded node: ancestor names joined by "/", with "#n" appended to the second and later
 * siblings that share a name. Used to carry expansion/selection across a re-parse of edited bytes. Bounded by
 * `limit` nodes (extra nodes simply get no key).
 */
export function nodePathKeys(root: Node, limit = 200_000): Map<number, string> {
  const out = new Map<number, string>();
  const stack: Array<{ node: Node; key: string }> = [{ node: root, key: '' }];
  while (stack.length > 0 && out.size < limit) {
    const { node, key } = stack.pop()!;
    out.set(node.id, key);
    const seen = new Map<string, number>();
    for (const c of node.children ?? []) {
      const n = seen.get(c.name) ?? 0;
      seen.set(c.name, n + 1);
      stack.push({ node: c, key: `${key}/${c.name}${n > 0 ? '#' + n : ''}` });
    }
  }
  return out;
}

/** Map ids of `oldRoot`'s nodes onto the nodes of `newRoot` that have the same path key (see nodePathKeys; ids are only unique per parse result, so this is how state survives a re-parse). Nodes without a counterpart are absent from the map. */
export function matchNodeIds(oldRoot: Node, newRoot: Node): Map<number, number> {
  const byKey = new Map<string, number>();
  for (const [id, key] of nodePathKeys(newRoot)) byKey.set(key, id);
  const out = new Map<number, number>();
  for (const [id, key] of nodePathKeys(oldRoot)) {
    const to = byKey.get(key);
    if (to !== undefined) out.set(id, to);
  }
  return out;
}
