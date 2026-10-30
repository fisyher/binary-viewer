import { describe, expect, it } from 'vitest';
import { fakeDir, type FakeFile } from '../test/fake-fs';
import { builtins, specText } from '../test/spec-fixtures';
import { FolderSync, MAX_FOLDER_FILES } from './spec-folder';
import { SpecLibrary } from './spec-library';
import { createMemoryStore, type SpecStore } from './spec-store';
import { rewriteTopLevelStrings } from './spec-text';

const T = 1_000_000_000_000;

function lib(store: SpecStore, fs: ReturnType<typeof fakeDir>, timeoutMs = 30) {
  let t = 100;
  return new SpecLibrary({ store, builtins: builtins(), folder: new FolderSync({ store, picker: async () => fs.dir, timeoutMs }), now: () => ++t });
}
async function connected(files: Record<string, FakeFile> = {}, store: SpecStore = createMemoryStore()) {
  const fs = fakeDir(files);
  const l = lib(store, fs);
  await l.init();
  await l.connectFolder();
  return { l, fs, store };
}
const text = (fs: ReturnType<typeof fakeDir>, name: string) => fs.files.get(name)?.text;
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('hung cleanup never stalls the queue', () => {
  it('write hangs and abort hangs: create() still resolves and the queue continues', async () => {
    const { l, fs } = await connected();
    fs.state.hangWrite = true;
    fs.state.hangAbort = true;
    fs.state.hangRemove = true;
    const started = Date.now();
    await l.create('stuck');
    expect(Date.now() - started).toBeLessThan(1500);
    expect(l.snapshot().message).toMatch(/did not respond/);
    fs.state.hangWrite = fs.state.hangAbort = fs.state.hangRemove = false;
    await l.create('next');
    expect(l.get('next')).toBeDefined();
  });

  it('a close that hangs is handled the same way', async () => {
    const { l, fs } = await connected();
    fs.state.holdClose = new Promise<void>(() => {});
    fs.state.hangAbort = true;
    await l.create('stuck');
    fs.state.holdClose = null;
    await l.create('next');
    expect(l.get('next')).toBeDefined();
  });

  it('a non-timeout failure still cleans up, bounded, even if abort and remove hang', async () => {
    const { l, fs } = await connected();
    fs.state.writeError = new Error('disk full');
    fs.state.hangRemove = true;
    await l.create('failing');
    fs.state.writeError = null;
    fs.state.hangRemove = false;
    await l.create('after');
    expect(l.get('after')).toBeDefined();
  });
});

describe('known file truncated to nothing', () => {
  it('"Keep" re-writes it', async () => {
    const { l, fs } = await connected();
    await l.create('z');
    fs.files.set('z.json', { text: '', lastModified: T });
    await l.syncFromFolder();
    expect(l.get('z')!.removedFromFolder).toBe(true);
    expect(await l.keepRemoved('z')).toEqual({ ok: true, id: 'z' });
    expect(text(fs, 'z.json')).toContain('"id": "z"');
    expect(l.get('z')!.removedFromFolder).toBe(false);
  });
});

describe('conflict copy storage', () => {
  it('overwriteFolderFile does not write when the copy cannot be stored, unless the user agreed', async () => {
    const mem = createMemoryStore();
    const failing = { fail: false };
    const store: SpecStore = {
      ...mem,
      put: async (s) => {
        if (failing.fail && s.id.includes('conflict')) throw new Error('quota');
        return mem.put(s);
      },
    };
    const { l, fs } = await connected({}, store);
    await l.create('a');
    fs.files.set('a.json', { text: '{nope', lastModified: T });
    await l.syncFromFolder();
    failing.fail = true;
    const first = await l.overwriteFolderFile('a');
    expect(first).toMatchObject({ ok: false, needsConfirm: true });
    expect(text(fs, 'a.json')).toBe('{nope');
    expect(l.get('a-conflict-1')).toBeUndefined();
    expect(await l.overwriteFolderFile('a', true)).toEqual({ ok: true, id: 'a' });
    expect(JSON.parse(text(fs, 'a.json')!).id).toBe('a');
  });

  it('a conflict whose copy would exceed the size cap is left unresolved instead of dropping data', async () => {
    const { l, fs } = await connected();
    await l.create('big');
    fs.files.set('big.json', { text: specText('big', { name: 'folder' }), lastModified: T });
    // An invalid local draft right at the size cap: re-targeting it to the copy id would push it over.
    const head = '{"id":"big","name":"n","zz":"';
    const draft = head + 'x'.repeat(1_048_576 - head.length - 2 - 3) + '"}';
    expect(await l.save('big', draft)).toMatchObject({ ok: true, valid: false });
    const r = await l.syncFromFolder();
    expect(r!.conflicts).toEqual([]);
    expect(r!.skipped.some((s) => /too large to keep/.test(s.reason))).toBe(true);
    expect(l.get('big')!.text).toBe(draft);
    expect(l.get('big-conflict-1')).toBeUndefined();
    expect(JSON.parse(text(fs, 'big.json')!).name).toBe('folder');
  });
});

