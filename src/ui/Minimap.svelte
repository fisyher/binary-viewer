<script lang="ts">
  import { untrack } from 'svelte';
  import { formatOffset, offsetWidth } from '../core/hex-format';
  import { bandsFromBuckets, offsetAtY, rangeToRows, smallRegionRows } from '../core/minimap';
  import { paintMinimap, readPalette } from './minimap-paint';

  let {
    size,
    overview = null,
    viewport = null,
    selection = null,
    controls = undefined,
    onSeek,
    onWheelBy,
    onWantBuckets,
  }: {
    /** Length of the open document in bytes. */
    size: number;
    /** The worker's structure summary; ignored when it was computed for another size (edited since). */
    overview?: { size: number; buckets: Uint8Array; regions?: ReadonlyArray<{ start: number; end: number; group: number }> } | null;
    /** Bytes on screen in the hex view, [start, end). */
    viewport?: { start: number; end: number } | null;
    /** Selected bytes, end inclusive. */
    selection?: { start: number; end: number } | null;
    /** DOM id of the hex grid this strip scrolls. */
    controls?: string;
    /** Scroll the hex view to `offset`: centred (pointer) or with its row at the top (keyboard). */
    onSeek: (offset: number, center: boolean) => void;
    /** Wheel over the strip: scroll the hex view by this many pixels. */
    onWheelBy: (px: number) => void;
    /** How many buckets the strip can show (its height in device pixels); fired once, then debounced on resize. */
    onWantBuckets?: (buckets: number) => void;
  } = $props();

  const WANT_DELAY_MS = 150;
  const ROW_BYTES = 16;

  let el: HTMLDivElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let cssW = $state(0);
  let cssH = $state(0);
  let dpr = $state(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
  let themeTick = $state(0);
  let hover = $state<{ y: number; offset: number } | null>(null);
  let dragging = false;

  const wPx = $derived(Math.round(cssW * dpr));
  const hPx = $derived(Math.round(cssH * dpr));
  const shown = $derived(overview !== null && overview.size === size && overview.buckets.length > 0 ? overview : null);
  const bands = $derived(shown ? bandsFromBuckets(shown.buckets, hPx) : null);
  // Regions too small for the bands (a header in a big file) are drawn at a 2 CSS px minimum, over them.
  const marks = $derived(shown ? smallRegionRows(shown.regions ?? [], size, hPx, Math.max(1, Math.round(dpr))) : null);
  const view = $derived(viewport && size > 0 ? rangeToRows(viewport.start, viewport.end, size, hPx, Math.round(4 * dpr)) : null);
  const selRows = $derived(selection && size > 0 ? rangeToRows(selection.start, selection.end + 1, size, hPx, Math.round(2 * dpr)) : null);
  const structured = $derived((bands ?? []).filter((b) => b.v > 0));

  const span = $derived(viewport ? Math.max(ROW_BYTES, viewport.end - viewport.start) : ROW_BYTES);
  const maxTop = $derived(Math.max(0, size - span));
  const top = $derived(Math.min(maxTop, Math.max(0, viewport?.start ?? 0)));
  const width = $derived(offsetWidth(size));

  // Repaint on any change of what is drawn, of the canvas size, or of the theme colours.
  $effect(() => {
    void themeTick;
    if (!canvas || wPx <= 0 || hPx <= 0) return;
    if (canvas.width !== wPx) canvas.width = wPx;
    if (canvas.height !== hPx) canvas.height = hPx;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    paintMinimap(ctx, { width: wPx, height: hPx, dpr, bands, marks, view, selection: selRows, palette: readPalette(canvas) });
  });

  // Theme: data-theme on <html> or the system colour scheme.
  $effect(() => {
    const bump = () => themeTick++;
    const mo = typeof MutationObserver === 'function' ? new MutationObserver(bump) : null;
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    mq?.addEventListener?.('change', bump);
    return () => {
      mo?.disconnect();
      mq?.removeEventListener?.('change', bump);
    };
  });

  // The pixel ratio changes without a window resize when the window moves to another monitor: watch the current one.
  $effect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(`(resolution: ${dpr}dppx)`);
    const on = () => (dpr = window.devicePixelRatio || 1);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  });

  // Tell the owner how many buckets fit: at once the first time, debounced after resizes.
  let asked = 0;
  $effect(() => {
    const n = hPx;
    if (n <= 0 || !onWantBuckets) return;
    if (asked === 0) {
      asked = n;
      untrack(() => onWantBuckets?.(n));
      return;
    }
    if (n === asked) return;
    const timer = setTimeout(() => {
      asked = n;
      onWantBuckets?.(n);
    }, WANT_DELAY_MS);
    return () => clearTimeout(timer);
  });

  function pointerOffset(e: PointerEvent): { y: number; offset: number } | null {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!(r.height > 0)) return null;
    const y = e.clientY - r.top;
    return { y: Math.min(r.height, Math.max(0, y)), offset: offsetAtY(y, r.height, size) };
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || size <= 0) return;
    // No preventDefault and no focus() call: the browser focuses the strip itself, without a keyboard focus ring.
    dragging = true;
    el?.setPointerCapture?.(e.pointerId);
    const p = pointerOffset(e);
    if (p) onSeek(p.offset, true);
  }

  function onPointerMove(e: PointerEvent) {
    const p = size > 0 ? pointerOffset(e) : null;
    hover = p;
    if (dragging && p) onSeek(p.offset, true);
  }

  function endDrag(e: PointerEvent) {
    dragging = false;
    if (el?.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }

  function onWheel(e: WheelEvent) {
    if (e.ctrlKey) return; // pinch / Ctrl+wheel is the browser's zoom
    e.preventDefault();
    // deltaMode: 0 pixels, 1 lines (20px rows), 2 pages.
    const unit = e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? Math.max(1, cssH) : 1;
    onWheelBy(e.deltaY * unit);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey || size <= 0) return;
    const start = viewport?.start ?? 0;
    let target: number;
    switch (e.key) {
      case 'PageUp':
        target = start - span;
        break;
      case 'PageDown':
        target = start + span;
        break;
      case 'ArrowUp':
        target = start - ROW_BYTES;
        break;
      case 'ArrowDown':
        target = start + ROW_BYTES;
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = size - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    onSeek(Math.min(size - 1, Math.max(0, target)), false);
  }
</script>

<svelte:window onresize={() => (dpr = window.devicePixelRatio || 1)} />

<div
  class="minimap"
  bind:this={el}
  bind:clientWidth={cssW}
  bind:clientHeight={cssH}
  role="scrollbar"
  tabindex="0"
  aria-label="File overview"
  aria-orientation="vertical"
  aria-controls={controls}
  aria-valuemin={0}
  aria-valuemax={maxTop}
  aria-valuenow={top}
  aria-valuetext="Offset 0x{formatOffset(top, width)}"
  data-slot="minimap"
  data-structured-bands={structured.length}
  data-structured-rows={structured.reduce((n, b) => n + b.y1 - b.y0, 0)}
  data-region-marks={marks?.length ?? 0}
  data-groups={[...new Set(structured.map((b) => b.v))].sort().join(',')}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={endDrag}
  onpointercancel={endDrag}
  onpointerleave={() => (hover = null)}
  onwheel={onWheel}
  onkeydown={onKeyDown}
>
  <canvas bind:this={canvas} aria-hidden="true"></canvas>
  {#if hover}
    <div class="tip" aria-hidden="true" style:top="{hover.y}px">{formatOffset(hover.offset, width)}</div>
  {/if}
</div>

<style>
  /* The strip never animates: the view jumps to where it is clicked, whatever prefers-reduced-motion says. */
  .minimap {
    position: relative;
    flex: none;
    width: 64px;
    box-sizing: content-box;
    border-left: 1px solid var(--rule);
    background: var(--ground);
    z-index: 3; /* above the panel resizer's wider hit area (z-index 2), which would cover the strip's bottom edge */
    cursor: pointer;
    touch-action: none;
    user-select: none;
    outline: none;
  }
  .minimap:focus-visible {
    outline: 1px solid color-mix(in srgb, var(--signal) 55%, transparent);
    outline-offset: -1px;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .tip {
    position: absolute;
    right: calc(100% + 6px);
    transform: translateY(-50%);
    padding: 1px 6px;
    background: var(--chrome-deep);
    border: 1px solid var(--rule);
    color: var(--ink);
    font-family: var(--mono);
    font-size: var(--fs-sm);
    line-height: 1.4;
    pointer-events: none;
    white-space: nowrap;
    z-index: 2;
  }
  @media (max-width: 599px) {
    .minimap {
      display: none;
    }
  }
</style>
