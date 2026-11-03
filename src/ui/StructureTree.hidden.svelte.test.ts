// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Node } from '../core/engine';
import StructureTree from './StructureTree.svelte';

// A tree that is not shown (a collapsed side bar) has no height; the test grows it by hand.
let height = 0;
type RO = { cb: (entries: Array<{ target: Element }>) => void; els: Element[] };
const observers: RO[] = []; // Svelte keeps one module-level observer: never reset this list
function resizeTo(h: number) {
  height = h;
  for (const o of observers) o.cb(o.els.filter((e) => e.isConnected).map((target) => ({ target })));
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => height });
  globalThis.ResizeObserver = class {
    private o: RO;
    constructor(cb: RO['cb']) {
      this.o = { cb, els: [] };
      observers.push(this.o);
    }
    observe(el: Element) {
      this.o.els.push(el);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  height = 0;
});

const noLoad = async () => ({ nodes: [], lazy: null });
/** A tree of `count` children c0.. whose ids start at `firstId` (a second parse reuses the ids of the first). */
const tree = (firstId: number, count: number): Node => ({
  id: firstId,
  name: 'root',
  typeName: 'r',
  offset: 0,
  size: count,
  children: Array.from({ length: count }, (_, i) => ({ id: firstId + 1 + i, name: `c${i}`, typeName: 'u1', offset: i, size: 1 })),
});

describe('StructureTree that is not shown', () => {
  it('a reveal made while it had no height scrolls to the row once it is shown', async () => {
    const root = tree(5000, 80);
    const { container, component } = render(StructureTree, { root, loadPage: noLoad, onSelect: () => {} });
    await component.reveal([root.id, root.children![60]!.id]);
    resizeTo(240); // 10 rows
    const scroller = container.querySelector('.scroller') as HTMLElement;
    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0));
    await waitFor(() => expect(container.querySelector('[role="treeitem"][aria-selected="true"]')).not.toBeNull());
  });

  it('a pending reveal is dropped when another tree replaces it (node ids are reused by the next parse)', async () => {
    const root = tree(5000, 80);
    const { container, component, rerender } = render(StructureTree, { root, loadPage: noLoad, onSelect: () => {} });
    await component.reveal([root.id, root.children![60]!.id]); // remembered: the tree has no height
    await rerender({ root: tree(5000, 80) }); // same ids, new tree
    resizeTo(240);
    const scroller = container.querySelector('.scroller') as HTMLElement;
    await waitFor(() => expect(container.querySelector('[role="treeitem"]')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 30));
    expect(scroller.scrollTop).toBe(0);
    expect(container.querySelector('[role="treeitem"][aria-selected="true"]')).toBeNull();
  });

  it('clearSelection() drops a remembered reveal: showing the tree later does not scroll to it', async () => {
    const root = tree(5000, 80);
    const { container, component } = render(StructureTree, { root, loadPage: noLoad, onSelect: () => {} });
    await component.reveal([root.id, root.children![60]!.id]); // remembered: the tree has no height
    component.clearSelection();
    resizeTo(240);
    const scroller = container.querySelector('.scroller') as HTMLElement;
    await waitFor(() => expect(container.querySelector('[role="treeitem"]')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 30));
    // jsdom keeps the scrollTop asked for while hidden (a browser clamps it to 0); what must not happen is the centred scroll of the dropped reveal
    expect(scroller.scrollTop).not.toBe(61 * 24 - 240 / 2);
  });
});
