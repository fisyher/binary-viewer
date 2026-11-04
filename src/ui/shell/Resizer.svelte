<script lang="ts">
  import { tick } from 'svelte';
  import { visualScale } from './zoom';

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
    onResetLayout = undefined,
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
    /** Adds a context menu (right-click, Shift+F10 or the ContextMenu key) with one item, "Reset layout". */
    onResetLayout?: () => void;
  } = $props();

  let bar: HTMLElement | undefined = $state();
  let item: HTMLButtonElement | undefined = $state();
  let menuEl: HTMLElement | undefined = $state();
  let menu = $state<{ left: number; top: number } | null>(null); // fixed position, in the page's own (unzoomed) px
  let dragging = $state(false);
  let startPos = 0;
  let startValue = 0;

  const clamp = (v: number) => Math.min(Math.max(min, v), Math.max(min, max));
  // Pointer coordinates are on screen; under the UI zoom one screen px is less than one CSS px of the page.
  const pos = (e: PointerEvent) => (orientation === 'vertical' ? e.clientX : e.clientY) / visualScale();

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

  // A press anywhere else, a resize of the window, the window losing focus or any scroll closes the menu (it is placed in the
  // viewport and would drift away from its divider); the event itself decides where focus goes.
  $effect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.('[data-resizer-menu]')) closeMenu(false);
    };
    const gone = () => closeMenu(false);
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('resize', gone);
    window.addEventListener('blur', gone);
    window.addEventListener('scroll', gone, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('resize', gone);
      window.removeEventListener('blur', gone);
      window.removeEventListener('scroll', gone, true);
    };
  });

  async function openMenu(clientX: number, clientY: number) {
    if (!onResetLayout || !bar) return;
    const k = visualScale();
    menu = { left: clientX / k, top: clientY / k };
    await tick();
    // Keep it inside the viewport: measure it (screen px) and move it back by the overhang (CSS px).
    if (menu && menuEl) {
      // offsetWidth/offsetHeight, not the bounding rect: the opening animation moves the rect by a few px
      const right = (menu.left + menuEl.offsetWidth) * k;
      const bottom = (menu.top + menuEl.offsetHeight) * k;
      const left = Math.max(0, menu.left - Math.max(0, right - window.innerWidth) / k);
      const top = Math.max(0, menu.top - Math.max(0, bottom - window.innerHeight) / k);
      if (left !== menu.left || top !== menu.top) menu = { left, top };
    }
    item?.focus();
  }

  /** Close the menu; focus goes back to the resizer unless something else took it (a press elsewhere). */
  function closeMenu(refocus = true) {
    if (!menu) return;
    menu = null;
    if (refocus) bar?.focus();
  }

  function onMenuKeyDown(e: KeyboardEvent) {
    e.stopPropagation(); // the arrow keys of the menu are not the resizer's
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
    } else if (e.key === 'Tab') {
      e.preventDefault(); // the menu item is about to disappear: moving on from it is not reliable, so focus just goes back to the divider
      closeMenu();
    }
  }

  async function chooseReset() {
    const el = bar;
    closeMenu();
    onResetLayout?.();
    await tick();
    // The action may have removed this divider (a closed panel's): focus must not fall to <body>.
    if (el && !el.isConnected) document.querySelector<HTMLElement>('[data-region="editor"]')?.focus();
  }

  function onContextMenu(e: MouseEvent) {
    if (!onResetLayout) return;
    e.preventDefault();
    if (!menu) void openMenu(e.clientX, e.clientY);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (onResetLayout && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
      e.preventDefault();
      const r = bar?.getBoundingClientRect();
      if (r) void openMenu(r.left + (orientation === 'vertical' ? 8 : r.width / 2), r.top + (orientation === 'vertical' ? r.height / 2 : 8));
      return;
    }
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
  bind:this={bar}
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
  oncontextmenu={onContextMenu}
></div>
{#if menu}
  <div class="menu" role="menu" bind:this={menuEl} aria-label="{label} menu" data-resizer-menu style:left="{menu.left}px" style:top="{menu.top}px" onkeydown={onMenuKeyDown} tabindex="-1">
    <button type="button" role="menuitem" bind:this={item} onclick={chooseReset}>Reset layout</button>
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 30;
    min-width: 140px;
    padding: 3px;
    background: var(--chrome);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    box-shadow: 0 4px 14px var(--dialog-shadow);
    animation: menu-in var(--motion-in) var(--ease-out);
  }
  .menu button {
    display: block;
    width: 100%;
    min-height: 24px;
    padding: 3px 10px;
    border-color: transparent;
    text-align: left;
    white-space: nowrap;
  }
  @keyframes menu-in {
    from {
      opacity: 0;
      transform: translateY(-2px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
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
