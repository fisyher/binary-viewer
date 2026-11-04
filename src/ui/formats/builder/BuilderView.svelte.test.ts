// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { builtins, specText } from '../../../test/spec-fixtures';
import { SpecLibrary } from '../../../core/spec-library';
import { createMemoryStore } from '../../../core/spec-store';
import FormatLibrary from '../../../test/FormatsHarness.svelte';

afterEach(cleanup);

async function open(seed: Array<[string, string]>, id: string) {
  localStorage.setItem('binaryviewer.builder.hideRewriteNotice', '1'); // these tests are not about the rewrite confirmation
  const lib = new SpecLibrary({ store: createMemoryStore(), builtins: builtins() });
  await lib.init();
  for (const [sid, text] of seed) {
    await lib.create(sid);
    await lib.save(sid, text);
  }
  const r = render(FormatLibrary, { library: lib });
  const entry = [...r.container.querySelectorAll<HTMLButtonElement>('button.entry')].find((b) => b.querySelector('.id')?.textContent === id)!;
  await fireEvent.click(entry);
  await fireEvent.click(r.getByRole('tab', { name: 'Builder' }));
  const json = () => r.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Spec JSON"]')!;
  const spec = () => JSON.parse(json().value);
  return { ...r, lib, json, spec };
}

const two = specText('two', { types: { root: { fields: [{ name: 'a', type: 'u1' }, { name: 'b', type: 'u2' }] } } });

