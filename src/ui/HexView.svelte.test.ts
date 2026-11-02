// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ByteSource } from '../core/byte-source';
import HexHarness from '../test/HexHarness.svelte';
import HexView from './HexView.svelte';

let viewport = 400; // 20 rows
const HEADER = 22; // the grid's own client height also holds its column header row
type RO = { cb: (entries: Array<{ target: Element }>) => void; els: Element[] };
// Svelte keeps one module-level observer for the whole file, so never reset this list.
const observers: RO[] = [];

/** Change the stubbed clientHeight and notify Svelte's resize observers. */
function resizeTo(height: number) {
  viewport = height;
  for (const o of observers) o.cb(o.els.filter((e) => e.isConnected).map((target) => ({ target })));
}

beforeAll(() => {
  // jsdom has no layout or ResizeObserver; stub both.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => viewport + HEADER });
  globalThis.ResizeObserver = class {
    private o: RO;
    constructor(cb: RO['cb']) {
      this.o = { cb, els: [] };
      observers.push(this.o);
    }
    observe(el: Element) {
      this.o.els.push(el);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  vi.useRealTimers();
  viewport = 400;
});
afterEach(cleanup);

/** Source whose reads are answered by the test; every byte read is `fill(offset)`. */
function stubSource(size: number, fill: (o: number) => number = () => 0) {
  const calls: Array<{ offset: number; length: number; resolve(): void; reject(e: Error): void }> = [];
  const src: ByteSource = {
    size,
    read: (offset, length) =>
      new Promise((res, rej) => {
        calls.push({
          offset,
          length,
          resolve: () => res(Uint8Array.from({ length }, (_, i) => fill(offset + i))),
          reject: rej,
        });
      }),
  };
  return { src, calls };
}

const hexCells = (c: HTMLElement) => [...c.querySelectorAll('.b')].map((e) => e.textContent);

describe('HexView', () => {
  it('discards the result of a read for a previous source', async () => {
    const a = stubSource(1000, () => 0xaa);
    const b = stubSource(1000, () => 0x42);
    const { container, rerender } = render(HexHarness, { source: a.src });
    await waitFor(() => expect(a.calls.length).toBeGreaterThan(0));
    await rerender({ source: b.src });
    await waitFor(() => expect(b.calls.length).toBeGreaterThan(0));
    a.calls.forEach((c) => c.resolve()); // stale
    b.calls.forEach((c) => c.resolve());
    await waitFor(() => expect(hexCells(container)).toContain('42'));
    expect(hexCells(container)).not.toContain('AA');
  });

  it('shows an error on a failed read and recovers via Retry', async () => {
    const s = stubSource(1000, () => 0x7f);
    const { container, getByRole, findByRole } = render(HexHarness, { source: s.src });
    await waitFor(() => expect(s.calls.length).toBe(1));
    s.calls[0]!.reject(new Error('disk gone'));
    const alert = await findByRole('alert');
    expect(alert.textContent).toContain('disk gone');
    await fireEvent.click(getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(s.calls.length).toBe(2));
    s.calls[1]!.resolve();
    await waitFor(() => expect(hexCells(container)).toContain('7F'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('goTo renders the target row on a huge (compressed) source', async () => {
    const size = 2 ** 40;
    const s = stubSource(size, (o) => o & 0xff);
    const { container, component } = render(HexHarness, { source: s.src });
    await waitFor(() => expect(s.calls.length).toBe(1));
    const target = 0x12_3456_7893;
    component.goTo(target);
    await waitFor(() => expect(container.querySelector(`[data-o="${target}"]`)).not.toBeNull());
    expect(container.querySelector(`[data-o="${target}"]`)!.classList.contains('caret')).toBe(true);
    expect([...container.querySelectorAll('.off')].map((e) => e.textContent)).toContain('1234567890');
    // the data for the new window is requested and shown
    await waitFor(() => expect(s.calls.some((c) => c.offset <= target && target < c.offset + c.length)).toBe(true));
    s.calls.forEach((c) => c.resolve());
    await waitFor(() => expect(container.querySelector(`.b[data-o="${target}"]`)!.textContent).toBe('93'));
  });

  it('ignores the scroll echo of a clamped programmatic scrollTop', async () => {
    const s = stubSource(2 ** 40);
    const { container, component } = render(HexHarness, { source: s.src });
    const scroller = container.querySelector('.scroller') as HTMLElement;
    let st = 0;
    const MAX = 5000; // the browser clamps to a value different from what we ask for
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => st,
      set: (v: number) => {
        const next = Math.min(MAX, Math.max(0, v));
        if (next !== st) {
          st = next;
          queueMicrotask(() => scroller.dispatchEvent(new Event('scroll')));
        }
      },
    });
    const target = 0x12_3456_7893;
    component.goTo(target);
    await waitFor(() => expect(container.querySelector(`[data-o="${target}"]`)).not.toBeNull());
    await new Promise((r) => setTimeout(r, 10)); // let the echo event arrive
    expect(container.querySelector(`[data-o="${target}"]`)).not.toBeNull();

    // a genuine user scroll still moves the view
    st = 1_000_000;
    await fireEvent.scroll(scroller);
    await waitFor(() => expect(container.querySelector(`[data-o="${target}"]`)).toBeNull());
  });

  it('clears the error when scrolling back into already-loaded rows', async () => {
    vi.useFakeTimers();
    const s = stubSource(16 * 100_000, () => 1);
    const { container, queryByRole } = render(HexHarness, { source: s.src });
    const scroller = container.querySelector('.scroller') as HTMLElement;
    let st = 0;
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => st, set: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    s.calls[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);

    st = 20 * 5000; // far outside the loaded window
    await fireEvent.scroll(scroller);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.calls.length).toBe(2);
    s.calls[1]!.reject(new Error('flaky'));
    await vi.advanceTimersByTimeAsync(0);
    expect(queryByRole('alert')?.textContent).toContain('flaky');

    st = 0; // back inside the loaded chunk
    await fireEvent.scroll(scroller);
    await vi.advanceTimersByTimeAsync(0);
    expect(queryByRole('alert')).toBeNull();
    await vi.advanceTimersByTimeAsync(5000); // pending auto-retry was cancelled
    expect(s.calls.length).toBe(2);
  });

  it('auto-retries a failed read exactly once', async () => {
    vi.useFakeTimers();
    const s = stubSource(1000);
    render(HexHarness, { source: s.src });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.calls.length).toBe(1);
    s.calls[0]!.reject(new Error('x'));
    await vi.advanceTimersByTimeAsync(999);
    expect(s.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.calls.length).toBe(2);
    s.calls[1]!.reject(new Error('y'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.calls.length).toBe(2);
  });

  it('cancels the pending auto-retry when the source changes', async () => {
    vi.useFakeTimers();
    const a = stubSource(1000);
    const b = stubSource(1000);
    const { rerender } = render(HexHarness, { source: a.src });
    await vi.advanceTimersByTimeAsync(0);
    a.calls[0]!.reject(new Error('a failed')); // retry timer due at t=1000
    await vi.advanceTimersByTimeAsync(0);
    await rerender({ source: b.src });
    await vi.advanceTimersByTimeAsync(500);
    expect(b.calls.length).toBe(1);
    b.calls[0]!.reject(new Error('b failed')); // B's own retry due at t=1500
    await vi.advanceTimersByTimeAsync(700); // t=1200: A's stale timer would have fired
    expect(b.calls.length).toBe(1);
    expect(a.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(300); // B's own auto-retry
    expect(b.calls.length).toBe(2);
  });

  it('re-clamps the top row when the viewport shrinks then grows', async () => {
    const s = stubSource(16 * 100); // 100 rows
    const { container, component } = render(HexHarness, { source: s.src });
    await waitFor(() => expect(s.calls.length).toBe(1));
    resizeTo(200); // 10 rows
    component.goTo(16 * 99 + 5); // last row; top row becomes 90 (max)
    await waitFor(() => expect(container.querySelector('[data-o="1589"]')).not.toBeNull());
    resizeTo(2000); // 100 rows fit: top row must fall back to 0
    const offs = () => [...container.querySelectorAll('.off')].map((e) => e.textContent);
    await waitFor(() => expect(offs()).toContain('00000000'));
    expect(offs()).toContain('00000630'); // last row (99 * 16) still rendered
  });

  it('reports the on-screen bytes (no overscan) and scrollToOffset places the row in the middle or at the top', async () => {
    const s = stubSource(16 * 1000);
    const seen: Array<[number, number]> = [];
    const { component, container } = render(HexHarness, { source: s.src, onViewport: (a: number, b: number) => seen.push([a, b]) });
    await waitFor(() => expect(seen.at(-1)).toEqual([0, 16 * 20])); // 400px = 20 rows
    expect(container.querySelector('[role="grid"]')?.id).toBe('hex-grid');
    component.scrollToOffset(16 * 500 + 3); // centred: row 500 - 10
    await waitFor(() => expect(seen.at(-1)).toEqual([16 * 490, 16 * 510]));
    component.scrollToOffset(16 * 700, false); // at the top
    await waitFor(() => expect(seen.at(-1)).toEqual([16 * 700, 16 * 720]));
    component.scrollToOffset(1e12); // clamped to the end: the last full page
    await waitFor(() => expect(seen.at(-1)).toEqual([16 * 980, 16 * 1000]));
    component.scrollToOffset(-5, false);
    await waitFor(() => expect(seen.at(-1)).toEqual([0, 16 * 20]));
  });

  it('scrollBy moves the grid like the wheel', async () => {
    const s = stubSource(16 * 1000);
    const { component, container } = render(HexHarness, { source: s.src });
    const scroller = container.querySelector('[role="grid"]') as HTMLElement;
    let st = 0;
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => st, set: (v: number) => (st = v) });
    component.scrollBy(120);
    expect(st).toBe(120);
    component.scrollBy(NaN);
    expect(st).toBe(120);
  });
});

describe('HexView banding', () => {
  const mountView = async (banding?: boolean) => {
    const { src, calls } = stubSource(1000, () => 7);
    const r = render(HexView, { source: src, selection: null, error: null, ...(banding === undefined ? {} : { banding }) } as never);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    return r;
  };

  it('marks the hex and ASCII columns as banded by default (CSS paints the bands, nothing per byte)', async () => {
    const { container } = await mountView();
    const rows = container.querySelectorAll('.row');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.querySelector('.hex')!.classList.contains('banded')).toBe(true);
      expect(row.querySelector('.ascii')!.classList.contains('banded')).toBe(true);
    }
    // no byte cell carries a band class or style of its own
    expect(container.querySelectorAll('.b[class*="band"], .c[class*="band"], .b[style], .c[style]')).toHaveLength(0);
  });

  it('is plain with banding off', async () => {
    const { container } = await mountView(false);
    expect(container.querySelector('.banded')).toBeNull();
  });
});

