// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import App from './App.svelte';
import * as realEngine from './core/engine';
import { le16, le32, mkSpec } from './core/engine/test-helpers';
import { loadBuiltinSpecs } from './formats';
import { createClient } from './worker/engine-client';
import { createEngineHandler } from './worker/engine-handler';
import type { EngineResponse } from './worker/protocol';
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

const rowOf = (c: HTMLElement, name: string) =>
  ([...c.querySelectorAll('[role="treeitem"]')] as HTMLElement[]).find((r) => r.querySelector('.nm')?.textContent === name);
const selectedOffsets = (c: HTMLElement, cls = '.b') =>
  [...c.querySelectorAll(`${cls}.sel`)].map((e) => Number((e as HTMLElement).dataset.o));
const nodeOffsets = (c: HTMLElement, cls = '.b') =>
  [...c.querySelectorAll(`${cls}.node`)].map((e) => Number((e as HTMLElement).dataset.o));

describe('App: format engine + structure tree', () => {
  it('detects a BMP, shows the tree, and links tree selection and hex clicks both ways', async () => {
    const { container, findByLabelText } = render(App, { createClient: () => createInlineClient() });
    await pick(container, new File([makeBmp()], 'pic.bmp'));

    // detection summary
    const select = (await findByLabelText('Format')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('bmp'));
    expect([...select.options].map((o) => o.textContent)).toEqual(['None (raw)', 'Windows Bitmap (magic + extension)', 'ZIP Archive']);

    // parse status + tree
    await waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toMatch(/^Parsed: \d+ nodes, 0 errors, 0 warnings/));
    await waitFor(() => expect(rowOf(container, 'file_header')).toBeTruthy());
    await waitFor(() => expect(rowOf(container, 'magic')).toBeTruthy());

    // tree -> hex
    await fireEvent.click(rowOf(container, 'magic')!);
    expect(selectedOffsets(container)).toEqual([0, 1]);
    expect(selectedOffsets(container, '.c')).toEqual([0, 1]);
    expect(nodeOffsets(container)).toEqual([0, 1]);
    expect(nodeOffsets(container, '.c')).toEqual([0, 1]);
    expect(container.querySelector('.at')?.textContent).toBe('@ 0x00000000'); // inspector follows

    // hex -> tree: click byte 10 (inside off_bits, bytes 10..13)
    const byte = container.querySelector('.b[data-o="10"]')!;
    await fireEvent.mouseDown(byte);
    await fireEvent.mouseUp(byte);
    await waitFor(() => expect(rowOf(container, 'off_bits')?.getAttribute('aria-selected')).toBe('true'));
    expect(selectedOffsets(container)).toEqual([10, 11, 12, 13]);
    expect(nodeOffsets(container)).toEqual([10, 11, 12, 13]);
    expect(container.querySelector('.at')?.textContent).toBe('@ 0x0000000A');
  });

  it('tints the visible bytes by top-level field using ranges from the worker', async () => {
    const { container } = render(App, { createClient: () => createInlineClient() });
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')?.getAttribute('data-t')).toBe('1')); // file_header
    expect(container.querySelector('.b[data-o="14"]')?.getAttribute('data-t')).toBe('2'); // dib
    expect(container.querySelector('.c[data-o="1"]')?.getAttribute('data-t')).toBe('1');
  });

  it('opening a second file at the same window tints it too', async () => {
    const { container } = render(App, { createClient: () => createInlineClient() });
    await pick(container, new File([makeBmp()], 'one.bmp'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')?.getAttribute('data-t')).toBe('1'));
    const other = makeBmp();
    other[0x20] = 7; // different content, same size, same window
    await pick(container, new File([other], 'two.bmp'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')?.getAttribute('data-t')).toBeNull()); // cleared on open
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')?.getAttribute('data-t')).toBe('1'));
    expect(container.querySelector('.b[data-o="14"]')?.getAttribute('data-t')).toBe('2');
  });

  it('a worker that fails before any request surfaces a message instead of hanging', async () => {
    let fail!: (m: string) => void;
    const client = createClient({
      post: () => {},
      onMessage: () => {},
      onError: (cb) => (fail = cb),
      close: () => {},
    });
    fail('Failed to load worker script');
    const { container, findByText } = render(App, { createClient: () => client });
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    await findByText(/Format engine unavailable: Failed to load worker script/);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('a worker that dies after a successful parse is reported on every later format pick and open', async () => {
    let fail!: (m: string) => void;
    let deliver!: (r: EngineResponse) => void;
    const { specs, errors } = loadBuiltinSpecs();
    const handler = createEngineHandler({ specs, specErrors: errors, post: (m) => setTimeout(() => deliver(structuredClone(m)), 0) });
    const client = createClient({
      post: (req) => void handler.handle(req.type === 'open' ? req : structuredClone(req)),
      onMessage: (cb) => (deliver = cb),
      onError: (cb) => (fail = cb),
      close: () => {},
    });
    const { container, findByText, findByLabelText } = render(App, { createClient: () => client });
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    await waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toMatch(/^Parsed/));

    fail('worker crashed');
    await findByText(/Format engine unavailable: worker crashed/);

    // (a) pick another format: no stuck "Parsing..."
    const select = (await findByLabelText('Format')) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: '' } });
    await fireEvent.change(select, { target: { value: 'bmp' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).not.toContain('Parsing');
    expect(container.textContent).toContain('Format engine unavailable: worker crashed');

    // (b) open a second file: the message is still there
    await pick(container, new File([makeBmp()], 'two.bmp'));
    await waitFor(() => expect(container.textContent).toContain('Format engine unavailable: worker crashed'));
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).not.toContain('Parsing');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('untrusted spec names and error strings are sanitized in the format bar', async () => {
    const evil = mkSpec({ root: { fields: [{ name: 'a', type: 'u1' }] } }, { id: 'evil', name: '‮Evil', extensions: ['bmp'] });
    const { container, findByText } = render(App, {
      createClient: () => createInlineClient({ specs: [evil], specErrors: ['bad‮key.json: oops'] }),
    });
    await pick(container, new File([new Uint8Array(4)], 'x.bmp'));
    await findByText(/Built-in format spec invalid: bad\\u\{202E\}key\.json/);
    const opts = [...container.querySelectorAll('option')].map((o) => o.textContent ?? '');
    expect(opts.some((t) => t.includes('\\u{202E}Evil'))).toBe(true);
    expect(opts.join('').includes('‮')).toBe(false);
    expect(container.textContent!.includes('‮')).toBe(false);
  });

  it('a drag-select does not trigger hex -> tree navigation, a plain click does', async () => {
    const { container } = render(App, { createClient: () => createInlineClient() });
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    await waitFor(() => expect(rowOf(container, 'magic')).toBeTruthy());
    const a = container.querySelector('.b[data-o="20"]')!;
    await fireEvent.mouseDown(a);
    // jsdom has no layout, so emulate the drag by moving the caret through a shift-less mousemove target
    const b = container.querySelector('.b[data-o="21"]')!;
    document.elementFromPoint = () => b;
    await fireEvent.mouseMove(window, { clientX: 1, clientY: 1 });
    await fireEvent.mouseUp(b);
    await new Promise((r) => setTimeout(r, 150));
    expect(selectedOffsets(container)).toEqual([20, 21]);
    expect(container.querySelector('[role="treeitem"][aria-selected="true"]')).toBeNull();
  });

  it('extension-only match is a suggestion and still parses; "None (raw)" clears the tree', async () => {
    const { container, findByLabelText, findByText } = render(App, { createClient: () => createInlineClient() });
    await pick(container, new File([new Uint8Array(40)], 'fake.bmp'));
    const select = (await findByLabelText('Format')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('bmp'));
    expect(select.selectedOptions[0]?.textContent).toBe('Windows Bitmap (extension)');
    await findByText(/Suggested from extension only/);
    await waitFor(() => expect(rowOf(container, 'file_header')).toBeTruthy());

    await fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(container.querySelector('[role="treeitem"]')).toBeNull());
    expect(container.querySelector('[role="status"]')).toBeNull();

    await fireEvent.change(select, { target: { value: 'bmp' } });
    await waitFor(() => expect(rowOf(container, 'file_header')).toBeTruthy());
  });

  it('shows parse errors under the tree and jumps to them', async () => {
    const bytes = makeBmp();
    const { container, findByText } = render(App, { createClient: () => createInlineClient() });
    await pick(container, new File([bytes.slice(0, 30)], 'cut.bmp')); // truncated inside the DIB header
    await waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toMatch(/[1-9]\d* errors/));
    await fireEvent.click(await findByText(/Problems/));
    const items = container.querySelectorAll('.diag .item');
    expect(items.length).toBeGreaterThan(0);
    await fireEvent.click(items[0]!);
    await waitFor(() => expect(container.querySelector('[role="treeitem"][aria-selected="true"]')).not.toBeNull());
  });

  it('Cancel aborts a slow parse and the partial result is reported as aborted', async () => {
    const engine = {
      ...realEngine,
      parse: (spec: Parameters<typeof realEngine.parse>[0], src: Parameters<typeof realEngine.parse>[1], opts: Parameters<typeof realEngine.parse>[2] = {}) =>
        new Promise<Awaited<ReturnType<typeof realEngine.parse>>>((resolve) => {
          const done = () =>
            realEngine.parse(spec, src, opts).then((r) => {
              r.stats.aborted = true;
              r.stats.truncated = true;
              resolve(r);
            });
          opts.signal?.addEventListener('abort', () => void done());
        }),
    };
    const { container, findByRole, findByText } = render(App, { createClient: () => createInlineClient({ engine }) });
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    await findByText('Parsing…');
    await fireEvent.click(await findByRole('button', { name: 'Cancel' }));
    await findByText(/^Aborted/);
  });

  it('a missing worker is a visible message and the hex view still works', async () => {
    const { container, findByText } = render(App, {
      createClient: () => {
        throw new Error('no Worker');
      },
    });
    await pick(container, new File([makeBmp()], 'pic.bmp'));
    await findByText(/Format engine unavailable: no Worker/);
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
  });
});
