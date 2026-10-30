// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import App from './App.svelte';
import { le16, le32 } from './core/engine/test-helpers';
import { buildZip, extraBlock } from './test/zip-builder';
import { createInlineClient } from './worker/inline-client';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 3000 });
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

async function pick(container: HTMLElement, bytes: Uint8Array<ArrayBuffer>, name: string) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([bytes], name)] });
  await fireEvent.change(input);
}

const rowOf = (c: HTMLElement, name: string) => ([...c.querySelectorAll('[role="treeitem"]')] as HTMLElement[]).find((r) => r.querySelector('.nm')?.textContent === name);
const selected = (c: HTMLElement) => [...c.querySelectorAll('.b.sel')].map((e) => Number((e as HTMLElement).dataset.o));
const highlighted = (c: HTMLElement) => [...c.querySelectorAll('.b.node')].map((e) => Number((e as HTMLElement).dataset.o));
const range = (start: number, len: number) => Array.from({ length: len }, (_, i) => start + i);
const status = (c: HTMLElement) => c.querySelector('footer.status')?.textContent ?? '';

/** BMP with `pixelBytes` of pixel data starting at `offBits` (BITMAPINFOHEADER, 24 bpp, 1 x 1; size_image says how long the pixels are). */
function makeBmp(pixelBytes: number, offBits = 54): Uint8Array<ArrayBuffer> {
  const dib = [...le32(40), ...le32(1), ...le32(1), ...le16(1), ...le16(24), ...le32(0), ...le32(pixelBytes), ...le32(2835), ...le32(2835), ...le32(0), ...le32(0)];
  const out = new Uint8Array(offBits + pixelBytes);
  out.set([0x42, 0x4d, ...le32(out.length), ...le16(0), ...le16(0), ...le32(offBits), ...dib]);
  for (let i = offBits; i < out.length; i += 1024) out[i] = 0xab;
  return out;
}

async function openBmp(container: HTMLElement, bytes: Uint8Array<ArrayBuffer>) {
  await pick(container, bytes, 'pic.bmp');
  await waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toMatch(/^Parsed: \d+ nodes/));
  await waitFor(() => expect(rowOf(container, 'off_bits')).toBeTruthy());
}

describe('App: tree selection reaches the hex view', () => {
  it('a multi-megabyte node selects its whole range, highlights only what is rendered, and scrolls there', async () => {
    const { container } = render(App, { createClient: () => createInlineClient() });
    const pixels = 3_000_000;
    await openBmp(container, makeBmp(pixels));
    await waitFor(() => expect(rowOf(container, 'pixels')).toBeTruthy());
    await fireEvent.click(rowOf(container, 'pixels')!);
    expect(status(container)).toContain(`Start: 0x36 (54)`);
    expect(status(container)).toContain(`End: 0x2DC6F5 (${54 + pixels - 1})`);
    expect(status(container)).toContain(`Length: 0x2DC6C0 (${pixels})`);
    // only the rendered window carries the highlight, and it starts at the node
    const sel = selected(container);
    expect(sel[0]).toBe(54);
    expect(sel.length).toBeGreaterThan(0);
    expect(sel.length).toBeLessThan(4000);
    expect(highlighted(container)).toEqual(sel);
  });

  it('a node far beyond the visible area is scrolled into view', async () => {
    const { container } = render(App, { createClient: () => createInlineClient() });
    const total = 3_000_000;
    await openBmp(container, makeBmp(16, total));
    // off_bits' link goes to the pixel data at 3,000,000: selection is made even though the bytes are far away
    await fireEvent.click(rowOf(container, 'off_bits')!.querySelector('button[data-link]')!);
    expect(status(container)).toContain(`Start: 0x2DC6C0 (${total})`);
    await waitFor(() => expect(selected(container)).toEqual(range(total, 16)));
    expect(container.querySelector('.b[data-o="0"]')).toBeNull(); // the view is no longer at the top
  });
});

