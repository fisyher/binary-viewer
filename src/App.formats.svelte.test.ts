// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import App from './App.svelte';
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
});

const magic = [0xde, 0xad, 0xbe, 0xef];
const customSpec = (extra: Record<string, unknown> = {}) =>
  specText('mine', {
    name: 'Mine',
    extensions: ['mine'],
    detect: [{ at: 0, bytes: 'DE AD BE EF' }],
    types: { root: { fields: [{ name: 'sig', type: 'u4' }, { name: 'rest', type: 'u1' }] } },
    ...extra,
  });

async function mkLib(seed: Array<[string, string]> = []) {
  const lib = new SpecLibrary({ store: createMemoryStore(), builtins: builtins() });
  await lib.init();
  for (const [id, text] of seed) {
    await lib.create(id);
    await lib.save(id, text);
  }
  return lib;
}

/** The real inline client with call counters, to prove when the engine is (not) asked to re-open or re-parse. */
function counting() {
  const client = createInlineClient();
  const state = { client, opens: 0, parses: 0 };
  const open = client.open.bind(client);
  const parse = client.parse.bind(client);
  client.open = (...a) => {
    state.opens++;
    return open(...a);
  };
  client.parse = (...a) => {
    state.parses++;
    return parse(...a);
  };
  return state;
}

async function pick(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await fireEvent.change(input);
}

const rowOf = (c: HTMLElement, name: string) => ([...c.querySelectorAll('[role="treeitem"]')] as HTMLElement[]).find((r) => r.querySelector('.nm')?.textContent === name);
const panes = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.stage > .pane')];

