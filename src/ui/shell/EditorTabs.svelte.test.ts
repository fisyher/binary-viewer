// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EditorTabs, { type EditorTab } from './EditorTabs.svelte';

afterEach(cleanup);

const file: EditorTab = { id: 'file', label: 'a.bin', modified: false, modifiedLabel: 'Modified', closable: false };
const spec: EditorTab = { id: 'spec', label: 'Fmt', modified: false, modifiedLabel: 'Unsaved changes', closable: true };

describe('EditorTabs', () => {
  it('falls back to the first tab when the active one is not in the list', () => {
    const { getByRole } = render(EditorTabs, { tabs: [file], activeId: 'spec', onSelect: () => {}, onClose: () => {} });
    const tab = getByRole('tab', { name: 'a.bin' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(tab.getAttribute('tabindex')).toBe('0');
  });

  it('the tablist itself is not a tab stop; arrows move between tabs', async () => {
    const onSelect = vi.fn();
    const { getByRole } = render(EditorTabs, { tabs: [file, spec], activeId: 'file', onSelect, onClose: () => {} });
    expect(getByRole('tablist').hasAttribute('tabindex')).toBe(false);
    await fireEvent.keyDown(getByRole('tab', { name: 'a.bin' }), { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenCalledWith('spec');
  });
});
