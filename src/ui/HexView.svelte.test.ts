// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ByteSource } from '../core/byte-source';
import HexHarness from '../test/HexHarness.svelte';

let viewport = 400; // 20 rows
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
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => viewport });
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
});
