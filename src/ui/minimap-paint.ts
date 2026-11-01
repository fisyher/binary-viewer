/** Draws the structure minimap into a 2D canvas context. Integer device-pixel rectangles only: no gradients, no curves. */
import type { Band } from '../core/minimap';

export interface Palette {
  ground: string;
  rule: string;
  signal: string;
  /** The four structure band colours, in group order, and their translucent tints (the same ones the hex view uses). */
  struct: readonly [string, string, string, string];
  tint: readonly [string, string, string, string];
}

export interface PaintInput {
  /** Canvas size in device pixels. */
  width: number;
  height: number;
  dpr: number;
  /** Structure bands covering [0, height); null while there is no structure to show (a blank strip). */
  bands: readonly Band[] | null;
  /** Small top-level regions at their minimum height (see smallRegionRows): drawn over the bands. */
  marks: readonly Band[] | null;
  /** Viewport and selection rows [y0, y1). */
  view: { y0: number; y1: number } | null;
  selection: { y0: number; y1: number } | null;
  palette: Palette;
}

/** Colours as the document currently defines them (they change with the theme). */
export function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    ground: v('--ground', '#1a1e26'),
    rule: v('--rule', '#323947'),
    signal: v('--signal', '#e8b04a'),
    struct: [v('--struct-1', '#4fb3a9'), v('--struct-2', '#8c9eff'), v('--struct-3', '#e58fa9'), v('--struct-4', '#c8b98c')],
    tint: [
      v('--struct-1-tint', 'rgba(79, 179, 169, 0.32)'),
      v('--struct-2-tint', 'rgba(140, 158, 255, 0.32)'),
      v('--struct-3-tint', 'rgba(229, 143, 169, 0.32)'),
      v('--struct-4-tint', 'rgba(200, 185, 140, 0.32)'),
    ],
  };
}

/** A band is a quiet tint with a crisp 1 CSS px edge in the full colour at its top and bottom: big regions stay calm, borders stay exact. */
export const EDGE_ALPHA = 0.55;
export const GAP_ALPHA = 0.6;
export const VIEW_FILL_ALPHA = 0.16;

export function paintMinimap(ctx: CanvasRenderingContext2D, p: PaintInput): void {
  const { width: w, height: h, palette: pal } = p;
  const px = Math.max(1, Math.round(p.dpr)); // one CSS pixel's worth of device pixels, for hairlines
  const rect = (color: string, alpha: number, x: number, y: number, rw: number, rh: number) => {
    if (rw <= 0 || rh <= 0) return;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, rw, rh);
  };
  ctx.clearRect(0, 0, w, h);
  rect(pal.ground, 1, 0, 0, w, h);
  if (p.bands) {
    const period = px * 4;
    for (const b of p.bands) {
      if (b.v > 0) {
        const g = (b.v - 1) % 4;
        rect(pal.tint[g]!, 1, 0, b.y0, w, b.y1 - b.y0);
        rect(pal.struct[g]!, EDGE_ALPHA, 0, b.y0, w, Math.min(px, b.y1 - b.y0));
        rect(pal.struct[g]!, EDGE_ALPHA, 0, Math.max(b.y0, b.y1 - px), w, px);
        continue;
      }
      // Gaps: a hairline every few pixels, aligned to the strip so neighbouring gaps share one rhythm.
      for (let y = b.y0 - (b.y0 % period); y < b.y1; y += period) {
        const top = Math.max(y, b.y0);
        rect(pal.rule, GAP_ALPHA, 0, top, w, Math.min(px, b.y1 - top));
      }
    }
  }
  for (const m of p.marks ?? []) {
    const g = (m.v - 1) % 4;
    rect(pal.ground, 1, 0, m.y0, w, m.y1 - m.y0); // an opaque base, so a neighbouring band's tint does not mix in
    rect(pal.tint[g]!, 1, 0, m.y0, w, m.y1 - m.y0);
    rect(pal.struct[g]!, 1, 0, m.y0, w, Math.min(px, m.y1 - m.y0));
    rect(pal.struct[g]!, 1, 0, Math.max(m.y0, m.y1 - px), w, px);
  }
  if (p.view) {
    const { y0, y1 } = p.view;
    rect(pal.signal, VIEW_FILL_ALPHA, 0, y0, w, y1 - y0);
    rect(pal.signal, 1, 0, y0, w, px); // top
    rect(pal.signal, 1, 0, Math.max(y0, y1 - px), w, px); // bottom
    rect(pal.signal, 1, 0, y0, px, y1 - y0); // left
    rect(pal.signal, 1, w - px, y0, px, y1 - y0); // right
  }
  if (p.selection) rect(pal.signal, 1, 0, p.selection.y0, w, p.selection.y1 - p.selection.y0);
  ctx.globalAlpha = 1;
}
