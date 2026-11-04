// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDir, type FakeFile } from '../../test/fake-fs';
import { builtins, specText } from '../../test/spec-fixtures';
import { FolderSync } from '../../core/spec-folder';
import { SpecLibrary } from '../../core/spec-library';
import { createMemoryStore } from '../../core/spec-store';
import FormatLibrary from '../../test/FormatsHarness.svelte';

const downloads: Array<{ name: string; blob: Blob }> = [];

beforeEach(() => {
  downloads.length = 0;
  const blobs = new Map<string, Blob>();
  URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
    const u = `blob:test/${blobs.size}`;
    blobs.set(u, b as Blob);
    return u;
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: blobs.get(this.href)! });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function mk(opts: { files?: Record<string, FakeFile>; folder?: 'none' | 'unsupported'; permission?: PermissionState; seed?: Array<[string, string]> } = {}) {
  const store = createMemoryStore();
  const fs = fakeDir(opts.files, { permission: opts.permission });
  const folder = new FolderSync({ store, picker: opts.folder === 'unsupported' ? undefined : async () => fs.dir });
  const lib = new SpecLibrary({ store, builtins: builtins(), folder });
  await lib.init();
  for (const [id, text] of opts.seed ?? []) {
    await lib.create(id);
    await lib.save(id, text);
  }
  const onDirtyChange = vi.fn();
  const r = render(FormatLibrary, { library: lib, onDirtyChange });
  return { lib, fs, store, onDirtyChange, ...r };
}

