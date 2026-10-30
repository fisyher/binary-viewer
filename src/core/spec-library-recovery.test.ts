import { describe, expect, it } from 'vitest';
import { fakeDir, type FakeFile } from '../test/fake-fs';
import { builtins, specText } from '../test/spec-fixtures';
import { FolderSync, MAX_FOLDER_FILES } from './spec-folder';
import { SpecLibrary } from './spec-library';
import { createMemoryStore, type SpecStore } from './spec-store';

const T = 1_000_000_000_000;
const VERIFY_MSG = 'Folder needs verification after a folder operation timed out';

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
const copies = (l: SpecLibrary, id: string) => l.list().filter((e) => e.id.startsWith(`${id}-conflict-`));

/** Make the folder time out once: a write that never completes. Leaves the library in "needs verification". */
async function timeOut(l: SpecLibrary, fs: ReturnType<typeof fakeDir>, id: string) {
  fs.state.holdClose = never();
  await l.create(id);
  fs.state.holdClose = null;
}
function crowd(fs: ReturnType<typeof fakeDir>) {
  for (let i = 0; i < MAX_FOLDER_FILES + 5; i++) fs.files.set(`junk${i}.json`, { text: '{}', lastModified: T });
}

describe('a folder write timeout puts the whole library in verify mode', () => {
  it('persists the flag, clears what it knew about the folder, and drops the old per-id meta', async () => {
    const store = createMemoryStore();
    await store.setMeta('folderUntrusted', ['x']);
    await store.setMeta('folderSuspect', ['y']);
    const { l, fs } = await connected({}, store);
    expect(await store.getMeta('folderUntrusted')).toBeUndefined();
    expect(await store.getMeta('folderSuspect')).toBeUndefined();
    await l.create('eq');
    expect(Object.keys((await store.getMeta('folderKnown')) as object)).toEqual(['eq']);
    await timeOut(l, fs, 'boom');
    expect(await store.getMeta('folderNeedsVerify')).toBe(true);
    expect(await store.getMeta('folderKnown')).toEqual({});
    expect(l.snapshot().folder.state).toBe('needs-permission');
    // A reload remembers it.
    fs.state.permission = 'prompt';
    const again = lib(store, fs);
    await again.init();
    expect(await store.getMeta('folderNeedsVerify')).toBe(true);
  });

  it('saves stay local while flagged, whether permission is lost or the listing keeps it unverified', async () => {
    const { l, fs } = await connected();
    await timeOut(l, fs, 'boom');
    const before = fs.state.attempts;
    await l.save('boom', specText('boom', { name: 'edited' }));
    expect(l.snapshot().message).toContain(VERIFY_MSG);
    expect(l.get('boom')!.name).toBe('edited');
    expect(fs.state.attempts).toBe(before);

    crowd(fs); // a truncated listing cannot verify: the library stays flagged although connected
    const r = await l.reconnectFolder();
    expect(r!.truncated).toBe(true);
    await l.create('local-only');
    expect(l.snapshot().message).toContain("can't be verified; saves stay local");
    expect(fs.files.has('local-only.json')).toBe(false);
    expect(fs.state.attempts).toBe(before);
  });

  it('the verify sync writes and deletes nothing: differing files become copies, equal ones are recorded, new files are added', async () => {
    const store = createMemoryStore();
    const { l, fs } = await connected({}, store);
    await l.create('eq');
    await l.create('diff');
    await timeOut(l, fs, 'boom');
    fs.files.set('diff.json', { text: specText('diff', { name: 'folder side' }), lastModified: T });
    fs.files.set('newf.json', { text: specText('newf'), lastModified: T });
    await l.create('local-only'); // created while flagged: local only
    fs.log.length = 0;
    const attempts = fs.state.attempts;

    const r = await l.reconnectFolder();
    expect(fs.log).toEqual([]);
    expect(fs.state.attempts).toBe(attempts);
    expect(r!.verified).toEqual({ differing: 1 });
    expect(r!.pushed).toEqual([]);
    expect(r!.added).toEqual(['newf']);
    expect(l.snapshot().message).toBe('Folder verified after a timed-out write; 1 differing file(s) were kept as conflict copies.');
    expect(l.get('diff')!.name).toBe('New format'); // the local spec stays the spec
    const [copy] = copies(l, 'diff');
    expect(copy!.name).toBe('folder side (conflict copy)');
    expect(l.get('eq')!.inFolder).toBe(true); // equal: recorded
    expect(l.get('local-only')!.removedFromFolder).toBe(false); // known was cleared, so nothing counts as removed
    expect(l.get('boom')!.removedFromFolder).toBe(false);
    expect(await store.getMeta('folderNeedsVerify')).toBe(false);
  });

  it('the next sync is normal: local-only specs are pushed, and a differing file gets the local version (its folder version is safe in the copy)', async () => {
    const { l, fs } = await connected();
    await l.create('diff');
    await timeOut(l, fs, 'boom');
    fs.files.set('diff.json', { text: specText('diff', { name: 'folder side' }), lastModified: T });
    await l.create('local-only');
    await l.reconnectFolder(); // verify
    const r = await l.syncFromFolder();
    expect(r!.verified).toBeUndefined();
    expect([...r!.pushed].sort()).toEqual(['boom', 'diff', 'diff-conflict-1', 'local-only']);
    expect(JSON.parse(text(fs, 'diff.json')!).name).toBe('New format');
    expect(copies(l, 'diff')).toHaveLength(1);
    expect(text(fs, 'boom.json')).toContain('"id": "boom"'); // the empty leftover of the failed write was filled
  });

  it('pending deletes are kept during verification and applied by the next normal sync', async () => {
    const store = createMemoryStore();
    const fs = fakeDir();
    const first = lib(store, fs, 5000);
    await first.init();
    await first.connectFolder();
    await first.create('p');
    fs.state.permission = 'prompt';
    const second = lib(store, fs, 5000);
    await second.init();
    await second.delete('p');
    await store.setMeta('folderNeedsVerify', true);
    fs.state.permission = 'granted';
    const third = lib(store, fs, 5000);
    await third.init(); // permission granted: its first sync is the verify sync
    expect(fs.files.has('p.json')).toBe(true);
    expect(third.get('p')).toBeUndefined(); // not brought back either
    await third.syncFromFolder();
    expect(fs.files.has('p.json')).toBe(false);
  });

  it('a late write that lands before the verify sync cannot silently replace a newer local edit: both versions survive', async () => {
    const { l, fs } = await connected();
    let land!: () => void;
    fs.state.holdClose = new Promise<void>((r) => (land = r));
    fs.state.abortIgnored = true; // the browser keeps the write alive although we gave up
    await l.create('v', 'Version one'); // v1: the write times out
    fs.state.holdClose = null;
    await l.save('v', specText('v', { name: 'Version two' })); // v2: stays local
    expect(l.snapshot().message).toContain(VERIFY_MSG);
    land(); // the stale v1 lands in the folder
    await new Promise((r) => setTimeout(r, 10));
    fs.files.get('v.json')!.lastModified = T;
    expect(JSON.parse(text(fs, 'v.json')!).name).toBe('Version one');

    const r = await l.reconnectFolder(); // verify
    expect(r!.verified).toEqual({ differing: 1 });
    expect(l.get('v')!.name).toBe('Version two');
    expect(copies(l, 'v').map((c) => c.name)).toEqual(['Version one (conflict copy)']);
    expect(JSON.parse(text(fs, 'v.json')!).name).toBe('Version one'); // untouched by the verify sync
  });
});