describe('Builder: editing', () => {
  it('adds a block through the palette and wizard and updates the JSON', async () => {
    const { getByRole, getByLabelText, spec } = await open([['two', two]], 'two');
    await fireEvent.click(getByRole('button', { name: /^Integer/ }));
    const wiz = within(getByRole('form', { name: 'Integer parameters' }));
    await fireEvent.input(wiz.getByLabelText(/^Field name/), { target: { value: 'count' } });
    await fireEvent.change(wiz.getByLabelText(/^Size in bytes/), { target: { value: '4' } });
    await fireEvent.click(wiz.getByRole('button', { name: 'Insert' }));
    expect(spec().types.root.fields.map((f: { name: string }) => f.name)).toEqual(['a', 'b', 'count']);
    expect(spec().types.root.fields[2]).toEqual({ name: 'count', type: 'u4' });
    expect(getByLabelText('Name of field 3')).toBeTruthy();
  });

  it('inserts after the selected row, and shows wizard errors without changing the spec', async () => {
    const { getByRole, getByLabelText, spec } = await open([['two', two]], 'two');
    await fireEvent.click(getByLabelText('Name of field 1'));
    await fireEvent.click(getByRole('button', { name: /^Padding/ }));
    const wiz = within(getByRole('form', { name: 'Padding / reserved parameters' }));
    await fireEvent.input(wiz.getByLabelText(/^Length in bytes/), { target: { value: 'x' } });
    await fireEvent.click(wiz.getByRole('button', { name: 'Insert' }));
    expect(wiz.getByRole('alert').textContent).toContain('whole number');
    expect(spec().types.root.fields).toHaveLength(2);
    await fireEvent.input(wiz.getByLabelText(/^Length in bytes/), { target: { value: '3' } });
    await fireEvent.click(wiz.getByRole('button', { name: 'Insert' }));
    expect(spec().types.root.fields.map((f: { name: string }) => f.name)).toEqual(['a', 'reserved', 'b']);
  });

  it('every palette block has help text', async () => {
    const { container } = await open([['two', two]], 'two');
    const blocks = [...container.querySelectorAll('.palette .block')];
    expect(blocks.length).toBe(18);
    for (const b of blocks) expect(b.querySelector('.bd')!.textContent!.length).toBeGreaterThan(10);
  });

  it('editing a field type updates the JSON', async () => {
    const { getByLabelText, spec } = await open([['two', two]], 'two');
    await fireEvent.change(getByLabelText('Type of field 1'), { target: { value: 'u4le' } });
    expect(spec().types.root.fields[0].type).toBe('u4le');
    await fireEvent.change(getByLabelText('Name of field 1'), { target: { value: 'first' } });
    expect(spec().types.root.fields[0].name).toBe('first');
  });

  it('reorders with the up/down buttons, duplicates and deletes', async () => {
    const { getByLabelText, spec } = await open([['two', two]], 'two');
    await fireEvent.click(getByLabelText('Move field 2 up'));
    expect(spec().types.root.fields.map((f: { name: string }) => f.name)).toEqual(['b', 'a']);
    await fireEvent.click(getByLabelText('Move field 1 down'));
    expect(spec().types.root.fields.map((f: { name: string }) => f.name)).toEqual(['a', 'b']);
    await fireEvent.click(getByLabelText('Duplicate field 1'));
    expect(spec().types.root.fields.map((f: { name: string }) => f.name)).toEqual(['a', 'a_copy', 'b']);
    await fireEvent.click(getByLabelText('Delete field 2'));
    expect(spec().types.root.fields.map((f: { name: string }) => f.name)).toEqual(['a', 'b']);
  });

  it('undo and redo buttons restore the previous text', async () => {
    const { getByRole, getByLabelText, spec } = await open([['two', two]], 'two');
    await fireEvent.click(getByLabelText('Delete field 1'));
    expect(spec().types.root.fields).toHaveLength(1);
    await fireEvent.click(getByRole('button', { name: 'Undo' }));
    expect(spec().types.root.fields).toHaveLength(2);
    await fireEvent.click(getByRole('button', { name: 'Redo' }));
    expect(spec().types.root.fields).toHaveLength(1);
  });

  it('Ctrl+Z undoes outside inputs but leaves text inputs alone', async () => {
    const { getByLabelText, getByRole, spec } = await open([['two', two]], 'two');
    await fireEvent.click(getByLabelText('Delete field 1'));
    await fireEvent.keyDown(getByLabelText('Name of field 1'), { key: 'z', ctrlKey: true });
    expect(spec().types.root.fields).toHaveLength(1);
    await fireEvent.keyDown(getByRole('button', { name: 'Undo' }), { key: 'z', ctrlKey: true });
    expect(spec().types.root.fields).toHaveLength(2);
    await fireEvent.keyDown(getByRole('button', { name: 'Undo' }), { key: 'y', ctrlKey: true });
    expect(spec().types.root.fields).toHaveLength(1);
  });

  it('Ctrl+S in the Builder saves the spec like the Save spec button, and keeps the browser dialog away', async () => {
    const { getByLabelText, getByRole, lib } = await open([['two', two]], 'two');
    const saved = () => JSON.parse(lib.snapshot().entries.find((e) => e.id === 'two')!.text).types.root.fields.length;
    await fireEvent.click(getByLabelText('Delete field 1'));
    expect(saved()).toBe(2); // only a draft so far
    expect(await fireEvent.keyDown(getByRole('button', { name: 'Undo' }), { key: 's', ctrlKey: true })).toBe(false);
    await waitFor(() => expect(saved()).toBe(1));
  });

  it('Ctrl+S also works while a text input in the Builder has focus', async () => {
    const { getByLabelText, lib } = await open([['two', two]], 'two');
    const saved = () => JSON.parse(lib.snapshot().entries.find((e) => e.id === 'two')!.text).types.root.fields.length;
    await fireEvent.click(getByLabelText('Delete field 1'));
    expect(await fireEvent.keyDown(getByLabelText('Name of field 1'), { key: 's', ctrlKey: true })).toBe(false);
    await waitFor(() => expect(saved()).toBe(1));
  });

  it('edits meta: endian, extension chips, detect rules', async () => {
    const { getByLabelText, getByRole, spec } = await open([['two', two]], 'two');
    await fireEvent.change(getByLabelText('Default endian'), { target: { value: 'be' } });
    expect(spec().endian).toBe('be');
    await fireEvent.input(getByLabelText('Add extension'), { target: { value: '.DAT' } });
    await fireEvent.click(getByRole('button', { name: 'Add' }));
    expect(spec().extensions).toEqual(['xyz', 'dat']);
    await fireEvent.click(getByLabelText('Remove extension xyz'));
    expect(spec().extensions).toEqual(['dat']);
    await fireEvent.click(getByRole('button', { name: 'Add detect rule' }));
    await fireEvent.change(getByLabelText('Detect 1 offset'), { target: { value: '-4' } });
    await fireEvent.change(getByLabelText('Detect 1 bytes'), { target: { value: '41 42' } });
    expect(spec().detect).toEqual([{ at: -4, bytes: '41 42' }]);
  });

  it('adds, renames and deletes types; delete is blocked while referenced', async () => {
    const withRef = specText('ref', { types: { root: { fields: [{ name: 'h', type: 'hdr' }] }, hdr: { fields: [{ name: 'x', type: 'u1' }] } } });
    const { getByLabelText, getByRole, spec, findByRole } = await open([['ref', withRef]], 'ref');
    await fireEvent.click(getByRole('button', { name: /^hdr/ }));
    await fireEvent.click(getByRole('button', { name: 'Delete type' }));
    const alert = await findByRole('alert');
    expect(alert.textContent).toContain('Cannot delete');
    expect(alert.textContent).toContain('root.fields[0] (h)');
    await fireEvent.input(getByLabelText('Rename type'), { target: { value: 'header' } });
    await fireEvent.click(getByRole('button', { name: 'Rename' }));
    expect(spec().types.root.fields[0].type).toBe('header');
    await fireEvent.input(getByLabelText('New type name'), { target: { value: 'extra' } });
    await fireEvent.click(getByRole('button', { name: 'Add type' }));
    expect(Object.keys(spec().types)).toEqual(['root', 'header', 'extra']);
    await fireEvent.click(getByRole('button', { name: 'Delete type' }));
    await fireEvent.click(within(getByRole('alertdialog')).getByRole('button', { name: 'Delete type' }));
    await waitFor(() => expect(Object.keys(spec().types)).toEqual(['root', 'header']));
  });

  it('warns when a renamed field is still used in an expression', async () => {
    const t = specText('x', { types: { root: { fields: [{ name: 'n', type: 'u1' }, { name: 'd', type: 'bytes', size: 'n' }] } } });
    const { getByLabelText, findByText, spec } = await open([['x', t]], 'x');
    await fireEvent.change(getByLabelText('Name of field 1'), { target: { value: 'count' } });
    expect(await findByText(/still mentions the old name/)).toBeTruthy();
    expect(spec().types.root.fields[1].size).toBe('n'); // not rewritten
  });

  it('edits enums', async () => {
    const { getByRole, getByLabelText, spec, container } = await open([['two', two]], 'two');
    for (const d of container.querySelectorAll('details')) (d as HTMLDetailsElement).open = true;
    await fireEvent.click(getByRole('button', { name: 'Add enum' }));
    await fireEvent.click(getByLabelText('Add value to enum new_enum'));
    await fireEvent.change(getByLabelText('Label 1 of enum new_enum'), { target: { value: 'Zero' } });
    expect(spec().enums).toEqual({ new_enum: { '0': 'Zero' } });
    await fireEvent.change(getByLabelText('Enum of field 1'), { target: { value: 'new_enum' } });
    expect(spec().types.root.fields[0].enum).toBe('new_enum');
  });

  it('expanded rows edit bits, asserts and switch cases', async () => {
    const { getByLabelText, getByRole, spec } = await open([['two', two]], 'two');
    await fireEvent.click(getByLabelText('Expand field 1'));
    await fireEvent.click(getByRole('button', { name: 'Add bit field' }));
    expect(spec().types.root.fields[0].bits).toEqual([{ name: 'bit0', offset: 0, width: 1 }]);
    await fireEvent.click(getByRole('button', { name: 'Add assert' }));
    expect(spec().types.root.fields[0].assert).toEqual([{ expr: '_ != 0' }]);
    await fireEvent.change(getByLabelText('Type of field 2'), { target: { value: '__switch__' } });
    await fireEvent.click(getByLabelText('Expand field 2'));
    await fireEvent.click(getByRole('button', { name: 'Add case' }));
    expect(spec().types.root.fields[1].type).toEqual({ switch: 'a', cases: { '1': 'u1' } });
  });
});

