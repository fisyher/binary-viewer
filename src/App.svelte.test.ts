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
afterEach(cleanup);

async function pick(container: HTMLElement, file: unknown) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await fireEvent.change(input);
}

describe('App', () => {
  it('shows an empty-file message and disables Go for a 0-byte file', async () => {
    const { container, findByText, getByRole } = render(App);
    await pick(container, new File([], 'empty.bin'));
    await findByText('Empty file (0 bytes)');
    expect((getByRole('button', { name: 'Go' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a stale slow load cannot override a newer one', async () => {
    const { container, findByText, queryByText } = render(App);
    let releaseSlow!: () => void;
    const slow = {
      name: 'slow.bin',
      size: 10,
      slice: () => ({
        arrayBuffer: () => new Promise<ArrayBuffer>((r) => (releaseSlow = () => r(new ArrayBuffer(1)))),
      }),
    };
    await pick(container, slow);
    await pick(container, new File([new Uint8Array([1, 2, 3])], 'fast.bin'));
    await findByText('fast.bin');
    releaseSlow();
    await new Promise((r) => setTimeout(r, 10));
    expect(queryByText('slow.bin')).toBeNull();
    await waitFor(() => expect(queryByText('fast.bin')).not.toBeNull());
  });
});
