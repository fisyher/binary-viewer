import { describe, expect, it, vi } from 'vitest';
import { fakeDir, type FakeFile } from '../test/fake-fs';
import { builtins, specText } from '../test/spec-fixtures';
import { FolderSync, isUserId, specFileName } from './spec-folder';
import { SpecLibrary } from './spec-library';
import { LOAD_FAILED_NOTICE, createMemoryStore, createResilientStore, type SpecStore } from './spec-store';

const T = 1_000_000_000_000;

function lib(store: SpecStore, fs: ReturnType<typeof fakeDir>) {
  let t = 100;
  return new SpecLibrary({ store, builtins: builtins(), folder: new FolderSync({ store, picker: async () => fs.dir }), now: () => ++t });
}
async function connected(files: Record<string, FakeFile> = {}, store: SpecStore = createMemoryStore()) {
  const fs = fakeDir(files);
  const l = lib(store, fs);
  await l.init();
  await l.connectFolder();
  return { l, fs, store };
}
const text = (fs: ReturnType<typeof fakeDir>, name: string) => fs.files.get(name)?.text;

describe('folder safety: files the app cannot read are never overwritten', () => {
  it('an invalid or oversized folder file survives a local spec with the same file name', async () => {
    const fs = fakeDir({
      'broken.json': { text: '{nope', lastModified: T },
      'big.json': { text: '{}', lastModified: T, size: 5_000_000 },
      'weird.json': { text: specText('other'), lastModified: T }, // a valid spec, but under another id
    });
    const store = createMemoryStore();
    const l = lib(store, fs);
    await l.init();
    for (const id of ['broken', 'big', 'weird']) await l.create(id);
    const r = await l.connectFolder();
    expect(text(fs, 'broken.json')).toBe('{nope');
    expect(fs.files.get('big.json')!.size).toBe(5_000_000);
    expect(text(fs, 'weird.json')).toBe(specText('other'));
    expect(fs.log).toEqual([]);
    expect(r!.pushed).toEqual([]);
    expect(r!.skipped.filter((s) => /not overwritten/.test(s.reason)).map((s) => s.fileName).sort()).toEqual(['big.json', 'broken.json', 'weird.json']);
    expect(r!.added).toEqual(['other']);
  });

  it('a permission error in the middle of the read aborts the sync: nothing is written, permission is marked lost', async () => {
    const fs = fakeDir({ 'a.json': { text: specText('a'), lastModified: T } });
    fs.state.readError = new DOMException('revoked', 'NotAllowedError');
    const l = lib(createMemoryStore(), fs);
    await l.init();
    await l.create('mine');
    const r = await l.connectFolder();
    expect(r).toBeNull();
    expect(fs.log).toEqual([]);
    expect(fs.state.attempts).toBe(0);
    expect(l.get('a')).toBeUndefined();
    expect(l.snapshot().folder.state).toBe('needs-permission');
    expect(l.snapshot().message).toMatch(/nothing was changed/);
  });

  it('a permission error in the push loop stops the sync at the first failure', async () => {
    const fs = fakeDir();
    fs.state.writeError = new DOMException('revoked', 'NotAllowedError');
    const l = lib(createMemoryStore(), fs);
    await l.init();
    for (const id of ['a1', 'a2', 'a3']) await l.create(id);
    await l.connectFolder();
    expect(fs.state.attempts).toBe(1);
    expect(l.snapshot().folder.state).toBe('needs-permission');
  });
});

