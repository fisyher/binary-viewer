// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryByteSource } from '../core/byte-source';
import Inspector from './Inspector.svelte';
import { loadLittleEndian, saveLittleEndian } from './prefs';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

const source = new MemoryByteSource(Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0xff, 0xff, 0xff, 0xff, 0x41]));
const cell = (c: HTMLElement, id: string) => c.querySelector(`[data-id="${id}"] td`)?.textContent;

describe('Inspector', () => {
  it('hints how to pick a byte when nothing is selected, naming the palette shortcut (there is no Go to key of its own)', () => {
    const { getByText } = render(Inspector, { source, offset: null });
    getByText('Click a byte, or press Ctrl+K and choose Go to offset.');
  });

  it('says the file is empty when it has no bytes, instead of asking to click one', () => {
    const { getByText, queryByText } = render(Inspector, { source: null, offset: null, hasFile: true, empty: true });
    getByText('The file is empty.');
    expect(queryByText(/Click a byte/)).toBeNull();
  });

  it('asks for a file when none is open', () => {
    const { getByText, queryByText } = render(Inspector, { source: null, offset: null, hasFile: false });
    getByText('Open a file to inspect its bytes.');
    expect(queryByText(/Click a byte/)).toBeNull();
  });

  it('says Cmd+K on macOS', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const { getByText } = render(Inspector, { source, offset: null });
    getByText('Click a byte, or press Cmd+K and choose Go to offset.');
  });

  it('updates when the caret moves', async () => {
    const { container, rerender } = render(Inspector, { source, offset: 0 });
    await waitFor(() => expect(cell(container, 'uint16')).toBe('513')); // 0x0201 LE
    await rerender({ offset: 2 });
    await waitFor(() => expect(cell(container, 'uint16')).toBe('1027')); // 0x0403
    await rerender({ offset: 8 }); // last byte: wider types are n/a, never partial
    await waitFor(() => expect(cell(container, 'uint8')).toBe('65'));
    expect(cell(container, 'uint16')).toBe('n/a');
    expect(cell(container, 'latin1')).toBe('A');
  });

  it('flips between little- and big-endian with the toggle', async () => {
    const { container, getByRole } = render(Inspector, { source, offset: 0 });
    await waitFor(() => expect(cell(container, 'uint16')).toBe('513'));
    const btn = getByRole('button', { name: /little-endian/ });
    expect(btn.textContent).toBe('LE');
    await fireEvent.click(btn);
    expect(getByRole('button', { name: /big-endian/ }).textContent).toBe('BE');
    expect(cell(container, 'uint16')).toBe('258'); // 0x0102
    expect(cell(container, 'uint32')).toBe(String(0x01020304));
    await fireEvent.click(getByRole('button', { name: /big-endian/ }));
    expect(cell(container, 'uint16')).toBe('513');
  });

  it('shows an error if the read fails', async () => {
    const bad = { size: 4, read: () => Promise.reject(new Error('nope')) };
    const { findByRole } = render(Inspector, { source: bad, offset: 0 });
    expect((await findByRole('alert')).textContent).toContain('nope');
  });
});

describe('prefs', () => {
  it('defaults to little-endian and round-trips', () => {
    expect(loadLittleEndian()).toBe(true);
    saveLittleEndian(false);
    expect(loadLittleEndian()).toBe(false);
    saveLittleEndian(true);
    expect(loadLittleEndian()).toBe(true);
  });

  it('survives a throwing localStorage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(loadLittleEndian()).toBe(true);
    expect(() => saveLittleEndian(false)).not.toThrow();
  });
});