describe('App: Viewer / Formats mode switch', () => {
  it('starts in the viewer; the formats pane is hidden and inert, and vice versa', async () => {
    const lib = await mkLib();
    const { container, getByRole } = render(App, { createClient: () => createInlineClient(), createLibrary: () => lib });
    const [viewer, formats] = panes(container);
    expect(viewer!.classList.contains('hidden')).toBe(false);
    expect(formats!.classList.contains('hidden')).toBe(true);
    expect(formats!.hasAttribute('inert')).toBe(true);
    expect((getByRole('button', { name: 'Viewer' }) as HTMLElement).getAttribute('aria-pressed')).toBe('true');
    await fireEvent.click(getByRole('button', { name: 'Formats' }));
    expect(viewer!.classList.contains('hidden')).toBe(true);
    expect(viewer!.hasAttribute('inert')).toBe(true);
    expect(formats!.classList.contains('hidden')).toBe(false);
    expect(formats!.hasAttribute('inert')).toBe(false);
  });

  it('keeps the viewer document (same DOM, selection, edits) while in Formats', async () => {
    const lib = await mkLib();
    const { container, getByRole, findByLabelText } = render(App, { createClient: () => createInlineClient(), createLibrary: () => lib });
    await pick(container, new File([Uint8Array.from([1, 2, 3, 4, 5, 6])], 'data.bin'));
    await findByLabelText('Format');
    await waitFor(() => expect(container.querySelector('.b[data-o="3"]')).not.toBeNull());
    const byte = container.querySelector('.b[data-o="3"]')!;
    await fireEvent.mouseDown(byte);
    await fireEvent.mouseUp(byte);
    await waitFor(() => expect(container.querySelector('.b.sel[data-o="3"]')).not.toBeNull());
    const hexRoot = container.querySelector('.hexcol')!;

    await fireEvent.click(getByRole('button', { name: 'Formats' }));
    await fireEvent.click(within(panes(container)[1]!).getByRole('button', { name: 'New' }));
    await fireEvent.click(within(panes(container)[1]!).getByRole('button', { name: 'Create' }));
    await findByLabelText('Spec JSON');
    await fireEvent.click(getByRole('button', { name: 'Viewer' }));

    expect(container.querySelector('.hexcol')).toBe(hexRoot);
    expect(container.querySelector('.b[data-o="3"]')).toBe(byte);
    expect(container.querySelector('.b.sel[data-o="3"]')).not.toBeNull();
    expect(container.textContent).toContain('data.bin');
  });

  it('keeps an unsaved spec draft across mode switches and warns before unloading', async () => {
    const lib = await mkLib([['draft', specText('draft')]]);
    const { container, getByRole, findByLabelText } = render(App, { createClient: () => createInlineClient(), createLibrary: () => lib });
    await fireEvent.click(getByRole('button', { name: 'Formats' }));
    await waitFor(() => expect(container.querySelector('button.entry')).not.toBeNull());
    await fireEvent.click([...container.querySelectorAll<HTMLButtonElement>('button.entry')].find((b) => b.querySelector('.id')?.textContent === 'draft')!);
    const area = (await findByLabelText('Spec JSON')) as HTMLTextAreaElement;
    await fireEvent.input(area, { target: { value: area.value.replace('Fmt draft', 'Fmt draft edited') } });
    const typed = area.value;
    await fireEvent.click(getByRole('button', { name: 'Viewer' }));
    await fireEvent.click(getByRole('button', { name: 'Formats' }));
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(typed);
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('opening a file from the Formats view switches back to the viewer', async () => {
    const lib = await mkLib();
    const { container, getByRole } = render(App, { createClient: () => createInlineClient(), createLibrary: () => lib });
    await fireEvent.click(getByRole('button', { name: 'Formats' }));
    await pick(container, new File([Uint8Array.from([1, 2])], 'a.bin'));
    await waitFor(() => expect(panes(container)[0]!.classList.contains('hidden')).toBe(false));
  });
});

describe('App: custom formats reach the engine', () => {
  it('detects with a custom spec, marks it (custom), and parses with it', async () => {
    const lib = await mkLib([['mine', customSpec()]]);
    const { container, findByLabelText } = render(App, { createClient: () => createInlineClient(), createLibrary: () => lib });
    await pick(container, new File([Uint8Array.from([...magic, 9])], 'x.bin'));
    const select = (await findByLabelText('Format')) as HTMLSelectElement;
    await waitFor(() => expect([...select.options].map((o) => o.textContent)).toContain('Mine (magic) (custom)'));
    await waitFor(() => expect(select.value).toBe('mine'));
    await waitFor(() => expect(rowOf(container, 'sig')).toBeTruthy());
  });

  it('a spec added while a file is open appears in the list but never switches or reparses the open file', async () => {
    const lib = await mkLib();
    const c = counting();
    const { container, findByLabelText } = render(App, { createClient: () => c.client, createLibrary: () => lib });
    await pick(container, new File([Uint8Array.from([...magic, 9])], 'x.bin'));
    const select = (await findByLabelText('Format')) as HTMLSelectElement;
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    await waitFor(() => expect(c.opens).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    const before = { opens: c.opens, parses: c.parses };
    expect(select.value).toBe('');
    await lib.create('mine');
    await lib.save('mine', customSpec());
    await waitFor(() => expect([...select.options].some((o) => o.value === 'mine')).toBe(true));
    expect(select.value).toBe(''); // never auto-selected because of a library change
    expect(c.opens).toBe(before.opens);
    expect(c.parses).toBe(before.parses);
    await fireEvent.change(select, { target: { value: 'mine' } });
    await waitFor(() => expect(rowOf(container, 'sig')).toBeTruthy());
  });

  it('saving an unrelated spec does not reparse or change the selected format', async () => {
    const lib = await mkLib([['mine', customSpec()], ['other', specText('other')]]);
    const c = counting();
    const { container, findByLabelText } = render(App, { createClient: () => c.client, createLibrary: () => lib });
    await pick(container, new File([Uint8Array.from([...magic, 9])], 'x.bin'));
    const select = (await findByLabelText('Format')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('mine'));
    await waitFor(() => expect(rowOf(container, 'sig')).toBeTruthy());
    await new Promise((r) => setTimeout(r, 20));
    const before = { opens: c.opens, parses: c.parses };
    await lib.save('other', specText('other', { name: 'Other renamed' }));
    await waitFor(() => expect([...select.options].some((o) => o.textContent === 'Other renamed (custom)')).toBe(true));
    expect(select.value).toBe('mine');
    expect(c.opens).toBe(before.opens);
    expect(c.parses).toBe(before.parses);
  });

  it('deleting the selected custom spec falls back to raw bytes with a notice', async () => {
    const lib = await mkLib([['mine', customSpec()]]);
    const { container, findByLabelText, findByText } = render(App, { createClient: () => createInlineClient(), createLibrary: () => lib });
    await pick(container, new File([Uint8Array.from([...magic, 9])], 'x.bin'));
    const select = (await findByLabelText('Format')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('mine'));
    await waitFor(() => expect(rowOf(container, 'sig')).toBeTruthy());
    await lib.delete('mine');
    await waitFor(() => expect(select.value).toBe(''));
    expect(await findByText('Format "Mine" was removed; showing raw bytes.')).toBeTruthy();
    expect(rowOf(container, 'sig')).toBeUndefined();
  });

  it('a library change during a save is picked up once the save finishes', async () => {
    const lib = await mkLib([['mine', customSpec()]]);
    const c = counting();
    const { container, findByLabelText, getByRole } = render(App, { createClient: () => c.client, createLibrary: () => lib });
    await pick(container, new File([Uint8Array.from([...magic, 9])], 'x.bin'));
    const select = (await findByLabelText('Format')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('mine'));
    await waitFor(() => expect(rowOf(container, 'sig')).toBeTruthy());

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const bytes = Uint8Array.from([...magic, 9]);
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async () => ({
      name: 'x.bin',
      getFile: async () => new File([bytes], 'x.bin'),
      createWritable: async () => {
        await gate; // the save is stuck here; the document is locked
        return { write: async () => {}, close: async () => {} };
      },
    });
    try {
      await fireEvent.click(getByRole('button', { name: 'Save As…' }));
      await waitFor(() => expect((getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true));
      const opensDuring = c.opens;
      await lib.save('mine', customSpec({ types: { root: { fields: [{ name: 'signature', type: 'u4' }, { name: 'rest', type: 'u1' }] } } }));
      await new Promise((r) => setTimeout(r, 30));
      expect(c.opens).toBe(opensDuring); // blocked while saving
      expect(rowOf(container, 'sig')).toBeTruthy();
      release();
      await waitFor(() => expect(rowOf(container, 'signature')).toBeTruthy());
      expect(select.value).toBe('mine');
    } finally {
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    }
  });

  it('an explicit "None (raw)" choice is respected when specs change', async () => {
    const lib = await mkLib();
    const { container, findByLabelText } = render(App, { createClient: () => createInlineClient(), createLibrary: () => lib });
    await pick(container, new File([Uint8Array.from([...magic, 9])], 'x.bin'));
    const select = (await findByLabelText('Format')) as HTMLSelectElement;
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    await fireEvent.change(select, { target: { value: '' } });
    await lib.create('mine');
    await lib.save('mine', customSpec());
    await waitFor(() => expect([...select.options].some((o) => o.value === 'mine')).toBe(true));
    expect(select.value).toBe('');
    expect(rowOf(container, 'sig')).toBeUndefined();
  });

  it('editing the selected custom spec re-parses the open file; invalidating it drops the selection', async () => {
    const lib = await mkLib([['mine', customSpec()]]);
    const { container, findByLabelText } = render(App, { createClient: () => createInlineClient(), createLibrary: () => lib });
    await pick(container, new File([Uint8Array.from([...magic, 9])], 'x.bin'));
    const select = (await findByLabelText('Format')) as HTMLSelectElement;
    await waitFor(() => expect(rowOf(container, 'sig')).toBeTruthy());

    await lib.save('mine', customSpec({ types: { root: { fields: [{ name: 'signature', type: 'u4' }] } } }));
    await waitFor(() => expect(rowOf(container, 'signature')).toBeTruthy());
    expect(select.value).toBe('mine'); // selection kept

    await lib.save('mine', '{"id":"mine"'); // now an invalid draft: excluded from the engine
    await waitFor(() => expect([...select.options].some((o) => o.value === 'mine')).toBe(false));
    expect(select.value).toBe('');
    await waitFor(() => expect(rowOf(container, 'signature')).toBeUndefined());
  });

  it('deleting a custom spec removes it from the format list', async () => {
    const lib = await mkLib([['mine', customSpec()]]);
    const { container, findByLabelText } = render(App, { createClient: () => createInlineClient(), createLibrary: () => lib });
    await pick(container, new File([Uint8Array.from([...magic, 9])], 'x.bin'));
    const select = (await findByLabelText('Format')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('mine'));
    await lib.delete('mine');
    await waitFor(() => expect([...select.options].some((o) => o.value === 'mine')).toBe(false));
  });
});