describe('folder safety: invalid drafts never reach the folder', () => {
  it('saving an invalid draft leaves the valid file alone; sync does not replace it either', async () => {
    const { l, fs } = await connected();
    await l.create('d1');
    const valid = text(fs, 'd1.json');
    expect(valid).toContain('"id": "d1"');
    fs.log.length = 0;
    await l.save('d1', '{"id":"d1", broken');
    expect(text(fs, 'd1.json')).toBe(valid);
    expect(fs.log).toEqual([]);
    const r = await l.syncFromFolder();
    expect(text(fs, 'd1.json')).toBe(valid);
    expect(fs.log).toEqual([]);
    expect(r!.skipped.some((s) => /invalid; the folder file was kept/.test(s.reason))).toBe(true);
    expect(l.get('d1')!.valid).toBe(false);
  });

  it('a draft that never was valid is not written, on save or on sync', async () => {
    const { l, fs } = await connected();
    await l.create('x');
    await l.save('x', '{nope');
    await l.syncFromFolder();
    expect(fs.files.has('x.json')).toBe(true); // the valid version written at creation
    const { l: l2, fs: fs2 } = await connected();
    await l2.create('never');
    await l2.save('never', '{nope');
    expect(fs2.log.filter((e) => e === 'write:never.json')).toHaveLength(1); // only the initial valid template
    fs2.files.delete('never.json');
    fs2.log.length = 0;
    await l2.syncFromFolder();
    expect(fs2.log).toEqual([]);
    expect(fs2.files.has('never.json')).toBe(false);
  });
});

describe('rename ordering', () => {
  function flaky(base: SpecStore) {
    const fail = { put: new Set<string>(), remove: new Set<string>() };
    const store: SpecStore = {
      ...base,
      put: async (s) => {
        if (fail.put.has(s.id)) throw new Error('put failed');
        return base.put(s);
      },
      remove: async (id) => {
        if (fail.remove.has(id)) throw new Error('remove failed');
        return base.remove(id);
      },
    };
    return { store, base, fail };
  }

  it('does not remove the old entry from storage when storing the new one failed', async () => {
    const f = flaky(createMemoryStore());
    const l = new SpecLibrary({ store: f.store, builtins: builtins() });
    await l.init();
    await l.create('old');
    f.fail.put.add('fresh');
    await l.save('old', specText('fresh'));
    expect((await f.base.loadAll()).map((s) => s.id)).toEqual(['old']);
    expect(l.snapshot().message).toMatch(/Could not store/);
  });

  it('still stores the new entry when removing the old one fails', async () => {
    const f = flaky(createMemoryStore());
    const l = new SpecLibrary({ store: f.store, builtins: builtins() });
    await l.init();
    await l.create('old');
    f.fail.remove.add('old');
    await l.save('old', specText('fresh'));
    expect((await f.base.loadAll()).map((s) => s.id).sort()).toEqual(['fresh', 'old']);
    expect(l.snapshot().message).toMatch(/Could not remove the old entry/);
  });

  it('does not remove the old folder file when writing the new one failed', async () => {
    const { l, fs } = await connected();
    await l.create('old');
    expect(fs.files.has('old.json')).toBe(true);
    fs.state.writeError = new Error('disk full');
    await l.save('old', specText('fresh'));
    expect(fs.files.has('old.json')).toBe(true);
    expect(text(fs, 'old.json')).toContain('"id": "old"');
    expect(l.snapshot().message).toMatch(/Folder not updated/);
  });

  it('removes the old folder file after the new one was written', async () => {
    const { l, fs } = await connected();
    await l.create('old');
    await l.save('old', specText('fresh'));
    expect([...fs.files.keys()]).toEqual(['fresh.json']);
  });

  it('a rename to an invalid draft keeps the old file (nothing new could be written)', async () => {
    const { l, fs } = await connected();
    await l.create('old');
    await l.save('old', '{"id":"fresh"');
    expect(fs.files.has('old.json')).toBe(true);
  });
});

