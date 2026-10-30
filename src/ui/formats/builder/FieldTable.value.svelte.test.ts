// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isModelError, toModel, toText } from '../../../core/builder';
import type { BuilderModel } from '../../../core/builder';
import FieldTable from './FieldTable.svelte';

afterEach(cleanup);

const SPEC = {
  schemaVersion: 1,
  id: 'v',
  name: 'V',
  endian: 'le',
  root: 'root',
  types: {
    rec: { fields: [{ name: 'n', type: 'u2' }] },
    root: {
      fields: [
        { name: 'count', type: 'u2' },
        { name: 'total', type: 'value', value: 'count * 2' },
        { name: 'e', type: 'rec', find: { bytes: '50 4B', from: '_io.end', window: 100, direction: 'backward' }, ifMagic: { at: 0, bytes: '41' }, ref: { type: 'rec', at: 'count' } },
        { name: 'm', type: 'u1', expect: 1, fatal: true },
      ],
    },
  },
};

function model(): BuilderModel {
  const m = toModel(JSON.stringify(SPEC));
  if (isModelError(m)) throw new Error(m.error);
  return m;
}

describe('FieldTable with the new field kinds', () => {
  it('shows a value field with its expression and the type "value"', () => {
    const { getByLabelText } = render(FieldTable, { model: model(), typeName: 'root', selected: null, issues: [], readOnly: false, commit: () => {}, onNotice: () => {} });
    expect((getByLabelText('Value of field 2') as HTMLInputElement).value).toBe('count * 2');
    expect((getByLabelText('Type of field 2') as HTMLSelectElement).value).toBe('value');
    expect((getByLabelText('Type of field 1') as HTMLSelectElement).value).toBe('u2');
  });

  it('editing the expression commits only that key; fields with find / ifMagic / ref / fatal are preserved', async () => {
    const commit = vi.fn();
    const { getByLabelText } = render(FieldTable, { model: model(), typeName: 'root', selected: null, issues: [], readOnly: false, commit, onNotice: () => {} });
    const input = getByLabelText('Value of field 2') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'count * 3' } });
    await fireEvent.change(input);
    expect(commit).toHaveBeenCalledTimes(1);
    const out = JSON.parse(toText(commit.mock.calls[0]![0] as BuilderModel));
    const fields = out.types.root.fields;
    expect(fields[1]).toEqual({ name: 'total', type: 'value', value: 'count * 3' });
    expect(fields[2]).toEqual(SPEC.types.root.fields[2]);
    expect(fields[3]).toEqual(SPEC.types.root.fields[3]);
  });

  it('offers cp437 among the encodings and can switch a field to the value type', async () => {
    const commit = vi.fn();
    const { getByLabelText, getAllByLabelText } = render(FieldTable, { model: model(), typeName: 'root', selected: null, issues: [], readOnly: false, commit, onNotice: () => {} });
    await fireEvent.click(getAllByLabelText(/Expand field 1/)[0]!);
    const enc = getByLabelText('Encoding of field 1') as HTMLSelectElement;
    expect([...enc.options].map((o) => o.value)).toContain('cp437');
    await fireEvent.change(getByLabelText('Type of field 4'), { target: { value: 'value' } });
    const out = JSON.parse(toText(commit.mock.calls[0]![0] as BuilderModel));
    expect(out.types.root.fields[3]).toEqual({ name: 'm', type: 'value' }); // expect/fatal dropped; the validator will ask for the expression
  });
});
