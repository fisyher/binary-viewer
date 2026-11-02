/**
 * The colour grouping of a parse tree, in one place: the worker's `ranges` (hex view tints), `overview` (minimap) and
 * the structure tree's swatches all colour by the same top-level group nodes. Pure; no DOM, no Svelte.
 */
import type { Node } from './engine';

/** Number of colour groups (`--struct-1` .. `--struct-4`). */
export const GROUP_COUNT = 4;

/** The colour group (0..3) of the top-level group node at `index`. */
export const groupOfIndex = (index: number): number => ((index % GROUP_COUNT) + GROUP_COUNT) % GROUP_COUNT;

/**
 * The nodes that define the colour groups: the root's children, except that a root with exactly one child that has
 * children of its own (a `file` wrapper) is grouped by that child's children instead (one level only).
 */
export function topGroupNodes(root: Node): readonly Node[] {
  const top = root.children ?? [];
  const only = top.length === 1 ? top[0]! : null;
  return only && only.children && only.children.length > 0 ? only.children : top;
}

/** Node id -> colour group (0..3) for each top-level group node. */
export function groupIdMap(root: Node): Map<number, number> {
  const m = new Map<number, number>();
  topGroupNodes(root).forEach((n, i) => m.set(n.id, groupOfIndex(i)));
  return m;
}

/** What a tree row shows: a swatch (the row is a group node), a rule (it is inside one), or nothing. */
export type RowGroup = { kind: 'self' | 'inside'; group: number } | null;

/**
 * Group marks for a flattened tree (pre-order rows with their depths): a row whose id is in `groups` is a group node;
 * the rows after it that are deeper are inside it, until the next row at its depth or above. `id` is null for rows that
 * are not nodes ("load more", "open reference"); those count as inside when they are deeper.
 */
export function rowGroups(rows: ReadonlyArray<{ depth: number; id: number | null }>, groups: ReadonlyMap<number, number>): RowGroup[] {
  const out: RowGroup[] = new Array(rows.length);
  let cur = -1;
  let curDepth = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const g = r.id === null ? undefined : groups.get(r.id);
    if (g !== undefined) {
      cur = g;
      curDepth = r.depth;
      out[i] = { kind: 'self', group: g };
    } else if (cur >= 0 && r.depth > curDepth) {
      out[i] = { kind: 'inside', group: cur };
    } else {
      cur = -1;
      out[i] = null;
    }
  }
  return out;
}
