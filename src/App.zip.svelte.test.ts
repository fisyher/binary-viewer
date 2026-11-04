// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import App from './App.svelte';
import { formatShown } from './test/format-ui';
import { buildZip } from './test/zip-builder';
import { createInlineClient } from './worker/inline-client';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 3000 });
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

const rowOf = (c: HTMLElement, name: string) => ([...c.querySelectorAll('[role="treeitem"]')] as HTMLElement[]).find((r) => r.querySelector('.nm')?.textContent === name);

describe('App: ZIP', () => {
  it('detects a ZIP, shows the tree and opens a local header through its reference', async () => {
    const { container } = render(App, { createClient: () => createInlineClient() });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([buildZip([{ name: 'a.txt', data: 'hi' }]).bytes], 'a.zip')] });
    await fireEvent.change(input);

    await waitFor(() => expect(formatShown(container)).toBe('ZIP Archive'));
    await waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toMatch(/^Parsed: \d+ nodes, 0 errors, 0 warnings/));
    await waitFor(() => expect(rowOf(container, 'eocd')).toBeTruthy());
    await waitFor(() => expect(rowOf(container, 'central_directory')).toBeTruthy());

    await fireEvent.dblClick(rowOf(container, 'entries')!);
    await fireEvent.dblClick(rowOf(container, 'entries[0]')!);
    await waitFor(() => expect(rowOf(container, 'local_header')).toBeTruthy());
    await fireEvent.dblClick(rowOf(container, 'local_header')!);
    const open = await waitFor(() => {
      const el = container.querySelector('[data-ref]');
      expect(el?.textContent).toMatch(/open local_entry @ 0x0/);
      return el!;
    });
    await fireEvent.click(open);
    await waitFor(() => expect(rowOf(container, 'local_entry')).toBeTruthy());
    await waitFor(() => expect(rowOf(container, 'header')).toBeTruthy());
    expect(rowOf(container, 'local_entry')?.getAttribute('aria-selected')).toBe('true');
  });
});
