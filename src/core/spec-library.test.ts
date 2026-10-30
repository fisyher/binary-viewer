import { describe, expect, it } from 'vitest';
import { fakeDir, type FakeFile } from '../test/fake-fs';
import { builtins, specText } from '../test/spec-fixtures';
import { FolderSync } from './spec-folder';
import { MAX_IMPORT_FILES, SpecLibrary, declaredId, sanitizeId, type ImportFile } from './spec-library';
import { createMemoryStore, createResilientStore, type SpecStore } from './spec-store';

async function mk(opts: { store?: SpecStore; files?: Record<string, FakeFile>; permission?: PermissionState; folder?: boolean } = {}) {
  const store = opts.store ?? createMemoryStore();
  const fs = fakeDir(opts.files, { permission: opts.permission });
  const folder = opts.folder === false ? undefined : new FolderSync({ store, picker: async () => fs.dir });
  let t = 100;
  const lib = new SpecLibrary({ store, builtins: builtins(), folder, now: () => ++t });
  await lib.init();
  return { lib, store, fs, folder };
}
const file = (name: string, text: string, size = text.length): ImportFile => ({ name, size, text: async () => text });

describe('SpecLibrary basics', () => {
  it('lists built-ins first, read-only, with source "builtin"', async () => {
    const { lib } = await mk();
    const [bmp] = lib.list();
    expect(bmp).toMatchObject({ id: 'bmp', source: 'builtin', valid: true, updatedAt: null });
    expect(bmp!.extensions).toContain('bmp');
    expect(lib.get('bmp')!.spec).not.toBeNull();
  });

  it('create makes a valid user spec and persists it', async () => {
    const { lib, store } = await mk();
    const r = await lib.create();
    expect(r).toEqual({ ok: true, id: 'new-format' });
    const e = lib.get('new-format')!;
    expect(e).toMatchObject({ source: 'user', valid: true });
    expect(e.issues).toEqual([]);
    expect((await store.loadAll()).map((s) => s.id)).toEqual(['new-format']);
    await lib.create();
    await lib.create();
    expect(lib.list().filter((x) => x.source === 'user').map((x) => x.id)).toEqual(['new-format', 'new-format-2', 'new-format-3']);
  });

  it('survives a reload: a new library over the same store sees the user specs', async () => {
    const { lib, store } = await mk();
    await lib.create('mine');
    const again = new SpecLibrary({ store, builtins: builtins() });
    await again.init();
    expect(again.get('mine')).toMatchObject({ source: 'user', valid: true });
  });

  it('user ids must not collide with built-ins or each other, and must match the id pattern', async () => {
    const { lib } = await mk();
    expect(await lib.create('bmp')).toMatchObject({ ok: false, error: expect.stringMatching(/built-in/) });
    expect(await lib.create('Bad Id')).toMatchObject({ ok: false });
    expect(await lib.create('../x')).toMatchObject({ ok: false });
    await lib.create('a');
    expect(await lib.create('a')).toMatchObject({ ok: false, error: expect.stringMatching(/already used/) });
    expect(await lib.rename('a', 'bmp')).toMatchObject({ ok: false });
    await lib.create('b');
    expect(await lib.rename('a', 'b')).toMatchObject({ ok: false });
    // Changing the id inside the JSON is a rename too, and is checked the same way.
    expect(await lib.save('a', specText('bmp'))).toMatchObject({ ok: false, error: expect.stringMatching(/built-in/) });
    expect(await lib.save('a', specText('b'))).toMatchObject({ ok: false, error: expect.stringMatching(/already used/) });
    expect(lib.get('a')).toBeDefined();
  });

  it('a stored spec whose id collides with a built-in is flagged invalid; unsafe stored ids are dropped', async () => {
    const store = createMemoryStore();
    await store.put({ id: 'bmp', text: specText('bmp'), updatedAt: 1 });
    await store.put({ id: '../evil', text: specText('evil'), updatedAt: 1 });
    const lib = new SpecLibrary({ store, builtins: builtins() });
    await lib.init();
    const user = lib.list().filter((e) => e.source === 'user');
    expect(user.map((e) => e.id)).toEqual(['bmp']);
    expect(user[0]).toMatchObject({ valid: false });
    expect(lib.snapshot().message).toMatch(/Ignored 1/);
    expect(lib.validUserTexts()).toEqual([]);
  });

  it('duplicate copies a built-in or user spec under a fresh id', async () => {
    const { lib } = await mk();
    expect(await lib.duplicate('bmp')).toEqual({ ok: true, id: 'bmp-copy' });
    const e = lib.get('bmp-copy')!;
    expect(e).toMatchObject({ source: 'user', valid: true, name: 'Windows Bitmap (copy)' });
    expect(e.spec!.types).toEqual(lib.get('bmp')!.spec!.types);
    expect(await lib.duplicate('bmp')).toEqual({ ok: true, id: 'bmp-copy-2' });
    expect(await lib.duplicate('bmp-copy')).toEqual({ ok: true, id: 'bmp-copy-copy' });
    expect(await lib.duplicate('nope')).toMatchObject({ ok: false });
  });

  it('save: a valid spec is valid; an invalid one is stored as a flagged draft; broken JSON too', async () => {
    const { lib, store } = await mk();
    await lib.create('s');
    const ok = await lib.save('s', specText('s', { name: 'Renamed' }));
    expect(ok).toMatchObject({ ok: true, valid: true, id: 's' });
    expect(lib.get('s')!.name).toBe('Renamed');

    const bad = await lib.save('s', specText('s', { root: 'missing' }));
    expect(bad).toMatchObject({ ok: true, valid: false });
    expect(bad.ok && bad.issues.length).toBeGreaterThan(0);
    expect(lib.get('s')).toMatchObject({ valid: false, spec: null });
    expect(lib.get('s')!.issues[0]!.path).toMatch(/^\$/);
    expect((await store.loadAll())[0]!.text).toContain('"missing"');

    const broken = await lib.save('s', '{ "id": "s", "name": "Half", ');
    expect(broken).toMatchObject({ ok: true, valid: false });
    expect(lib.get('s')).toMatchObject({ valid: false, name: 's' });
    expect(lib.get('s')!.issues[0]!.message).toMatch(/invalid JSON/);
  });

  it('invalid drafts are excluded from the specs handed to the engine', async () => {
    const { lib } = await mk();
    await lib.create('good');
    await lib.create('draft');
    await lib.save('draft', '{"id":"draft"');
    expect(lib.validUserTexts()).toHaveLength(1);
    expect(JSON.parse(lib.validUserTexts()[0]!).id).toBe('good');
  });

  it('save refuses built-ins, unknown ids and oversized text', async () => {
    const { lib } = await mk();
    expect(await lib.save('bmp', '{}')).toMatchObject({ ok: false, error: expect.stringMatching(/read-only/) });
    expect(await lib.save('nope', '{}')).toMatchObject({ ok: false });
    await lib.create('big');
    expect(await lib.save('big', 'x'.repeat(1_048_577))).toMatchObject({ ok: false, error: expect.stringMatching(/too large/) });
  });

  it('save with a new valid id inside the text renames the entry everywhere', async () => {
    const { lib, store, fs } = await mk();
    await lib.connectFolder();
    await lib.create('old');
    expect(fs.files.has('old.json')).toBe(true);
    const r = await lib.save('old', specText('fresh'));
    expect(r).toMatchObject({ ok: true, id: 'fresh', renamedFrom: 'old' });
    expect(lib.get('old')).toBeUndefined();
    expect((await store.loadAll()).map((s) => s.id)).toEqual(['fresh']);
    expect([...fs.files.keys()]).toEqual(['fresh.json']);
  });

  it('rename updates the id inside the JSON', async () => {
    const { lib } = await mk();
    await lib.create('a');
    expect(await lib.rename('a', 'zed')).toEqual({ ok: true, id: 'zed' });
    expect(declaredId(lib.get('zed')!.text)).toBe('zed');
    expect(lib.get('zed')!.valid).toBe(true);
    await lib.save('zed', '{broken');
    expect(await lib.rename('zed', 'q')).toMatchObject({ ok: false });
    expect(await lib.rename('bmp', 'q')).toMatchObject({ ok: false });
  });

  it('delete removes user specs only', async () => {
    const { lib, store } = await mk();
    await lib.create('gone');
    expect(await lib.delete('gone')).toEqual({ ok: true, id: 'gone' });
    expect(lib.get('gone')).toBeUndefined();
    expect(await store.loadAll()).toEqual([]);
    expect(await lib.delete('bmp')).toMatchObject({ ok: false });
    expect(lib.get('bmp')).toBeDefined();
  });

  it('notifies subscribers and builds a fresh snapshot after changes', async () => {
    const { lib } = await mk();
    let n = 0;
    const off = lib.subscribe(() => n++);
    const s1 = lib.snapshot();
    await lib.create('x');
    expect(n).toBeGreaterThan(0);
    expect(lib.snapshot()).not.toBe(s1);
    expect(lib.snapshot().entries.some((e) => e.id === 'x')).toBe(true);
    off();
    const before = n;
    await lib.create('y');
    expect(n).toBe(before);
  });

  it('sanitizeId makes safe ids', () => {
    expect(sanitizeId('My Format!')).toBe('my-format-');
    expect(sanitizeId('...')).toBe('format');
    expect(sanitizeId('A'.repeat(100)).length).toBeLessThanOrEqual(56);
  });

  it('falls back to memory with a notice when storage throws', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('denied');
    };
    const store = createResilientStore({ loadAll: boom, put: boom, remove: boom, getMeta: boom, setMeta: boom, removeMeta: boom });
    const lib = new SpecLibrary({ store, builtins: builtins() });
    await lib.init();
    expect(lib.snapshot().notice).toMatch(/won't be saved/);
    await lib.create('still-works');
    expect(lib.get('still-works')).toBeDefined();
    expect((await store.loadAll()).map((s) => s.id)).toEqual(['still-works']);
  });
});

