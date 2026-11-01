// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import App from './App.svelte';
import { le16, le32 } from './core/engine/test-helpers';
import { createInlineClient } from './worker/inline-client';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** 1x1 24-bit BMP: 14-byte file header, 40-byte DIB header, 4 pixel bytes. */
function makeBmp(): Uint8Array<ArrayBuffer> {
  const dib = [...le32(40), ...le32(1), ...le32(1), ...le16(1), ...le16(24), ...le32(0), ...le32(4), ...le32(2835), ...le32(2835), ...le32(0), ...le32(0)];
  return Uint8Array.from([0x42, 0x4d, ...le32(14 + 40 + 4), ...le16(0), ...le16(0), ...le32(54), ...dib, 0xab, 0xcd, 0xef, 0]);
}

async function pick(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await fireEvent.change(input);
}

function counting() {
  const client = createInlineClient();
  const overviews: number[] = [];
  const overview = client.overview.bind(client);
  client.overview = (n) => (overviews.push(n), overview(n));
  return { client, overviews };
}

const strip = (c: HTMLElement) => c.querySelector<HTMLElement>('[role="scrollbar"][aria-label="File overview"]');
const bands = (c: HTMLElement) => Number(strip(c)?.dataset.structuredBands ?? NaN);

describe('App: structure minimap', () => {
  it('shows a strip beside the hex grid and fills it from the viewer worker after the parse', async () => {
    const v = counting();
    const p = counting();
    const { container } = render(App, { createClient: () => v.client, createPreviewClient: () => p.client });
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    await waitFor(() => expect(strip(container)).not.toBeNull());
    expect(strip(container)!.getAttribute('aria-controls')).toBe('hex-grid');
    expect(container.querySelector('#hex-grid')?.getAttribute('role')).toBe('grid');
    await waitFor(() => expect(bands(container)).toBeGreaterThan(0));
    expect(v.overviews.length).toBeGreaterThan(0);
    expect(v.overviews.every((n) => n === 400)).toBe(true); // one bucket per device pixel of the strip
    expect(strip(container)!.dataset.groups).toBe('1,2,4'); // file header, DIB header, pixel data (root child 3)
    expect(p.overviews).toEqual([]); // the preview worker is never asked
  });

  it('is blank for a file without a format, and cleared when another file replaces the parsed one', async () => {
    const { container } = render(App, { createClient: () => createInlineClient() });
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    await waitFor(() => expect(bands(container)).toBeGreaterThan(0));
    await pick(container, new File([Uint8Array.from({ length: 64 }, (_, i) => i)], 'plain.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="63"]')).not.toBeNull());
    await waitFor(() => expect(bands(container)).toBe(0));
    expect(strip(container)).not.toBeNull(); // the viewport frame still helps navigation
  });

  it('a click on the strip scrolls the hex view to that part of the file (centred, clamped at the end)', async () => {
    const { container } = render(App, { createClient: () => createInlineClient() });
    await pick(container, new File([new Uint8Array(16 * 1000)], 'plain.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    const s = strip(container)!;
    s.getBoundingClientRect = () => ({ top: 0, left: 0, right: 64, bottom: 400, width: 64, height: 400, x: 0, y: 0, toJSON() {} });
    s.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientY: 399, button: 0 }));
    s.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientY: 399 }));
    await waitFor(() => expect(container.querySelector('.b[data-o="15999"]')).not.toBeNull()); // last row shown
    expect(container.querySelector('.b[data-o="0"]')).toBeNull();
    await waitFor(() => expect(strip(container)!.getAttribute('aria-valuenow')).toBe(String(16 * 981)));
    s.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientY: 200, button: 0 })); // middle: row 500 centred
    s.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientY: 200 }));
    await waitFor(() => expect(container.querySelector('.b[data-o="8000"]')).not.toBeNull());
    expect(container.querySelector('.b[data-o="15999"]')).toBeNull();
    await waitFor(() => expect(strip(container)!.getAttribute('aria-valuenow')).toBe(String(16 * 490)));
  });

  it('the wheel over the strip scrolls the hex view', async () => {
    const { container } = render(App, { createClient: () => createInlineClient() });
    await pick(container, new File([new Uint8Array(16 * 1000)], 'plain.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    const grid = container.querySelector<HTMLElement>('#hex-grid')!;
    let st = 0;
    Object.defineProperty(grid, 'scrollTop', { configurable: true, get: () => st, set: (v: number) => (st = v) });
    await fireEvent.wheel(strip(container)!, { deltaY: 100 });
    expect(st).toBe(100);
  });

  it('keeps the bands while a re-parse after an edit has no result (the worker answers an error)', async () => {
    const client = createInlineClient();
    const real = client.overview.bind(client);
    let calls = 0;
    client.overview = (n) => (++calls === 1 ? real(n) : Promise.reject(new Error('no parse result')));
    const { container } = render(App, { createClient: () => client });
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    await waitFor(() => expect(bands(container)).toBeGreaterThan(0));
    const before = strip(container)!.dataset.structuredRows;
    const b = container.querySelector('.b[data-o="56"]')!;
    await fireEvent.mouseDown(b);
    await fireEvent.mouseUp(b);
    for (const ch of 'aa') await fireEvent.keyDown(container.querySelector('[role="grid"]')!, { key: ch });
    await waitFor(() => expect(calls).toBeGreaterThan(1)); // the re-parse finished and asked again
    expect(bands(container)).toBeGreaterThan(0);
    expect(strip(container)!.dataset.structuredRows).toBe(before);
  });

  it('the strip is hidden through the showMinimap preference', async () => {
    localStorage.setItem('binaryviewer.layout.showMinimap', '0');
    const { container } = render(App, { createClient: () => createInlineClient() });
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    await waitFor(() => expect(container.querySelector('#hex-grid')).not.toBeNull());
    expect(strip(container)).toBeNull();
  });

  it('a client without an overview answer (engine gone) leaves the strip blank without errors', async () => {
    const client = createInlineClient();
    client.overview = vi.fn(async () => {
      throw new Error('engine gone');
    });
    const { container } = render(App, { createClient: () => client });
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    await waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toMatch(/^Parsed/));
    await waitFor(() => expect(client.overview).toHaveBeenCalled());
    expect(bands(container)).toBe(0);
  });
});