describe('stale blocked flags', () => {
  it('are cleared by delete, rename and disconnect', async () => {
    const { l, fs } = await connected();
    for (const id of ['d', 'r']) {
      await l.create(id);
      fs.files.set(`${id}.json`, { text: '{nope', lastModified: T });
    }
    await l.syncFromFolder();
    expect(l.get('d')!.folderBlocked).toBe('d.json');
    expect(l.get('r')!.folderBlocked).toBe('r.json');
    await l.rename('r', 'r2');
    expect(l.get('r2')!.folderBlocked).toBeNull();
    fs.files.delete('r.json');
    await l.create('r'); // a new spec under the old id must not inherit the old flag
    expect(l.get('r')!.folderBlocked).toBeNull();
    await l.delete('d');
    await l.create('d');
    expect(l.get('d')!.folderBlocked).toBeNull();
    await l.syncFromFolder();
    await l.disconnectFolder();
    expect(l.list().every((e) => e.folderBlocked === null)).toBe(true);
  });
});

describe('truncated listings', () => {
  function crowd(): Record<string, FakeFile> {
    const files: Record<string, FakeFile> = {};
    for (let i = 0; i < MAX_FOLDER_FILES + 5; i++) files[`junk${i}.json`] = { text: '{}', lastModified: T };
    return files;
  }

  it('keep a pending delete and its file, and say so', async () => {
    const store = createMemoryStore();
    const fs = fakeDir();
    const first = lib(store, fs, 5000);
    await first.init();
    await first.connectFolder();
    await first.create('p');
    fs.state.permission = 'prompt';
    const second = lib(store, fs, 5000);
    await second.init();
    await second.delete('p'); // pending: no permission
    for (const [k, v] of Object.entries(crowd())) fs.files.set(k, v);
    fs.state.permission = 'granted';
    const r = await second.reconnectFolder();
    expect(r!.truncated).toBe(true);
    expect(fs.files.has('p.json')).toBe(true); // not deleted from a partly read folder
    expect(second.snapshot().message).toMatch(/nothing was pushed, deleted or flagged/);
    for (const k of Object.keys(crowd())) fs.files.delete(k);
    await second.syncFromFolder();
    expect(fs.files.has('p.json')).toBe(false); // applied once the folder can be read completely
  });

  it('do not push a local change either', async () => {
    const { l, fs } = await connected();
    await l.create('c');
    // The file is unchanged, the local text changed offline of the folder: normally a push on sync.
    fs.state.permission = 'granted';
    await l.save('c', specText('c', { name: 'edited' })); // pushed right away (connected)...
    fs.files.set('c.json', { text: specText('c', { name: 'edited' }), lastModified: T });
    await l.save('c', specText('c', { name: 'edited again' }));
    expect(JSON.parse(text(fs, 'c.json')!).name).toBe('edited again');
    // Now make the next sync see a truncated listing while the file lags behind the library.
    fs.files.set('c.json', { text: specText('c', { name: 'edited' }), lastModified: T });
    for (const [k, v] of Object.entries(crowd())) fs.files.set(k, v);
    fs.log.length = 0;
    const r = await l.syncFromFolder();
    expect(r!.truncated).toBe(true);
    expect(fs.log).toEqual([]);
  });
});

describe('lone surrogates from storage', () => {
  it('are kept but flagged invalid, and never written to the folder', async () => {
    const store = createMemoryStore();
    const bad = specText('s').replace('Fmt s', 'a' + String.fromCharCode(0xd800) + 'b');
    await store.put({ id: 's', text: bad, updatedAt: 5 });
    const fs = fakeDir();
    const l = lib(store, fs);
    await l.init();
    expect(l.get('s')).toMatchObject({ valid: false, source: 'user', text: bad });
    expect(l.get('s')!.issues[0]!.message).toMatch(/unpaired surrogate/);
    await l.connectFolder();
    expect(fs.files.has('s.json')).toBe(false);
    expect(l.validUserTexts()).toEqual([]);
  });

  it('are rejected on import', async () => {
    const l = new SpecLibrary({ store: createMemoryStore(), builtins: builtins() });
    await l.init();
    const bad = specText('imp').replace('Fmt imp', 'a' + String.fromCharCode(0xdc00));
    const r = await l.importFiles([{ name: 'a.json', size: 10, text: async () => bad }]);
    expect(r.skipped[0]!.reason).toMatch(/unpaired surrogate/);
  });
});

describe('textual id rewrite edge cases', () => {
  it('finds an escaped "id" key', () => {
    const src = String.raw`{"id":"old","name":"n"}`;
    expect(rewriteTopLevelStrings(src, 'new')).toBe(String.raw`{"id":"new","name":"n"}`);
  });

  it('returns null when it cannot rewrite, and conflict copies then fall back to re-serialising', async () => {
    expect(rewriteTopLevelStrings('{"id":5,"name":"n"}', 'x')).toBeNull();
    const { l, fs } = await connected();
    await l.create('c');
    fs.files.set('c.json', { text: specText('c', { name: 'folder' }), lastModified: T });
    await l.save('c', '{"id":5,"name":"draft"}'); // an invalid local draft with a numeric id (and refused by the folder)
    await l.syncFromFolder();
    const copy = l.get('c-conflict-1')!;
    const parsed = JSON.parse(copy.text);
    expect(parsed.id).toBe('c-conflict-1');
    expect(parsed.name).toBe('draft (conflict copy)');
    expect(copy.text).toContain('\n  "id"'); // re-serialised with two-space indent
  });
});
