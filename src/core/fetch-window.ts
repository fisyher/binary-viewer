import type { VisibleRange } from './virtual-scroll';

/** Half-open row range. */
export type RowWindow = VisibleRange;

/**
 * Rows to load for a visible range: the range plus one viewport of margin on each
 * side, snapped outward to multiples of `align` and clamped to [0, totalRows].
 * Falls back to the visible range itself if the window would exceed `maxRows`.
 */
export function computeFetchWindow(
  visible: RowWindow,
  totalRows: number,
  align = 32,
  maxRows = 65_536,
): RowWindow {
  if (visible.end <= visible.start || totalRows <= 0) return { start: 0, end: 0 };
  const span = visible.end - visible.start;
  const start = Math.max(0, Math.floor((visible.start - span) / align) * align);
  const end = Math.min(totalRows, Math.ceil((visible.end + span) / align) * align);
  return end - start > maxRows ? { start: visible.start, end: visible.end } : { start, end };
}

/** True when `loaded` already contains every row of `visible` (an empty `visible` is covered). */
export function covers(loaded: RowWindow | null, visible: RowWindow): boolean {
  if (visible.end <= visible.start) return true;
  return loaded !== null && loaded.start <= visible.start && loaded.end >= visible.end;
}
