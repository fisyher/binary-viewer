// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import App from './App.svelte';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function pick(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await fireEvent.change(input);
}

const cell = (c: HTMLElement, id: string) => c.querySelector(`[data-id="${id}"] td`)?.textContent;

describe('App + Inspector', () => {
  it('selecting a byte in the hex view updates the inspector; loading a new file resets it', async () => {
    const { container, findByText } = render(App);
    await findByText('Select a byte to inspect.');

    await pick(container, new File([new Uint8Array([0x10, 0x20, 0x30, 0x40])], 'a.bin'));
    await waitFor(() => expect(container.querySelector('[data-o="1"]')).not.toBeNull());
    await fireEvent.mouseDown(container.querySelector('.b[data-o="1"]')!);
    await waitFor(() => expect(cell(container, 'uint8')).toBe('32')); // 0x20
    expect(cell(container, 'uint16')).toBe(String(0x3020)); // LE default
    expect(container.querySelector('.at')?.textContent).toBe('@ 0x00000001');

    await fireEvent.mouseDown(container.querySelector('.b[data-o="3"]')!);
    await waitFor(() => expect(cell(container, 'uint8')).toBe('64'));
    expect(cell(container, 'uint16')).toBe('n/a');

    await pick(container, new File([new Uint8Array([9, 9])], 'b.bin'));
    await findByText('Select a byte to inspect.');
    expect(container.querySelector('[data-id]')).toBeNull();
  });
});
