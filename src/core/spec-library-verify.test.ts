import { describe, expect, it } from 'vitest';
import { fakeDir, type FakeFile } from '../test/fake-fs';
import { builtins, specText } from '../test/spec-fixtures';
import { FolderSync, MAX_FOLDER_FILES } from './spec-folder';
import { SpecLibrary } from './spec-library';
import { createMemoryStore, type SpecStore } from './spec-store';

const T = 1_000_000_000_000;
const TRUNCATED = "Folder has more than 500 .json files and can't be verified; saves stay local. Reduce the folder or disconnect it.";

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
const never = () => new Promise<void>(() => {});
const copies = (l: SpecLibrary, prefix: string) => l.list().filter((e) => e.id.startsWith(`${prefix}-conflict-`));
async function timeOut(l: SpecLibrary, fs: ReturnType<typeof fakeDir>, id: string) {
  fs.state.holdClose = never();
  await l.create(id);
  fs.state.holdClose = null;
}
function crowd(fs: ReturnType<typeof fakeDir>) {
  for (let i = 0; i < MAX_FOLDER_FILES + 5; i++) fs.files.set(`junk${i}.json`, { text: '{}', lastModified: T });
}

describe('conflict copy dedup is exact', () => {
  it('works for 60-character ids (the copy id uses a truncated root)', async () => {
    const id = 'a'.repeat(60);
    const { l, fs } = await connected();
    await l.create(id);
    fs.files.set(`${id}.json`, { text: specText(id, { name: 'folder side' }), lastModified: T });
    for (let i = 0; i < 3; i++) {
      await timeOut(l, fs, `boom${i}`);
      await l.reconnectFolder();
    }
    const found = copies(l, id.slice(0, 50));
    expect(found).toHaveLength(1);
    expect(found[0]!.id.startsWith('a'.repeat(50) + '-conflict-')).toBe(true);
  });

  it('compares the real text: a copy edited by the user is not reused', async () => {
    const { l, fs } = await connected();
    await l.create('c');
    fs.files.set('c.json', { text: specText('c', { name: 'folder side' }), lastModified: T });
    await timeOut(l, fs, 'b1');
    await l.reconnectFolder();
    const [copy] = copies(l, 'c');
    await l.save(copy!.id, copy!.text.replace('folder side', 'folder side edited'));
    await timeOut(l, fs, 'b2');
    await l.reconnectFolder();
    expect(copies(l, 'c')).toHaveLength(2);
  });
});

describe('a folder that cannot be verified', () => {
  it('a truncated verify still adds new files and records equal ones, keeps the flag, and the message sticks', async () => {
    const store = createMemoryStore();
    const { l, fs } = await connected({}, store);
    await l.create('eq');
    await timeOut(l, fs, 'boom');
    fs.files.set('newf.json', { text: specText('newf'), lastModified: T });
    crowd(fs);
    const r = await l.reconnectFolder();
    expect(r!.truncated).toBe(true);
    expect(r!.added).toEqual(['newf']);
    expect(l.get('eq')!.inFolder).toBe(true);
    expect(await store.getMeta('folderNeedsVerify')).toBe(true);
    expect(l.snapshot().message).toBe(TRUNCATED);
    await l.create('later'); // the next save must not replace the reason
    expect(l.snapshot().message).toBe(TRUNCATED);
    expect(fs.files.has('later.json')).toBe(false);
  });

  it('connecting (or disconnecting) the folder clears the flag: the escape hatch', async () => {
    const store = createMemoryStore();
    const { l, fs } = await connected({}, store);
    await timeOut(l, fs, 'boom');
    crowd(fs);
    await l.reconnectFolder();
    expect(await store.getMeta('folderNeedsVerify')).toBe(true);
    await l.connectFolder();
    expect(await store.getMeta('folderNeedsVerify')).toBe(false);

    await timeOut(l, fs, 'boom2');
    expect(await store.getMeta('folderNeedsVerify')).toBe(true);
    await l.disconnectFolder();
    expect(await store.getMeta('folderNeedsVerify')).toBe(false);
  });

  it('a verify that could not keep a copy leaves the flag set, so the next sync verifies again', async () => {
    const mem = createMemoryStore();
    const failing = { on: true };
    const store: SpecStore = {
      ...mem,
      put: async (s) => {
        if (failing.on && s.id.includes('conflict')) throw new Error('quota');
        return mem.put(s);
      },
    };
    const { l, fs } = await connected({}, store);
    await l.create('c');
    await timeOut(l, fs, 'boom');
    fs.files.set('c.json', { text: specText('c', { name: 'folder side' }), lastModified: T });
    const first = await l.reconnectFolder();
    expect(first!.verified).toEqual({ differing: 0 });
    expect(first!.skipped.some((s) => /could not save a local copy/.test(s.reason))).toBe(true);
    expect(await store.getMeta('folderNeedsVerify')).toBe(true);
    expect(l.snapshot().message).toMatch(/verification is incomplete/);
    expect(l.snapshot().message).not.toMatch(/Folder verified/);
    await l.save('c', specText('c', { name: 'edited while blocked' }));
    expect(l.snapshot().message).toMatch(/verification is incomplete/); // the reason sticks across saves
    failing.on = false;
    const second = await l.syncFromFolder();
    expect(second!.verified).toEqual({ differing: 1 }); // still a verify sync, now complete
    expect(copies(l, 'c')).toHaveLength(1);
    expect(await store.getMeta('folderNeedsVerify')).toBe(false);
  });

  it('says "connect the folder again" when there is no connection to reconnect', async () => {
    const store = createMemoryStore();
    await store.setMeta('folderNeedsVerify', true);
    const fs = fakeDir();
    const l = lib(store, fs);
    await l.init(); // no remembered handle: state is "none"
    expect(l.snapshot().folder.state).toBe('none');
    await l.create('x');
    expect(l.snapshot().message).toBe('Folder needs verification after a folder operation timed out — connect the folder again to verify it.');
  });
});

