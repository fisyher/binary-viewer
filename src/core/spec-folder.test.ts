import { describe, expect, it } from 'vitest';
import { fakeDir } from '../test/fake-fs';
import { specText } from '../test/spec-fixtures';
import { FolderSync, MAX_FOLDER_FILES, specFileName } from './spec-folder';
import { createMemoryStore } from './spec-store';

describe('specFileName', () => {
  it('only produces <id>.json for ids matching the strict pattern', () => {
    expect(specFileName('my-spec_1')).toBe('my-spec_1.json');
    for (const bad of ['', '../x', '..', 'a/b', 'a\\b', 'A', '.hidden', '-x', 'a.json', 'x'.repeat(65), 'a b', 'a\u0000b', 'con:', '%2e%2e']) {
      expect(() => specFileName(bad), bad).toThrow(/unsafe/);
    }
  });

  it('refuses to write or remove with an unsafe id, touching nothing', async () => {
    const fs = fakeDir({ 'keep.json': { text: '{}', lastModified: 1 } });
    const sync = new FolderSync({ store: createMemoryStore(), picker: async () => fs.dir });
    await sync.connect();
    await expect(sync.write('../evil', 'x')).rejects.toThrow(/unsafe/);
    await expect(sync.remove('../keep.json')).rejects.toThrow(/unsafe/);
    await expect(sync.remove('a/b.json')).rejects.toThrow(/unsafe/);
    await expect(sync.remove('keep')).rejects.toThrow(/unsafe/);
    await expect(sync.write('x', 'y', '../evil.json')).rejects.toThrow(/unsafe/);
    expect(fs.log).toEqual([]);
    expect([...fs.files.keys()]).toEqual(['keep.json']);
  });
});

describe('FolderSync', () => {
  it('is unsupported without a picker', async () => {
    const s = new FolderSync({ store: createMemoryStore() });
    expect(s.state).toBe('unsupported');
    expect(s.supported).toBe(false);
    await expect(s.connect()).rejects.toThrow(/not supported/);
  });

  it('connect stores the handle; restore finds it again with permission granted', async () => {
    const store = createMemoryStore();
    const fs = fakeDir();
    const a = new FolderSync({ store, picker: async () => fs.dir });
    expect(await a.connect()).toBe(true);
    expect(a.state).toBe('connected');
    expect(a.name).toBe('specs');
    const b = new FolderSync({ store, picker: async () => fs.dir });
    await b.restore();
    expect(b.state).toBe('connected');
  });

  it('restore reports needs-permission and reconnect requests it', async () => {
    const store = createMemoryStore();
    const fs = fakeDir({}, { permission: 'prompt' });
    await new FolderSync({ store, picker: async () => fs.dir }).connect();
    const b = new FolderSync({ store, picker: async () => fs.dir });
    await b.restore();
    expect(b.state).toBe('needs-permission');
    expect(fs.state.requested).toBe(0); // querying never prompts
    await expect(b.readAll()).rejects.toThrow(/not connected/);
    expect(await b.reconnect()).toBe(false); // still "prompt" in the mock => denied
    expect(fs.state.requested).toBe(1);
    expect(b.state).toBe('needs-permission');
    fs.state.permission = 'granted';
    expect(await b.reconnect()).toBe(true);
    expect(b.state).toBe('connected');
  });

  it('a cancelled picker is not an error; other picker failures are', async () => {
    const cancel = new FolderSync({ store: createMemoryStore(), picker: () => Promise.reject(new DOMException('x', 'AbortError')) });
    expect(await cancel.connect()).toBe(false);
    expect(cancel.state).toBe('none');
    const broken = new FolderSync({ store: createMemoryStore(), picker: () => Promise.reject(new Error('nope')) });
    await expect(broken.connect()).rejects.toThrow('nope');
  });

  it('disconnect forgets the handle', async () => {
    const store = createMemoryStore();
    const fs = fakeDir();
    const a = new FolderSync({ store, picker: async () => fs.dir });
    await a.connect();
    await a.disconnect();
    expect(a.state).toBe('none');
    const b = new FolderSync({ store, picker: async () => fs.dir });
    await b.restore();
    expect(b.state).toBe('none');
  });

  it('readAll reads only .json files, skipping too-large and unreadable ones with reasons', async () => {
    const fs = fakeDir({
      'a.json': { text: specText('a'), lastModified: 10 },
      'b.JSON': { text: specText('b'), lastModified: 11 },
      'notes.txt': { text: 'hi', lastModified: 1 },
      'huge.json': { text: '{}', lastModified: 1, size: 2_000_000 },
      'bad.json': { text: '{}', lastModified: 1, failRead: true },
    });
    const sync = new FolderSync({ store: createMemoryStore(), picker: async () => fs.dir });
    await sync.connect();
    const r = await sync.readAll();
    expect(r.files.map((f) => f.fileName)).toEqual(['a.json']);
    expect(r.skipped.find((s) => s.fileName === 'b.JSON')?.reason).toMatch(/unsupported file name/);
    expect(r.skipped.find((s) => s.fileName === 'huge.json')?.reason).toMatch(/too large/);
    expect(r.skipped.find((s) => s.fileName === 'bad.json')?.reason).toMatch(/unreadable/);
  });

  it('caps the number of files read', async () => {
    const files: Record<string, { text: string; lastModified: number }> = {};
    for (let i = 0; i < MAX_FOLDER_FILES + 5; i++) files[`f${i}.json`] = { text: '{}', lastModified: 1 };
    const fs = fakeDir(files);
    const sync = new FolderSync({ store: createMemoryStore(), picker: async () => fs.dir });
    await sync.connect();
    const r = await sync.readAll();
    expect(r.files).toHaveLength(MAX_FOLDER_FILES);
    expect(r.skipped.some((s) => /more than/.test(s.reason))).toBe(true);
  });

  it('write and remove use <id>.json; removing a missing file is fine', async () => {
    const fs = fakeDir();
    const sync = new FolderSync({ store: createMemoryStore(), picker: async () => fs.dir });
    await sync.connect();
    await sync.write('one', 'TEXT');
    expect(fs.files.get('one.json')?.text).toBe('TEXT');
    await sync.remove('one.json');
    expect(fs.files.has('one.json')).toBe(false);
    await sync.remove('one.json');
    expect(fs.log).toEqual(['write:one.json', 'remove:one.json']);
  });
});