describe('files whose name differs from the id', () => {
  it('delete removes the remembered file name, not <id>.json', async () => {
    const { l, fs } = await connected({ 'my-spec.json': { text: specText('foo'), lastModified: T } });
    expect(l.get('foo')!.inFolder).toBe(true);
    await l.delete('foo');
    expect(fs.files.has('my-spec.json')).toBe(false);
    expect(fs.files.has('foo.json')).toBe(false);
    expect(fs.log).toEqual(['remove:my-spec.json']);
  });

  it('saving writes the same remembered file instead of creating <id>.json', async () => {
    const { l, fs } = await connected({ 'my-spec.json': { text: specText('foo'), lastModified: T } });
    await l.save('foo', specText('foo', { name: 'edited' }));
    expect(JSON.parse(text(fs, 'my-spec.json')!).name).toBe('edited');
    expect(fs.files.has('foo.json')).toBe(false);
  });

  it('does not delete or overwrite a file that changed in the folder since the last sync', async () => {
    const { l, fs } = await connected({ 'a.json': { text: specText('a'), lastModified: T } });
    const external = specText('a', { name: 'edited elsewhere' });
    fs.files.set('a.json', { text: external, lastModified: T + 5 });
    await l.save('a', specText('a', { name: 'edited here' }));
    expect(text(fs, 'a.json')).toBe(external);
    expect(l.snapshot().message).toMatch(/changed in the folder since the last sync/);
    await l.delete('a');
    expect(text(fs, 'a.json')).toBe(external);
  });

  it('a delete while permission is needed is remembered and applied after reconnecting', async () => {
    const store = createMemoryStore();
    const fs = fakeDir();
    const first = lib(store, fs);
    await first.init();
    await first.connectFolder();
    await first.create('p');
    await first.create('q');
    expect(fs.files.has('p.json')).toBe(true);

    fs.state.permission = 'prompt';
    const second = lib(store, fs);
    await second.init();
    expect(second.snapshot().folder.state).toBe('needs-permission');
    await second.delete('p');
    expect(fs.files.has('p.json')).toBe(true); // not touched without permission
    expect(second.snapshot().message).toMatch(/removed the next time/);

    fs.state.permission = 'granted';
    const r = await second.reconnectFolder();
    expect(fs.files.has('p.json')).toBe(false);
    expect(fs.files.has('q.json')).toBe(true);
    expect(second.get('p')).toBeUndefined(); // no resurrection from the folder
    expect(r!.added).toEqual([]);
  });

  it('a pending delete survives a reload', async () => {
    const store = createMemoryStore();
    const fs = fakeDir();
    const first = lib(store, fs);
    await first.init();
    await first.connectFolder();
    await first.create('p');
    fs.state.permission = 'prompt';
    const second = lib(store, fs);
    await second.init();
    await second.delete('p');
    fs.state.permission = 'granted';
    const third = lib(store, fs);
    await third.init(); // permission is granted again: auto sync
    expect(fs.files.has('p.json')).toBe(false);
    expect(third.get('p')).toBeUndefined();
  });

  it('a pending delete is skipped when the file changed meanwhile', async () => {
    const store = createMemoryStore();
    const fs = fakeDir();
    const first = lib(store, fs);
    await first.init();
    await first.connectFolder();
    await first.create('p');
    fs.state.permission = 'prompt';
    const second = lib(store, fs);
    await second.init();
    await second.delete('p');
    fs.files.set('p.json', { text: specText('p', { name: 'changed' }), lastModified: T });
    fs.state.permission = 'granted';
    const r = await second.reconnectFolder();
    expect(fs.files.has('p.json')).toBe(true);
    expect(r!.skipped.some((s) => /not deleted/.test(s.reason))).toBe(true);
  });
});

describe('sync races with edits', () => {
  it('a delete issued while the folder is being read leaves no ghost entry', async () => {
    const { l, fs } = await connected({ 'g.json': { text: specText('g'), lastModified: T } });
    let release!: () => void;
    fs.state.gate = new Promise<void>((r) => (release = r));
    const sync = l.syncFromFolder();
    const del = l.delete('g');
    release();
    await Promise.all([sync, del]);
    expect(l.get('g')).toBeUndefined();
    expect(fs.files.has('g.json')).toBe(false);
    await l.syncFromFolder();
    expect(l.get('g')).toBeUndefined();
  });

  it('a save issued during a sync is applied after it, not lost', async () => {
    const { l, fs } = await connected();
    await l.create('s');
    let release!: () => void;
    fs.state.gate = new Promise<void>((r) => (release = r));
    const sync = l.syncFromFolder();
    const save = l.save('s', specText('s', { name: 'during sync' }));
    release();
    await Promise.all([sync, save]);
    expect(l.get('s')!.name).toBe('during sync');
    expect(JSON.parse(text(fs, 's.json')!).name).toBe('during sync');
  });
});