const entryButton = (container: HTMLElement, id: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button.entry')].find((b) => b.querySelector('.id')?.textContent === id)!;

describe('FormatLibrary', () => {
  it('groups built-in and custom specs with name, id, extensions and badges', async () => {
    const { container, getByText } = await mk({ seed: [['good', specText('good')], ['draft', '{"id":"draft"']] });
    const headings = [...container.querySelectorAll('h3')].map((h) => h.textContent);
    expect(headings).toEqual(['Built-in', 'Custom']);
    const bmp = entryButton(container, 'bmp');
    expect(bmp.textContent).toContain('Windows Bitmap');
    expect(bmp.textContent).toContain('.bmp');
    expect(bmp.textContent).toContain('built-in');
    const good = entryButton(container, 'good');
    expect(good.textContent).toContain('Fmt good');
    expect(good.textContent).toContain('.xyz');
    expect(good.querySelector('.badge.ok')!.textContent).toBe('valid');
    expect(entryButton(container, 'draft').querySelector('.badge.bad')!.textContent).toBe('invalid');
    expect(getByText('Custom')).toBeTruthy();
  });

  it('New creates a spec, selects it and opens the builder', async () => {
    const { container, getByRole, lib, findByLabelText } = await mk();
    await fireEvent.click(getByRole('button', { name: 'New' }));
    await fireEvent.click(getByRole('button', { name: 'Create' }));
    const area = (await findByLabelText('Spec JSON')) as HTMLTextAreaElement;
    expect(area.value).toContain('"id": "new-format"');
    expect(lib.get('new-format')).toBeDefined();
    expect(entryButton(container, 'new-format').classList.contains('selected')).toBe(true);
  });

  it('built-ins open read-only; Duplicate to edit makes an editable copy', async () => {
    const { container, getByRole, findByLabelText, lib } = await mk();
    await fireEvent.click(entryButton(container, 'bmp'));
    const area = (await findByLabelText('Spec JSON')) as HTMLTextAreaElement;
    expect(area.readOnly).toBe(true);
    expect((getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(getByRole('button', { name: 'Duplicate to edit' }));
    await waitFor(() => expect(lib.get('bmp-copy')).toBeDefined());
    await waitFor(() => expect((container.querySelector('textarea') as HTMLTextAreaElement).readOnly).toBe(false));
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toContain('"id": "bmp-copy"');
  });

  it('Duplicate (toolbar) copies the selected spec', async () => {
    const { container, getByRole, lib } = await mk({ seed: [['orig', specText('orig')]] });
    await fireEvent.click(entryButton(container, 'orig'));
    await fireEvent.click(getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(lib.get('orig-copy')).toBeDefined());
  });

  it('Delete asks first (in-app dialog); Cancel keeps the spec, confirm removes it', async () => {
    const { container, getByRole, lib, findByRole, queryByRole } = await mk({ seed: [['victim', specText('victim')]] });
    await fireEvent.click(entryButton(container, 'victim'));
    await fireEvent.click(getByRole('button', { name: 'Delete' }));
    const dialog = await findByRole('alertdialog');
    expect(dialog.textContent).toContain('victim');
    await fireEvent.click(getByRole('button', { name: 'Cancel' }));
    expect(queryByRole('alertdialog')).toBeNull();
    expect(lib.get('victim')).toBeDefined();
    await fireEvent.click(getByRole('button', { name: 'Delete' }));
    const confirmBtn = [...(await findByRole('alertdialog')).querySelectorAll('button')].find((b) => b.textContent === 'Delete')!;
    await fireEvent.click(confirmBtn);
    await waitFor(() => expect(lib.get('victim')).toBeUndefined());
    expect(container.textContent).toContain('Select a format');
  });

  it('Import reads the chosen files through the library caps and reports skipped ones', async () => {
    const { container, lib, findByText } = await mk();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const good = new File([specText('imp')], 'imp.json');
    const bad = new File(['nope'], 'bad.json');
    Object.defineProperty(input, 'files', { configurable: true, value: [good, bad] });
    await fireEvent.change(input);
    await waitFor(() => expect(lib.get('imp')).toBeDefined());
    expect(await findByText(/Imported 1, skipped 1 \(bad\.json: invalid JSON/)).toBeTruthy();
  });

  it('Export JSON / Markdown / HTML download <id>.<ext>; docs exports need a valid spec', async () => {
    const { container, getByRole, lib } = await mk({ seed: [['exp', specText('exp')]] });
    await fireEvent.click(entryButton(container, 'exp'));
    await fireEvent.click(getByRole('button', { name: 'Export JSON' }));
    await fireEvent.click(getByRole('button', { name: 'Export Markdown' }));
    await fireEvent.click(getByRole('button', { name: 'Export HTML' }));
    expect(downloads.map((d) => d.name)).toEqual(['exp.json', 'exp.md', 'exp.html']);
    expect(JSON.parse(await downloads[0]!.blob.text()).id).toBe('exp');
    expect(await downloads[2]!.blob.text()).toContain('Content-Security-Policy');
    await lib.save('exp', '{"id":"exp"');
    await waitFor(() => expect((getByRole('button', { name: 'Export Markdown' }) as HTMLButtonElement).disabled).toBe(true));
    expect((getByRole('button', { name: 'Export HTML' }) as HTMLButtonElement).disabled).toBe(true);
    expect((getByRole('button', { name: 'Export JSON' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Docs tab renders the generated documentation for a valid spec, and explains an invalid one', async () => {
    const { container, getByRole, lib, findByText } = await mk({ seed: [['docd', specText('docd')]] });
    await fireEvent.click(entryButton(container, 'docd'));
    await fireEvent.click(getByRole('tab', { name: 'Docs' }));
    expect(await findByText('Magic and detection')).toBeTruthy();
    expect(container.querySelector('section[data-type="root"]')).not.toBeNull();
    await fireEvent.click(getByRole('tab', { name: 'JSON' }));
    await lib.save('docd', '{"id":"docd"');
    await fireEvent.click(getByRole('tab', { name: 'Docs' }));
    expect(await findByText(/saved version is invalid; showing the last valid version/)).toBeTruthy();
    expect(container.querySelector('section[data-type="root"]')).not.toBeNull();
  });

  it('docs are available for built-in specs too', async () => {
    const { container, getByRole, findByText } = await mk();
    await fireEvent.click(entryButton(container, 'bmp'));
    await fireEvent.click(getByRole('tab', { name: 'Docs' }));
    expect(await findByText('Magic and detection')).toBeTruthy();
  });

  it('opening another spec keeps the edited one open with its text, without asking', async () => {
    const { container, queryByRole, onDirtyChange, findByLabelText } = await mk({ seed: [['one', specText('one')], ['two', specText('two')]] });
    await fireEvent.click(entryButton(container, 'one'));
    const area = (await findByLabelText('Spec JSON')) as HTMLTextAreaElement;
    await fireEvent.input(area, { target: { value: area.value.replace('Fmt one', 'Fmt one edited') } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    await fireEvent.click(entryButton(container, 'two'));
    expect(queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(entryButton(container, 'two').classList.contains('selected')).toBe(true));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false)); // the active tab is the clean one
    expect(entryButton(container, 'one').classList.contains('open')).toBe(true);
    expect(entryButton(container, 'one').querySelector('.dirty')).not.toBeNull();
    await fireEvent.click(entryButton(container, 'one'));
    expect(((await findByLabelText('Spec JSON')) as HTMLTextAreaElement).value).toContain('Fmt one edited');
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  });

  it('saving a changed id inside the JSON keeps the selection on the renamed spec', async () => {
    const { container, getByRole, lib, findByLabelText } = await mk({ seed: [['before', specText('before')]] });
    await fireEvent.click(entryButton(container, 'before'));
    const area = (await findByLabelText('Spec JSON')) as HTMLTextAreaElement;
    await fireEvent.input(area, { target: { value: specText('after') } });
    const save = getByRole('button', { name: 'Save spec' }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    await fireEvent.click(save);
    await waitFor(() => expect(lib.get('after')).toBeDefined());
    expect(lib.get('before')).toBeUndefined();
    await waitFor(() => expect(entryButton(container, 'after')?.classList.contains('selected')).toBe(true));
  });

  describe('folder', () => {
    it('says so when the browser does not support folders', async () => {
      const { container, queryByRole } = await mk({ folder: 'unsupported' });
      expect(container.querySelector('.folder-line')!.textContent).toBe('Folder: not supported in this browser — use Import/Export');
      expect(queryByRole('button', { name: /folder/i })).toBeNull();
    });

    it('Connect folder merges its specs, shows "synced" and "in folder", and Disconnect forgets it', async () => {
      const { container, getByRole, fs, lib, queryByRole } = await mk({ files: { 'ext.json': { text: specText('ext'), lastModified: 5 } } });
      expect(container.querySelector('.folder-line')!.textContent).toBe('Folder: not connected');
      await fireEvent.click(getByRole('button', { name: 'Connect folder…' }));
      await waitFor(() => expect(container.querySelector('.folder-line')!.textContent).toBe('Folder: specs (synced)'));
      await waitFor(() => expect(lib.get('ext')).toBeDefined());
      await waitFor(() => expect(entryButton(container, 'ext')).toBeDefined());
      expect(entryButton(container, 'ext').textContent).toContain('in folder');
      expect(fs.log).toEqual([]);
      await fireEvent.click(getByRole('button', { name: 'Disconnect folder' }));
      await waitFor(() => expect(container.querySelector('.folder-line')!.textContent).toBe('Folder: not connected'));
      expect(queryByRole('button', { name: 'Reconnect folder' })).toBeNull();
      expect(entryButton(container, 'ext').textContent).not.toContain('in folder');
    });

    it('shows "permission needed" with a Reconnect button that requests permission', async () => {
      const store = createMemoryStore();
      const fs = fakeDir({}, { permission: 'prompt' });
      await new FolderSync({ store, picker: async () => fs.dir }).connect();
      const lib = new SpecLibrary({ store, builtins: builtins(), folder: new FolderSync({ store, picker: async () => fs.dir }) });
      await lib.init();
      const { container, getByRole } = render(FormatLibrary, { library: lib });
      expect(container.querySelector('.folder-line')!.textContent).toBe('Folder: specs (permission needed)');
      fs.state.permission = 'granted';
      await fireEvent.click(getByRole('button', { name: 'Reconnect folder' }));
      await waitFor(() => expect(container.querySelector('.folder-line')!.textContent).toBe('Folder: specs (synced)'));
      expect(fs.state.requested).toBe(1);
    });
  });

  it('shows the storage fallback notice', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('denied');
    };
    const { createResilientStore } = await import('../../core/spec-store');
    const store = createResilientStore({ loadAll: boom, put: boom, remove: boom, getMeta: boom, setMeta: boom, removeMeta: boom });
    const lib = new SpecLibrary({ store, builtins: builtins() });
    await lib.init();
    const { container } = render(FormatLibrary, { library: lib });
    expect(container.querySelector('.notice')!.textContent).toMatch(/won't be saved/);
  });

  it('renders hostile spec names literally in the list', async () => {
    const { container } = await mk({ seed: [['evil', specText('evil', { name: '<img src=x onerror=alert(1)>' })]] });
    expect(container.querySelector('.entries img')).toBeNull();
    expect(entryButton(container, 'evil').querySelector('.name')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('FormatLibrary: unsaved edits and renames', () => {
  it('keeps unsaved text (and the dirty state) when switching to Docs and back; Docs shows the saved version with a note', async () => {
    const { container, getByRole, findByLabelText, findByText, onDirtyChange, queryByText } = await mk({ seed: [['keep', specText('keep')]] });
    await fireEvent.click(entryButton(container, 'keep'));
    const area = (await findByLabelText('Spec JSON')) as HTMLTextAreaElement;
    const edited = specText('keep', { name: 'UNSAVED NAME' });
    await fireEvent.input(area, { target: { value: edited } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    await fireEvent.click(getByRole('tab', { name: 'Docs' }));
    expect(await findByText('Magic and detection')).toBeTruthy();
    expect(container.querySelector('h2')!.textContent).toBe('Fmt keep'); // the saved version, not the draft
    expect(await findByText(/last saved version; you have unsaved changes/)).toBeTruthy();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    await fireEvent.click(getByRole('tab', { name: 'JSON' }));
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(edited);
    expect(queryByText(/Unsaved changes/)).not.toBeNull();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('saving an id change keeps the editor mounted and shows its result', async () => {
    const { container, getByRole, findByLabelText, findByText } = await mk({ seed: [['before', specText('before')]] });
    await fireEvent.click(entryButton(container, 'before'));
    const area = (await findByLabelText('Spec JSON')) as HTMLTextAreaElement;
    await fireEvent.input(area, { target: { value: specText('after') } });
    const save = getByRole('button', { name: 'Save spec' }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    await fireEvent.click(save);
    expect(await findByText('Saved.')).toBeTruthy();
    expect(container.querySelector('textarea')).toBe(area); // same element: never unmounted
  });

  it('flags a spec removed from the folder and offers Keep / Delete locally', async () => {
    const store = createMemoryStore();
    const fs = fakeDir();
    const first = new SpecLibrary({ store, builtins: builtins(), folder: new FolderSync({ store, picker: async () => fs.dir }) });
    await first.init();
    await first.connectFolder();
    await first.create('gone');
    fs.files.delete('gone.json');
    const lib = new SpecLibrary({ store, builtins: builtins(), folder: new FolderSync({ store, picker: async () => fs.dir }) });
    await lib.init();
    const { container, getByRole, findByRole, findByText } = render(FormatLibrary, { library: lib });
    expect(entryButton(container, 'gone').textContent).toContain('removed from folder');
    await fireEvent.click(entryButton(container, 'gone'));
    expect((await findByRole('alert')).textContent).toContain('Removed from folder outside the app');
    await fireEvent.click(getByRole('button', { name: 'Keep (re-write to folder)' }));
    await waitFor(() => expect(fs.files.has('gone.json')).toBe(true));
    await waitFor(() => expect(container.querySelector('.removed')).toBeNull());

    fs.files.delete('gone.json');
    await lib.syncFromFolder();
    await fireEvent.click(await findByRole('button', { name: 'Delete locally' }));
    const confirmBtn = [...(await findByRole('alertdialog')).querySelectorAll('button')].find((b) => b.textContent === 'Delete locally')!;
    await fireEvent.click(confirmBtn);
    await waitFor(() => expect(lib.get('gone')).toBeUndefined());
    expect(await findByText(/Select a format/)).toBeTruthy();
  });
});

describe('FormatLibrary: blocked folder file', () => {
  it('offers Overwrite folder file, and asks first when the old content cannot be read', async () => {
    const store = createMemoryStore();
    const fs = fakeDir();
    const lib = new SpecLibrary({ store, builtins: builtins(), folder: new FolderSync({ store, picker: async () => fs.dir }) });
    await lib.init();
    await lib.connectFolder();
    await lib.create('blk');
    fs.files.set('blk.json', { text: '{nope', lastModified: 5, failRead: true });
    await lib.syncFromFolder();
    const { container, getByRole, findByRole } = render(FormatLibrary, { library: lib });
    await fireEvent.click(entryButton(container, 'blk'));
    expect((await findByRole('alert')).textContent).toContain('blk.json');
    await fireEvent.click(getByRole('button', { name: 'Overwrite folder file' }));
    const dialog = await findByRole('alertdialog');
    expect(dialog.textContent).toContain('would not be preserved');
    expect(fs.files.get('blk.json')!.text).toBe('{nope');
    await fireEvent.click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Overwrite')!);
    await waitFor(() => expect(JSON.parse(fs.files.get('blk.json')!.text).id).toBe('blk'));
    await waitFor(() => expect(container.querySelector('.removed')).toBeNull());
  });
});
