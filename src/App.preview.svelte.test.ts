// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import App from './App.svelte';
import type { SaveHandle } from './core/save';
import { SpecLibrary } from './core/spec-library';
import { createMemoryStore } from './core/spec-store';
import { builtins, specText } from './test/spec-fixtures';
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
  delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
  vi.restoreAllMocks();
});

const T = { timeout: 4000 };
const mine = specText('mine', {
  name: 'Mine',
  detect: [{ at: 0, bytes: 'DE AD BE EF' }],
  types: { root: { fields: [{ name: 'sig', type: 'u4' }, { name: 'rest', type: 'u1' }] } },
});
const other = specText('other', { name: 'Other', types: { root: { fields: [{ name: 'zzz', type: 'u4' }] } } });
const file = () => new File([Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 9, 8, 7, 6])], 'x.bin');

async function mkLib(seed: Array<[string, string]> = []) {
  const lib = new SpecLibrary({ store: createMemoryStore(), builtins: builtins() });
  await lib.init();
  for (const [id, text] of seed) {
    await lib.create(id);
    await lib.save(id, text);
  }
  return lib;
}

function counting() {
  const client = createInlineClient();
  const calls = { drafts: [] as string[], parses: [] as Array<string | null> };
  const parseDraft = client.parseDraft.bind(client);
  const parse = client.parse.bind(client);
  client.parseDraft = (t) => (calls.drafts.push(t), parseDraft(t));
  client.parse = (id) => (calls.parses.push(id), parse(id));
  return { client, calls };
}

async function pick(container: HTMLElement, f: File) {
  const input = container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [f] });
  await fireEvent.change(input);
}

const panels = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.panels > .panel')];
// The viewer's structure tree lives in the side bar's Structure view.
const viewerTree = (c: HTMLElement) => c.querySelector<HTMLElement>('.views > .view')!;
const fileTab = (c: HTMLElement) => c.querySelector<HTMLElement>('#editor-tab-file')!;
const formatList = (c: HTMLElement) => c.querySelector<HTMLElement>('section[aria-label="Format library"]')!;
const names = (root: Element) => [...root.querySelectorAll('[role="treeitem"] .nm')].map((e) => e.textContent);
const preview = (c: HTMLElement) => c.querySelector('section[aria-label="Preview on open file"]') as HTMLElement | null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(seed: Array<[string, string]> = [['mine', mine], ['other', other]]) {
  const lib = await mkLib(seed);
  const c = counting();
  const r = render(App, { createClient: () => c.client, createLibrary: () => lib });
  await pick(r.container, file());
  const select = (await r.findByLabelText('Format')) as HTMLSelectElement;
  if (seed.length > 0) {
    await waitFor(() => expect(select.value).toBe('mine'), T);
    await waitFor(() => expect(names(viewerTree(r.container))).toContain('sig'), T);
  }
  const toFormats = async (id: string, tab?: string) => {
    await fireEvent.click(r.getByRole('button', { name: 'Formats' }));
    const entry = [...r.container.querySelectorAll<HTMLButtonElement>('button.entry')].find((b) => b.querySelector('.id')?.textContent === id)!;
    await fireEvent.click(entry);
    if (tab) await fireEvent.click(r.getByRole('tab', { name: tab }));
  };
  const json = () => r.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Spec JSON"]')!;
  return { ...r, lib, ...c, select, toFormats, json };
}