describe('import / export', () => {
  it('imports valid files, replacing an existing user spec with the same id', async () => {
    const { lib } = await mk();
    const r = await lib.importFiles([file('a.json', specText('a')), file('b.json', specText('b'))]);
    expect(r.imported).toEqual(['a', 'b']);
    const r2 = await lib.importFiles([file('a2.json', specText('a', { name: 'Newer' }))]);
    expect(r2.replaced).toEqual(['a']);
    expect(lib.get('a')!.name).toBe('Newer');
    expect(lib.snapshot().message).toMatch(/replaced 1/);
  });

  it('rejects files that are too big (without reading them), not JSON, invalid specs, or colliding with built-ins', async () => {
    const { lib } = await mk();
    let read = false;
    const huge: ImportFile = {
      name: 'huge.json',
      size: 2_000_000,
      text: async () => {
        read = true;
        return '{}';
      },
    };
    const r = await lib.importFiles([
      huge,
      file('junk.json', 'not json'),
      file('bad.json', specText('bad', { root: 'nope' })),
      file('bmp.json', specText('bmp')),
      file('upper.json', specText('Upper')),
      file('slash.json', specText('../x')),
      file('big-text.json', ' '.repeat(1_048_577), 10),
    ]);
    expect(read).toBe(false);
    expect(r.imported).toEqual([]);
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.fileName, s.reason]));
    expect(reasons['huge.json']).toMatch(/too large/);
    expect(reasons['junk.json']).toMatch(/invalid JSON/);
    expect(reasons['bad.json']).toMatch(/\$/);
    expect(reasons['bmp.json']).toMatch(/built-in/);
    expect(reasons['upper.json']).toMatch(/not allowed/);
    expect(reasons['slash.json']).toBeTruthy();
    expect(reasons['big-text.json']).toMatch(/too large/);
    expect(lib.list().filter((e) => e.source === 'user')).toEqual([]);
  });

  it('stops after MAX_IMPORT_FILES files', async () => {
    const { lib } = await mk({ folder: false });
    const files = Array.from({ length: MAX_IMPORT_FILES + 3 }, (_, i) => file(`f${i}.json`, specText(`f${i}`)));
    const r = await lib.importFiles(files);
    expect(r.imported).toHaveLength(MAX_IMPORT_FILES);
    expect(r.skipped.at(-1)!.reason).toMatch(/more than/);
  }, 30_000);

  it('exports spec JSON as a Blob (built-in and user) and generated docs for valid specs only', async () => {
    const { lib } = await mk();
    await lib.create('doc');
    const blob = lib.export('doc')!;
    expect(blob.type).toBe('application/json');
    expect(JSON.parse(await blob.text()).id).toBe('doc');
    expect(JSON.parse(await lib.export('bmp')!.text()).id).toBe('bmp');
    expect(lib.export('nope')).toBeNull();
    const md = lib.exportDoc('doc', 'md')!;
    expect(md.fileName).toBe('doc.md');
    expect(await md.blob.text()).toMatch(/^# New format/);
    const html = lib.exportDoc('doc', 'html')!;
    expect(html.fileName).toBe('doc.html');
    expect(await html.blob.text()).toContain('Content-Security-Policy');
    await lib.save('doc', '{');
    expect(lib.exportDoc('doc', 'md')).toBeNull();
  });
});