describe('Builder: states', () => {
  it('an unparseable JSON makes the builder read-only with the message', async () => {
    const { json, getByRole, queryByLabelText, findByText } = await open([['two', two]], 'two');
    await fireEvent.click(getByRole('tab', { name: 'JSON' }));
    await fireEvent.input(json(), { target: { value: '{\n  "id": }' } });
    await fireEvent.click(getByRole('tab', { name: 'Builder' }));
    expect(await findByText(/Fix the JSON syntax error at line 2, col \d+ to use the builder/)).toBeTruthy();
    expect(queryByLabelText('Name of field 1')).toBeNull();
    expect(queryByLabelText('Format id')).toBeNull();
  });

  it('JSON edits show up in the builder when it is next shown', async () => {
    const { json, getByRole, getByLabelText } = await open([['two', two]], 'two');
    await fireEvent.click(getByRole('tab', { name: 'JSON' }));
    await fireEvent.input(json(), { target: { value: specText('two', { name: 'Edited in JSON' }) } });
    await fireEvent.click(getByRole('tab', { name: 'Builder' }));
    expect((getByLabelText('Format name') as HTMLInputElement).value).toBe('Edited in JSON');
  });

  it('built-ins are read-only with Duplicate to edit', async () => {
    const { container, getByRole, spec, lib } = await open([], 'bmp');
    const before = spec();
    expect(getByRole('button', { name: 'Duplicate to edit' })).toBeTruthy();
    const area = container.querySelector('.builder')!;
    for (const el of area.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')) expect(el.disabled).toBe(true);
    for (const b of area.querySelectorAll<HTMLButtonElement>('.palette .block, button[aria-label^="Delete field"], button[aria-label^="Move field"]')) expect(b.disabled).toBe(true);
    await fireEvent.click(getByRole('button', { name: /^Integer/ })); // no wizard opens
    expect(container.querySelector('form[aria-label$="parameters"]')).toBeNull();
    expect(spec()).toEqual(before);
    await fireEvent.click(within(area as HTMLElement).getByRole('button', { name: 'Duplicate to edit' }));
    await waitFor(() => expect(lib.get('bmp-copy')).toBeDefined());
  });

  it('hostile names render as literal text', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const t = specText('evil', {
      name: evil,
      types: { root: { fields: [{ name: evil, type: evil }] }, [evil]: { fields: [] } },
      enums: { [evil]: { '0': evil } },
    });
    const { container } = await open([['evil', t]], 'evil');
    expect(container.querySelector('img')).toBeNull();
    expect([...container.querySelectorAll('.types .tname')].map((b) => b.textContent).join('|')).toContain(evil);
    expect((container.querySelector('[aria-label="Name of field 1"]') as HTMLInputElement).value).toBe(evil);
    expect(container.querySelector('.builder')!.textContent).toContain(evil);
  });

  it('maps validation errors to the field and shows the message', async () => {
    const t = specText('bad', { types: { root: { fields: [{ name: 'a', type: 'u1', size: 4 }, { name: 'b', type: 'u1', if: 'nope > 1' }] } } });
    const { container, findAllByText } = await open([['bad', t]], 'bad');
    expect((await findAllByText(/primitive numeric types have a fixed size/)).length).toBeGreaterThan(0);
    expect((await findAllByText(/unknown name "nope"/)).length).toBeGreaterThan(0);
    const rows = container.querySelectorAll('tbody tr:not(.detail)');
    expect(rows[0]!.classList.contains('bad')).toBe(true);
    expect(rows[1]!.classList.contains('bad')).toBe(true);
    expect(container.querySelector('.tname.bad')).not.toBeNull();
  });

  it('expression inputs give parse feedback and suggest earlier fields', async () => {
    const { getByLabelText, findByText, container, spec } = await open([['two', two]], 'two');
    const input = getByLabelText('If of field 2') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'a +' } });
    expect(await findByText(/Expression error/)).toBeTruthy();
    await fireEvent.input(input, { target: { value: 'a == 1' } });
    expect(container.querySelector('.fb')).toBeNull();
    await fireEvent.change(input, { target: { value: 'a == 1' } });
    expect(spec().types.root.fields[1].if).toBe('a == 1');
    const list = container.querySelector(`#${input.getAttribute('list')}`)!;
    const opts = [...list.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    expect(opts).toEqual(['a', '_io.size', '_parent', '_root', '_index', '_start', 'lookup']);
  });
});
