<script lang="ts">
  let {
    orientation,
    value,
    min,
    max,
    label,
    invert = false,
    step = 16,
    onResize,
    onReset,
  }: {
    /** 'vertical' is a vertical bar that changes a width; 'horizontal' is a horizontal bar that changes a height. */
    orientation: 'vertical' | 'horizontal';
    /** The panel's current size in px. */
    value: number;
    min: number;
    max: number;
    label: string;
    /** The panel grows when the bar moves left/up (right-hand and bottom panels). */
    invert?: boolean;
    step?: number;
    onResize: (px: number) => void;
    onReset: () => void;
  } = $props();

  let dragging = $state(false);
  let startPos = 0;
  let startValue = 0;

  const clamp = (v: number) => Math.min(Math.max(min, v), Math.max(min, max));
  const pos = (e: PointerEvent) => (orientation === 'vertical' ? e.clientX : e.clientY);

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragging = true;
    startPos = pos(e);
    startValue = value;
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const d = pos(e) - startPos;
    onResize(clamp(startValue + (invert ? -d : d)));
  }

  function onPointerUp() {
    dragging = false;
  }

  function onKeyDown(e: KeyboardEvent) {
    const grow = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    const shrink = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    let next: number | null = null;
    if (e.key === grow) next = value + (invert ? -step : step);
    else if (e.key === shrink) next = value + (invert ? step : -step);
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    onResize(clamp(next));
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="resizer {orientation}"
  class:dragging
  role="separator"
  tabindex="0"
  aria-orientation={orientation}
  aria-label={label}
  aria-valuenow={Math.round(value)}
  aria-valuemin={min}
  aria-valuemax={Math.round(max)}
  title="Drag to resize, double-click to reset"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  onkeydown={onKeyDown}
  ondblclick={onReset}
></div>

<style>
  .resizer {
    position: relative;
    flex: none;
    background: var(--rule);
    touch-action: none;
    z-index: 2;
  }
  .resizer.vertical {
    width: 1px;
    cursor: col-resize;
  }
  .resizer.horizontal {
    height: 1px;
    cursor: row-resize;
  }
  /* a wider hit area than the 1px rule: 8px on each side, 17px in all */
  .resizer::after {
    content: '';
    position: absolute;
  }
  .vertical::after {
    inset: 0 -8px;
  }
  .horizontal::after {
    inset: -8px 0;
  }
  .resizer:hover,
  .resizer.dragging {
    background: var(--signal);
  }
  .resizer:focus-visible {
    background: var(--signal);
    outline: none;
  }
  /* hovering, dragging or focusing draws a 2px line in the signal colour */
  .resizer::before {
    content: none;
    position: absolute;
    background: var(--signal);
  }
  .resizer:hover::before,
  .resizer.dragging::before,
  .resizer:focus-visible::before {
    content: '';
  }
  .vertical::before {
    inset: 0 -1px 0 0;
  }
  .horizontal::before {
    inset: 0 0 -1px 0;
  }
</style>
