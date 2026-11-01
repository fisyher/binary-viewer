import { describe, expect, it } from 'vitest';
import { SpecLibrary } from '../../core/spec-library';
import { createMemoryStore } from '../../core/spec-store';
import { builtins, specText } from '../../test/spec-fixtures';
import { FormatsState } from './formats-state.svelte';

async function mk(ids: string[] = ['a', 'b', 'c']) {
  const lib = new SpecLibrary({ store: createMemoryStore(), builtins: builtins() });
  await lib.init();
  for (const id of ids) {
    await lib.create(id);
    await lib.save(id, specText(id));
  }
  const ctl = new FormatsState(lib);
  const opened: number[] = [];
  ctl.onOpened = () => opened.push(1);
  const off = ctl.connect();
  return { lib, ctl, opened, off };
}

/** Edit the active tab's draft the way the JSON editor does. */
const edit = (ctl: FormatsState, from: string, to: string) => (ctl.draft = ctl.draftText.replace(from, to));

describe('FormatsState: spec tabs', () => {
  it('opens a spec after the active tab and activates it; an open spec is only activated', async () => {
    const { ctl, opened } = await mk();
    ctl.select('b');
    ctl.select('a'); // after b
    expect(ctl.tabIds).toEqual(['b', 'a']);
    expect(ctl.activeSpecId).toBe('a');
    ctl.activate('b');
    ctl.select('c'); // opened after the active one (b), before a
    expect(ctl.tabIds).toEqual(['b', 'c', 'a']);
    ctl.select('a');
    expect(ctl.tabIds).toEqual(['b', 'c', 'a']);
    expect(ctl.activeSpecId).toBe('a');
    expect(opened).toHaveLength(5); // every select/activate shows the spec tab
    expect(ctl.openTabs.map((t) => t.name)).toEqual(['Fmt b', 'Fmt c', 'Fmt a']);
  });

  it('ignores unknown ids', async () => {
    const { ctl } = await mk();
    ctl.select('nope');
    ctl.activate('a');
    expect(ctl.tabIds).toEqual([]);
    expect(ctl.activeSpecId).toBeNull();
  });

  it('keeps the draft, view and error of each tab while another is active', async () => {
    const { ctl } = await mk();
    ctl.select('a');
    ctl.tab = 'builder';
    edit(ctl, 'Fmt a', 'Fmt a edited');
    ctl.saveStatus = { ok: false, text: 'nope' };
    const keyA = ctl.editorKey;
    ctl.select('b');
    expect(ctl.editorKey).not.toBe(keyA); // editors are remounted for the other tab
    expect(ctl.tab).toBe('json');
    expect(ctl.draft).toBeNull();
    expect(ctl.saveStatus).toBeNull();
    ctl.tab = 'docs';
    ctl.activate('a');
    expect(ctl.tab).toBe('builder');
    expect(ctl.draftText).toContain('Fmt a edited');
    expect(ctl.saveStatus).toEqual({ ok: false, text: 'nope' });
    ctl.activate('b');
    expect(ctl.tab).toBe('docs');
  });

  it('derives dirty per tab: edit then revert to the same value is clean again', async () => {
    const { ctl } = await mk();
    ctl.select('a');
    ctl.select('b');
    expect(ctl.anyDirty).toBe(false);
    edit(ctl, 'Fmt b', 'Fmt b edited');
    expect(ctl.isDirty('b')).toBe(true);
    expect(ctl.editorDirty).toBe(true);
    expect(ctl.isDirty('a')).toBe(false);
    expect(ctl.openTabs.map((t) => t.dirty)).toEqual([false, true]);
    ctl.activate('a');
    expect(ctl.editorDirty).toBe(false); // the active tab decides editorDirty
    expect(ctl.anyDirty).toBe(true); // ...but the page still has unsaved work
    ctl.activate('b');
    ctl.draft = ctl.library.get('b')!.text; // back to the saved text
    expect(ctl.isDirty('b')).toBe(false);
    expect(ctl.anyDirty).toBe(false);
    // layout-only differences are not changes either
    ctl.draft = JSON.stringify(JSON.parse(ctl.library.get('b')!.text));
    expect(ctl.isDirty('b')).toBe(false);
    edit(ctl, 'Fmt b', 'Fmt b edited');
    expect(ctl.isDirty('b')).toBe(true);
  });

  it('closing a clean tab activates the right neighbour, else the left one, else nothing', async () => {
    const { ctl } = await mk();
    for (const id of ['a', 'b', 'c']) ctl.select(id);
    ctl.activate('a');
    ctl.close();
    expect(ctl.tabIds).toEqual(['b', 'c']);
    expect(ctl.activeSpecId).toBe('b'); // right
    ctl.activate('c');
    ctl.close();
    expect(ctl.activeSpecId).toBe('b'); // no right one: left
    ctl.close();
    expect(ctl.tabIds).toEqual([]);
    expect(ctl.activeSpecId).toBeNull();
    expect(ctl.selected).toBeUndefined();
  });

  it('closing a background tab keeps the active one; closing drops its session', async () => {
    const { ctl } = await mk();
    for (const id of ['a', 'b']) ctl.select(id);
    ctl.activate('a');
    edit(ctl, 'Fmt a', 'Fmt a edited');
    const key = ctl.editorKey;
    ctl.close('b');
    expect(ctl.tabIds).toEqual(['a']);
    expect(ctl.activeSpecId).toBe('a');
    expect(ctl.editorKey).toBe(key);
    expect(ctl.draftText).toContain('Fmt a edited');
    ctl.select('b'); // reopening starts clean
    expect(ctl.draft).toBeNull();
  });

  it('closing a modified tab asks first: cancel keeps it, discard drops it and its draft', async () => {
    const { ctl } = await mk();
    ctl.select('a');
    ctl.select('b');
    ctl.close('b');
    expect(ctl.confirm).toBeNull();
    ctl.select('b');
    edit(ctl, 'Fmt b', 'Fmt b edited');
    ctl.close('b');
    expect(ctl.confirm?.message).toBe('"Fmt b" has unsaved changes. Discard them?');
    expect(ctl.confirm?.label).toBe('Discard changes');
    ctl.confirm = null; // cancel
    expect(ctl.tabIds).toEqual(['a', 'b']);
    expect(ctl.draftText).toContain('Fmt b edited');
    ctl.close('b');
    ctl.confirm!.run();
    expect(ctl.tabIds).toEqual(['a']);
    ctl.select('b');
    expect(ctl.draftText).not.toContain('edited');
  });

  it('saving with a changed id in the JSON renames the tab in place and keeps its state', async () => {
    const { ctl } = await mk();
    ctl.select('a');
    ctl.select('b');
    ctl.select('c');
    ctl.activate('b');
    ctl.tab = 'builder';
    const key = ctl.editorKey;
    const r = await ctl.save(specText('renamed'));
    expect(r.ok).toBe(true);
    expect(ctl.tabIds).toEqual(['a', 'renamed', 'c']);
    expect(ctl.activeSpecId).toBe('renamed');
    expect(ctl.tab).toBe('builder');
    expect(ctl.editorKey).toBe(key); // the editors stay mounted
    expect(ctl.selected?.id).toBe('renamed');
    expect(ctl.openTabs.map((t) => t.name)).toEqual(['Fmt a', 'Fmt renamed', 'Fmt c']);
    expect(ctl.library.get('b')).toBeUndefined();
  });

  it('renaming a background-saved tab never touches the other tabs’ drafts', async () => {
    const { ctl } = await mk();
    ctl.select('a');
    edit(ctl, 'Fmt a', 'Fmt a edited');
    ctl.select('b');
    await ctl.save(specText('b2'));
    ctl.activate('a');
    expect(ctl.draftText).toContain('Fmt a edited');
    expect(ctl.isDirty('a')).toBe(true);
    expect(ctl.isDirty('b2')).toBe(false);
  });

  it('overlapping saves with a rename on both tabs keep both tabs and their drafts', async () => {
    const { ctl } = await mk();
    ctl.select('a');
    ctl.select('b');
    ctl.activate('a');
    const pa = ctl.save(specText('a2')); // in flight ...
    ctl.activate('b'); // ... while the user saves the other tab too
    edit(ctl, 'Fmt b', 'Fmt b edited');
    const pb = ctl.save(specText('b2', { name: 'Fmt b edited' }));
    const [ra, rb] = await Promise.all([pa, pb]);
    expect(ra.ok && rb.ok).toBe(true);
    expect(ctl.tabIds).toEqual(['a2', 'b2']);
    expect(ctl.activeSpecId).toBe('b2');
    expect(ctl.saving).toBe(false);
    expect(ctl.openTabs.map((t) => t.name)).toEqual(['Fmt a2', 'Fmt b edited']);
  });

  it('a saved draft is clean; a save of the active tab leaves the others dirty', async () => {
    const { ctl } = await mk();
    ctl.select('a');
    edit(ctl, 'Fmt a', 'Fmt a edited');
    ctl.select('b');
    edit(ctl, 'Fmt b', 'Fmt b edited');
    const r = await ctl.save(ctl.draftText);
    expect(r.ok).toBe(true);
    expect(ctl.isDirty('b')).toBe(false);
    expect(ctl.isDirty('a')).toBe(true);
    expect(ctl.library.get('b')!.text).toContain('Fmt b edited');
  });

  it('a saved text that changes underneath a clean tab is followed; under a dirty one the draft stays', async () => {
    const { ctl, lib } = await mk();
    ctl.select('a');
    ctl.select('b');
    edit(ctl, 'Fmt b', 'Fmt b edited');
    await ctl.save(ctl.draftText); // draft now equals saved text
    await lib.save('b', specText('b', { name: 'Fmt b from elsewhere' })); // e.g. a folder sync
    expect(ctl.isDirty('b')).toBe(false);
    expect(ctl.draftText).toContain('from elsewhere');
    ctl.activate('a');
    edit(ctl, 'Fmt a', 'Fmt a mine');
    await lib.save('a', specText('a', { name: 'Fmt a theirs' }));
    expect(ctl.isDirty('a')).toBe(true);
    expect(ctl.draftText).toContain('Fmt a mine');
  });

  it('delete closes only that tab (after the library confirmation); the neighbour becomes active', async () => {
    const { ctl, lib } = await mk();
    for (const id of ['a', 'b', 'c']) ctl.select(id);
    ctl.activate('b');
    ctl.askDelete();
    expect(ctl.confirm?.label).toBe('Delete');
    ctl.confirm!.run();
    await new Promise((r) => setTimeout(r, 0));
    expect(lib.get('b')).toBeUndefined();
    expect(ctl.tabIds).toEqual(['a', 'c']);
    expect(ctl.activeSpecId).toBe('c');
  });

  it('deleting a modified tab does not prompt a second time', async () => {
    const { ctl } = await mk();
    ctl.select('a');
    edit(ctl, 'Fmt a', 'Fmt a edited');
    ctl.askDelete();
    ctl.confirm!.run();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctl.tabIds).toEqual([]);
    expect(ctl.confirm?.label).toBe('Delete'); // only the delete confirmation was ever shown, no discard prompt
  });

  it('duplicate opens the copy in a new tab after the current one', async () => {
    const { ctl } = await mk();
    ctl.select('a');
    ctl.select('b');
    ctl.activate('a');
    await ctl.duplicate();
    expect(ctl.tabIds).toHaveLength(3);
    expect(ctl.tabIds[0]).toBe('a');
    expect(ctl.tabIds[2]).toBe('b');
    expect(ctl.activeSpecId).toBe(ctl.tabIds[1]);
    expect(ctl.activeSpecId).not.toBe('a');
    expect(ctl.tab).toBe('json');
  });

  it('a new spec opens in its own tab on the Builder view; a failing create changes nothing', async () => {
    const { ctl } = await mk();
    ctl.select('a');
    edit(ctl, 'Fmt a', 'Fmt a edited');
    ctl.openNew();
    ctl.newForm!.id = 'a'; // taken
    await ctl.submitNew();
    expect(ctl.newError).toBeTruthy();
    expect(ctl.tabIds).toEqual(['a']);
    expect(ctl.confirm).toBeNull();
    ctl.newForm!.id = 'fresh';
    ctl.newForm!.name = 'Fresh';
    await ctl.submitNew();
    expect(ctl.newForm).toBeNull();
    expect(ctl.tabIds).toEqual(['a', 'fresh']);
    expect(ctl.activeSpecId).toBe('fresh');
    expect(ctl.tab).toBe('builder');
    expect(ctl.isDirty('a')).toBe(true); // the old tab kept its unsaved edit
  });

  it('a spec removed from the library closes only its tab and drops its session', async () => {
    const { ctl, lib } = await mk();
    for (const id of ['a', 'b', 'c']) ctl.select(id);
    edit(ctl, 'Fmt c', 'Fmt c edited');
    ctl.activate('b');
    await lib.delete('c'); // e.g. its file left the synced folder
    expect(ctl.tabIds).toEqual(['a', 'b']);
    expect(ctl.activeSpecId).toBe('b');
    expect(ctl.anyDirty).toBe(false);
    await lib.create('c'); // the id reappearing must not resurrect the tab or its draft
    await lib.save('c', specText('c'));
    expect(ctl.tabIds).toEqual(['a', 'b']);
    ctl.select('c');
    expect(ctl.draft).toBeNull();
    // removing the active one moves to its neighbour
    await lib.delete('b');
    expect(ctl.tabIds).toEqual(['a', 'c']);
    expect(ctl.activeSpecId).toBe('c');
  });

  it('anyDirty covers every open tab (the beforeunload warning)', async () => {
    const { ctl } = await mk();
    ctl.select('a');
    ctl.select('b');
    ctl.select('c');
    expect(ctl.anyDirty).toBe(false);
    ctl.activate('a');
    edit(ctl, 'Fmt a', 'Fmt a edited');
    ctl.activate('c');
    expect(ctl.anyDirty).toBe(true);
    ctl.close('a');
    ctl.confirm!.run();
    expect(ctl.anyDirty).toBe(false);
  });
});
