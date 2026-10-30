<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { ByteSource } from '../core/byte-source';
  import { navigate, selectionRange, type CaretMove, type Selection } from '../core/caret';
  import { computeFetchWindow, covers } from '../core/fetch-window';
  import {
    BYTES_PER_ROW,
    byteToAscii,
    byteToHex,
    formatOffset,
    offsetWidth,
    rowCount,
  } from '../core/hex-format';
  import {
    maxTopRow,
    rowPixelOffset,
    rowToScrollTop,
    scrollTopToRow,
    spacerHeight,
    visibleRangeFromTop,
    type ScrollGeometry,
  } from '../core/virtual-scroll';

  const ROW_HEIGHT = 20;

  let {
    source,
    selection = $bindable(null),
    error = $bindable(null),
  }: { source: ByteSource; selection: Selection | null; error: string | null } = $props();

  let scroller: HTMLDivElement | undefined = $state();
  let viewportHeight = $state(0);

  // The first row in the viewport is the source of truth for rendering. It is derived from
  // scrollTop only on user scrolls; goTo/keyboard set it exactly (matters for huge files where
  // one scrollbar pixel spans many rows).
  let topRow = $state(0);
  let pixelShift = $state(0);
  let ignoreScroll: number | null = null; // scrollTop produced by our own programmatic scroll

  // Loaded byte window; rows outside it render as blanks (never stale data).
  let chunk = $state<{ startRow: number; bytes: Uint8Array } | null>(null);
  let reqId = 0;
  let retryTick = $state(0); // bump to re-run the fetch effect after a failure
  let autoRetried = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: { src: ByteSource; start: number; end: number } | null = null;

  const totalRows = $derived(rowCount(source.size));
  const width = $derived(offsetWidth(source.size));
  const geometry: ScrollGeometry = $derived({ totalRows, rowHeight: ROW_HEIGHT, viewportHeight });
  const range = $derived(visibleRangeFromTop(topRow, geometry));
  const shiftY = $derived(-((topRow - range.start) * ROW_HEIGHT + pixelShift));
  const rows = $derived(Array.from({ length: range.end - range.start }, (_, i) => range.start + i));
  const sel = $derived(selection ? selectionRange(selection) : null);
  const fullRows = $derived(Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT)));

  // Reset when a new source is opened.
  $effect(() => {
    void source;
    reqId++;
    clearTimeout(retryTimer);
    autoRetried = false;
    pending = null;
    chunk = null;
    error = null;
    topRow = 0;
    pixelShift = 0;
    ignoreScroll = null;
    untrack(() => {
      if (scroller) scroller.scrollTop = 0;
    });
  });

  // Keep topRow valid when the viewport (and so maxTopRow) changes.
  $effect(() => {
    const m = maxTopRow(geometry);
    if (topRow > m) untrack(() => setTop(m));
  });

  onDestroy(() => clearTimeout(retryTimer));

  /** Re-attempt a failed read now. */
  export function retry() {
    clearTimeout(retryTimer);
    retryTick++;
  }

  // Fetch a window larger than the viewport, immediately, but only when not already covered.
  // Superseded requests are ignored when they finish. A failed read leaves the view as-is;
  // it is retried once automatically, on retry(), and whenever the visible range changes.
  $effect(() => {
    const src = source;
    const vis = range;
    void retryTick;
    const loaded = chunk
      ? { start: chunk.startRow, end: chunk.startRow + Math.ceil(chunk.bytes.length / BYTES_PER_ROW) }
      : null;
    if (covers(loaded, vis)) {
      // Back in loaded territory: a failure for some other range no longer applies.
      error = null;
      clearTimeout(retryTimer);
      autoRetried = false;
      return;
    }
    if (pending && pending.src === src && covers(pending, vis)) return;

    const win = computeFetchWindow(vis, rowCount(src.size));
    const id = ++reqId;
    pending = { src, ...win };
    src
      .read(win.start * BYTES_PER_ROW, (win.end - win.start) * BYTES_PER_ROW)
      .then((bytes) => {
        if (id !== reqId) return;
        pending = null;
        chunk = { startRow: win.start, bytes };
        error = null;
        autoRetried = false;
      })
      .catch((e: unknown) => {
        if (id !== reqId) return;
        pending = null;
        error = `Read failed: ${e instanceof Error ? e.message : String(e)}`;
        if (!autoRetried) {
          autoRetried = true; // one automatic retry; after that the user clicks Retry
          retryTimer = setTimeout(() => retryTick++, 1000);
        }
      });
  });

  function byteAt(offset: number): number | undefined {
    if (!chunk) return undefined;
    const i = offset - chunk.startRow * BYTES_PER_ROW;
    return i >= 0 && i < chunk.bytes.length ? chunk.bytes[i] : undefined;
  }

  function onScroll() {
    if (!scroller) return;
    const st = scroller.scrollTop;
    if (ignoreScroll !== null) {
      const expected = ignoreScroll;
      ignoreScroll = null;
      if (st === expected) return; // echo of setTop(); topRow is already exact
    }
    topRow = scrollTopToRow(st, geometry);
    pixelShift = rowPixelOffset(st, geometry);
  }

  /** Place `row` at the top of the viewport (clamped), exactly. */
  function setTop(row: number) {
    const r = Math.min(maxTopRow(geometry), Math.max(0, Math.floor(row)));
    topRow = r;
    pixelShift = 0;
    if (!scroller) return;
    const before = scroller.scrollTop;
    scroller.scrollTop = rowToScrollTop(r, geometry); // moves the thumb only
    const after = scroller.scrollTop;
    if (after !== before) ignoreScroll = after;
  }

  function ensureVisible(offset: number, center = false) {
    const row = Math.floor(offset / BYTES_PER_ROW);
    if (center) {
      setTop(row - Math.floor(fullRows / 2));
    } else if (row < topRow) {
      setTop(row);
    } else if (row >= topRow + fullRows) {
      setTop(row - fullRows + 1);
    }
  }

  /** Select a single byte and scroll it into the middle of the view. */
  export function goTo(offset: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= source.size) return;
    selection = { anchor: offset, caret: offset };
    ensureVisible(offset, true);
    scroller?.focus();
  }

  // ---- Mouse selection ----
  let dragging = false;

  function offsetFromTarget(t: EventTarget | null): number | null {
    const el = (t as Element | null)?.closest?.('[data-o]');
    if (!el) return null;
    const o = Number((el as HTMLElement).dataset.o);
    return Number.isSafeInteger(o) && o >= 0 && o < source.size ? o : null;
  }

  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const o = offsetFromTarget(e.target);
    if (o === null) return;
    e.preventDefault();
    scroller?.focus();
    selection = e.shiftKey && selection ? { anchor: selection.anchor, caret: o } : { anchor: o, caret: o };
    dragging = true;
  }

  function onWindowMouseMove(e: MouseEvent) {
    if (!dragging || !selection) return;
    const o = offsetFromTarget(document.elementFromPoint(e.clientX, e.clientY));
    if (o !== null && o !== selection.caret) selection = { anchor: selection.anchor, caret: o };
  }

  function onWindowMouseUp() {
    dragging = false;
  }

  // ---- Keyboard ----
  const KEYS: Record<string, CaretMove> = {
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ArrowUp: 'up',
    ArrowDown: 'down',
    PageUp: 'pageUp',
    PageDown: 'pageDown',
    Home: 'rowStart',
    End: 'rowEnd',
  };

  function onKeyDown(e: KeyboardEvent) {
    if (source.size <= 0 || e.altKey || e.metaKey) return;
    let move = KEYS[e.key];
    if (!move) return;
    if (e.ctrlKey) {
      if (e.key === 'Home') move = 'fileStart';
      else if (e.key === 'End') move = 'fileEnd';
      else return;
    }
    e.preventDefault();
    const next = navigate(selection, move, source.size, fullRows, e.shiftKey);
    selection = next;
    ensureVisible(next.caret);
  }