describe('folder sync', () => {
  const T = 1_000_000_000_000;

  it('connect reads specs, skips bad files with reasons, ignores built-in ids and non-spec files', async () => {
    const { lib, fs } = await mk({
      files: {
        'good.json': { text: specText('good'), lastModified: T },
        'broken.json': { text: '{nope', lastModified: T },
        'invalid.json': { text: specText('inv', { root: 'x' }), lastModified: T },
        'bmp.json': { text: specText('bmp'), lastModified: T },
        'huge.json': { text: '{}', lastModified: T, size: 5_000_000 },
        'readme.txt': { text: 'x', lastModified: T },
      },
    });
    const report = await lib.connectFolder();
    expect(report!.added).toEqual(['good']);
    const skipped = Object.fromEntries(report!.skipped.map((s) => [s.fileName, s.reason]));
    expect(Object.keys(skipped).sort()).toEqual(['bmp.json', 'broken.json', 'huge.json', 'invalid.json']);
    expect(skipped['bmp.json']).toMatch(/built-in/);
    expect(skipped['huge.json']).toMatch(/too large/);
    expect(lib.get('good')).toMatchObject({ valid: true, inFolder: true, updatedAt: T });
    expect(lib.snapshot().folder).toEqual({ supported: true, state: 'connected', name: 'specs' });
    expect(lib.snapshot().message).toMatch(/synced: 1 added/);
    expect(fs.log).toEqual([]); // nothing to push
  });

  it('save writes <id>.json and delete removes it', async () => {
    const { lib, fs } = await mk();
    await lib.connectFolder();
    await lib.create('doc1');
    expect(fs.files.get('doc1.json')!.text).toContain('"id": "doc1"');
    expect(lib.get('doc1')!.inFolder).toBe(true);
    await lib.save('doc1', specText('doc1', { name: 'Edited' }));
    expect(JSON.parse(fs.files.get('doc1.json')!.text).name).toBe('Edited');
    await lib.delete('doc1');
    expect(fs.files.has('doc1.json')).toBe(false);
    expect(fs.log).toEqual(['write:doc1.json', 'write:doc1.json', 'remove:doc1.json']);
  });

  it('does not touch the folder while permission is needed; reconnect syncs', async () => {
    const store = createMemoryStore();
    const fs = fakeDir({}, { permission: 'prompt' });
    await new FolderSync({ store, picker: async () => fs.dir }).connect();
    const lib = new SpecLibrary({ store, builtins: builtins(), folder: new FolderSync({ store, picker: async () => fs.dir }) });
    await lib.init();
    expect(lib.snapshot().folder.state).toBe('needs-permission');
    await lib.create('local-only');
    expect(fs.log).toEqual([]);
    expect(lib.get('local-only')!.inFolder).toBe(false);
    expect(await lib.syncFromFolder()).toBeNull();
    fs.state.permission = 'granted';
    const r = await lib.reconnectFolder();
    expect(lib.snapshot().folder.state).toBe('connected');
    expect(r!.pushed).toEqual(['local-only']);
    expect(fs.files.has('local-only.json')).toBe(true);
  });

  it('init syncs automatically when permission is still granted', async () => {
    const store = createMemoryStore();
    const fs = fakeDir({ 'auto.json': { text: specText('auto'), lastModified: T } });
    await new FolderSync({ store, picker: async () => fs.dir }).connect();
    const lib = new SpecLibrary({ store, builtins: builtins(), folder: new FolderSync({ store, picker: async () => fs.dir }) });
    await lib.init();
    expect(lib.get('auto')).toMatchObject({ source: 'user', inFolder: true });
  });

  it('reports write failures instead of throwing, and marks lost permission', async () => {
    const { lib, fs } = await mk();
    await lib.connectFolder();
    fs.state.writeError = new DOMException('no', 'NotAllowedError');
    await lib.create('w');
    expect(lib.get('w')).toBeDefined(); // still saved locally
    expect(lib.snapshot().message).toMatch(/Folder not updated/);
    expect(lib.snapshot().folder.state).toBe('needs-permission');
  });

  it('disconnect keeps the specs but stops syncing', async () => {
    const { lib, fs } = await mk();
    await lib.connectFolder();
    await lib.create('keep');
    await lib.disconnectFolder();
    expect(lib.snapshot().folder.state).toBe('none');
    expect(lib.get('keep')!.inFolder).toBe(false);
    fs.log.length = 0;
    await lib.save('keep', specText('keep', { name: 'x' }));
    expect(fs.log).toEqual([]);
  });

  it('reports unsupported browsers', async () => {
    const store = createMemoryStore();
    const lib = new SpecLibrary({ store, builtins: builtins(), folder: new FolderSync({ store }) });
    await lib.init();
    expect(lib.snapshot().folder).toEqual({ supported: false, state: 'unsupported', name: null });
    expect(await lib.connectFolder()).toBeNull();
  });
});
