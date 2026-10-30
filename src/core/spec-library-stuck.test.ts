import { describe, expect, it } from 'vitest';
import { fakeDir, type FakeFile } from '../test/fake-fs';
import { builtins, specText } from '../test/spec-fixtures';
import { FolderSync, MAX_FOLDER_FILES, hasLoneSurrogate } from './spec-folder';
import { SpecLibrary } from './spec-library';
import { createMemoryStore, type SpecStore } from './spec-store';
import { checkSpecText, rewriteTopLevelStrings } from './spec-text';

const T = 1_000_000_000_000;

function lib(store: SpecStore, fs: ReturnType<typeof fakeDir>, timeoutMs?: number) {
  let t = 100;
  return new SpecLibrary({ store, builtins: builtins(), folder: new FolderSync({ store, picker: async () => fs.dir, timeoutMs }), now: () => ++t });
}
async function connected(files: Record<string, FakeFile> = {}, timeoutMs?: number) {
  const store = createMemoryStore();
  const fs = fakeDir(files);
  const l = lib(store, fs, timeoutMs);
  await l.init();
  await l.connectFolder();
  return { l, fs, store };
}
const text = (fs: ReturnType<typeof fakeDir>, name: string) => fs.files.get(name)?.text;

describe('a failed first write leaves nothing stuck', () => {
  it('removes the file it created, so the next save can write it', async () => {
    const { l, fs } = await connected();
    fs.state.writeError = new Error('disk full');
    await l.create('first');
    expect(fs.files.has('first.json')).toBe(false); // no leftover empty file
    expect(l.snapshot().message).toMatch(/Folder not updated/);
    fs.state.writeError = null;
    await l.save('first', specText('first', { name: 'second try' }));
    expect(JSON.parse(text(fs, 'first.json')!).name).toBe('second try');
    expect(l.get('first')!.inFolder).toBe(true);
  });

  it('does not delete a file that already existed when the write fails', async () => {
    const { l, fs } = await connected();
    await l.create('keepme');
    const before = text(fs, 'keepme.json');
    fs.state.writeError = new Error('disk full');
    await l.save('keepme', specText('keepme', { name: 'changed' }));
    expect(text(fs, 'keepme.json')).toBe(before);
  });

  it('an empty file of unknown origin holds no data and is filled, not treated as a blocker', async () => {
    const fs = fakeDir({ 'e.json': { text: '', lastModified: T } });
    const l = lib(createMemoryStore(), fs);
    await l.init();
    await l.create('e');
    const r = await l.connectFolder();
    expect(r!.skipped).toEqual([]);
    expect(r!.pushed).toEqual(['e']);
    expect(text(fs, 'e.json')).toContain('"id": "e"');
  });
});

