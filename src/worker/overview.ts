/**
 * Whole-file structure summary for the minimap: which parsed group dominates each of N equal slices of the file.
 * Structure-only (it never reads file bytes) and O(nodes + buckets) in time and memory, whatever the file size.
 */
import type { Node } from '../core/engine';

export const MIN_OVERVIEW_BUCKETS = 16;
export const MAX_OVERVIEW_BUCKETS = 4096;
/** Colour groups, as in the hex view's tints (the root child's index modulo this). */
const GROUPS = 4;

export const clampBuckets = (n: number): number => Math.min(MAX_OVERVIEW_BUCKETS, Math.max(MIN_OVERVIEW_BUCKETS, n));

/** `starts[b] = floor(b*size/n)` for b in 0..n (exact even where b*size would exceed 2^53). */
export function bucketStarts(size: number, n: number): Float64Array {
  const starts = new Float64Array(n + 1);
  const safe = size * n <= Number.MAX_SAFE_INTEGER;
  const big = BigInt(size);
  for (let b = 0; b <= n; b++) starts[b] = safe ? Math.floor((b * size) / n) : Number((BigInt(b) * big) / BigInt(n));
  return starts;
}

/**
 * Bucket b holds 0 (no parsed node touches [starts[b], starts[b+1])) or the dominant group + 1. Leaves are taken as the
 * hex view's `ranges` takes them: nodes without children (an unexpanded lazy array is one leaf), `bits` nodes skipped,
 * the group being the index of the root child modulo 4. Dominance is by covered bytes in the bucket (overlapping leaves
 * count twice); a tie goes to the lower group, and any covered byte makes the bucket non-empty.
 */
export function computeOverview(root: Node, size: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  if (!(size > 0)) return out;
  const starts = bucketStarts(size, n);
  const partial = new Float64Array(n * GROUPS); // bytes of leaves that start or end inside the bucket
  const diff = new Int32Array((n + 1) * GROUPS); // leaves that cover whole buckets, as a running count
  const bucketOf = (o: number): number => {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= o) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const add = (a0: number, b0: number, v: number): void => {
    // Whole bytes only (a hostile spec could produce fractional offsets): the bytes [ceil(a), floor(b)).
    const a = Math.ceil(Math.max(0, a0));
    const b = Math.floor(Math.min(size, b0));
    if (!(b > a)) return;
    const bf = bucketOf(a);
    const bl = bucketOf(b - 1);
    if (bl < bf) return;
    if (bf === bl) {
      partial[bf * GROUPS + v]! += b - a;
      return;
    }
    partial[bf * GROUPS + v]! += starts[bf + 1]! - a;
    partial[bl * GROUPS + v]! += b - starts[bl]!;
    diff[(bf + 1) * GROUPS + v]!++;
    diff[bl * GROUPS + v]!--;
  };
  (root.children ?? []).forEach((top, g) => {
    const v = g % GROUPS;
    const stack: Node[] = [top];
    while (stack.length > 0) {
      const nd = stack.pop()!;
      if (nd.typeName === 'bits') continue;
      if (nd.children && nd.children.length > 0) for (const c of nd.children) stack.push(c);
      else if (nd.size > 0 && Number.isFinite(nd.offset) && Number.isFinite(nd.size)) add(nd.offset, nd.offset + nd.size, v);
    }
  });
  const covering = new Int32Array(GROUPS);
  for (let b = 0; b < n; b++) {
    const width = starts[b + 1]! - starts[b]!;
    let best = -1;
    let bestBytes = 0;
    for (let v = 0; v < GROUPS; v++) {
      covering[v]! += diff[b * GROUPS + v]!;
      const bytes = partial[b * GROUPS + v]! + covering[v]! * width;
      if (bytes > bestBytes) {
        bestBytes = bytes;
        best = v;
      }
    }
    out[b] = best + 1;
  }
  return out;
}

/** A top-level region of the tree: the byte range [start, end) of one node and its colour group (0..3). */
export interface OverviewRegion {
  start: number;
  end: number;
  group: number;
}

export const MAX_OVERVIEW_REGIONS = 1024;

/**
 * The root's children as regions, in file order, so that small ones (a 14-byte header in a 64 MiB file) can be drawn
 * even where no bucket is dominated by them. Zero-size, `bits` and out-of-file nodes are skipped. A root with a single
 * child shows that child's children instead (one level only). The group is the index among the nodes listed (modulo 4),
 * which for a normal root is the group `ranges` uses. At most MAX_OVERVIEW_REGIONS are kept (`truncated` says if more existed).
 */
export function computeRegions(root: Node, size: number): { regions: OverviewRegion[]; truncated: boolean } {
  let top = root.children ?? [];
  if (top.length === 1 && top[0]!.children && top[0]!.children.length > 0) top = top[0]!.children;
  const regions: OverviewRegion[] = [];
  let truncated = false;
  top.forEach((nd, i) => {
    if (nd.typeName === 'bits' || !Number.isFinite(nd.offset) || !Number.isFinite(nd.size)) return;
    const start = Math.ceil(Math.max(0, nd.offset));
    const end = Math.floor(Math.min(size, nd.offset + nd.size));
    if (!(end > start)) return;
    if (regions.length >= MAX_OVERVIEW_REGIONS) {
      truncated = true;
      return;
    }
    regions.push({ start, end, group: i % GROUPS });
  });
  regions.sort((x, y) => x.start - y.start);
  return { regions, truncated };
}
