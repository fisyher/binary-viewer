// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isModelError, toModel, toText } from '../../../core/builder';
import { SpecLibrary } from '../../../core/spec-library';
import { createMemoryStore } from '../../../core/spec-store';
import { builtins, specText } from '../../../test/spec-fixtures';
import FormatLibrary from '../../../test/FormatsHarness.svelte';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

async function open(seed: Array<[string, string]>, id: string) {
  const lib = new SpecLibrary({ store: createMemoryStore(), builtins: builtins() });
  await lib.init();
  for (const [sid, text] of seed) {
    await lib.create(sid);
    await lib.save(sid, text);
  }
  const onDirtyChange = vi.fn();
  const r = render(FormatLibrary, { library: lib, onDirtyChange });
  const entry = () => [...r.container.querySelectorAll<HTMLButtonElement>('button.entry')].find((b) => b.querySelector('.id')?.textContent === id)!;
  await fireEvent.click(entry());
  await fireEvent.click(r.getByRole('tab', { name: 'Builder' }));
  const json = () => r.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Spec JSON"]')!;
  return { ...r, lib, json, spec: () => JSON.parse(json().value), onDirtyChange, entry };
}

const two = specText('two', { types: { root: { fields: [{ name: 'a', type: 'u1' }, { name: 'b', type: 'u2' }] } } });
const canonical = (text: string) => {
  const m = toModel(text);
  if (isModelError(m)) throw new Error(m.error);
  return toText(m);
};
const NOTICE = /Editing here rewrites the JSON in canonical form/;

describe('Builder: duplicate keys', () => {
  it('an enum key that already exists (by value) is refused inline and nothing is dropped', async () => {
    const t = specText('en', { enums: { e: { '16': 'A', '1': 'B' } }, types: { root: { fields: [{ name: 'a', type: 'u1' }] } } });
    const { getByLabelText, findByText, spec } = await open([['en', t]], 'en');
    await fireEvent.change(getByLabelText('Value 1 of enum e'), { target: { value: '0x10' } });
    expect(await findByText(/already exists/)).toBeTruthy();
    expect(Object.keys(spec().enums.e)).toHaveLength(2);
    expect(spec().enums.e).toEqual({ '16': 'A', '1': 'B' });
  });

  it('a switch case key that already exists is refused inline', async () => {
    const t = specText('sw', { types: { root: { fields: [{ name: 'k', type: 'u1' }, { name: 'p', type: { switch: 'k', cases: { '1': 'u1', '2': 'u1' } } }] } } });
    const { getByLabelText, findByText, spec } = await open([['sw', t]], 'sw');
    await fireEvent.click(getByLabelText('Expand field 2'));
    await fireEvent.change(getByLabelText('Case 2 value of field 2'), { target: { value: '0x1' } });
    expect(await findByText(/already exists/)).toBeTruthy();
    expect(Object.keys(spec().types.root.fields[1].type.cases)).toEqual(['1', '2']);
  });
});

