/**
 * Pure helpers behind the breadcrumb bar: the segments of a node's path through the tree, their labels and titles, and
 * how many leading segments to collapse when the path does not fit. No DOM, no Svelte.
 */
import type { Node } from '../../core/engine';
import { lazyElementIndexAt } from '../../core/engine/interpret';
import { followPath, sanitizeText } from '../../core/tree-model';

/** Where selecting a segment goes: the arguments of `StructureTree.reveal`. */
export interface CrumbReveal {
  /** Worker ids from the root; for something inside a fixed-size lazy array's element, up to the array. */
  path: number[];
  lazyIndex: number | null;
  offset: number | null;
}

/** A snapshot of one node on the path (lazy loads mutate the tree in place, so nothing here points into it). */
export interface Crumb {
  id: number;
  name: string;
  typeName: string;
  offset: number;
  size: number;
  /** Shown text: the node's name, `arrayName[index]` for a located element of a fixed-size lazy array. */
  label: string;
  reveal: CrumbReveal;
}

const MAX_LABEL = 60;

const isFixedLazy = (n: Node) => n.lazy !== undefined && n.lazy.elemSize !== null;

function snapshot(n: Node, label: string, reveal: CrumbReveal): Crumb {
  return { id: n.id, name: n.name, typeName: n.typeName, offset: n.offset, size: n.size, label: sanitizeText(label, MAX_LABEL), reveal };
}

/**
 * The segments for a located node: `path` is the worker's id path from the root (`nodeAt`), resolved through the main
 * thread's tree (it stops where a node is not attached yet). A fixed-size lazy array with a `lazyIndex` is shown as the
 * element `name[index]` and is revealed with that index.
 */
export function crumbsFromLocation(root: Node, path: readonly number[], lazyIndex: number | null, offset: number | null): Crumb[] {
  const chain = followPath(root, path);
  const ids = path.slice(0, chain.length);
  return chain.map((n, i) => {
    const last = i === chain.length - 1;
    const element = last && lazyIndex !== null && isFixedLazy(n);
    const reveal: CrumbReveal = { path: ids.slice(0, i + 1), lazyIndex: element ? lazyIndex : null, offset: element ? offset : null };
    return snapshot(n, element ? `${n.name}[${lazyIndex}]` : n.name, reveal);
  });
}

/**
 * The segments for a chain of nodes the structure tree selected (root first), in the same form as `crumbsFromLocation`.
 * The elements of a fixed-size lazy array are not attached to it, so the worker does not know their ids: the element is
 * shown as the array's segment `name[index]`, and it and everything inside it is revealed through the array, by element
 * index and offset, like a hex click.
 */
export function crumbsFromChain(chain: readonly Node[]): Crumb[] {
  const out: Crumb[] = [];
  const ids: number[] = [];
  let element: number | null = null; // the array's element index once the chain is inside one (-1: not computable)
  chain.forEach((n, i) => {
    const parent = i > 0 ? chain[i - 1]! : null;
    if (element === null && parent && isFixedLazy(parent)) {
      element = lazyElementIndexAt(parent, n.offset) ?? -1;
      const array = out[out.length - 1]!;
      if (element >= 0) array.label = sanitizeText(`${parent.name}[${element}]`, MAX_LABEL);
      array.reveal = { path: ids.slice(), lazyIndex: element >= 0 ? element : null, offset: n.offset };
      return; // the element is the array's segment
    }
    if (element === null) {
      ids.push(n.id);
      out.push(snapshot(n, n.name, { path: ids.slice(), lazyIndex: null, offset: null }));
    } else {
      out.push(snapshot(n, n.name, { path: ids.slice(), lazyIndex: element >= 0 ? element : null, offset: n.offset }));
    }
  });
  return out;
}

/**
 * Whether a fresh lookup `next` (the node at the caret) should leave the `current` path alone: it is a shorter path
 * along the same nodes (a lazy array element is only known down to its array) and the caret is still inside the deepest
 * segment of `current`, so `current` is the more precise answer for that caret.
 */
export function keepDeeperCrumbs(current: readonly Crumb[], next: readonly Crumb[], caret: number): boolean {
  if (next.length === 0 || next.length >= current.length) return false;
  if (!next.every((c, i) => c.id === current[i]!.id)) return false;
  const deepest = current[current.length - 1]!;
  return deepest.size > 0 && caret >= deepest.offset && caret < deepest.offset + deepest.size;
}

const hex = (n: number) => '0x' + (Number.isFinite(n) && n >= 0 ? Math.trunc(n).toString(16).toUpperCase() : '?');

/** "name : typeName @ 0xOFFSET (size N)" */
export function crumbTitle(c: Crumb): string {
  return `${sanitizeText(c.name, 100)} : ${sanitizeText(c.typeName, 60)} @ ${hex(c.offset)} (size ${c.size})`;
}

/** Characters one segment takes: its padding and the separator after it, on top of its label. */
const CELL = 3;
/** Characters the "…" segment takes. */
const ELLIPSIS = 3;

/**
 * How many leading segments to collapse into "…" so that the rest fits in `maxChars` characters. The last segment is
 * always kept, however long. 0 when everything fits or the width is not known (`maxChars` not a positive number).
 */
export function collapseLeading(labels: readonly string[], maxChars: number): number {
  if (!(maxChars > 0) || !Number.isFinite(maxChars) || labels.length <= 1) return 0;
  const widths = labels.map((l) => l.length + CELL);
  let total = widths.reduce((a, b) => a + b, 0);
  if (total <= maxChars) return 0;
  let hidden = 0;
  while (hidden < labels.length - 1 && total + ELLIPSIS > maxChars) total -= widths[hidden++]!;
  return hidden;
}