describe('removed outside the app', () => {
  it('is flagged, not pushed back, and the user can keep or delete it', async () => {
    const store = createMemoryStore();
    const fs = fakeDir();
    const a = lib(store, fs);
    await a.init();
    await a.connectFolder();
    await a.create('r');
    await a.create('s');
    fs.files.delete('r.json');
    fs.files.delete('s.json');
    fs.log.length = 0;

    const reloaded = lib(store, fs); // known state comes from the store meta
    await reloaded.init();
    expect(fs.files.has('r.json')).toBe(false);
    expect(fs.log).toEqual([]);
    expect(reloaded.get('r')).toMatchObject({ removedFromFolder: true, inFolder: false });
    expect(reloaded.snapshot().message).toMatch(/removed from the folder outside the app/);
    await reloaded.syncFromFolder();
    expect(fs.files.has('r.json')).toBe(false); // still not pushed

    expect(await reloaded.keepRemoved('r')).toEqual({ ok: true, id: 'r' });
    expect(fs.files.has('r.json')).toBe(true);
    expect(reloaded.get('r')).toMatchObject({ removedFromFolder: false, inFolder: true });

    expect(await reloaded.deleteRemoved('s')).toEqual({ ok: true, id: 's' });
    expect(reloaded.get('s')).toBeUndefined();
    expect((await store.loadAll()).map((x) => x.id)).toEqual(['r']);
    expect(fs.files.has('s.json')).toBe(false);
  });

  it('a spec created locally before connecting is still pushed', async () => {
    const fs = fakeDir();
    const l = lib(createMemoryStore(), fs);
    await l.init();
    await l.create('early');
    await l.connectFolder();
    expect(fs.files.has('early.json')).toBe(true);
  });

  it('forgets what it knew when a different folder is connected', async () => {
    const store = createMemoryStore();
    const fs1 = fakeDir();
    const l = lib(store, fs1);
    await l.init();
    await l.connectFolder();
    await l.create('moved');
    const fs2 = fakeDir();
    const l2 = new SpecLibrary({ store, builtins: builtins(), folder: new FolderSync({ store, picker: async () => fs2.dir }) });
    await l2.init();
    await l2.connectFolder();
    expect(l2.get('moved')!.removedFromFolder).toBe(false);
    expect(fs2.files.has('moved.json')).toBe(true); // treated as never synced there, so pushed
  });
});

describe('both sides changed', () => {
  it('folder newer: the folder version becomes the spec, the local version is kept as a conflict copy', async () => {
    const { l, fs } = await connected();
    await l.create('c');
    fs.files.set('c.json', { text: specText('c', { name: 'folder edit' }), lastModified: T });
    await l.save('c', specText('c', { name: 'local edit' })); // refused by the folder: it changed since the last sync
    const r = await l.syncFromFolder();
    expect(r!.conflicts).toEqual([{ id: 'c', copyId: 'c-conflict-1' }]);
    expect(l.get('c')!.name).toBe('folder edit');
    expect(l.get('c-conflict-1')).toMatchObject({ valid: true, source: 'user' });
    expect(l.get('c-conflict-1')!.name).toBe('local edit (conflict copy)');
    expect(JSON.parse(text(fs, 'c.json')!).name).toBe('folder edit');
    expect(l.snapshot().message).toMatch(/1 conflict\(s\)/);
  });

  it('local newer: the local version stays and the folder version is kept as a copy before the file is replaced', async () => {
    const { l, fs } = await connected();
    await l.create('c');
    fs.files.set('c.json', { text: specText('c', { name: 'folder edit' }), lastModified: 1 });
    await l.save('c', specText('c', { name: 'local edit' }));
    const r = await l.syncFromFolder();
    expect(r!.conflicts).toHaveLength(1);
    expect(l.get('c')!.name).toBe('local edit');
    expect(l.get('c-conflict-1')!.name).toBe('folder edit (conflict copy)');
    expect(JSON.parse(text(fs, 'c.json')!).name).toBe('local edit');
    expect(l.get('c-conflict-1')!.valid).toBe(true);
  });

  it('an invalid local draft never wins over a valid folder file', async () => {
    const { l, fs } = await connected();
    await l.create('c');
    fs.files.set('c.json', { text: specText('c', { name: 'folder edit' }), lastModified: 1 });
    await l.save('c', '{"id":"c", broken');
    await l.syncFromFolder();
    expect(l.get('c')!.name).toBe('folder edit');
    expect(l.get('c-conflict-1')!.text).toContain('broken');
    expect(JSON.parse(text(fs, 'c.json')!).name).toBe('folder edit');
  });

  it('one side changed: no conflict, the changed side is taken', async () => {
    const { l, fs } = await connected();
    await l.create('c');
    fs.files.set('c.json', { text: specText('c', { name: 'folder only' }), lastModified: T });
    const r = await l.syncFromFolder();
    expect(r!.conflicts).toEqual([]);
    expect(r!.updated).toEqual(['c']);
    expect(l.get('c')!.name).toBe('folder only');
  });
});