describe('Builder: canonical rewrite confirmation and semantic dirty', () => {
  const confirmBox = (c: HTMLElement) => c.querySelector('[aria-label="Rewrite confirmation"]');

  it('asks before the first rewrite of non-canonical text; Cancel leaves the JSON and the input untouched', async () => {
    const { container, getByLabelText, getByRole, queryByText, findByText, spec } = await open([['two', two]], 'two');
    expect(queryByText(NOTICE)).toBeNull();
    await fireEvent.change(getByLabelText('Name of field 1'), { target: { value: 'first' } });
    expect(await findByText(NOTICE)).toBeTruthy();
    expect(spec().types.root.fields[0].name).toBe('a'); // nothing applied yet
    await fireEvent.click(getByRole('button', { name: 'Cancel' }));
    expect(confirmBox(container)).toBeNull();
    expect(spec().types.root.fields[0].name).toBe('a');
    expect((getByLabelText('Name of field 1') as HTMLInputElement).value).toBe('a');
    await fireEvent.change(getByLabelText('Name of field 1'), { target: { value: 'first' } });
    await fireEvent.click(getByRole('button', { name: 'Apply' }));
    expect(spec().types.root.fields[0].name).toBe('first');
    await fireEvent.change(getByLabelText('Name of field 2'), { target: { value: 'second' } });
    expect(confirmBox(container)).toBeNull(); // the text is canonical now
    expect(spec().types.root.fields[1].name).toBe('second');
  });

  it('asks again after the text is changed from the JSON tab, and drops a stale pending edit', async () => {
    const { container, getByLabelText, getByRole, json } = await open([['two', two]], 'two');
    await fireEvent.change(getByLabelText('Name of field 1'), { target: { value: 'first' } });
    expect(confirmBox(container)).not.toBeNull();
    await fireEvent.click(getByRole('tab', { name: 'JSON' }));
    await fireEvent.input(json(), { target: { value: two.replace('Fmt two', 'Fmt two!') } });
    await fireEvent.click(getByRole('tab', { name: 'Builder' }));
    expect(confirmBox(container)).toBeNull();
    await fireEvent.change(getByLabelText('Name of field 1'), { target: { value: 'first' } });
    expect(confirmBox(container)).not.toBeNull();
  });

  it('the "do not show again" checkbox persists; canonical text never asks', async () => {
    const first = await open([['two', two]], 'two');
    await fireEvent.change(first.getByLabelText('Name of field 1'), { target: { value: 'first' } });
    await fireEvent.click(first.getByLabelText(/Don.t show this again/));
    await fireEvent.click(first.getByRole('button', { name: 'Apply' }));
    expect(localStorage.getItem('binaryviewer.builder.hideRewriteNotice')).toBe('1');
    expect(first.spec().types.root.fields[0].name).toBe('first');
    cleanup();
    const second = await open([['two', two]], 'two');
    await fireEvent.change(second.getByLabelText('Name of field 1'), { target: { value: 'first' } });
    expect(confirmBox(second.container)).toBeNull();
    expect(second.spec().types.root.fields[0].name).toBe('first');
    cleanup();
    localStorage.clear();
    const third = await open([['two', canonical(two)]], 'two');
    await fireEvent.change(third.getByLabelText('Name of field 1'), { target: { value: 'first' } });
    expect(confirmBox(third.container)).toBeNull();
  });

  it('an unavailable localStorage does not break the confirmation', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { getByLabelText, findByText } = await open([['two', two]], 'two');
    await fireEvent.change(getByLabelText('Name of field 1'), { target: { value: 'first' } });
    expect(await findByText(NOTICE)).toBeTruthy();
    spy.mockRestore();
  });

  it('an edit that puts things back while a confirmation is pending drops the held edit', async () => {
    const { container, getByLabelText, spec } = await open([['two', two]], 'two');
    await fireEvent.change(getByLabelText('Name of field 1'), { target: { value: 'first' } });
    expect(confirmBox(container)).not.toBeNull();
    await fireEvent.change(getByLabelText('Name of field 1'), { target: { value: 'a' } });
    expect(confirmBox(container)).toBeNull();
    expect(spec().types.root.fields[0].name).toBe('a');
    expect(container.textContent).not.toContain('Rewrite confirmation');
  });

  it('a second edit while pending replaces the held edit: Apply writes the latest', async () => {
    const { container, getByLabelText, getByRole, spec } = await open([['two', two]], 'two');
    await fireEvent.change(getByLabelText('Name of field 1'), { target: { value: 'first' } });
    await fireEvent.change(getByLabelText('Name of field 2'), { target: { value: 'second' } });
    expect(confirmBox(container)!.textContent).toContain('Apply your latest edit?');
    await fireEvent.click(getByRole('button', { name: 'Apply' }));
    expect(spec().types.root.fields.map((f: { name: string }) => f.name)).toEqual(['a', 'second']);
  });

  it('an edit then undo on a spec with non-schema key order ends clean', async () => {
    localStorage.setItem('binaryviewer.builder.hideRewriteNotice', '1');
    const odd = JSON.stringify({ types: { root: { fields: [{ type: 'u1', name: 'a' }, { type: 'u2', name: 'b' }] } }, root: 'root', endian: 'le', name: 'Odd', id: 'odd', schemaVersion: 1 }, null, 2);
    const { getByLabelText, getByRole, onDirtyChange } = await open([['odd', odd]], 'odd');
    await fireEvent.click(getByLabelText('Delete field 1'));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    await fireEvent.click(getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it('undoing back to the original (different layout, same JSON) is not dirty', async () => {
    localStorage.setItem('binaryviewer.builder.hideRewriteNotice', '1');
    const { getByLabelText, getByRole, queryByText, onDirtyChange } = await open([['two', two]], 'two');
    await fireEvent.click(getByLabelText('Delete field 1'));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    await fireEvent.click(getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(queryByText(/Unsaved edits/)).toBeNull();
    expect((getByRole('button', { name: 'Save spec' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('swapping switch cases or value-equal enum keys in the JSON counts as a change', async () => {
    const sw = specText('sw', { types: { root: { fields: [{ name: 'k', type: 'u1' }, { name: 'p', type: { switch: 'k', cases: { 'k == 1': 'u1', 'k > 0': 'u2' } } }] } } });
    const a = await open([['sw', sw]], 'sw');
    await fireEvent.click(a.getByRole('tab', { name: 'JSON' }));
    const swapped = JSON.stringify({ ...JSON.parse(sw), types: { root: { fields: [{ name: 'k', type: 'u1' }, { name: 'p', type: { switch: 'k', cases: { 'k > 0': 'u2', 'k == 1': 'u1' } } }] } } }, null, 2);
    await fireEvent.input(a.json(), { target: { value: swapped } });
    await waitFor(() => expect(a.onDirtyChange).toHaveBeenLastCalledWith(true));
    cleanup();
    const en = specText('en', { enums: { e: { '0x10': 'A', '0x010': 'B' } } });
    const b = await open([['en', en]], 'en');
    await fireEvent.click(b.getByRole('tab', { name: 'JSON' }));
    await fireEvent.input(b.json(), { target: { value: JSON.stringify({ ...JSON.parse(en), enums: { e: { '0x010': 'B', '0x10': 'A' } } }, null, 2) } });
    await waitFor(() => expect(b.onDirtyChange).toHaveBeenLastCalledWith(true));
  });

  it('a number out of range makes the builder read-only with a message', async () => {
    const t = two.replace('"schemaVersion": 1', '"schemaVersion": 1,\n  "big": 1e400');
    const { findByText, queryByLabelText } = await open([['two', t]], 'two');
    expect(await findByText(/number out of range at \$\.big; fix it in JSON/)).toBeTruthy();
    expect(queryByLabelText('Name of field 1')).toBeNull();
  });
});

describe('New format', () => {
  it('a failing create keeps the dirty flag and the prompt', async () => {
    const { container, getByRole, getByLabelText, findByRole, json, onDirtyChange, lib, entry } = await open([['two', two], ['taken', specText('taken')]], 'two');
    await fireEvent.click(entry());
    await fireEvent.input(json(), { target: { value: json().value.replace('Fmt two', 'Fmt two edited') } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    await fireEvent.click(getByRole('button', { name: 'New' }));
    await fireEvent.input(getByLabelText('New format id'), { target: { value: 'taken' } });
    await fireEvent.click(getByRole('button', { name: 'Create' }));
    await fireEvent.click(await findByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(container.querySelector('form[aria-label="New format"] [role="alert"]')).not.toBeNull());
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(container.querySelector('form[aria-label="New format"]')).not.toBeNull();
    expect(lib.get('taken')!.text).toContain('Fmt taken');
    expect(json().value).toContain('Fmt two edited');
  });
});

describe('Builder: sanitised suggestions', () => {
  it('datalist options never carry control or bidi characters from field names', async () => {
    const evil = 'a‮b\u0007';
    const t = specText('ev', { types: { root: { fields: [{ name: evil, type: 'u1' }, { name: 'z', type: 'u1' }] } } });
    const { container } = await open([['ev', t]], 'ev');
    const opts = [...container.querySelectorAll('datalist option')].map((o) => o.getAttribute('value') ?? '');
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) expect(/[‮\u0007]/.test(o)).toBe(false);
  });
});