describe('a known folder file that stopped being a valid spec', () => {
  async function broken(content: string, extra: Partial<FakeFile> = {}) {
    const c = await connected();
    await c.l.create('a');
    c.fs.files.set('a.json', { text: content, lastModified: T, ...extra });
    const r = await c.l.syncFromFolder();
    return { ...c, r: r! };
  }

  it('says what to do, flags the entry, and does not touch the file', async () => {
    const { l, fs, r } = await broken('{nope');
    expect(text(fs, 'a.json')).toBe('{nope');
    expect(r.skipped).toHaveLength(1); // one entry per file, with both the cause and the hint
    expect(r.skipped[0]!.reason).toMatch(/invalid JSON.*fix or remove it in the folder, or use "Overwrite folder file"/);
    expect(l.get('a')!.folderBlocked).toBe('a.json');
    expect(l.get('a')!.removedFromFolder).toBe(false);
  });

  it('Overwrite folder file saves the old content as a conflict copy first, then writes', async () => {
    const { l, fs } = await broken('{nope');
    expect(await l.overwriteFolderFile('a')).toEqual({ ok: true, id: 'a' });
    expect(JSON.parse(text(fs, 'a.json')!).id).toBe('a');
    expect(l.get('a-conflict-1')!.text).toBe('{nope');
    expect(l.get('a')!.folderBlocked).toBeNull();
    expect(l.get('a')!.inFolder).toBe(true);
    const again = await l.syncFromFolder();
    expect(again!.skipped).toEqual([]);
  });

  it('a file that now declares another id blocks the same way', async () => {
    const { l, fs } = await broken(specText('other'));
    expect(l.get('a')!.folderBlocked).toBe('a.json');
    expect(l.get('other')).toBeDefined(); // it is also a perfectly good spec under its own id
    await l.overwriteFolderFile('a');
    expect(JSON.parse(text(fs, 'a.json')!).id).toBe('a');
    expect(l.get('a-conflict-1')!.text).toContain('"id": "a-conflict-1"');
  });

  it('an unreadable file is only replaced after the user agreed to lose its contents', async () => {
    const { l, fs } = await broken('{nope', { failRead: true });
    const first = await l.overwriteFolderFile('a');
    expect(first).toMatchObject({ ok: false, needsConfirm: true, error: expect.stringMatching(/not be preserved/) });
    expect(text(fs, 'a.json')).toBe('{nope');
    expect(await l.overwriteFolderFile('a', true)).toEqual({ ok: true, id: 'a' });
    expect(l.get('a-conflict-1')).toBeUndefined(); // the unreadable content could not be kept
    expect(JSON.parse(text(fs, 'a.json')!).id).toBe('a');
  });

  it('refuses when nothing blocks, or the spec is an invalid draft', async () => {
    const { l } = await connected();
    await l.create('fine');
    expect(await l.overwriteFolderFile('fine')).toMatchObject({ ok: false });
    expect(await l.overwriteFolderFile('nope')).toMatchObject({ ok: false });
  });
});

describe('folders with more than 500 files', () => {
  it('pushes nothing and flags nothing, and says so', async () => {
    const fs = fakeDir();
    const store = createMemoryStore();
    const l = lib(store, fs);
    await l.init();
    await l.connectFolder();
    await l.create('known1');
    fs.files.delete('known1.json');
    for (let i = 0; i < MAX_FOLDER_FILES + 5; i++) fs.files.set(`junk${i}.json`, { text: '{}', lastModified: T });
    await l.create('fresh'); // refused by nothing: written at creation, before the folder grew... but known1's file is gone
    fs.log.length = 0;
    const r = await l.syncFromFolder();
    expect(r!.truncated).toBe(true);
    expect(r!.removedOutside).toEqual([]);
    expect(r!.pushed).toEqual([]);
    expect(l.get('known1')!.removedFromFolder).toBe(false);
    expect(fs.log).toEqual([]);
    expect(l.snapshot().message).toMatch(/more than 500 \.json files; only the first 500 were read/);
  });

  it('does not push a never-synced spec into a partly read folder', async () => {
    const files: Record<string, FakeFile> = {};
    for (let i = 0; i < MAX_FOLDER_FILES + 5; i++) files[`junk${i}.json`] = { text: '{}', lastModified: T };
    const fs = fakeDir(files);
    const l = lib(createMemoryStore(), fs);
    await l.init();
    await l.create('only');
    const r = await l.connectFolder();
    expect(r!.truncated).toBe(true);
    expect(fs.files.has('only.json')).toBe(false);
  });
});

describe('the old folder file after a rename that could not be written', () => {
  it('is removed at the next sync instead of coming back as a duplicate', async () => {
    const { l, fs } = await connected();
    await l.create('old');
    await l.save('old', '{"id":"renamed", broken'); // not valid: nothing can be written for the new id
    expect(l.get('old')).toBeDefined(); // invalid id in text is not a rename; same entry
    await l.save('old', specText('renamed')); // now a real rename, valid
    expect(fs.files.has('renamed.json')).toBe(true);
    expect(fs.files.has('old.json')).toBe(false);

    await l.create('src');
    fs.state.writeError = new Error('disk full');
    await l.save('src', specText('moved'));
    expect(fs.files.has('src.json')).toBe(true); // kept for now
    expect(l.snapshot().message).toMatch(/removed at the next sync/);
    fs.state.writeError = null;
    const r = await l.syncFromFolder();
    expect(fs.files.has('src.json')).toBe(false); // gone: no duplicate "src"
    expect(l.get('src')).toBeUndefined();
    expect(l.get('moved')).toBeDefined();
    expect(fs.files.has('moved.json')).toBe(true);
    expect(r!.added).toEqual([]);
  });
});