describe('App: BMP links', () => {
  it('off_bits link selects the pixel data and highlights it', async () => {
    const { container } = render(App, { createClient: () => createInlineClient() });
    const bytes = makeBmp(40);
    await openBmp(container, bytes);
    const btn = rowOf(container, 'off_bits')!.querySelector('button[data-link]') as HTMLButtonElement;
    expect(btn.textContent).toBe('→ pixel data');
    await fireEvent.click(btn);
    expect(selected(container)).toEqual(range(54, 40));
    expect(highlighted(container)).toEqual(range(54, 40));
    expect(status(container)).toContain('Length: 0x28 (40)');
    expect(rowOf(container, 'off_bits')!.getAttribute('aria-selected')).toBe('false'); // the link does not select the row
    expect(container.querySelector('.at')?.textContent).toBe('@ 0x00000036'); // the inspector follows
  });
});

describe('App: ZIP jumps and links', () => {
  const entries = [
    { name: 'first.txt', data: 'hello' },
    { name: 'second.txt', data: 'a longer second payload', localExtra: extraBlock(0xcafe, [1, 2, 3, 4]) },
  ];

  async function openZip(container: HTMLElement) {
    const built = buildZip(entries);
    await pick(container, built.bytes, 'a.zip');
    await waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toMatch(/^Parsed: \d+ nodes, 0 errors, 0 warnings/));
    await waitFor(() => expect(rowOf(container, 'central_directory')).toBeTruthy());
    await fireEvent.dblClick(rowOf(container, 'entries')!);
    await fireEvent.dblClick(rowOf(container, 'entries[1]')!);
    await waitFor(() => expect(rowOf(container, 'local_header')).toBeTruthy());
    return built;
  }
  const jump = (c: HTMLElement, label: string) =>
    [...rowOf(c, 'local_header')!.querySelectorAll('button[data-jump]')].find((b) => b.textContent === label) as HTMLButtonElement;

  it('"data" on an unopened entry opens it and selects exactly the compressed data (lfh + 30 + name + extra, comp size bytes)', async () => {
    const { container } = render(App, { createClient: () => createInlineClient() });
    const { layout } = await openZip(container);
    const e = layout.entries[1]!;
    expect(e.data).toBe(e.lfh + 30 + 'second.txt'.length + 8); // the 4-byte extra body gets a 4-byte block header
    expect(rowOf(container, 'local_header')!.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(jump(container, 'data'));
    await waitFor(() => expect(selected(container)).toEqual(range(e.data, e.dataLen)));
    expect(highlighted(container)).toEqual(range(e.data, e.dataLen));
    expect(status(container)).toContain(`Start: 0x${e.data.toString(16).toUpperCase()} (${e.data})`);
    expect(status(container)).toContain(`Length: 0x${e.dataLen.toString(16).toUpperCase()} (${e.dataLen})`);
    await waitFor(() => expect(rowOf(container, 'data')?.getAttribute('aria-selected')).toBe('true'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('"local header" on an opened entry selects the header; "descriptor" without flag bit 3 reports it is not present', async () => {
    const { container } = render(App, { createClient: () => createInlineClient() });
    const { layout } = await openZip(container);
    const e = layout.entries[1]!;
    await fireEvent.click(jump(container, 'data'));
    await waitFor(() => expect(selected(container).length).toBe(e.dataLen));
    await fireEvent.click(jump(container, 'local header'));
    const headerLen = 30 + 'second.txt'.length + 8;
    await waitFor(() => expect(selected(container)).toEqual(range(e.lfh, headerLen)));
    await fireEvent.click(jump(container, 'descriptor'));
    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/"descriptor" is not available/));
  });

  it('the lho_eff link selects the 30 fixed local header bytes; the eocd cd_offset link selects the whole central directory', async () => {
    const { container } = render(App, { createClient: () => createInlineClient() });
    const { layout } = await openZip(container);
    const e = layout.entries[1]!;
    await fireEvent.click(rowOf(container, 'lho_eff')!.querySelector('button[data-link]')!);
    expect(selected(container)).toEqual(range(e.lfh, 30));
    await fireEvent.click(rowOf(container, 'cd_offset')!.querySelector('button[data-link]')!);
    expect(status(container)).toContain(`Start: 0x${layout.cd.toString(16).toUpperCase()} (${layout.cd})`);
    expect(status(container)).toContain(`Length: 0x${layout.cdSize.toString(16).toUpperCase()} (${layout.cdSize})`);
    expect(selected(container)[0]).toBe(layout.cd);
  });
});
