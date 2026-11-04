// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Breadcrumb from './Breadcrumb.svelte';
import type { Crumb } from './breadcrumb';

let cssW = 0;
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => cssW });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  cssW = 0;
});

const crumb = (id: number, name: string, over: Partial<Crumb> = {}): Crumb => ({
  id,
  name,
  typeName: 'struct',
  offset: id * 16,
  size: 8,
  label: name,
  reveal: { path: [1, id], lazyIndex: null, offset: null },
  ...over,
});

describe('Breadcrumb', () => {
  it('is a labelled nav with one button per segment; the last is the current location and the separators are hidden', () => {
    const crumbs = [crumb(1, 'bmp'), crumb(2, 'header'), crumb(3, 'width')];
    const { getByRole, getAllByRole, container } = render(Breadcrumb, { crumbs, hasStructure: true, onSelect: () => {} });
    expect(getByRole('navigation', { name: 'Structure path' })).toBeTruthy();
    const buttons = getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['bmp', 'header', 'width']);
    expect(buttons.map((b) => b.getAttribute('aria-current'))).toEqual([null, null, 'location']);
    expect(buttons[2]!.getAttribute('title')).toBe('width : struct @ 0x30 (size 8)');
    const seps = [...container.querySelectorAll('.sep')];
    expect(seps).toHaveLength(2);
    expect(seps.every((s) => s.getAttribute('aria-hidden') === 'true' && s.textContent === '›')).toBe(true);
    expect(container.querySelector('ol')).toBeTruthy();
  });

  it('shows just the root segment when only the root is given', () => {
    const { getAllByRole } = render(Breadcrumb, { crumbs: [crumb(1, 'bmp')], hasStructure: true, onSelect: () => {} });
    const b = getAllByRole('button');
    expect(b).toHaveLength(1);
    expect(b[0]!.getAttribute('aria-current')).toBe('location');
  });

  it('shows a muted "No structure" that is not a button when there is no parse', () => {
    const { getByText, queryAllByRole } = render(Breadcrumb, { crumbs: [], hasStructure: false, onSelect: () => {} });
    expect(getByText('No structure').tagName).not.toBe('BUTTON');
    expect(queryAllByRole('button')).toHaveLength(0);
  });

  it('clicking a segment reports it', async () => {
    const onSelect = vi.fn();
    const crumbs = [crumb(1, 'bmp'), crumb(2, 'header'), crumb(3, 'width')];
    const { getByRole } = render(Breadcrumb, { crumbs, hasStructure: true, onSelect });
    await fireEvent.click(getByRole('button', { name: 'header' }));
    expect(onSelect).toHaveBeenLastCalledWith(crumbs[1]);
    await fireEvent.click(getByRole('button', { name: 'width' }));
    expect(onSelect).toHaveBeenLastCalledWith(crumbs[2]);
  });

  it('collapses the leading segments to "…" when the path does not fit, and "…" selects the nearest hidden one', async () => {
    cssW = 14 * 7; // about 14 characters
    const onSelect = vi.fn();
    const crumbs = [crumb(1, 'bmp'), crumb(2, 'header'), crumb(3, 'fields'), crumb(4, 'width')];
    const { getAllByRole, getByRole } = render(Breadcrumb, { crumbs, hasStructure: true, onSelect });
    const labels = getAllByRole('button').map((b) => b.textContent);
    expect(labels[0]).toBe('…');
    expect(labels.at(-1)).toBe('width');
    expect(labels.length).toBeLessThan(5);
    const more = getByRole('button', { name: /^Show parent: / });
    expect(more.getAttribute('title')).toContain('bmp');
    await fireEvent.click(more);
    const hidden = 5 - labels.length; // number of segments behind the ellipsis
    expect(onSelect).toHaveBeenLastCalledWith(crumbs[hidden - 1]);
  });
});
