/** Max scroll spacer height in px; browsers cap element heights well above this. */
export const MAX_SPACER_HEIGHT = 10_000_000;

export interface ScrollGeometry {
  totalRows: number;
  rowHeight: number;
  viewportHeight: number;
  maxSpacerHeight?: number;
}

export interface VisibleRange {
  /** First row to render (inclusive). */
  start: number;
  /** One past the last row to render. */
  end: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function cap(g: ScrollGeometry): number {
  return g.maxSpacerHeight ?? MAX_SPACER_HEIGHT;
}

/** True when the file is too tall for 1:1 scrolling and scroll is mapped proportionally. */
export function isCompressed(g: ScrollGeometry): boolean {
  return g.totalRows * g.rowHeight > cap(g);
}

/** Height of the scroll spacer, capped at the maximum. */
export function spacerHeight(g: ScrollGeometry): number {
  return Math.min(g.totalRows * g.rowHeight, cap(g));
}

function maxScrollTop(g: ScrollGeometry): number {
  return Math.max(0, spacerHeight(g) - g.viewportHeight);
}

/** Largest row index that can be the first row in the viewport. */
export function maxTopRow(g: ScrollGeometry): number {
  return Math.max(0, g.totalRows - Math.floor(g.viewportHeight / g.rowHeight));
}

/** Index of the first row at the top of the viewport. */
export function scrollTopToRow(scrollTop: number, g: ScrollGeometry): number {
  if (g.totalRows <= 0 || g.rowHeight <= 0) return 0;
  if (!isCompressed(g)) {
    return clamp(Math.floor(scrollTop / g.rowHeight), 0, g.totalRows - 1);
  }
  const max = maxScrollTop(g);
  if (max <= 0) return 0;
  const t = clamp(scrollTop, 0, max);
  if (t >= max) return maxTopRow(g); // exact at the bottom
  return clamp(Math.floor((t / max) * maxTopRow(g)), 0, g.totalRows - 1);
}

/** Sub-row pixel shift for smooth scrolling (always 0 in compressed mode). */
export function rowPixelOffset(scrollTop: number, g: ScrollGeometry): number {
  if (isCompressed(g) || g.rowHeight <= 0) return 0;
  const top = scrollTopToRow(scrollTop, g);
  return Math.max(0, scrollTop - top * g.rowHeight);
}

/**
 * Inverse of scrollTopToRow: the scrollTop (scrollbar thumb position) for `row`.
 * In compressed mode several rows can share one pixel, so this is only approximate;
 * callers must track the exact top row themselves rather than re-derive it from scrollTop.
 */
export function rowToScrollTop(row: number, g: ScrollGeometry): number {
  if (g.totalRows <= 0 || g.rowHeight <= 0) return 0;
  const r = clamp(Math.floor(row), 0, g.totalRows - 1);
  const max = maxScrollTop(g);
  if (!isCompressed(g)) return Math.min(r * g.rowHeight, max);
  const top = maxTopRow(g);
  if (top === 0) return 0;
  if (r >= top) return max;
  // Nudge up to the first scrollTop that maps back to r despite flooring.
  let s = Math.ceil((r / top) * max);
  while (s > 0 && scrollTopToRow(s - 1, g) >= r) s--;
  while (s < max && scrollTopToRow(s, g) < r) s++;
  return s;
}

/** Rows to render when `topRow` is the first row in the viewport, including overscan. */
export function visibleRangeFromTop(topRow: number, g: ScrollGeometry, overscan = 4): VisibleRange {
  if (g.totalRows <= 0 || g.viewportHeight <= 0 || g.rowHeight <= 0) return { start: 0, end: 0 };
  const top = clamp(Math.floor(topRow), 0, g.totalRows - 1);
  const visible = Math.ceil(g.viewportHeight / g.rowHeight) + 1;
  return {
    start: Math.max(0, top - overscan),
    end: Math.min(g.totalRows, top + visible + overscan),
  };
}

/** Rows to render for the given scroll position, including overscan. */
export function visibleRange(scrollTop: number, g: ScrollGeometry, overscan = 4): VisibleRange {
  return visibleRangeFromTop(scrollTopToRow(scrollTop, g), g, overscan);
}