describe('reserved names and ids', () => {
  it('rejects exact Windows device names as ids, but not names that merely contain them', async () => {
    for (const bad of ['con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9']) {
      expect(isUserId(bad), bad).toBe(false);
      expect(() => specFileName(bad)).toThrow(/unsafe/);
    }
    for (const ok of ['con-x', 'com10', 'console', 'lpt0', 'nul2', 'auxiliary']) expect(isUserId(ok), ok).toBe(true);
    const l = new SpecLibrary({ store: createMemoryStore(), builtins: builtins() });
    await l.init();
    expect(await l.create('con')).toMatchObject({ ok: false, error: expect.stringMatching(/reserved/) });
    expect(await l.create('con-x')).toMatchObject({ ok: true });
    await l.create('plain');
    expect(await l.save('plain', specText('nul'))).toMatchObject({ ok: true, valid: false });
    expect(l.get('plain')!.issues.some((i) => i.path === '$.id')).toBe(true);
    expect(await l.rename('plain', 'prn')).toMatchObject({ ok: false });
    const r = await l.importFiles([{ name: 'a.json', size: 10, text: async () => specText('aux') }]);
    expect(r.skipped[0]!.reason).toMatch(/not allowed/);
  });
});

describe('import timestamps', () => {
  it('imports use the current time as updatedAt, not the file modification time', async () => {
    const l = new SpecLibrary({ store: createMemoryStore(), builtins: builtins(), now: () => 4242 });
    await l.init();
    const file = { name: 'a.json', size: 10, lastModified: 99_999_999_999_999, text: async () => specText('imp') };
    await l.importFiles([file]);
    expect(l.get('imp')!.updatedAt).toBe(4242);
  });
});

describe('storage that cannot be loaded', () => {
  it('retries the load once before giving up', async () => {
    const mem = createMemoryStore();
    await mem.put({ id: 'kept', text: specText('kept'), updatedAt: 1 });
    let calls = 0;
    const primary: SpecStore = {
      ...mem,
      loadAll: async () => {
        if (calls++ === 0) throw new Error('transient');
        return mem.loadAll();
      },
    };
    const store = createResilientStore(primary);
    const l = new SpecLibrary({ store, builtins: builtins() });
    await l.init();
    expect(calls).toBe(2);
    expect(l.get('kept')).toBeDefined();
    expect(l.snapshot().notice).toBeNull();
  });

  it('after two failures shows the persistent notice and never writes to the unreadable store', async () => {
    const put = vi.fn(async () => {});
    const boom = async (): Promise<never> => {
      throw new Error('locked');
    };
    const primary: SpecStore = { loadAll: boom, put, remove: vi.fn(async () => {}), getMeta: boom, setMeta: boom, removeMeta: boom };
    const store = createResilientStore(primary);
    const l = new SpecLibrary({ store, builtins: builtins() });
    await l.init();
    expect(l.snapshot().notice).toBe(LOAD_FAILED_NOTICE);
    await l.create('session-only');
    expect(l.get('session-only')).toBeDefined();
    expect(put).not.toHaveBeenCalled();
    expect(l.snapshot().notice).toBe(LOAD_FAILED_NOTICE);
  });
});
