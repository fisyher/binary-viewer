// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { builtins, specText } from '../../test/spec-fixtures';
import { SpecLibrary, type SaveResult, type SpecEntry } from '../../core/spec-library';
import { createMemoryStore } from '../../core/spec-store';
import SpecJsonEditor from './SpecJsonEditor.svelte';

afterEach(cleanup);

async function entryFor(text: string, id = 'mine'): Promise<{ lib: SpecLibrary; entry: SpecEntry }> {
  const lib = new SpecLibrary({ store: createMemoryStore(), builtins: builtins() });
  await lib.init();
  await lib.create(id);
  await lib.save(id, text);
  return { lib, entry: lib.get(id)! };
}

const ok: SaveResult = { ok: true, id: 'mine', valid: true, issues: [] };

function mount(entry: SpecEntry, extra: { onSave?: (t: string) => Promise<SaveResult>; onDuplicate?: () => void; onDirtyChange?: (d: boolean) => void } = {}) {
  const onSave = extra.onSave ?? vi.fn(async () => ok);
  const onDuplicate = extra.onDuplicate ?? vi.fn();
  const r = render(SpecJsonEditor, { entry, onSave, onDuplicate, onDirtyChange: extra.onDirtyChange });
  const area = r.getByLabelText('Spec JSON') as HTMLTextAreaElement;
  const type = (v: string) => fireEvent.input(area, { target: { value: v } });
  const saveBtn = () => r.getByRole('button', { name: 'Save spec' }) as HTMLButtonElement;
  return { ...r, area, type, saveBtn, onSave, onDuplicate };
}