describe('Preview on open file', () => {
  it('parses the draft against the open document after a debounce, and coalesces rapid edits', async () => {
    const { container, toFormats, calls, json } = await setup();
    await toFormats('other');
    expect(preview(container)).not.toBeNull();
    expect(calls.drafts).toHaveLength(0); // debounced
    await waitFor(() => expect(names(preview(container)!)).toContain('zzz'), T);
    expect(calls.drafts).toHaveLength(1);
    for (const name of ['a1', 'a2', 'a3']) await fireEvent.input(json(), { target: { value: specText('other', { types: { root: { fields: [{ name, type: 'u4' }] } } }) } });
    await sleep(100);
    expect(calls.drafts).toHaveLength(1);
    await waitFor(() => expect(names(preview(container)!)).toContain('a3'), T);
    expect(calls.drafts).toHaveLength(2);
  });

  it('the side-bar tree is inert while a draft preview owns the worker, and live again on the file tab', async () => {
    const { container, toFormats, calls } = await setup();
    const wrap = () => container.querySelector('.tree-wrap')!;
    expect(wrap().hasAttribute('inert')).toBe(false);
    await toFormats('other');
    await waitFor(() => expect(calls.drafts).toHaveLength(1), T);
    await waitFor(() => expect(wrap().hasAttribute('inert')).toBe(true), T);
    expect(container.querySelector('.views .quiet')!.textContent).toContain('Paused while a format preview is running');
    await fireEvent.click(fileTab(container));
    await waitFor(() => expect(wrap().hasAttribute('inert')).toBe(false), T);
    expect(container.querySelector('.views .quiet')).toBeNull();
  });

  it('shows validation errors for an invalid draft and makes no parseDraft call', async () => {
    const { container, toFormats, calls, json } = await setup();
    await toFormats('other');
    await waitFor(() => expect(calls.drafts).toHaveLength(1), T);
    await fireEvent.input(json(), { target: { value: specText('other', { types: { root: { fields: [{ name: 'a', type: 'u4', size: 3 }] } } }) } });
    await waitFor(() => expect(within(preview(container)!).getByRole('alert').textContent).toContain('fixed size'), T);
    await fireEvent.input(json(), { target: { value: '{ nope' } });
    await waitFor(() => expect(within(preview(container)!).getByRole('alert').textContent).toContain('Syntax error'), T);
    await sleep(700);
    expect(calls.drafts).toHaveLength(1);
  });

  it('the toggle turns the preview off and hides the pane without a document', async () => {
    const { container, toFormats, calls } = await setup();
    await toFormats('other');
    const box = within(preview(container)!).getByLabelText('Preview on open file') as HTMLInputElement;
    expect(box.checked).toBe(true);
    await fireEvent.click(box);
    await sleep(700);
    expect(calls.drafts).toHaveLength(0);
    expect(preview(container)!.textContent).toContain('Preview is off');
    cleanup();
    const lib = await mkLib([['other', other]]);
    const r = render(App, { createClient: () => createInlineClient(), createLibrary: () => lib });
    await fireEvent.click(r.getByRole('button', { name: 'Formats' }));
    expect(preview(r.container)).toBeNull();
  });

  it('Show in viewer selects and highlights the node range and leaves the viewer on its own format', async () => {
    const { container, toFormats, select } = await setup();
    await toFormats('other');
    await waitFor(() => expect(names(preview(container)!)).toContain('zzz'), T);
    const row = [...preview(container)!.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((r) => r.querySelector('.nm')?.textContent === 'zzz')!;
    await fireEvent.click(row);
    await fireEvent.click(within(preview(container)!).getByRole('button', { name: 'Show in viewer' }));
    expect(panels(container)[0]!.classList.contains('hidden')).toBe(false);
    await waitFor(() => {
      for (const o of [0, 1, 2, 3]) expect(container.querySelector(`.b.sel[data-o="${o}"]`)).not.toBeNull();
    }, T);
    expect(container.querySelector('.b.sel[data-o="4"]')).toBeNull();
    // The viewer still names and shows its own format, never the draft's tree.
    expect(select.value).toBe('mine');
    await waitFor(() => expect(names(viewerTree(container))).toContain('sig'), T);
    expect(names(viewerTree(container))).not.toContain('zzz');
  });

  it('a link button in the preview tree sets the preview selection, and Show in viewer selects those bytes', async () => {
    const linked = specText('other', { name: 'Other', types: { root: { fields: [{ name: 'zzz', type: 'u4', link: { at: '4', size: '2', label: 'tail' } }] } } });
    const { container, toFormats, getByRole } = await setup([['mine', mine], ['other', linked]]);
    await toFormats('other');
    await waitFor(() => expect(names(preview(container)!)).toContain('zzz'), T);
    await fireEvent.click(preview(container)!.querySelector('button[data-link]')!);
    expect(preview(container)!.querySelector('.selinfo')?.textContent).toContain('offset 0x4 (4)');
    await fireEvent.click(within(preview(container)!).getByRole('button', { name: 'Show in viewer' }));
    await waitFor(() => {
      for (const o of [4, 5]) expect(container.querySelector(`.b.sel[data-o="${o}"]`)).not.toBeNull();
    }, T);
    expect(container.querySelector('.b.sel[data-o="6"]')).toBeNull();
    expect(container.querySelector('.b.sel[data-o="3"]')).toBeNull();
    expect(fileTab(container).getAttribute('aria-selected')).toBe('true');
  });

  it('switching back to the Viewer re-parses the viewer format: FormatBar and tree agree', async () => {
    const { container, toFormats, select, calls, getByRole } = await setup();
    await toFormats('other');
    await waitFor(() => expect(names(preview(container)!)).toContain('zzz'), T);
    const parsesBefore = calls.parses.length;
    await fireEvent.click(fileTab(container));
    await waitFor(() => expect(calls.parses.length).toBe(parsesBefore + 1), T);
    expect(calls.parses[calls.parses.length - 1]).toBe('mine');
    await waitFor(() => expect(names(viewerTree(container))).toContain('rest'), T);
    expect(names(viewerTree(container))).not.toContain('zzz');
    expect(select.value).toBe('mine');
    // Without a preview in between there is nothing to restore.
    const n = calls.parses.length;
    await fireEvent.click(getByRole('button', { name: 'Formats' }));
    await fireEvent.click(fileTab(container));
    await sleep(50);
    expect(calls.parses.length).toBe(n);
  });

  it('a viewer tree expand after the round trip is served from the viewer parse, not the draft', async () => {
    const { container, toFormats, getByRole } = await setup();
    await toFormats('other');
    await waitFor(() => expect(names(preview(container)!)).toContain('zzz'), T);
    await fireEvent.click(fileTab(container));
    await waitFor(() => expect(names(viewerTree(container))).toEqual(expect.arrayContaining(['sig', 'rest'])), T);
    const row = [...viewerTree(container).querySelectorAll<HTMLElement>('[role="treeitem"]')].find((r) => r.querySelector('.nm')?.textContent === 'rest')!;
    await fireEvent.click(row);
    await waitFor(() => expect(container.querySelector('.b.sel[data-o="4"]')).not.toBeNull(), T);
  });

  it('never parses a draft while a save is in progress, then previews once it finished', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let data = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 9, 8, 7, 6]);
    const handle: SaveHandle = {
      name: 'x.bin',
      getFile: async () => new File([data], 'x.bin'),
      createWritable: async () => {
        const parts: Uint8Array[] = [];
        return {
          async write(chunk) {
            parts.push(chunk instanceof Blob ? new Uint8Array(await chunk.arrayBuffer()) : chunk);
          },
          async close() {
            await gate;
            data = Uint8Array.from(parts.flatMap((p) => [...p]));
          },
          async abort() {},
        };
      },
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
    };
    (window as unknown as Record<string, unknown>).showSaveFilePicker = async () => handle;
    const { container, toFormats, calls, getByRole } = await setup();
    // edit a byte so there is something to save
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    const b0 = container.querySelector('.b[data-o="5"]')!;
    await fireEvent.mouseDown(b0);
    await fireEvent.mouseUp(b0);
    for (const ch of 'aa') await fireEvent.keyDown(grid, { key: ch });
    await fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save')!);
    await waitFor(() => expect(container.querySelector('[aria-label="Modified"]')).not.toBeNull(), T);
    await toFormats('other');
    await sleep(800);
    expect(calls.drafts).toHaveLength(0);
    expect(preview(container)!.textContent).toContain('Waiting for the save');
    release();
    await waitFor(() => expect(names(preview(container)!)).toContain('zzz'), T);
    expect(calls.drafts.length).toBeGreaterThan(0);
  });
});