describe('lone surrogates', () => {
  it('are rejected on save and flagged by the live check', async () => {
    const bad = specText('s').replace('Fmt s', 'x' + String.fromCharCode(0xd800) + 'y'); // JSON.stringify would escape it
    expect(hasLoneSurrogate(bad)).toBe(true);
    expect(hasLoneSurrogate('ok \u{1F600} fine')).toBe(false);
    expect(checkSpecText(bad).issues[0]!.message).toMatch(/unpaired surrogate/);
    const l = new SpecLibrary({ store: createMemoryStore(), builtins: builtins() });
    await l.init();
    await l.create('s');
    expect(await l.save('s', bad)).toMatchObject({ ok: false, error: expect.stringMatching(/unpaired surrogate/) });
    expect(l.get('s')!.text).not.toBe(bad);
  });
});

describe('a hung file system', () => {
  it('times out, marks the folder as needing a reconnect, and releases the queue', async () => {
    const { l, fs } = await connected({ 'a.json': { text: specText('a'), lastModified: T } }, 30);
    fs.state.hang = true;
    const r = await l.syncFromFolder();
    expect(r).toBeNull();
    expect(l.snapshot().folder.state).toBe('needs-permission');
    expect(l.snapshot().message).toMatch(/did not respond/);
    // The queue is free again: later work completes.
    fs.state.hang = false;
    await l.create('after');
    expect(l.get('after')).toBeDefined();
  });

  it('a write that hangs also times out', async () => {
    const { l, fs } = await connected({}, 30);
    fs.state.hang = true;
    await l.create('slow');
    expect(l.get('slow')).toBeDefined();
    expect(l.snapshot().folder.state).toBe('needs-permission');
    expect(l.snapshot().message).toMatch(/did not respond/);
  });
});

describe('rewriteTopLevelStrings', () => {
  it('changes only the top-level id and name, keeping every other byte', () => {
    const src = '{\n\t"types" : { "id": "inner", "root": {} },\n  "id"  :  "old" ,\n\t"name":"A \\"quoted\\" name",\n "z":[1,2,{"id":"x"}]\n}\n';
    const out = rewriteTopLevelStrings(src, 'new-id', (n) => n + ' (copy)')!;
    expect(out).toBe(src.replace('"old"', '"new-id"').replace('"A \\"quoted\\" name"', '"A \\"quoted\\" name (copy)"'));
    expect(JSON.parse(out).types.id).toBe('inner');
  });

  it('uses the last duplicate key like JSON.parse and gives up on non-objects or a missing id', () => {
    expect(rewriteTopLevelStrings('{"id":"a","id":"b"}', 'n')).toBe('{"id":"a","id":"n"}');
    expect(rewriteTopLevelStrings('[1]', 'n')).toBeNull();
    expect(rewriteTopLevelStrings('{"name":"x"}', 'n')).toBeNull();
    expect(rewriteTopLevelStrings('{"id":5}', 'n')).toBeNull();
  });

  it('conflict copies keep the original formatting byte for byte', async () => {
    const { l, fs } = await connected();
    await l.create('c');
    const odd = '{\n\t"schemaVersion":1, "id" : "c",\n\t"name":"Odd",   "endian":"le", "root":"root",\n\t"types":{"root":{"fields":[{"name":"m","type":"u4"}]}}\n}';
    fs.files.set('c.json', { text: specText('c', { name: 'folder' }), lastModified: T }); // newer: the folder wins
    await l.save('c', odd);
    await l.syncFromFolder();
    const copy = l.get('c-conflict-1')!;
    expect(copy.text).toBe(odd.replace('"id" : "c"', '"id" : "c-conflict-1"').replace('"Odd"', '"Odd (conflict copy)"'));
  });
});