describe('timeouts of every kind set the flag', () => {
  it('a timed-out read during sync', async () => {
    const store = createMemoryStore();
    const { l, fs } = await connected({ 'a.json': { text: specText('a'), lastModified: T } }, store);
    fs.state.hang = true;
    expect(await l.syncFromFolder()).toBeNull();
    expect(await store.getMeta('folderNeedsVerify')).toBe(true);
    expect(l.snapshot().folder.state).toBe('needs-permission');
  });

  it('a timed-out check before a write (readOne)', async () => {
    const store = createMemoryStore();
    const { l, fs } = await connected({}, store);
    fs.state.hang = true;
    await l.create('x');
    expect(await store.getMeta('folderNeedsVerify')).toBe(true);
    expect(await store.getMeta('folderKnown')).toEqual({});
  });

  it('a timed-out remove during delete keeps the pending delete from the old record', async () => {
    const store = createMemoryStore();
    const { l, fs } = await connected({}, store);
    await l.create('d');
    const hash = ((await store.getMeta('folderKnown')) as Record<string, { hash: string; fileName: string }>)['d']!;
    fs.state.hangRemove = true;
    await l.delete('d');
    fs.state.hangRemove = false;
    expect(await store.getMeta('folderNeedsVerify')).toBe(true);
    expect(await store.getMeta('folderPendingDeletes')).toEqual({ d: { fileName: 'd.json', hash: hash.hash } });
    expect(fs.files.has('d.json')).toBe(true);
    await l.reconnectFolder(); // verify: pending kept, nothing deleted, not brought back
    expect(fs.files.has('d.json')).toBe(true);
    expect(l.get('d')).toBeUndefined();
    await l.syncFromFolder(); // normal: the unchanged file is now deleted
    expect(fs.files.has('d.json')).toBe(false);
  });
});

describe('deleting while the folder awaits verification', () => {
  it('leaves a tombstone: the file is kept, not re-added, reported, and the id can be re-created', async () => {
    const store = createMemoryStore();
    const { l, fs } = await connected({}, store);
    await l.create('gone');
    await timeOut(l, fs, 'boom');
    await l.delete('gone');
    expect(await store.getMeta('folderPendingDeletes')).toEqual({ gone: { fileName: 'gone.json', hash: '' } });
    const verify = await l.reconnectFolder();
    expect(verify!.skipped.some((s) => s.fileName === 'gone.json' && /kept in folder; deleted locally — remove the file manually/.test(s.reason))).toBe(true);
    expect(l.get('gone')).toBeUndefined();
    expect(fs.files.has('gone.json')).toBe(true);
    const normal = await l.syncFromFolder();
    expect(l.get('gone')).toBeUndefined(); // still not brought back
    expect(fs.files.has('gone.json')).toBe(true); // and never deleted without content to verify
    expect(normal!.skipped.some((s) => /remove the file manually/.test(s.reason))).toBe(true);

    fs.files.delete('gone.json'); // the user removes it by hand: the tombstone disappears
    await l.syncFromFolder();
    expect(await store.getMeta('folderPendingDeletes')).toEqual({});
  });

  it('creating or importing the id again clears the tombstone', async () => {
    const store = createMemoryStore();
    const { l, fs } = await connected({}, store);
    for (const id of ['t1', 't2']) await l.create(id);
    await timeOut(l, fs, 'boom');
    await l.delete('t1');
    await l.delete('t2');
    expect(Object.keys((await store.getMeta('folderPendingDeletes')) as object).sort()).toEqual(['t1', 't2']);
    await l.create('t1');
    await l.importFiles([{ name: 't2.json', size: 10, text: async () => specText('t2') }]);
    expect(await store.getMeta('folderPendingDeletes')).toEqual({});
  });
});