</script>

<svelte:window onmousemove={onWindowMouseMove} onmouseup={onWindowMouseUp} />

<div
  class="scroller"
  bind:this={scroller}
  bind:clientHeight={viewportHeight}
  onscroll={onScroll}
  onkeydown={onKeyDown}
  onmousedown={onMouseDown}
  tabindex="0"
  role="grid"
  aria-label="Hex view"
  aria-rowcount={totalRows}
>
  <div class="spacer" style:height="{spacerHeight(geometry)}px">
    <div class="layer" style:height="{viewportHeight}px">
      <div class="rows" style:transform="translateY({shiftY}px)">
        {#each rows as row (row)}
          {@const base = row * BYTES_PER_ROW}
          <div class="row" style:height="{ROW_HEIGHT}px" role="row">
            <span class="off">{formatOffset(base, width)}</span>
            <span class="hex">
              {#each { length: BYTES_PER_ROW } as _, i}
                {@const o = base + i}
                {@const b = o < source.size ? byteAt(o) : undefined}
                <span
                  class="b"
                  class:gap={i === 8}
                  class:sel={sel && o >= sel.start && o <= sel.end}
                  class:caret={selection?.caret === o}
                  data-o={o < source.size ? o : undefined}
                  >{b === undefined ? (o < source.size ? '··' : '') : byteToHex(b)}</span
                >
              {/each}
            </span>
            <span class="ascii">
              {#each { length: BYTES_PER_ROW } as _, i}
                {@const o = base + i}
                {@const b = o < source.size ? byteAt(o) : undefined}
                <span
                  class="c"
                  class:sel={sel && o >= sel.start && o <= sel.end}
                  class:caret={selection?.caret === o}
                  data-o={o < source.size ? o : undefined}
                  >{b === undefined ? (o < source.size ? ' ' : '') : byteToAscii(b)}</span
                >
              {/each}
            </span>
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .scroller {
    flex: 1;
    min-height: 0;
    overflow: auto;
    outline: none;
    font-family: var(--mono);
    font-size: 13px;
    background: var(--bg);
    user-select: none;
  }
  .scroller:focus-visible {
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .spacer {
    position: relative;
    min-width: max-content;
  }
  .layer {
    position: sticky;
    top: 0;
    overflow: hidden;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 12px;
    white-space: pre;
    box-sizing: border-box;
  }
  .off {
    color: var(--muted);
  }
  .hex {
    display: inline-flex;
  }
  .b {
    display: inline-block;
    width: 2.4ch;
    text-align: center;
    margin-right: 0.4ch;
    border-radius: 2px;
  }
  .b.gap {
    margin-left: 1ch;
  }
  .c {
    display: inline-block;
    width: 1ch;
    text-align: center;
  }
  .ascii {
    display: inline-flex;
    color: var(--ascii);
  }
  .sel {
    background: var(--sel-bg);
    color: var(--sel-fg);
  }
  .caret {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
</style>
