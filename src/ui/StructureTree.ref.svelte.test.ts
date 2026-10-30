// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Node } from '../core/engine';
import StructureTree from './StructureTree.svelte';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 440 });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

let nextId = 1;
const n = (name: string, offset: number, size: number, extra: Partial<Node> = {}): Node => ({ id: nextId++, name, typeName: 'u1', offset, size, ...extra });
const rowsOf = (c: HTMLElement) => [...c.querySelectorAll('[role="treeitem"]')] as HTMLElement[];
const row = (c: HTMLElement, name: string) => rowsOf(c).find((r) => r.querySelector('.nm')?.textContent === name)!;
const noPage = async () => ({ nodes: [], lazy: null });

function sample() {
  const ptr = n('ptr', 0, 1, { value: 6, ref: { typeName: 'blob', offset: 0xa } });
  const root = n('file', 0, 12, { children: [ptr, n('pad', 1, 5)] });
  const target = n('blob', 10, 2, { typeName: 'blob', children: [n('b0', 10, 1), n('b1', 11, 1)] });
  return { root, ptr, target };
}

describe('StructureTree references', () => {
  it('shows a marker, an "open <type> @ offset" row on expand, and opens the target as children on click', async () => {
    const { root, ptr, target } = sample();
    const loadRef = vi.fn(async () => [target]);
    const onSelect = vi.fn();
    const { container } = render(StructureTree, { root, loadPage: noPage, loadRef, onSelect });
    await waitFor(() => row(container, 'ptr'));
    expect(row(container, 'ptr').querySelector('.refmark')).not.toBeNull();
    expect(row(container, 'ptr').getAttribute('aria-expanded')).toBe('false');

    await fireEvent.click(row(container, 'ptr').querySelector('[data-twisty]')!);
    const open = container.querySelector('[data-ref]') as HTMLElement;
    expect(open.textContent).toContain('open blob @ 0xA');

    await fireEvent.click(open);
    expect(loadRef).toHaveBeenCalledWith(ptr.id);
    await waitFor(() => expect(row(container, 'blob')).toBeTruthy());
    expect(container.querySelector('[data-ref]')).toBeNull(); // the affordance is gone once opened
    expect(ptr.children).toEqual([target]);
    expect(ptr.ref?.loaded).toBe(true);
    expect(row(container, 'blob').getAttribute('aria-selected')).toBe('true');
    expect(onSelect).toHaveBeenLastCalledWith(target, { start: 10, end: 11 }); // selecting target nodes jumps like normal ones
    await fireEvent.click(row(container, 'b1'));
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'b1' }), { start: 11, end: 11 });
  });

  it('a failed open shows a message and keeps the row', async () => {
    const { root, ptr } = sample();
    const loadRef = vi.fn(async () => {
      throw new Error('worker is busy');
    });
    const { container } = render(StructureTree, { root, loadPage: noPage, loadRef, onSelect: () => {} });
    await waitFor(() => row(container, 'ptr'));
    await fireEvent.click(row(container, 'ptr').querySelector('[data-twisty]')!);
    await fireEvent.click(container.querySelector('[data-ref]')!);
    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('worker is busy'));
    expect(container.querySelector('[data-ref]')).not.toBeNull();
    expect(ptr.ref?.loaded).toBeUndefined();
  });

  it('an empty answer (aborted / failed open) reports and leaves the ref unopened', async () => {
    const { root } = sample();
    const { container } = render(StructureTree, { root, loadPage: noPage, loadRef: async () => [], onSelect: () => {} });
    await waitFor(() => row(container, 'ptr'));
    await fireEvent.click(row(container, 'ptr').querySelector('[data-twisty]')!);
    await fireEvent.click(container.querySelector('[data-ref]')!);
    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not open the reference'));
  });
});
