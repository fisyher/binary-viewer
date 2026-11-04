// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import App from './App.svelte';
import { SpecLibrary } from './core/spec-library';
import { createMemoryStore } from './core/spec-store';
import { builtins, specText } from './test/spec-fixtures';
import { createInlineClient } from './worker/inline-client';

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

const T = { timeout: 4000 };
const MAGIC = [0xde, 0xad, 0xbe, 0xef];
const fixed = specText('fixedarr', {
  name: 'Fixed',
  detect: [{ at: 0, bytes: 'DE AD BE EF' }],
  types: { root: { fields: [{ name: 'sig', type: 'u4' }, { name: 'arr', type: 'u1', repeat: { count: 3000 } }] } },
});
const variable = specText('vararr', {
  name: 'Variable',
  detect: [{ at: 0, bytes: 'DE AD BE EF' }],
  types: {
    root: { fields: [{ name: 'sig', type: 'u4' }, { name: 'recs', type: 'rec', at: 4, repeat: { until: '_.a == 0' } }] },
    rec: { fields: [{ name: 'a', type: 'u1' }, { name: 'b', type: 'u1' }] },
  },
});

const names = (root: Element) => [...root.querySelectorAll('[role="treeitem"] .nm')].map((e) => e.textContent);
const viewerTree = (c: HTMLElement) => c.querySelector<HTMLElement>('.views > .view')!;

async function open(specId: string, specSrc: string, bytes: number[], lazyName: string) {
  const lib = new SpecLibrary({ store: createMemoryStore(), builtins: builtins() });
  await lib.init();
  await lib.create(specId);
  await lib.save(specId, specSrc);
  const client = createInlineClient();
  const counts = { overview: 0, expand: 0 };
  const overview = client.overview.bind(client);
  const expand = client.expand.bind(client);
  client.overview = (n) => (counts.overview++, overview(n));
  client.expand = (...a) => (counts.expand++, expand(...a));
  const r = render(App, { createClient: () => client, createLibrary: () => lib });
  const input = r.container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([Uint8Array.from(bytes)], 'big.bin')] });
  await fireEvent.change(input);
  await waitFor(() => expect(names(viewerTree(r.container))).toContain(lazyName), T);
  await waitFor(() => expect(counts.overview).toBeGreaterThan(0), T);
  await new Promise((res) => setTimeout(res, 300)); // let the throttled overview requests settle
  const row = [...viewerTree(r.container).querySelectorAll<HTMLElement>('[role="treeitem"]')].find((x) => x.querySelector('.nm')?.textContent === lazyName)!;
  return { counts, twisty: row.querySelector('[data-twisty]')! };
}

describe('App: overview refresh after a lazy expansion', () => {
  it('a fixed-size page load does not ask the worker for a new overview', async () => {
    const { counts, twisty } = await open('fixedarr', fixed, [...MAGIC, ...new Array<number>(3000).fill(1)], 'arr');
    const overviews = counts.overview;
    const expands = counts.expand;
    await fireEvent.click(twisty);
    await waitFor(() => expect(counts.expand).toBeGreaterThan(expands), T);
    await new Promise((res) => setTimeout(res, 400));
    expect(counts.overview).toBe(overviews);
  });

  it('a variable-size expansion still refreshes the overview', async () => {
    const bytes = [...MAGIC, ...Array.from({ length: 3000 }, () => [1, 1]).flat(), 0, 0];
    const { counts, twisty } = await open('vararr', variable, bytes, 'recs');
    const overviews = counts.overview;
    const expands = counts.expand;
    await fireEvent.click(twisty); // the first 1000 elements are already there; the rest sits behind "Load more…"
    const tree = await waitFor(() => {
      const t = document.querySelector<HTMLElement>('.views > .view [role="tree"]');
      expect(t).not.toBeNull();
      return t!;
    }, T);
    await fireEvent.keyDown(tree, { key: 'End' }); // the "Load more…" row is the last one
    await fireEvent.keyDown(tree, { key: 'Enter' });
    await waitFor(() => expect(counts.expand).toBeGreaterThan(expands), T);
    await waitFor(() => expect(counts.overview).toBeGreaterThan(overviews), T);
  });
});