describe('HexView column header row', () => {
  it('has 16 hex labels 00..0F and 16 ASCII labels 0..F, hidden from assistive technology, outside the data rows', async () => {
    const { src, calls } = stubSource(1000, () => 7);
    const { container } = render(HexView, { source: src, selection: null, error: null } as never);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const head = container.querySelector('.hrow')!;
    expect(head.getAttribute('aria-hidden')).toBe('true');
    expect(head.closest('[role="row"]')).toBeNull();
    expect(head.textContent).toContain('Offset');
    expect([...head.querySelectorAll('.hb')].map((e) => e.textContent)).toEqual(Array.from({ length: 16 }, (_, i) => i.toString(16).toUpperCase().padStart(2, '0')));
    expect([...head.querySelectorAll('.hc')].map((e) => e.textContent).join('')).toBe('0123456789ABCDEF');
    expect(head.querySelectorAll('.hb')[8]!.classList.contains('gap')).toBe(true); // the same 8-byte gap as the data
    expect(container.querySelectorAll('.hrow [data-o]')).toHaveLength(0); // never a click target
    expect(container.querySelectorAll('.row').length).toBeGreaterThan(0);
  });

  it('highlights the labels of the column the caret is in, in both columns', async () => {
    const { src, calls } = stubSource(1000, () => 7);
    const { container } = render(HexView, { source: src, selection: { anchor: 0x25, caret: 0x25 }, error: null } as never);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect([...container.querySelectorAll('.hb.here')].map((e) => e.textContent)).toEqual(['05']);
    expect([...container.querySelectorAll('.hc.here')].map((e) => e.textContent)).toEqual(['5']);
  });

  it('a grid shorter than its header has no rows area, but the row maths stays finite: no NaN or negative heights, paging and goTo work, and it recovers', async () => {
    const s = stubSource(16 * 100);
    const seen: Array<[number, number]> = [];
    const { container, component } = render(HexHarness, { source: s.src, onViewport: (a: number, b: number) => seen.push([a, b]) });
    await waitFor(() => expect(s.calls.length).toBe(1));
    resizeTo(-15); // client height 7: less than the 22px header
    await waitFor(() => expect((container.querySelector('.layer') as HTMLElement).style.height).toBe('0px'));
    expect(container.querySelector('.layer')!.getAttribute('style')).not.toMatch(/NaN|-d/);
    for (const [a, b] of seen) {
      expect(Number.isFinite(a) && Number.isFinite(b)).toBe(true);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeGreaterThanOrEqual(a);
    }
    component.goTo(16 * 50 + 3);
    component.scrollToOffset(16 * 70);
    const grid = container.querySelector('[role="grid"]')!;
    await fireEvent.keyDown(grid, { key: 'PageDown' });
    await fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(container.innerHTML).not.toMatch(/NaN/);
    expect(container.querySelectorAll('.row')).toHaveLength(0); // no data height: nothing to draw (as for a hidden grid)
    resizeTo(400); // and it recovers when the grid grows again
    await waitFor(() => expect(container.querySelectorAll('.row').length).toBeGreaterThan(10));
  });

  it('the header takes its own height out of the grid: the rows area is the 400px that is left, below the 22px header', async () => {
    const { src, calls } = stubSource(16 * 100, () => 7);
    const { container } = render(HexView, { source: src, selection: null, error: null } as never);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect((container.querySelector('.layer') as HTMLElement).style.height).toBe('400px');
    expect((container.querySelector('.layer') as HTMLElement).style.top).toBe('22px');
  });
});
