/** Geometry of the structure minimap: pure functions from file offsets and worker buckets to pixel rows and back. */

/** A run of pixel rows [y0, y1) painted alike: v is 0 (no parsed node) or the colour group + 1 (1..4). */
export interface Band {
  y0: number;
  y1: number;
  v: number;
}

/**
 * Turn the worker's buckets into bands of whole pixel rows for a strip `heightPx` rows tall. Bucket i owns rows
 * [round(i*H/N), round((i+1)*H/N)); neighbouring buckets of the same value merge, and the bands tile [0, H) exactly.
 * With more buckets than rows several buckets share a row and the later one wins.
 */
export function bandsFromBuckets(buckets: ArrayLike<number>, heightPx: number): Band[] {
  const h = Math.max(0, Math.floor(heightPx));
  const n = buckets.length;
  const out: Band[] = [];
  if (n === 0 || h === 0) return out;
  let prevEnd = 0;
  for (let i = 0; i < n; i++) {
    const y1 = Math.round(((i + 1) * h) / n);
    const y0 = Math.min(prevEnd, y1);
    prevEnd = Math.max(prevEnd, y1);
    if (y1 <= y0) continue;
    const v = buckets[i]!;
    const last = out[out.length - 1];
    if (last && last.v === v) last.y1 = y1;
    else out.push({ y0, y1, v });
  }
  return out;
}

/**
 * The pixel rows [y0, y1) of the byte range [start, end) of a `size`-byte file on a strip `heightPx` rows tall, at least
 * `minPx` tall (kept inside the strip). An empty file maps to the whole strip.
 */
export function rangeToRows(start: number, end: number, size: number, heightPx: number, minPx = 1): { y0: number; y1: number } {
  const h = Math.max(0, Math.floor(heightPx));
  if (!(size > 0) || h === 0) return { y0: 0, y1: h };
  const clamp = (v: number) => Math.min(size, Math.max(0, v));
  const a = clamp(start);
  const b = clamp(Math.max(start, end));
  let y0 = Math.min(h - 1, Math.floor((a / size) * h));
  let y1 = Math.min(h, Math.max(y0 + 1, Math.ceil((b / size) * h)));
  if (y1 - y0 < minPx) {
    y1 = Math.min(h, y0 + minPx);
    y0 = Math.max(0, y1 - minPx);
  }
  return { y0, y1 };
}

/** The file offset under a pointer `y` px down a strip `heightPx` tall; the ends map to byte 0 and the last byte. */
export function offsetAtY(y: number, heightPx: number, size: number): number {
  if (!(size > 0) || !(heightPx > 0) || Number.isNaN(y)) return 0;
  const f = Math.min(1, Math.max(0, y / heightPx));
  return Math.min(size - 1, Math.floor(f * size));
}

/**
 * Marks for the regions too small to show up in the bucket bands: every region whose true height ((end - start) / size * rows) is under
 * `2 * px` device rows is returned at exactly that minimum height (value = group + 1), inside the strip, in file order and not overlapping
 * one another (they are stacked from their natural position, so a header and the next header read as two lines).
 * `px` is one CSS pixel in device pixels.
 */
export function smallRegionRows(
  regions: ReadonlyArray<{ start: number; end: number; group: number }>,
  size: number,
  heightPx: number,
  px: number,
): Band[] {
  const min = Math.max(1, px) * 2;
  const out: Band[] = [];
  if (!(size > 0)) return out;
  for (const r of regions) {
    if (((Math.min(size, r.end) - Math.max(0, r.start)) / size) * heightPx >= min) continue; // tall enough to read as a band
    const { y0, y1 } = rangeToRows(r.start, r.end, size, heightPx, min);
    if (y1 > y0) out.push({ y0, y1, v: (((r.group % 4) + 4) % 4) + 1 });
  }
  // Neighbouring small regions must not cover one another: push each below the previous one, then pull the tail back
  // inside the strip (the order, and so which region is first, is always the file order).
  for (let i = 1; i < out.length; i++) {
    const m = out[i]!;
    const h = m.y1 - m.y0;
    m.y0 = Math.max(m.y0, out[i - 1]!.y1);
    m.y1 = m.y0 + h;
  }
  const H = Math.floor(heightPx);
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    const limit = i === out.length - 1 ? H : out[i + 1]!.y0;
    if (m.y1 > limit) {
      const h = m.y1 - m.y0;
      m.y1 = limit;
      m.y0 = Math.max(0, limit - h);
    }
  }
  return out;
}

/** The region of [start, end) that contains `offset`, or null (regions are in file order; the first match wins). */
export function regionAt<R extends { start: number; end: number }>(regions: ReadonlyArray<R>, offset: number): R | null {
  for (const r of regions) if (offset >= r.start && offset < r.end) return r;
  return null;
}

/**
 * Device rows where a 1 CSS px boundary line is painted between neighbouring regions, so that regions that share a
 * colour (or sit side by side in a similar one) can be told apart. One line at the top of every region that touches the
 * one before it (it starts where the previous one ends, or earlier). Only between regions that are both at least
 * 4 CSS px tall: a thin region would be erased by its own boundary. `px` is one CSS pixel in device pixels.
 */
export function regionBoundaryRows(
  regions: ReadonlyArray<{ start: number; end: number }>,
  size: number,
  heightPx: number,
  px: number,
): number[] {
  const out: number[] = [];
  if (!(size > 0) || !(heightPx > 0)) return out;
  const min = Math.max(1, px) * 4;
  const tall = (r: { start: number; end: number }) => ((Math.min(size, r.end) - Math.max(0, r.start)) / size) * heightPx >= min;
  for (let i = 1; i < regions.length; i++) {
    const prev = regions[i - 1]!;
    const r = regions[i]!;
    if (r.start > prev.end || !tall(prev) || !tall(r)) continue;
    const y = rangeToRows(r.start, r.end, size, heightPx).y0;
    if (y > 0 && out[out.length - 1] !== y) out.push(y);
  }
  return out;
}
