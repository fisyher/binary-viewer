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
const JUMPS = [
  { label: 'header', path: 'header' },
  { label: 'data', path: 'inner.data' },
  { label: 'descriptor', path: 'descriptor' },
];

function sample() {
  const off = n('off', 0, 4, { value: 20, link: { offset: 20, size: 8, label: 'blob' } });
  const ptr = n('ptr', 4, 4, { value: 40, ref: { typeName: 'entry', offset: 40, jumps: JUMPS } });
  const root = n('file', 0, 8, { children: [off, ptr] });
  const target = (): Node =>
    n('entry', 40, 30, { typeName: 'entry', fromRef: true, children: [n('header', 40, 10), n('inner', 50, 20, { children: [n('data', 55, 15)] })] });
  return { root, off, ptr, target };
}
const buttons = (r: HTMLElement, sel: string) => [...r.querySelectorAll(sel)] as HTMLButtonElement[];

describe('StructureTree link button', () => {
  it('shows "→ label", is a labelled button, and calls onJump with offset and size without selecting or toggling the row', async () => {
    const { root, off } = sample();
    const onSelect = vi.fn();
    const onJump = vi.fn();
    const { container } = render(StructureTree, { root, loadPage: noPage, onSelect, onJump });
    await waitFor(() => row(container, 'off'));
    const [btn] = buttons(row(container, 'off'), 'button[data-link]');
    expect(btn!.tagName).toBe('BUTTON');
    expect(btn!.textContent).toBe('→ blob');
    expect(btn!.getAttribute('aria-label')).toBe('Go to blob (offset 0x14) from off');
    await fireEvent.click(btn!);
    expect(onJump).toHaveBeenCalledExactlyOnceWith(20, 8);
    expect(onSelect).not.toHaveBeenCalled();
    expect(row(container, 'off').getAttribute('aria-selected')).toBe('false');
    await fireEvent.dblClick(btn!);
    expect(row(container, 'file').getAttribute('aria-expanded')).toBe('true');
    expect(off.link).toBeDefined();
  });

  it('a caret-only link (size 0) reports size 0; a link without a label shows the hex offset', async () => {
    const a = n('a', 0, 1, { link: { offset: 9, size: 0 } });
    const root = n('file', 0, 1, { children: [a] });
    const onJump = vi.fn();
    const { container } = render(StructureTree, { root, loadPage: noPage, onSelect: () => {}, onJump });
    await waitFor(() => row(container, 'a'));
    const btn = buttons(row(container, 'a'), 'button[data-link]')[0]!;
    expect(btn.textContent).toBe('→ 0x9');
    await fireEvent.click(btn);
    expect(onJump).toHaveBeenCalledWith(9, 0);
  });

  it('is keyboard accessible: Enter and Space on the focused button are left to the browser (not swallowed by the tree)', async () => {
    const { root } = sample();
    const { container } = render(StructureTree, { root, loadPage: noPage, onSelect: () => {}, onJump: () => {} });
    await waitFor(() => row(container, 'off'));
    const btn = buttons(row(container, 'off'), 'button[data-link]')[0]!;
    for (const key of ['Enter', ' ']) {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      btn.dispatchEvent(ev);
      expect(ev.defaultPrevented, key).toBe(false);
    }
    // while the same keys on the tree itself are still handled
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    container.querySelector('[role="tree"]')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('shows no link button without an onJump handler', async () => {
    const { root } = sample();
    const { container } = render(StructureTree, { root, loadPage: noPage, onSelect: () => {} });
    await waitFor(() => row(container, 'off'));
    expect(container.querySelector('button[data-link]')).toBeNull();
  });

  it('shows hostile labels as text only', async () => {
    const a = n('a', 0, 1, { link: { offset: 1, size: 1, label: '<img src=x onerror=1>' } });
    const root = n('file', 0, 1, { children: [a] });
    const { container } = render(StructureTree, { root, loadPage: noPage, onSelect: () => {}, onJump: () => {} });
    await waitFor(() => row(container, 'a'));
    expect(container.querySelector('img')).toBeNull();
    expect(buttons(row(container, 'a'), 'button[data-link]')[0]!.textContent).toBe('→ <img src=x onerror=1>');
  });
});

describe('StructureTree ref jumps', () => {
  it('shows one button per jump on the ref row; an unopened ref is opened (once) and the node at the path is selected', async () => {
    const { root, ptr, target } = sample();
    const t = target();
    const loadRef = vi.fn(async () => [t]);
    const onSelect = vi.fn();
    const { container } = render(StructureTree, { root, loadPage: noPage, loadRef, onSelect });
    await waitFor(() => row(container, 'ptr'));
    const btns = buttons(row(container, 'ptr'), 'button[data-jump]');
    expect(btns.map((b) => b.textContent)).toEqual(['header', 'data', 'descriptor']);
    expect(btns[1]!.getAttribute('aria-label')).toBe('Jump to data of ptr');
    await fireEvent.click(btns[1]!);
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(loadRef).toHaveBeenCalledExactlyOnceWith(ptr.id);
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'data' }), { start: 55, end: 69 });
    expect(ptr.ref?.loaded).toBe(true);
    expect(ptr.children).toEqual([t]);
    await waitFor(() => expect(row(container, 'data')?.getAttribute('aria-selected')).toBe('true'));
    expect(row(container, 'inner')).toBeTruthy(); // ancestors are expanded so the node is visible
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('on an already opened ref it selects directly without asking the worker again', async () => {
    const { root, ptr, target } = sample();
    const t = target();
    ptr.children = [t];
    ptr.ref = { ...ptr.ref!, loaded: true };
    const loadRef = vi.fn(async () => [t]);
    const onSelect = vi.fn();
    const { container } = render(StructureTree, { root, loadPage: noPage, loadRef, onSelect });
    await waitFor(() => row(container, 'ptr'));
    await fireEvent.click(buttons(row(container, 'ptr'), 'button[data-jump]')[0]!);
    expect(loadRef).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'header' }), { start: 40, end: 49 });
    await waitFor(() => expect(row(container, 'header').getAttribute('aria-selected')).toBe('true'));
  });

  it('a path that is not in the target selects the target and shows a short message', async () => {
    const { root, target } = sample();
    const t = target();
    const onSelect = vi.fn();
    const { container } = render(StructureTree, { root, loadPage: noPage, loadRef: async () => [t], onSelect });
    await waitFor(() => row(container, 'ptr'));
    await fireEvent.click(buttons(row(container, 'ptr'), 'button[data-jump]')[2]!);
    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toBe('"descriptor" is not available: descriptor was not parsed in this entry (see Diagnostics).'));
    expect(onSelect).toHaveBeenLastCalledWith(t, { start: 40, end: 69 });
  });

  it('a failed or superseded open selects nothing; superseded stays silent', async () => {
    const { root } = sample();
    const onSelect = vi.fn();
    const sup = Object.assign(new Error('superseded'), { name: 'SupersededError' });
    const loadRef = vi.fn().mockRejectedValueOnce(sup).mockRejectedValueOnce(new Error('worker is busy'));
    const { container } = render(StructureTree, { root, loadPage: noPage, loadRef, onSelect });
    await waitFor(() => row(container, 'ptr'));
    const btn = () => buttons(row(container, 'ptr'), 'button[data-jump]')[0]!;
    await fireEvent.click(btn());
    await waitFor(() => expect(loadRef).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await fireEvent.click(btn());
    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('worker is busy'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('repeated clicks while the ref is opening open it once and the newest jump wins', async () => {
    const { root, target } = sample();
    const t = target();
    let done!: (v: Node[]) => void;
    const loadRef = vi.fn(() => new Promise<Node[]>((r) => (done = r)));
    const onSelect = vi.fn();
    const { container } = render(StructureTree, { root, loadPage: noPage, loadRef, onSelect });
    await waitFor(() => row(container, 'ptr'));
    const btns = buttons(row(container, 'ptr'), 'button[data-jump]');
    await fireEvent.click(btns[0]!);
    await fireEvent.click(btns[0]!);
    await fireEvent.click(btns[1]!);
    expect(loadRef).toHaveBeenCalledTimes(1);
    done([t]);
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'data' }), { start: 55, end: 69 });
  });

  it('a jump on another reference cancels the selection of an earlier, slower one', async () => {
    const p1 = n('p1', 0, 1, { ref: { typeName: 'entry', offset: 40, jumps: JUMPS } });
    const p2 = n('p2', 1, 1, { ref: { typeName: 'entry', offset: 40, jumps: JUMPS } });
    const root = n('file', 0, 2, { children: [p1, p2] });
    const t1 = n('entry', 40, 5, { fromRef: true, children: [n('header', 40, 5)] });
    const t2 = n('entry', 40, 5, { fromRef: true, children: [n('header', 40, 5)] });
    const resolvers: Array<(v: Node[]) => void> = [];
    const loadRef = vi.fn(() => new Promise<Node[]>((r) => resolvers.push(r)));
    const onSelect = vi.fn();
    const { container } = render(StructureTree, { root, loadPage: noPage, loadRef, onSelect });
    await waitFor(() => row(container, 'p1'));
    await fireEvent.click(buttons(row(container, 'p1'), 'button[data-jump]')[0]!);
    await fireEvent.click(buttons(row(container, 'p2'), 'button[data-jump]')[0]!);
    resolvers[1]!([t2]);
    resolvers[0]!([t1]);
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(p1.ref?.loaded).toBe(true); // still attached, just not selected
  });

  it('jump buttons do not toggle or select the row', async () => {
    const { root, target } = sample();
    const t = target();
    const onSelect = vi.fn();
    const { container } = render(StructureTree, { root, loadPage: noPage, loadRef: async () => [t], onSelect });
    await waitFor(() => row(container, 'ptr'));
    const btn = buttons(row(container, 'ptr'), 'button[data-jump]')[2]!;
    await fireEvent.dblClick(btn);
    expect(row(container, 'ptr').getAttribute('aria-expanded')).toBe('false');
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('StructureTree jump ordering and focus', () => {
  const mk = (name: string, offset: number) => n(name, offset, 1, { ref: { typeName: 'entry', offset: 40, jumps: JUMPS } });
  const tgt = () => n('entry', 40, 5, { fromRef: true, children: [n('header', 40, 5)] });

  it('A1 -> C -> A2: the newest click (the second one on A, while A is still loading) is the one that selects', async () => {
    const a = mk('a', 0);
    const c = mk('c', 1);
    const root = n('file', 0, 2, { children: [a, c] });
    const resolvers = new Map<number, (v: Node[]) => void>();
    const loadRef = vi.fn((id: number) => new Promise<Node[]>((r) => resolvers.set(id, r)));
    const onSelect = vi.fn();
    const { container } = render(StructureTree, { root, loadPage: noPage, loadRef, onSelect });
    await waitFor(() => row(container, 'a'));
    const jb = (name: string, i: number) => buttons(row(container, name), 'button[data-jump]')[i]!;
    await fireEvent.click(jb('a', 0)); // A1: header
    await fireEvent.click(jb('c', 0)); // C
    await fireEvent.click(jb('a', 1)); // A2: data (the newest click)
    expect(loadRef).toHaveBeenCalledTimes(2);
    const ta = n('entry', 40, 20, { fromRef: true, children: [n('header', 40, 5), n('inner', 45, 15, { children: [n('data', 50, 10)] })] });
    resolvers.get(c.id)!([tgt()]);
    resolvers.get(a.id)!([ta]);
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'data' }), { start: 50, end: 59 });
  });

  it('a jump clicked while Enter / the "open" row is loading the same ref is honoured when it opens', async () => {
    const a = mk('a', 0);
    const root = n('file', 0, 1, { children: [a] });
    let done!: (v: Node[]) => void;
    const loadRef = vi.fn(() => new Promise<Node[]>((r) => (done = r)));
    const onSelect = vi.fn();
    const { container } = render(StructureTree, { root, loadPage: noPage, loadRef, onSelect });
    await waitFor(() => row(container, 'a'));
    await fireEvent.click(row(container, 'a').querySelector('[data-twisty]')!);
    await fireEvent.click(container.querySelector('[data-ref]')!); // open row
    await fireEvent.click(buttons(row(container, 'a'), 'button[data-jump]')[0]!);
    await fireEvent.click(container.querySelector('[data-ref]')!); // a second open click is a no-op
    expect(loadRef).toHaveBeenCalledTimes(1);
    done([tgt()]);
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'header' }), { start: 40, end: 44 });
  });

  it('a failed open drops the pending jump: a later plain open selects the target, not the old jump', async () => {
    const a = mk('a', 0);
    const root = n('file', 0, 1, { children: [a] });
    const t = tgt();
    const loadRef = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce([t]);
    const onSelect = vi.fn();
    const { container } = render(StructureTree, { root, loadPage: noPage, loadRef, onSelect });
    await waitFor(() => row(container, 'a'));
    await fireEvent.click(buttons(row(container, 'a'), 'button[data-jump]')[1]!);
    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('busy'));
    await fireEvent.click(row(container, 'a').querySelector('[data-twisty]')!);
    await fireEvent.click(container.querySelector('[data-ref]')!);
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect).toHaveBeenLastCalledWith(t, { start: 40, end: 44 });
  });

  it('a load from a replaced tree that fails late does not drop a pending jump on the new tree (same node id)', async () => {
    const a = mk('a', 0);
    const root = n('file', 0, 1, { children: [a] });
    const calls: Array<{ resolve: (v: Node[]) => void; reject: (e: Error) => void }> = [];
    const loadRef = vi.fn(() => new Promise<Node[]>((resolve, reject) => calls.push({ resolve, reject })));
    const onSelect = vi.fn();
    const { container, rerender } = render(StructureTree, { root, loadPage: noPage, loadRef, onSelect });
    await waitFor(() => row(container, 'a'));
    await fireEvent.click(buttons(row(container, 'a'), 'button[data-jump]')[0]!);
    const a2: Node = { ...a, ref: { typeName: 'entry', offset: 40, jumps: JUMPS } }; // a re-parse reuses the id
    await rerender({ root: n('file', 0, 1, { children: [a2] }) });
    await waitFor(() => row(container, 'a'));
    await fireEvent.click(buttons(row(container, 'a'), 'button[data-jump]')[0]!);
    expect(loadRef).toHaveBeenCalledTimes(2);
    calls[0]!.reject(new Error('stale'));
    await new Promise((r) => setTimeout(r, 10));
    calls[1]!.resolve([tgt()]);
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'header' }), { start: 40, end: 44 });
  });

  it('after a link click focus returns to the tree and ArrowDown moves the selection', async () => {
    const { root } = sample();
    const onSelect = vi.fn();
    const { container } = render(StructureTree, { root, loadPage: noPage, onSelect, onJump: () => {} });
    await waitFor(() => row(container, 'off'));
    await fireEvent.click(row(container, 'off'));
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'off' }), expect.anything());
    const btn = buttons(row(container, 'off'), 'button[data-link]')[0]!;
    btn.focus();
    await fireEvent.click(btn);
    const tree = container.querySelector('[role="tree"]') as HTMLElement;
    expect(document.activeElement).toBe(tree);
    // arrow keys also work with the button still focused
    btn.focus();
    await fireEvent.keyDown(btn, { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'ptr' }), expect.anything());
  });

  it('after a jump click focus returns to the tree', async () => {
    const { root, target } = sample();
    const { container } = render(StructureTree, { root, loadPage: noPage, loadRef: async () => [target()], onSelect: () => {} });
    await waitFor(() => row(container, 'ptr'));
    const btn = buttons(row(container, 'ptr'), 'button[data-jump]')[0]!;
    btn.focus();
    await fireEvent.click(btn);
    expect(document.activeElement).toBe(container.querySelector('[role="tree"]'));
  });
});