describe('SpecJsonEditor', () => {
  it('shows the spec text with a line-number gutter', async () => {
    const { entry } = await entryFor(specText('mine'));
    const { area, container } = mount(entry);
    expect(area.value).toBe(entry.text);
    const lines = entry.text.split('\n').length;
    const gutter = container.querySelector('.gutter')!;
    expect(gutter.textContent!.split('\n')).toHaveLength(lines);
    expect(gutter.textContent!.startsWith('1\n2\n')).toBe(true);
  });

  it('validates after a 300 ms pause and lists errors with JSON paths', async () => {
    const { entry } = await entryFor(specText('mine'));
    const { type, findAllByText, container, getByText } = mount(entry);
    expect(getByText('No problems found.')).toBeTruthy();
    await type(specText('mine', { root: 'missing', types: { root: { fields: [{ name: 'a', type: 'nope' }] } } }));
    expect(container.querySelector('.problems li.err')).toBeNull(); // still debouncing
    const codes = await findAllByText(/^\$\.(root|types)/, undefined, { timeout: 2000 });
    expect(codes[0]!.tagName).toBe('CODE');
    const items = [...container.querySelectorAll('.problems li.err code')].map((c) => c.textContent!);
    expect(items.some((p) => p.startsWith('$.types.root.fields[0]'))).toBe(true);
    expect(getByText(/validation issues?/)).toBeTruthy();
  });

  it('reports the line and column of a syntax error and disables Save', async () => {
    const { entry } = await entryFor(specText('mine'));
    const { type, findByText, saveBtn, onSave } = mount(entry);
    await type('{\n  "id": "mine",\n  "name": oops\n}');
    const msg = await findByText(/Syntax error at line 3, column \d+/, undefined, { timeout: 2000 });
    expect(msg).toBeTruthy();
    expect(saveBtn().disabled).toBe(true);
    await fireEvent.click(saveBtn());
    expect(onSave).not.toHaveBeenCalled();
  });

  it('even before the debounce fires, Save refuses broken JSON', async () => {
    const { entry } = await entryFor(specText('mine'));
    const { type, saveBtn, onSave, area } = mount(entry);
    await type('{ nope');
    // Button may still look enabled (check is debounced); the handler must re-check.
    saveBtn().disabled = false;
    await fireEvent.click(saveBtn());
    expect(onSave).not.toHaveBeenCalled();
    expect(area.value).toBe('{ nope');
  });

  it('saves a spec with validation errors as an invalid draft and says so', async () => {
    const { entry } = await entryFor(specText('mine'));
    const bad = specText('mine', { root: 'missing' });
    const onSave = vi.fn(async (): Promise<SaveResult> => ({ ok: true, id: 'mine', valid: false, issues: [{ path: '$.root', message: 'x' }] }));
    const { type, saveBtn, findByText } = mount(entry, { onSave });
    await type(bad);
    await waitFor(() => expect(saveBtn().disabled).toBe(false));
    await fireEvent.click(saveBtn());
    expect(onSave).toHaveBeenCalledWith(bad);
    expect(await findByText(/Saved as an invalid draft \(1 issue\)/)).toBeTruthy();
  });

  it('shows a failed save and keeps the text', async () => {
    const { entry } = await entryFor(specText('mine'));
    const onSave = vi.fn(async (): Promise<SaveResult> => ({ ok: false, error: 'Id "x" is already used by another format.' }));
    const { type, saveBtn, findByText, area } = mount(entry, { onSave });
    await type(specText('mine', { name: 'changed' }));
    await waitFor(() => expect(saveBtn().disabled).toBe(false));
    await fireEvent.click(saveBtn());
    expect(await findByText(/already used/)).toBeTruthy();
    expect(area.value).toContain('changed');
  });

  it('tracks dirty state, reports it, and Revert restores the saved text', async () => {
    const { entry } = await entryFor(specText('mine'));
    const dirty = vi.fn();
    const { type, area, getByRole, queryByText, saveBtn } = mount(entry, { onDirtyChange: dirty });
    expect(saveBtn().disabled).toBe(true); // nothing to save
    await type(specText('mine', { name: 'edited' }));
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(true));
    expect(queryByText(/Unsaved changes/)).not.toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Revert' }));
    expect(area.value).toBe(entry.text);
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
    expect(queryByText(/Unsaved changes/)).toBeNull();
  });

  it('built-in specs open read-only with a Duplicate to edit button', async () => {
    const lib = new SpecLibrary({ store: createMemoryStore(), builtins: builtins() });
    await lib.init();
    const { area, getByRole, queryByRole, getByText, onDuplicate } = mount(lib.get('bmp')!);
    expect(area.readOnly).toBe(true);
    expect(getByText('Built-in format (read-only)')).toBeTruthy();
    expect(queryByRole('button', { name: 'Save spec' })).toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Duplicate to edit' }));
    expect(onDuplicate).toHaveBeenCalledOnce();
  });

  it('follows external changes to the entry unless the user has unsaved edits', async () => {
    const { lib, entry } = await entryFor(specText('mine'));
    const r = mount(entry);
    await r.rerender({ entry: { ...entry, text: specText('mine', { name: 'from folder' }) } });
    await waitFor(() => expect(r.area.value).toContain('from folder'));
    await r.type('my own edit');
    await r.rerender({ entry: { ...entry, text: specText('mine', { name: 'newer' }) } });
    await new Promise((res) => setTimeout(res, 10));
    expect(r.area.value).toBe('my own edit');
    void lib;
  });

  it('shows hostile validation text literally', async () => {
    const { entry } = await entryFor(specText('mine'));
    const { type, container } = mount(entry);
    await type(JSON.stringify({ schemaVersion: 1, id: 'mine', name: '<img src=x onerror=alert(1)>', root: '<script>', types: {} }));
    await waitFor(() => expect(container.querySelector('.problems li.err')).not.toBeNull(), { timeout: 2000 });
    expect(container.querySelector('.problems script, .problems img')).toBeNull();
  });
});

describe('SpecJsonEditor: size cap', () => {
  it('refuses oversized input with a clear message and keeps the previous text', async () => {
    const { entry } = await entryFor(specText('mine'));
    const { type, area, findByText } = mount(entry);
    const before = area.value;
    await type('x'.repeat(1_048_577));
    expect(area.value).toBe(before);
    expect(await findByText(/Input too large/)).toBeTruthy();
  });
});
