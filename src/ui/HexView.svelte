<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { ByteSource } from '../core/byte-source';
  import { MAX_CLIPBOARD_BYTES, bytesToHexText, parseAsciiText, parseHexText } from '../core/clipboard-text';
  import type { EditBuffer } from '../core/edit-buffer';
  import type { RangeSegment } from '../worker/protocol';
  import { navigate, selectionRange, type CaretMove, type Selection } from '../core/caret';
  import { computeFetchWindow, covers } from '../core/fetch-window';
  import {
    BYTES_PER_ROW,
    byteToAscii,
    byteToHex,
    editRowCount,
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
  const TINT_COUNT = 4;

  let {
    source,
    selection = $bindable(null),
    error = $bindable(null),
    nodeRange = null,
    tints = [],
    editor = null,
    editVersion = 0,
    insertMode = $bindable(false),
    locked = false,
    onNotice,
    onViewChange,
    onByteClick,
  }: {
    source: ByteSource;
    selection: Selection | null;
    error: string | null;
    /** Byte range (inclusive) of the node selected in the structure tree. */
    nodeRange?: { start: number; end: number } | null;
    /** Sorted leaf ranges [start, end) with a group number, for tinting the visible window only. */
    tints?: RangeSegment[];
    /** When set (and the same object as `source`), typing/delete/paste/undo edit it. */
    editor?: EditBuffer | null;
    /** The editor's `version`; bump to invalidate cached bytes and the edited-byte marks. */
    editVersion?: number;
    /** Insert (true) or overwrite (false) mode, toggled by the Insert key. */
    insertMode?: boolean;
    /** Editing is temporarily disabled (a save is in progress). */
    locked?: boolean;
    /** Edit/copy/paste problems for the status bar; null clears. */
    onNotice?: (message: string | null) => void;
    /** Visible byte window [start, end) changed (rows rendered, not just fully visible). */
    onViewChange?: (start: number, end: number) => void;
    /** A plain click (no drag, no shift) landed on a byte. */
    onByteClick?: (offset: number) => void;
  } = $props();

  let scroller: HTMLDivElement | undefined = $state();
  let viewportHeight = $state(0);

  // The first row in the viewport is the source of truth for rendering. It is derived from
  // scrollTop only on user scrolls; goTo/keyboard set it exactly (matters for huge files where
  // one scrollbar pixel spans many rows).
  let topRow = $state(0);
  let pixelShift = $state(0);
  let ignoreScroll: number | null = null; // scrollTop produced by our own programmatic scroll

  // Loaded byte window; rows outside it render as blanks (never stale data).
  let chunk = $state.raw<{ startRow: number; ver: number; bytes: Uint8Array } | null>(null);
  let reqId = 0;
  let retryTick = $state(0); // bump to re-run the fetch effect after a failure
  let autoRetried = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: { src: ByteSource; ver: number; start: number; end: number } | null = null;

  // The source's size is not reactive by itself; editVersion changes whenever it may have changed.
  const size = $derived.by(() => {
    void editVersion;
    return source.size;
  });
  // While editing there is one more slot than bytes (the caret at offset == size, for appending).
  const totalRows = $derived(editor ? editRowCount(size) : rowCount(size));
  const width = $derived(offsetWidth(size));
  const geometry: ScrollGeometry = $derived({ totalRows, rowHeight: ROW_HEIGHT, viewportHeight });
  const range = $derived(visibleRangeFromTop(topRow, geometry));
  const shiftY = $derived(-((topRow - range.start) * ROW_HEIGHT + pixelShift));
  const rows = $derived(Array.from({ length: range.end - range.start }, (_, i) => range.start + i));
  const sel = $derived(selection ? selectionRange(selection) : null);
  const winStart = $derived(range.start * BYTES_PER_ROW);
  const winEnd = $derived(Math.min(size, range.end * BYTES_PER_ROW));
  // Tint group per byte of the rendered window (0 = none). Work is bounded by the window, never the file.
  const tintMap = $derived.by(() => {
    const map = new Uint8Array(Math.max(0, winEnd - winStart));
    for (const t of tints) {
      const a = Math.max(t.start, winStart);
      const b = Math.min(t.end, winEnd);
      const v = (((t.group % TINT_COUNT) + TINT_COUNT) % TINT_COUNT) + 1;
      for (let o = a; o < b; o++) map[o - winStart] = v;
    }
    return map;
  });
  // Edited bytes of the rendered window (1 = in an added piece); bounded by the window, never the file.
  const modMap = $derived.by(() => {
    void editVersion;
    const map = new Uint8Array(Math.max(0, winEnd - winStart));
    if (editor) for (const [a, b] of editor.modifiedRanges(winStart, winEnd)) map.fill(1, a - winStart, b - winStart);
    return map;
  });
  const modAt = (o: number) => modMap[o - winStart] === 1;
  const tintAt = (o: number) => tintMap[o - winStart] || undefined;
  const inNode = (o: number) => nodeRange !== null && o >= nodeRange.start && o <= nodeRange.end;
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
    half = null;
    column = 'hex';
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

  $effect(() => {
    void source; // a new file showing the same window must still announce it
    const a = winStart;
    const b = winEnd;
    untrack(() => onViewChange?.(a, b));
  });

  /** Give the grid keyboard focus. */
  export function focus() {
    scroller?.focus();
  }

  /** Re-attempt a failed read now. */
  export function retry() {
    clearTimeout(retryTimer);
    retryTick++;
  }

  // Fetch a window larger than the viewport, immediately, but only when not already covered.
  // Superseded requests are ignored when they finish. A failed read leaves the view as-is;
  // it is retried once automatically, on retry(), and whenever the visible range changes.
  // Cached bytes are tagged with editVersion: after an edit they no longer count as covering anything,
  // so the window is re-read (the old bytes stay drawn only until the new read lands, never mixed in).
  $effect(() => {
    const src = source;
    const ver = editVersion;
    const readRows = rowCount(src.size);
    const vis = { start: Math.min(range.start, readRows), end: Math.min(range.end, readRows) };
    void retryTick;
    const loaded =
      chunk && chunk.ver === ver
        ? { start: chunk.startRow, end: chunk.startRow + Math.ceil(chunk.bytes.length / BYTES_PER_ROW) }
        : null;
    if (covers(loaded, vis)) {
      // Back in loaded territory: a failure for some other range no longer applies.
      error = null;
      clearTimeout(retryTimer);
      autoRetried = false;
      return;
    }
    if (pending && pending.src === src && pending.ver === ver && covers(pending, vis)) return;

    const win = computeFetchWindow(vis, readRows);
    const id = ++reqId;
    pending = { src, ver, ...win };
    src
      .read(win.start * BYTES_PER_ROW, (win.end - win.start) * BYTES_PER_ROW)
      .then((bytes) => {
        if (id !== reqId) return;
        pending = null;
        chunk = { startRow: win.start, ver, bytes };
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

  /** Scroll so `offset` is visible (centred when it was off-screen) without touching the selection. */
  export function reveal(offset: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || source.size <= 0) return;
    const row = Math.floor(Math.min(offset, source.size - 1) / BYTES_PER_ROW);
    if (row < topRow || row >= topRow + fullRows) setTop(row - Math.floor(fullRows / 2));
  }

  /** Select a single byte and scroll it into the middle of the view. */
  export function goTo(offset: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= source.size) return;
    selection = { anchor: offset, caret: offset };
    half = null;
    queueEdit(() => editor?.breakGroup());
    ensureVisible(offset, true);
    scroller?.focus();
  }

  // ---- Mouse selection ----
  let dragging = false;
  let clickCandidate: number | null = null; // byte under a plain mousedown; cleared if the drag moves

  function offsetFromTarget(t: EventTarget | null): number | null {
    const el = (t as Element | null)?.closest?.('[data-o]');
    if (!el) return null;
    const o = Number((el as HTMLElement).dataset.o);
    // While editing, the empty slot at offset == size is a valid target (append position).
    return Number.isSafeInteger(o) && o >= 0 && o < source.size + (editor ? 1 : 0) ? o : null;
  }

  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const o = offsetFromTarget(e.target);
    if (o === null) return;
    e.preventDefault();
    scroller?.focus();
    column = (e.target as Element).closest('.ascii') ? 'ascii' : 'hex';
    half = null;
    queueEdit(() => editor?.breakGroup());
    selection = e.shiftKey && selection ? { anchor: selection.anchor, caret: o } : { anchor: o, caret: o };
    dragging = true;
    clickCandidate = e.shiftKey ? null : o;
  }

  function onWindowMouseMove(e: MouseEvent) {
    if (!dragging || !selection) return;
    const o = offsetFromTarget(document.elementFromPoint(e.clientX, e.clientY));
    if (o !== null && o !== selection.caret) {
      selection = { anchor: selection.anchor, caret: o };
      clickCandidate = null;
    }
  }

  function onWindowMouseUp() {
    const click = dragging ? clickCandidate : null;
    dragging = false;
    clickCandidate = null;
    if (click !== null) onByteClick?.(click);
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

  // ---- Editing ----
  // Which column last received a click decides what typed characters mean.
  let column: 'hex' | 'ascii' = 'hex';
  // Offset whose high nibble was just typed; the next hex digit completes its low nibble. Any caret
  // movement (arrows, clicks, goTo, undo) clears it.
  let half: number | null = null;
  // Edits are applied in order (they await reads), while the caret moves synchronously.
  let editQueue: Promise<void> = Promise.resolve();

  function queueEdit(fn: () => void | Promise<void>) {
    editQueue = editQueue
      .then(() => {
        if (locked) return; // a save started after this was queued: it must not change the document
        return fn();
      })
      .catch((e: unknown) => {
        onNotice?.(e instanceof Error ? e.message : String(e));
      });
  }

  /** Resolves once every edit queued so far (including ones queued while waiting) has been applied. */
  export async function settled(): Promise<void> {
    let q: Promise<void>;
    do {
      q = editQueue;
      await q;
    } while (q !== editQueue);
  }

  function setCaret(offset: number) {
    selection = { anchor: offset, caret: offset };
  }

  /** After an edit has been applied: keep the caret on screen (the row count may just have grown). */
  function settle() {
    if (selection) ensureVisible(selection.caret);
  }

  const currentCaret = () => Math.max(0, selection?.caret ?? 0);

  function typeHex(d: number, ed: EditBuffer) {
    const caret = currentCaret();
    if (half !== null && half === caret && selection && selection.anchor === selection.caret) {
      // Low nibble of the byte typed a moment ago.
      const o = caret;
      half = null;
      setCaret(o + 1);
      queueEdit(async () => {
        if (o >= ed.size) return;
        const old = (await ed.read(o, 1))[0]!;
        ed.overwrite(o, Uint8Array.of((old & 0xf0) | d), { coalesce: true });
        settle();
      });
      return;
    }
    // High nibble. The caret stays on the byte until its second digit arrives.
    const o = caret;
    half = o;
    setCaret(o);
    queueEdit(async () => {
      const at = Math.min(o, ed.size);
      if (insertMode) {
        ed.insert(at, Uint8Array.of(d << 4), { coalesce: true });
      } else if (at >= ed.size) {
        ed.overwrite(at, Uint8Array.of(d << 4), { coalesce: true }); // appends
      } else {
        const old = (await ed.read(at, 1))[0]!;
        ed.overwrite(at, Uint8Array.of((d << 4) | (old & 0x0f)), { coalesce: true });
      }
      settle();
    });
  }

  function typeAscii(code: number, ed: EditBuffer) {
    const o = currentCaret();
    half = null;
    setCaret(o + 1);
    queueEdit(() => {
      const at = Math.min(o, ed.size);
      if (insertMode) ed.insert(at, Uint8Array.of(code), { coalesce: true });
      else ed.overwrite(at, Uint8Array.of(code), { coalesce: true });
      settle();
    });
  }

  /** Delete: the selection, or the byte at the caret. Works in both modes (see docs/DESIGN.md). */
  function deleteForward(ed: EditBuffer) {
    const r = selection ? selectionRange(selection) : { start: 0, end: 0 };
    half = null;
    setCaret(r.start);
    queueEdit(() => {
      const len = Math.min(r.end + 1, ed.size) - r.start;
      if (len > 0) ed.delete(r.start, len);
      settle();
    });
  }

  /** Backspace: a multi-byte selection, else the byte before the caret. */
  function deleteBackward(ed: EditBuffer) {
    const r = selection ? selectionRange(selection) : { start: 0, end: 0 };
    half = null;
    if (r.end > r.start) {
      setCaret(r.start);
      queueEdit(() => {
        const len = Math.min(r.end + 1, ed.size) - r.start;
        if (len > 0) ed.delete(r.start, len);
        settle();
      });
    } else if (r.start > 0) {
      const o = r.start - 1;
      setCaret(o);
      queueEdit(() => {
        if (o < ed.size) ed.delete(o, 1);
        settle();
      });
    }
  }

  function undoRedo(redo: boolean, ed: EditBuffer) {
    half = null;
    queueEdit(() => {
      const at = redo ? ed.redo() : ed.undo();
      if (at === null) return;
      setCaret(at);
      settle();
    });
  }

  function copySelection() {
    if (!selection) return;
    const r = selectionRange(selection);
    const src = source;
    queueEdit(async () => {
      const len = Math.min(r.end + 1, src.size) - r.start;
      if (len <= 0) return;
      if (len > MAX_CLIPBOARD_BYTES) {
        onNotice?.(`Selection is too large to copy (${len.toLocaleString()} bytes; limit ${MAX_CLIPBOARD_BYTES.toLocaleString()})`);
        return;
      }
      const bytes = await src.read(r.start, len);
      // Not awaited: a clipboard write that never settles (permission prompt) must not block the edit queue,
      // and with it Save.
      navigator.clipboard.writeText(bytesToHexText(bytes)).then(
        () => onNotice?.(null),
        (e: unknown) => onNotice?.(`Copy failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    });
  }

  function onPaste(e: ClipboardEvent) {
    const ed = locked ? null : editor;
    if (!ed) return;
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    const parsed = column === 'ascii' ? parseAsciiText(text) : parseHexText(text);
    if (!parsed.ok) {
      onNotice?.(parsed.error);
      return;
    }
    onNotice?.(null);
    const bytes = parsed.bytes;
    // Pastes go to the start of the selection (the caret for a single byte) and do not replace the rest of it.
    const start = selection ? selectionRange(selection).start : 0;
    half = null;
    setCaret(start + bytes.length);
    queueEdit(() => {
      const at = Math.min(start, ed.size);
      if (insertMode) ed.insert(at, bytes);
      else ed.overwrite(at, bytes);
      setCaret(at + bytes.length);
      settle();
    });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.altKey || e.metaKey) return;
    const ed = locked ? null : editor;

    if (e.ctrlKey) {
      const k = e.key.toLowerCase();
      if (ed && (k === 'z' || k === 'y')) {
        e.preventDefault();
        undoRedo(k === 'y' || e.shiftKey, ed);
        return;
      }
      if (k === 'c') {
        e.preventDefault();
        copySelection();
        return;
      }
    } else if (ed) {
      if (e.key === 'Insert') {
        e.preventDefault();
        insertMode = !insertMode;
        half = null;
        return;
      }
      if (e.key === 'Delete') {
        e.preventDefault();
        onNotice?.(null);
        deleteForward(ed);
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        onNotice?.(null);
        deleteBackward(ed);
        return;
      }
      if (e.key.length === 1) {
        e.preventDefault(); // also stops Space from scrolling the page
        onNotice?.(null);
        if (column === 'ascii') {
          const code = e.key.charCodeAt(0);
          if (code >= 0x20 && code <= 0x7e) typeAscii(code, ed);
        } else if (/^[0-9a-fA-F]$/.test(e.key)) {
          typeHex(parseInt(e.key, 16), ed);
        }
        return;
      }
    }

    if (!ed && source.size <= 0) return;
    let move = KEYS[e.key];
    if (!move) return;
    if (e.ctrlKey) {
      if (e.key === 'Home') move = 'fileStart';
      else if (e.key === 'End') move = 'fileEnd';
      else return;
    }
    e.preventDefault();
    const next = navigate(selection, move, source.size, fullRows, e.shiftKey, ed !== null);
    selection = next;
    half = null;
    queueEdit(() => ed?.breakGroup());
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
  onpaste={onPaste}
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
              {#each { length: BYTES_PER_ROW } as _, i (i)}
                {@const o = base + i}
                {@const b = o < size ? byteAt(o) : undefined}
                <span
                  class="b"
                  class:gap={i === 8}
                  class:sel={sel && o >= sel.start && o <= sel.end}
                  class:node={inNode(o)}
                  class:mod={modAt(o)}
                  class:caret={selection?.caret === o}
                  data-o={o < size || (editor && o === size) ? o : undefined}
                  data-t={tintAt(o)}
                  >{b === undefined ? (o < size ? '··' : '') : byteToHex(b)}</span
                >
              {/each}
            </span>
            <span class="ascii">
              {#each { length: BYTES_PER_ROW } as _, i (i)}
                {@const o = base + i}
                {@const b = o < size ? byteAt(o) : undefined}
                <span
                  class="c"
                  class:sel={sel && o >= sel.start && o <= sel.end}
                  class:node={inNode(o)}
                  class:mod={modAt(o)}
                  class:caret={selection?.caret === o}
                  data-o={o < size || (editor && o === size) ? o : undefined}
                  data-t={tintAt(o)}
                  >{b === undefined ? (o < size ? ' ' : '') : byteToAscii(b)}</span
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
    font-size: var(--fs-base);
    background: var(--ground);
    user-select: none;
  }
  /* The caret already shows the position, so the focused grid only gets a quiet 1px frame. */
  .scroller:focus-visible {
    outline: 1px solid color-mix(in srgb, var(--signal) 55%, transparent);
    outline-offset: -1px;
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
    color: var(--ink-faint);
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
    color: var(--ink-quiet);
  }
  [data-t='1'] {
    background: var(--struct-1-tint);
  }
  [data-t='2'] {
    background: var(--struct-2-tint);
  }
  [data-t='3'] {
    background: var(--struct-3-tint);
  }
  [data-t='4'] {
    background: var(--struct-4-tint);
  }
  /* The tree-selected node: a signal-tinted background plus an underline that stays visible under .sel. */
  .node {
    background: var(--node-bg);
    box-shadow: inset 0 -2px 0 var(--node-edge);
  }
  .sel {
    background: var(--sel-bg);
    color: var(--sel-fg);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--signal) 50%, transparent);
  }
  .sel.node {
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--signal) 50%, transparent),
      inset 0 -2px 0 var(--node-edge);
  }
  /* ASCII over a structure tint stays readable */
  .c[data-t] {
    color: var(--ink);
  }
  /* Bytes the user has written (live edits not yet saved). Declared after .sel so it stays visible when selected. */
  .mod {
    color: var(--edited);
    font-weight: 600;
  }
  /* A modified byte inside the selection: the selection colour wins, the edit shows as an underline. */
  .sel.mod {
    color: var(--sel-fg);
    text-decoration: underline var(--edited) 2px;
    text-underline-offset: 2px;
  }
  .caret {
    outline: 2px solid var(--signal);
    outline-offset: -1px;
    border-radius: 2px;
  }
</style>
