// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryByteSource, type ByteSource } from '../core/byte-source';
import Inspector from './Inspector.svelte';

afterEach(cleanup);

/** Source whose reads stay pending until the test settles them. */
function deferredSource(size = 100) {
  const calls: Array<{ offset: number; resolve(b: number[]): void; reject(e: Error): void }> = [];
  const src: ByteSource = {
    size,
    read: (offset) =>
      new Promise((res, rej) => {
        calls.push({ offset, resolve: (b) => res(Uint8Array.from(b)), reject: rej });
      }),
  };
  return { src, calls };
}

const cell = (c: HTMLElement, id: string) => c.querySelector(`[data-id="${id}"] td`)?.textContent;
const settle = () => new Promise((r) => setTimeout(r, 10));

describe('Inspector request ordering', () => {
  it('a slow older read resolving last does not replace newer data', async () => {
    const s = deferredSource();
    const { container, rerender } = render(Inspector, { source: s.src, offset: 0 });
    await waitFor(() => expect(s.calls.length).toBe(1));
    await rerender({ offset: 1 });
    await waitFor(() => expect(s.calls.length).toBe(2));
    s.calls[1]!.resolve([5]); // B (fast)
    await waitFor(() => expect(cell(container, 'uint8')).toBe('5'));
    s.calls[0]!.resolve([9]); // A (slow, stale)
    await settle();
    expect(cell(container, 'uint8')).toBe('5');
  });

  it('a stale read cannot repopulate after the source becomes null', async () => {
    const s = deferredSource();
    const { container, rerender, getByText } = render(Inspector, { source: s.src, offset: 0 });
    await waitFor(() => expect(s.calls.length).toBe(1));
    await rerender({ source: null, offset: null });
    getByText('Select a byte to inspect.');
    s.calls[0]!.resolve([7]);
    await settle();
    expect(container.querySelector('[data-id]')).toBeNull();
    getByText('Select a byte to inspect.');
  });

  it('a stale read from the previous source is ignored after a source switch', async () => {
    const a = deferredSource();
    const b = deferredSource();
    const { container, rerender } = render(Inspector, { source: a.src, offset: 0 });
    await waitFor(() => expect(a.calls.length).toBe(1));
    await rerender({ source: b.src });
    await waitFor(() => expect(b.calls.length).toBe(1));
    b.calls[0]!.resolve([2]);
    await waitFor(() => expect(cell(container, 'uint8')).toBe('2'));
    a.calls[0]!.resolve([1]);
    await settle();
    expect(cell(container, 'uint8')).toBe('2');
  });

  it('an error followed by a successful read clears the alert', async () => {
    const s = deferredSource();
    const { container, rerender, findByRole, queryByRole } = render(Inspector, { source: s.src, offset: 0 });
    await waitFor(() => expect(s.calls.length).toBe(1));
    s.calls[0]!.reject(new Error('boom'));
    expect((await findByRole('alert')).textContent).toContain('boom');
    await rerender({ offset: 1 });
    await waitFor(() => expect(s.calls.length).toBe(2));
    s.calls[1]!.resolve([3]);
    await waitFor(() => expect(cell(container, 'uint8')).toBe('3'));
    expect(queryByRole('alert')).toBeNull();
  });

  it('a stale rejection does not overwrite newer good data', async () => {
    const s = deferredSource();
    const { container, rerender, queryByRole } = render(Inspector, { source: s.src, offset: 0 });
    await waitFor(() => expect(s.calls.length).toBe(1));
    await rerender({ offset: 1 });
    await waitFor(() => expect(s.calls.length).toBe(2));
    s.calls[1]!.resolve([4]);
    await waitFor(() => expect(cell(container, 'uint8')).toBe('4'));
    s.calls[0]!.reject(new Error('late failure'));
    await settle();
    expect(queryByRole('alert')).toBeNull();
    expect(cell(container, 'uint8')).toBe('4');
  });

  it('inspects the last byte of a 1-byte source (wider rows are n/a)', async () => {
    const one = new MemoryByteSource(Uint8Array.from([0xab]));
    const { container } = render(Inspector, { source: one, offset: 0 });
    await waitFor(() => expect(cell(container, 'uint8')).toBe('171'));
    expect(cell(container, 'uint16')).toBe('n/a');
    expect(cell(container, 'guidms')).toBe('n/a');
  });
});

describe('Inspector header and stale values', () => {
  it('shows the decoded offset', async () => {
    const s = deferredSource(0x1000);
    const { container } = render(Inspector, { source: s.src, offset: 0x1f });
    expect(container.querySelector('.at')?.textContent).toBe('@ 0x0000001F');
  });

  it('dims the previous values while a new read is pending', async () => {
    const s = deferredSource();
    const { container, rerender } = render(Inspector, { source: s.src, offset: 0 });
    await waitFor(() => expect(s.calls.length).toBe(1));
    s.calls[0]!.resolve([1]);
    await waitFor(() => expect(cell(container, 'uint8')).toBe('1'));
    expect(container.querySelector('.body.stale')).toBeNull();

    await rerender({ offset: 1 });
    await waitFor(() => expect(s.calls.length).toBe(2));
    expect(container.querySelector('.body.stale')).not.toBeNull();
    expect(container.querySelector('.body')!.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('.at')?.textContent).toBe('@ 0x00000001');

    s.calls[1]!.resolve([2]);
    await waitFor(() => expect(container.querySelector('.body.stale')).toBeNull());
    expect(cell(container, 'uint8')).toBe('2');
  });

  it('puts the DOS little-endian hint on DOS rows', async () => {
    const one = new MemoryByteSource(new Uint8Array(8));
    const { container } = render(Inspector, { source: one, offset: 0 });
    await waitFor(() => expect(cell(container, 'dosdate')).toBeDefined());
    expect(container.querySelector('[data-id="dosdate"]')!.getAttribute('title')).toMatch(/little-endian/);
  });
});