describe('conflict copies are deduplicated', () => {
  it('repeated verify syncs against the same differing folder content create exactly one copy', async () => {
    const { l, fs } = await connected();
    await l.create('c');
    fs.files.set('c.json', { text: specText('c', { name: 'folder side' }), lastModified: T });
    for (let i = 0; i < 3; i++) {
      await timeOut(l, fs, `boom${i}`);
      const r = await l.reconnectFolder();
      expect(r!.verified!.differing).toBe(1);
    }
    expect(copies(l, 'c')).toHaveLength(1);
  });

  it('a normal conflict is not copied again by later syncs', async () => {
    const { l, fs } = await connected();
    await l.create('c');
    fs.files.set('c.json', { text: specText('c', { name: 'folder side' }), lastModified: T });
    await l.save('c', specText('c', { name: 'local side' }));
    await l.syncFromFolder();
    expect(copies(l, 'c')).toHaveLength(1);
    await l.syncFromFolder();
    await l.syncFromFolder();
    expect(copies(l, 'c')).toHaveLength(1);
  });
});

describe('a conflict copy that could not be stored leaves both sides alone', () => {
  function failingStore(): SpecStore {
    const mem = createMemoryStore();
    return {
      ...mem,
      put: async (s) => {
        if (s.id.includes('conflict')) throw new Error('quota');
        return mem.put(s);
      },
    };
  }

  for (const [label, lastModified] of [['folder newer', T], ['local newer', 1]] as const) {
    it(`${label}: the winner is not adopted or pushed, and the reason is reported`, async () => {
      const { l, fs } = await connected({}, failingStore());
      await l.create('c');
      const external = specText('c', { name: 'folder side' });
      fs.files.set('c.json', { text: external, lastModified });
      await l.save('c', specText('c', { name: 'local side' })); // refused by the folder: it changed
      const r = await l.syncFromFolder();
      expect(r!.conflicts).toEqual([]);
      expect(r!.pushed).not.toContain('c');
      expect(r!.skipped.some((s) => /could not save a local copy/.test(s.reason))).toBe(true);
      expect(text(fs, 'c.json')).toBe(external);
      expect(l.get('c')!.name).toBe('local side');
      expect(copies(l, 'c')).toEqual([]);
    });
  }
});

describe('deleting without a usable record of the folder file', () => {
  it('a file with no record is kept and the user is told to delete it by hand', async () => {
    const fs = fakeDir({ 'nr.json': { text: '{nope', lastModified: T } });
    const l = lib(createMemoryStore(), fs);
    await l.init();
    await l.create('nr');
    await l.connectFolder();
    expect(l.get('nr')!.folderBlocked).toBe('nr.json');
    await l.delete('nr');
    expect(text(fs, 'nr.json')).toBe('{nope');
    expect(l.snapshot().message).toMatch(/nr\.json was kept \(no record of it\); delete it manually/);
  });

  it('deleting while the library awaits verification keeps the file and says so', async () => {
    const { l, fs } = await connected();
    await l.create('gone');
    await timeOut(l, fs, 'boom');
    await l.delete('gone');
    expect(fs.files.has('gone.json')).toBe(true);
    expect(l.snapshot().message).toMatch(/gone\.json \(if it exists\) was kept; delete it manually/);
  });
});