describe('New format flow', () => {
  it('creates a format from the starter, previews a new field live, saves it and detects it on the next open', async () => {
    const { container, getByRole, getByLabelText, findByLabelText } = await setup([]);
    await fireEvent.click(getByRole('button', { name: 'Formats' }));
    await fireEvent.click(within(formatList(container)).getByRole('button', { name: 'New' }));
    await fireEvent.input(getByLabelText('New format id'), { target: { value: 'cafe' } });
    await fireEvent.input(getByLabelText('New format name'), { target: { value: 'Cafe' } });
    await fireEvent.input(getByLabelText('New format magic'), { target: { value: 'CA FE' } });
    await fireEvent.input(getByLabelText('New format extension'), { target: { value: 'caf' } });
    await fireEvent.click(getByRole('button', { name: 'Create' }));
    // opens the Builder tab, with the magic field from the starter
    expect(((await findByLabelText('Name of field 1')) as HTMLInputElement).value).toBe('magic');
    expect(getByRole('tab', { name: 'Builder' }).getAttribute('aria-selected')).toBe('true');
    await fireEvent.click(getByRole('button', { name: /^Integer/ }));
    const wiz = within(getByRole('form', { name: 'Integer parameters' }));
    await fireEvent.input(wiz.getByLabelText(/^Field name/), { target: { value: 'value' } });
    await fireEvent.click(wiz.getByRole('button', { name: 'Insert' }));
    // live preview on the open document (DE AD BE EF 09 ... does not start with the magic, but the field is shown)
    await waitFor(() => expect(names(preview(container)!)).toContain('value'), T);
    await fireEvent.click(within(container.querySelector('.builder') as HTMLElement).getByRole('button', { name: 'Save spec' }));
    await waitFor(() => expect(container.querySelector('.builder .result')?.textContent).toBe('Saved.'), T);

    // Open a file with the magic: the viewer detects the new format.
    await fireEvent.click(fileTab(container));
    await pick(container, new File([Uint8Array.from([0xca, 0xfe, 1, 2, 3, 4])], 'y.caf'));
    const select = (await findByLabelText('Format')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('cafe'), T);
    await waitFor(() => expect(names(viewerTree(container))).toEqual(expect.arrayContaining(['magic', 'value'])), T);
  });

  it('refuses a bad starter without creating anything', async () => {
    const { container, getByRole, getByLabelText, lib } = await setup([]);
    await fireEvent.click(getByRole('button', { name: 'Formats' }));
    await fireEvent.click(within(formatList(container)).getByRole('button', { name: 'New' }));
    await fireEvent.input(getByLabelText('New format id'), { target: { value: 'ok-id' } });
    await fireEvent.input(getByLabelText('New format magic'), { target: { value: 'zz' } });
    await fireEvent.click(getByRole('button', { name: 'Create' }));
    expect(within(container.querySelector('form[aria-label="New format"]') as HTMLElement).getByRole('alert').textContent).toContain('hex');
    expect(lib.get('ok-id')).toBeUndefined();
  });
});

