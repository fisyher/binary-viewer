// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Minimap from './Minimap.svelte';

let cssW = 64;
let cssH = 160;
type RO = { cb: (entries: Array<{ target: Element }>) => void; els: Element[] };
const observers: RO[] = [];

function resizeTo(h: number) {
  cssH = h;
  for (const o of observers) o.cb(o.els.filter((e) => e.isConnected).map((target) => ({ target })));
}

interface Draw {
  style: string;
  alpha: number;
  rect: [number, number, number, number];
}
let draws: Draw[] = [];

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => cssH });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => cssW });
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
  // A recording 2D context: the paint calls are the seam (jsdom has no canvas).
  HTMLCanvasElement.prototype.getContext = function () {
    const ctx = {
      fillStyle: '',
      globalAlpha: 1,
      clearRect() {},
      fillRect(x: number, y: number, w: number, h: number) {
        draws.push({ style: ctx.fillStyle, alpha: ctx.globalAlpha, rect: [x, y, w, h] });
      },
    };
    return ctx as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

beforeEach(() => {
  cssH = 160;
  draws = [];
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Palette fallbacks used when the CSS variables are not defined (jsdom loads no stylesheet).
const C1 = '#4fb3a9';
const C2 = '#8c9eff';
const T1 = 'rgba(79, 179, 169, 0.32)';
const T2 = 'rgba(140, 158, 255, 0.32)';
const SIGNAL = '#e8b04a';

const ptr = (type: string, clientY: number, extra: MouseEventInit = {}) => new MouseEvent(type, { bubbles: true, clientY, button: 0, ...extra });

function mount(props: Partial<Parameters<typeof render<typeof Minimap>>[1]> = {}) {
  const onSeek = vi.fn();
  const onWheelBy = vi.fn();
  const onWantBuckets = vi.fn();
  const r = render(Minimap, { size: 1600, onSeek, onWheelBy, onWantBuckets, controls: 'hex-grid', ...props } as never);
  const strip = r.getByRole('scrollbar', { name: 'File overview' }) as HTMLElement;
  strip.getBoundingClientRect = () => ({ top: 100, left: 0, right: 64, bottom: 100 + cssH, width: 64, height: cssH, x: 0, y: 100, toJSON() {} });
  return { ...r, strip, onSeek, onWheelBy, onWantBuckets };
}

describe('Minimap', () => {
  it('exposes a labelled vertical scrollbar tied to the hex grid', async () => {
    const { strip } = mount({ viewport: { start: 320, end: 640 } });
    expect(strip.getAttribute('aria-orientation')).toBe('vertical');
    expect(strip.getAttribute('aria-controls')).toBe('hex-grid');
    expect(strip.getAttribute('aria-valuemin')).toBe('0');
    expect(strip.getAttribute('aria-valuemax')).toBe('1280'); // size - visible bytes
    expect(strip.getAttribute('aria-valuenow')).toBe('320');
    expect(strip.getAttribute('aria-valuetext')).toBe('Offset 0x00000140');
    expect(strip.tabIndex).toBe(0);
  });

  it('paints one band per run of buckets in the structure colours, gaps as hairlines', () => {
    // 16 buckets on 160 rows: 10 rows each. group 1 (rows 0-30), gap (30-80), group 2 (80-160)
    const buckets = Uint8Array.from([1, 1, 1, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2]);
    const { strip } = mount({ overview: { size: 1600, buckets } });
    // the tint fills the band; a 1px edge in the full colour closes it at the top and the bottom
    const bands = draws.filter((d) => d.style === T1 || d.style === T2 || d.alpha === 0.55);
    expect(bands.map((d) => [d.style, ...d.rect])).toEqual([
      [T1, 0, 0, 64, 30],
      [C1, 0, 0, 64, 1],
      [C1, 0, 29, 64, 1],
      [T2, 0, 80, 64, 80],
      [C2, 0, 80, 64, 1],
      [C2, 0, 159, 64, 1],
    ]);
    const hairlines = draws.filter((d) => d.alpha === 0.6);
    expect(hairlines.length).toBeGreaterThan(0);
    expect(hairlines.every((d) => d.rect[1] >= 30 && d.rect[1] < 80 && d.rect[3] === 1)).toBe(true);
    expect(strip.dataset.structuredBands).toBe('2');
    expect(strip.dataset.structuredRows).toBe('110');
    expect(strip.dataset.groups).toBe('1,2');
  });

  it('paints a blank strip with no structure when there is no overview, and ignores one for another size', () => {
    const buckets = Uint8Array.from(Array(16).fill(1));
    const blank = mount({ viewport: { start: 0, end: 160 } });
    expect(draws.some((d) => d.alpha === 0.55)).toBe(false);
    expect(blank.strip.dataset.structuredBands).toBe('0');
    cleanup();
    draws = [];
    const stale = mount({ overview: { size: 999, buckets } });
    expect(draws.some((d) => d.alpha === 0.55)).toBe(false);
    expect(stale.strip.dataset.structuredBands).toBe('0');
  });

  it('draws the viewport frame (fill and 1px outline) and the selection tick in the signal colour', () => {
    mount({ size: 1600, viewport: { start: 400, end: 800 }, selection: { start: 1200, end: 1209 } });
    const signal = draws.filter((d) => d.style === SIGNAL);
    const fill = signal.find((d) => d.alpha === 0.16)!;
    expect(fill.rect).toEqual([0, 40, 64, 40]);
    const edges = signal.filter((d) => d.alpha === 1).map((d) => d.rect);
    expect(edges).toContainEqual([0, 40, 64, 1]); // top
    expect(edges).toContainEqual([0, 79, 64, 1]); // bottom
    expect(edges).toContainEqual([0, 40, 1, 40]); // left
    expect(edges).toContainEqual([63, 40, 1, 40]); // right
    // 10 selected bytes are 1 row; kept at least 2 rows tall
    expect(edges).toContainEqual([0, 120, 64, 2]);
  });

  it('draws small top-level regions as 2px lines over the bands, stacked in file order', () => {
    const buckets = Uint8Array.from(Array(16).fill(4));
    const regions = [
      { start: 0, end: 14, group: 0 },
      { start: 14, end: 54, group: 1 },
      { start: 54, end: 20054, group: 3 },
    ];
    const { strip } = mount({ size: 20054, overview: { size: 20054, buckets, regions } });
    expect(strip.dataset.regionMarks).toBe('2');
    const lines = draws.filter((d) => d.style === C1 || d.style === C2);
    expect(lines.map((d) => [d.style, ...d.rect])).toEqual([
      [C1, 0, 0, 64, 1],
      [C1, 0, 1, 64, 1],
      [C2, 0, 2, 64, 1],
      [C2, 0, 3, 64, 1],
    ]);
    expect(draws.some((d) => d.style === T1 && d.rect[1] === 0 && d.rect[3] === 2)).toBe(true);
  });

  it('scales to the device pixel ratio', () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    const { container } = mount({ viewport: { start: 0, end: 800 } });
    const canvas = container.querySelector('canvas')!;
    expect([canvas.width, canvas.height]).toEqual([128, 320]);
    const fill = draws.find((d) => d.alpha === 0.16)!;
    expect(fill.rect).toEqual([0, 0, 128, 160]);
    expect(draws.some((d) => d.alpha === 1 && d.style === SIGNAL && d.rect[3] === 2)).toBe(true); // 1 CSS px = 2 device px
  });

  it('a click seeks to the offset under the pointer, centred, and the ends map to the first and last byte', async () => {
    const { strip, onSeek } = mount();
    strip.dispatchEvent(ptr('pointerdown', 100 + 80)); // halfway
    expect(onSeek).toHaveBeenLastCalledWith(800, true);
    strip.dispatchEvent(ptr('pointerup', 180));
    strip.dispatchEvent(ptr('pointerdown', 100));
    expect(onSeek).toHaveBeenLastCalledWith(0, true);
    strip.dispatchEvent(ptr('pointerup', 100));
    strip.dispatchEvent(ptr('pointerdown', 100 + 160));
    expect(onSeek).toHaveBeenLastCalledWith(1599, true); // bottom edge: last byte, not past it
    strip.dispatchEvent(ptr('pointerup', 260));
    strip.dispatchEvent(ptr('pointerdown', 100 + 159.99));
    expect(onSeek).toHaveBeenLastCalledWith(1599, true);
    strip.dispatchEvent(ptr('pointerup', 260));
    strip.dispatchEvent(ptr('pointerdown', 100 + 1000)); // below
    expect(onSeek).toHaveBeenLastCalledWith(1599, true);
    strip.dispatchEvent(ptr('pointerup', 260));
    strip.dispatchEvent(ptr('pointerdown', 100 + 16)); // 0.1 of the strip: floor(160)
    expect(onSeek).toHaveBeenLastCalledWith(160, true);
  });

  it('dragging keeps seeking until the pointer is released; other buttons and empty files do nothing', () => {
    const { strip, onSeek } = mount();
    strip.dispatchEvent(ptr('pointerdown', 120));
    strip.dispatchEvent(ptr('pointermove', 140));
    strip.dispatchEvent(ptr('pointermove', 160));
    expect(onSeek.mock.calls.map((c) => c[0])).toEqual([200, 400, 600]);
    strip.dispatchEvent(ptr('pointerup', 160));
    strip.dispatchEvent(ptr('pointermove', 200));
    expect(onSeek).toHaveBeenCalledTimes(3);
    strip.dispatchEvent(ptr('pointerdown', 120, { button: 2 }));
    expect(onSeek).toHaveBeenCalledTimes(3);
    cleanup();
    const empty = mount({ size: 0 });
    empty.strip.dispatchEvent(ptr('pointerdown', 120));
    expect(empty.onSeek).not.toHaveBeenCalled();
  });

  it('shows the offset under the pointer as a tooltip while hovering', async () => {
    const { strip, container } = mount({ size: 0x10000 });
    strip.dispatchEvent(ptr('pointermove', 100 + 80));
    await vi.waitFor(() => expect(container.querySelector('.tip')?.textContent).toBe('00008000'));
    strip.dispatchEvent(new MouseEvent('pointerleave'));
    await vi.waitFor(() => expect(container.querySelector('.tip')).toBeNull());
  });

  it('PageUp/PageDown/Arrow/Home/End scroll the hex view from the top row, clamped to the file', async () => {
    const { strip, onSeek } = mount({ viewport: { start: 320, end: 640 } });
    const press = async (key: string) => {
      await fireEvent.keyDown(strip, { key });
      return onSeek.mock.calls.at(-1);
    };
    expect(await press('PageDown')).toEqual([640, false]);
    expect(await press('PageUp')).toEqual([0, false]);
    expect(await press('ArrowDown')).toEqual([336, false]);
    expect(await press('ArrowUp')).toEqual([304, false]);
    expect(await press('Home')).toEqual([0, false]);
    expect(await press('End')).toEqual([1599, false]);
    const n = onSeek.mock.calls.length;
    await press('a');
    await fireEvent.keyDown(strip, { key: 'Home', ctrlKey: true });
    expect(onSeek).toHaveBeenCalledTimes(n);
  });

  it('PageDown near the end stays inside the file', async () => {
    const { strip, onSeek } = mount({ viewport: { start: 1400, end: 1600 } });
    await fireEvent.keyDown(strip, { key: 'PageDown' });
    expect(onSeek).toHaveBeenLastCalledWith(1599, false);
  });

  it('Ctrl+wheel (browser zoom) is left alone', async () => {
    const { strip, onWheelBy } = mount();
    const ev = new WheelEvent('wheel', { deltaY: 40, ctrlKey: true, bubbles: true, cancelable: true });
    strip.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(onWheelBy).not.toHaveBeenCalled();
    const plain = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    strip.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
  });

  it('a pointer press does not call preventDefault (so the browser focuses it without a keyboard focus ring)', () => {
    const { strip } = mount();
    const ev = ptr('pointerdown', 120, { cancelable: true });
    strip.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('follows a device pixel ratio change that comes without a window resize', async () => {
    const listeners: Array<{ q: string; cb: () => void }> = [];
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: false,
      addEventListener: (_: string, cb: () => void) => listeners.push({ q, cb }),
      removeEventListener: (_: string, cb: () => void) => void listeners.splice(listeners.findIndex((l) => l.cb === cb), 1),
    }));
    try {
      const { container } = mount({ viewport: { start: 0, end: 800 } });
      const canvas = container.querySelector('canvas')!;
      expect([canvas.width, canvas.height]).toEqual([64, 160]);
      expect(listeners.some((l) => l.q === '(resolution: 1dppx)')).toBe(true);
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
      listeners.find((l) => l.q === '(resolution: 1dppx)')!.cb();
      await vi.waitFor(() => expect([canvas.width, canvas.height]).toEqual([128, 320]));
      expect(listeners.some((l) => l.q === '(resolution: 2dppx)')).toBe(true); // now watching the new ratio
      expect(listeners.some((l) => l.q === '(resolution: 1dppx)')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the wheel scrolls the hex view (pixels, lines and pages)', async () => {
    const { strip, onWheelBy } = mount();
    await fireEvent.wheel(strip, { deltaY: 53 });
    await fireEvent.wheel(strip, { deltaY: -3, deltaMode: 1 });
    await fireEvent.wheel(strip, { deltaY: 1, deltaMode: 2 });
    expect(onWheelBy.mock.calls.map((c) => c[0])).toEqual([53, -60, 160]);
  });

  it('asks for as many buckets as it has device pixels, once, and again (debounced) after a resize', async () => {
    vi.useFakeTimers();
    const { onWantBuckets } = mount();
    expect(onWantBuckets).toHaveBeenCalledTimes(1);
    expect(onWantBuckets).toHaveBeenLastCalledWith(160);
    resizeTo(300);
    resizeTo(320);
    await vi.advanceTimersByTimeAsync(149);
    expect(onWantBuckets).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(onWantBuckets).toHaveBeenCalledTimes(2);
    expect(onWantBuckets).toHaveBeenLastCalledWith(320);
  });

  it('asks for nothing while it has no height (hidden)', async () => {
    cssH = 0;
    const { onWantBuckets } = mount();
    expect(onWantBuckets).not.toHaveBeenCalled();
    expect(draws).toEqual([]);
  });
});
