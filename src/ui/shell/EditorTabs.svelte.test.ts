// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EditorTabs, { type EditorTab } from './EditorTabs.svelte';

afterEach(cleanup);

const file: EditorTab = { id: 'file', label: 'a.bin', modified: false, modifiedLabel: 'Modified', closable: false };
const spec = (id: string, label = id, modified = false): EditorTab => ({ id: 'spec:' + id, label, modified, modifiedLabel: 'Modified', closable: true });
const panelId = (id: string) => (id === 'file' ? 'editor-panel-file' : 'editor-panel-spec');
const base = { panelId, onSelect: () => {}, onClose: () => {} };

describe('EditorTabs', () => {
  it('falls back to the first tab when the active one is not in the list', () => {
    const { getByRole } = render(EditorTabs, { ...base, tabs: [file], activeId: 'spec:x' });
    const tab = getByRole('tab', { name: 'a.bin' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(tab.getAttribute('tabindex')).toBe('0');
  });

  it('the tablist itself is not a tab stop; arrows, Home and End move between tabs (roving tabindex)', async () => {
    const onSelect = vi.fn();
    const tabs = [file, spec('a', 'Alpha'), spec('b', 'Beta')];
    const { getByRole } = render(EditorTabs, { ...base, tabs, activeId: 'file', onSelect });
    expect(getByRole('tablist').hasAttribute('tabindex')).toBe(false);
    expect(getByRole('tab', { name: 'Alpha' }).getAttribute('tabindex')).toBe('-1');
    await fireEvent.keyDown(getByRole('tab', { name: 'a.bin' }), { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenLastCalledWith('spec:a');
    await fireEvent.keyDown(getByRole('tab', { name: 'a.bin' }), { key: 'End' });
    expect(onSelect).toHaveBeenLastCalledWith('spec:b');
    await fireEvent.keyDown(getByRole('tab', { name: 'a.bin' }), { key: 'ArrowLeft' });
    expect(onSelect).toHaveBeenLastCalledWith('spec:b'); // wraps
  });

  it('shows a Modified dot per modified tab and one close button per spec tab', () => {
    const tabs = [file, spec('a', 'Alpha', true), spec('b', 'Beta')];
    const { getAllByLabelText, getByRole, queryByRole } = render(EditorTabs, { ...base, tabs, activeId: 'spec:a' });
    expect(getAllByLabelText('Modified')).toHaveLength(1);
    expect(getByRole('button', { name: 'Close Alpha' })).toBeTruthy();
    expect(getByRole('button', { name: 'Close Beta' })).toBeTruthy();
    expect(queryByRole('button', { name: 'Close a.bin' })).toBeNull();
  });

  it('closes with the close button, the middle mouse button and Delete (not the file tab)', async () => {
    const onClose = vi.fn();
    const tabs = [file, spec('a', 'Alpha'), spec('b', 'Beta')];
    const { getByRole } = render(EditorTabs, { ...base, tabs, activeId: 'spec:a', onClose });
    await fireEvent.click(getByRole('button', { name: 'Close Beta' }));
    expect(onClose).toHaveBeenLastCalledWith('spec:b');
    await fireEvent(getByRole('tab', { name: 'Beta' }), new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
    expect(onClose).toHaveBeenLastCalledWith('spec:b');
    await fireEvent(getByRole('tab', { name: 'Beta' }), new MouseEvent('auxclick', { button: 2, bubbles: true, cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
    await fireEvent.keyDown(getByRole('tab', { name: 'Alpha' }), { key: 'Delete' });
    expect(onClose).toHaveBeenLastCalledWith('spec:a');
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('a middle mousedown on a tab or its close button is cancelled so the browser does not autoscroll', async () => {
    const { getByRole } = render(EditorTabs, { ...base, tabs: [file, spec('a', 'Alpha')], activeId: 'spec:a' });
    for (const el of [getByRole('tab', { name: 'Alpha' }), getByRole('button', { name: 'Close Alpha' })]) {
      const ev = new MouseEvent('mousedown', { button: 1, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    }
    const left = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true });
    getByRole('tab', { name: 'Alpha' }).dispatchEvent(left);
    expect(left.defaultPrevented).toBe(false);
  });

  it('Delete on the file tab does nothing', async () => {
    const onClose = vi.fn();
    const { getByRole } = render(EditorTabs, { ...base, tabs: [file, spec('a')], activeId: 'file', onClose });
    await fireEvent.keyDown(getByRole('tab', { name: 'a.bin' }), { key: 'Delete' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps ids selector-safe and points aria-controls at the shown panel only', () => {
    const tabs = [file, spec('we ird:id', 'Weird')];
    const { getByRole } = render(EditorTabs, { ...base, tabs, activeId: 'spec:we ird:id' });
    const t = getByRole('tab', { name: 'Weird' });
    expect(t.id).toBe('editor-tab-spec_we_ird_id');
    expect(t.getAttribute('aria-controls')).toBe('editor-panel-spec');
    expect(getByRole('tab', { name: 'a.bin' }).hasAttribute('aria-controls')).toBe(false);
  });

  it('scrolls the active tab into view when there are many', async () => {
    const tabs = [file, ...Array.from({ length: 12 }, (_, i) => spec('s' + i))];
    const { getByRole, rerender } = render(EditorTabs, { ...base, tabs, activeId: 'file' });
    const box = getByRole('tablist');
    Object.defineProperty(box, 'clientWidth', { configurable: true, value: 300 });
    for (const el of box.querySelectorAll<HTMLElement>('.tab')) {
      const i = [...box.children].indexOf(el);
      Object.defineProperty(el, 'offsetLeft', { configurable: true, value: i * 120 });
      Object.defineProperty(el, 'offsetWidth', { configurable: true, value: 120 });
    }
    await rerender({ ...base, tabs, activeId: 'spec:s9' });
    expect(box.scrollLeft).toBe(10 * 120 + 120 - 300);
  });
});

describe('EditorTabs icons', () => {
  const icon = (el: HTMLElement) => el.querySelector('svg.icon');

  it('every tab has an aria-hidden inline glyph in the activity bar line style: binary file for the file, braces for specs', () => {
    const { getByRole } = render(EditorTabs, { ...base, tabs: [file, spec('a', 'Alpha')], activeId: 'file' });
    const f = icon(getByRole('tab', { name: 'a.bin' }))!;
    const s = icon(getByRole('tab', { name: 'Alpha' }))!;
    expect(f.getAttribute('data-icon')).toBe('file');
    expect(s.getAttribute('data-icon')).toBe('spec');
    for (const svg of [f, s]) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('focusable')).toBe('false');
      expect(svg.getAttribute('stroke-width')).toBe('1.6'); // the activity bar's
      expect(svg.getAttribute('stroke')).toBe('currentColor');
    }
    expect(f.innerHTML).not.toBe(s.innerHTML);
  });

  it('the glyph does not change the tab name, and the file tab may be shown as a BMP image or a ZIP archive', () => {
    const { getByRole } = render(EditorTabs, { ...base, tabs: [{ ...file, icon: 'bmp' }, spec('a', 'Alpha')], activeId: 'file' });
    expect(getByRole('tab', { name: 'a.bin' })).toBeTruthy();
    expect(icon(getByRole('tab', { name: 'a.bin' }))!.getAttribute('data-icon')).toBe('bmp');
    cleanup();
    const zip = render(EditorTabs, { ...base, tabs: [{ ...file, icon: 'zip' }], activeId: 'file' });
    expect(icon(zip.getByRole('tab', { name: 'a.bin' }))!.getAttribute('data-icon')).toBe('zip');
    const all = new Set(['file', 'bmp', 'zip', 'spec']);
    expect(all.size).toBe(4);
  });

  it('the four glyphs are different drawings', () => {
    const drawn = (t: EditorTab) => {
      const r = render(EditorTabs, { ...base, tabs: [t], activeId: t.id });
      const html = r.container.querySelector('svg.icon')!.innerHTML;
      r.unmount();
      return html;
    };
    const set = new Set([drawn({ ...file, icon: 'file' }), drawn({ ...file, icon: 'bmp' }), drawn({ ...file, icon: 'zip' }), drawn(spec('a'))]);
    expect(set.size).toBe(4);
  });
});