function gatedHandle() {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let data = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 9, 8, 7, 6]);
  const handle: SaveHandle = {
    name: 'x.bin',
    getFile: async () => new File([data], 'x.bin'),
    createWritable: async () => {
      const parts: Uint8Array[] = [];
      return {
        async write(chunk) {
          parts.push(chunk instanceof Blob ? new Uint8Array(await chunk.arrayBuffer()) : chunk);
        },
        async close() {
          await gate;
          data = Uint8Array.from(parts.flatMap((p) => [...p]));
        },
        async abort() {},
      };
    },
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
  };
  return { handle, release: () => release() };
}

async function editByte(container: HTMLElement, offset: number, hex: string) {
  const grid = container.querySelector('[role="grid"]') as HTMLElement;
  const b = container.querySelector(`.b[data-o="${offset}"]`)!;
  await fireEvent.mouseDown(b);
  await fireEvent.mouseUp(b);
  for (const ch of hex) await fireEvent.keyDown(grid, { key: ch });
}

describe('Preview: races and stale state', () => {
  it('a worker error that arrives after a save started is dropped and the stale tree is cleared', async () => {
    const g = gatedHandle();
    (window as unknown as Record<string, unknown>).showSaveFilePicker = async () => g.handle;
    const { container, toFormats, client, json } = await setup();
    await editByte(container, 5, 'aa');
    await waitFor(() => expect(container.querySelector('[aria-label="Modified"]')).not.toBeNull(), T);
    await toFormats('other');
    await waitFor(() => expect(names(preview(container)!)).toContain('zzz'), T);
    const row = [...preview(container)!.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((r) => r.querySelector('.nm')?.textContent === 'zzz')!;
    await fireEvent.click(row);
    expect(within(preview(container)!).queryByRole('button', { name: 'Show in viewer' })).not.toBeNull();

    let fail: (e: Error) => void = () => {};
    client.parseDraft = () => new Promise((_, rej) => (fail = rej));
    await fireEvent.input(json(), { target: { value: specText('other', { name: 'Other 2', types: { root: { fields: [{ name: 'yyy', type: 'u4' }] } } }) } });
    await sleep(700); // the debounced draft parse is now in flight
    await fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save')!);
    await waitFor(() => expect(preview(container)!.textContent).toContain('Waiting for the save'), T);
    fail(new Error('boom from worker'));
    await sleep(50);
    expect(preview(container)!.textContent).not.toContain('boom');
    expect(preview(container)!.querySelector('[role="treeitem"]')).toBeNull(); // stale tree dropped
    expect(within(preview(container)!).queryByRole('button', { name: 'Show in viewer' })).toBeNull();
    g.release();
  });

  it('a viewer edit whose debounced reparse lands while the preview is open ends with both views right', async () => {
    const { container, toFormats, calls, select, getByRole } = await setup();
    const parsesBefore = calls.parses.length;
    await editByte(container, 5, 'aa');
    await toFormats('other'); // the 300 ms reparse is still pending
    await waitFor(() => expect(calls.parses.length).toBeGreaterThan(parsesBefore), T);
    await waitFor(() => expect(names(preview(container)!)).toContain('zzz'), T);
    await waitFor(() => expect(calls.drafts.length).toBeGreaterThan(0), T);
    await fireEvent.click(fileTab(container));
    await waitFor(() => expect(names(viewerTree(container))).toEqual(expect.arrayContaining(['sig', 'rest'])), T);
    expect(names(viewerTree(container))).not.toContain('zzz');
    expect(select.value).toBe('mine');
    expect(container.querySelector('.b[data-o="5"]')!.textContent!.toLowerCase()).toBe('aa');
  });

  it('viewer tree loads, locate and diagnostic jumps never reach the worker while a draft owns its slot', async () => {
    const big = specText('mine', {
      name: 'Mine',
      detect: [{ at: 0, bytes: 'DE AD BE EF' }],
      types: { root: { fields: [{ name: 'sig', type: 'u4', expect: 1 }, { name: 'arr', type: 'u1', repeat: { count: 3000 } }] } },
    });
    const lib = await mkLib([['mine', big], ['other', other]]);
    const c = counting();
    const counts = { expand: 0, nodeAt: 0, nodeById: 0, ranges: 0 };
    for (const k of Object.keys(counts) as Array<keyof typeof counts>) {
      const orig = (c.client[k] as (...a: never[]) => Promise<unknown>).bind(c.client);
      (c.client as unknown as Record<string, unknown>)[k] = (...a: never[]) => (counts[k]++, orig(...a));
    }
    const r = render(App, { createClient: () => c.client, createLibrary: () => lib });
    await pick(r.container, new File([Uint8Array.from([0xde, 0xad, 0xbe, 0xef, ...new Array<number>(3000).fill(1)])], 'big.bin'));
    await waitFor(() => expect(names(viewerTree(r.container))).toContain('arr'), T);
    await fireEvent.click(r.getByRole('button', { name: 'Formats' }));
    const entry = [...r.container.querySelectorAll<HTMLButtonElement>('button.entry')].find((b) => b.querySelector('.id')?.textContent === 'other')!;
    await fireEvent.click(entry);
    await waitFor(() => expect(names(preview(r.container)!)).toContain('zzz'), T);
    const before = { ...counts };

    const viewer = viewerTree(r.container);
    const filePanel = panels(r.container)[0]!;
    const byte = r.container.querySelector('.b[data-o="1"]')!;
    await fireEvent.mouseDown(byte); // locate
    await fireEvent.mouseUp(byte);
    const arrRow = [...viewer.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((x) => x.querySelector('.nm')?.textContent === 'arr')!;
    await fireEvent.click(arrRow.querySelector('[data-twisty]')!); // loadPage
    const item = filePanel.querySelector<HTMLButtonElement>('.diag .item'); // the Problems panel is always open
    if (item) await fireEvent.click(item); // jumpToDiagnostic
    await sleep(300);
    expect(counts).toEqual(before);
  });
});
