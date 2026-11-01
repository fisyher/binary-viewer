// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import App from './App.svelte';
import { SpecLibrary } from './core/spec-library';
import { createMemoryStore } from './core/spec-store';
import { builtins } from './test/spec-fixtures';
import { createInlineClient } from './worker/inline-client';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

async function mount() {
  const lib = new SpecLibrary({ store: createMemoryStore(), builtins: builtins() });
  await lib.init();
  return render(App, { createClient: () => createInlineClient(), createLibrary: () => lib });
}

async function pick(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await fireEvent.change(input);
}

const theme = () => document.documentElement.getAttribute('data-theme');
const sep = (c: HTMLElement, name: string) => within(c).getByRole('separator', { name });
const val = (el: HTMLElement) => Number(el.getAttribute('aria-valuenow'));
const flag = (name: string) => localStorage.getItem('binaryviewer.layout.' + name);

describe('theme', () => {
  it('cycles System, Light, Dark; sets or removes data-theme and remembers the choice', async () => {
    const { getByRole } = await mount();
    expect(theme()).toBeNull();
    expect(getByRole('button', { name: 'Theme: System' })).toBeTruthy();

    await fireEvent.click(getByRole('button', { name: 'Theme: System' }));
    expect(theme()).toBe('light');
    expect(localStorage.getItem('binaryviewer.theme')).toBe('light');
    expect(getByRole('button', { name: 'Theme: Light' })).toBeTruthy();

    await fireEvent.click(getByRole('button', { name: 'Theme: Light' }));
    expect(theme()).toBe('dark');
    expect(localStorage.getItem('binaryviewer.theme')).toBe('dark');

    await fireEvent.click(getByRole('button', { name: 'Theme: Dark' }));
    expect(theme()).toBeNull(); // 'system': the media query decides
    expect(localStorage.getItem('binaryviewer.theme')).toBeNull();
    expect(getByRole('button', { name: 'Theme: System' })).toBeTruthy();
  });

  it('applies the stored theme on startup', async () => {
    localStorage.setItem('binaryviewer.theme', 'dark');
    const { getByRole } = await mount();
    await waitFor(() => expect(theme()).toBe('dark'));
    expect(getByRole('button', { name: 'Theme: Dark' })).toBeTruthy();
  });

  it('ignores a malformed stored theme', async () => {
    localStorage.setItem('binaryviewer.theme', 'neon');
    const { getByRole } = await mount();
    expect(theme()).toBeNull();
    expect(getByRole('button', { name: 'Theme: System' })).toBeTruthy();
  });
});

describe('activity bar and side bar', () => {
  it('switches the side bar view; the active item collapses and expands the side bar', async () => {
    const { container, getByRole, queryByRole } = await mount();
    const structure = getByRole('button', { name: 'Structure' });
    const formats = getByRole('button', { name: 'Formats' });
    const views = () => [...container.querySelectorAll<HTMLElement>('.views > .view')];
    expect(structure.getAttribute('aria-pressed')).toBe('true');
    expect(formats.getAttribute('aria-pressed')).toBe('false');
    expect(views()[0]!.classList.contains('hidden')).toBe(false);
    expect(views()[1]!.classList.contains('hidden')).toBe(true);

    await fireEvent.click(formats);
    expect(formats.getAttribute('aria-pressed')).toBe('true');
    expect(structure.getAttribute('aria-pressed')).toBe('false');
    expect(views()[0]!.classList.contains('hidden')).toBe(true);
    expect(views()[1]!.classList.contains('hidden')).toBe(false);
    expect(views()[0]!.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('aside[aria-label="Formats side bar"]')).not.toBeNull();
    expect(localStorage.getItem('binaryviewer.layout.sideView')).toBe('formats');

    await fireEvent.click(formats); // active item: collapse
    expect(container.querySelector('.side-slot.closed')).not.toBeNull(); // hidden, still mounted
    expect(formats.getAttribute('aria-pressed')).toBe('false');
    expect(queryByRole('separator', { name: 'Resize side bar' })).toBeNull();
    expect(flag('sideOpen')).toBe('0');

    await fireEvent.click(formats); // expand again on the same view
    expect(container.querySelector('.side-slot:not(.closed)')).not.toBeNull();
    expect(flag('sideOpen')).toBe('1');
  });

  it('the side bar header has a collapse button, and the activity bar brings it back', async () => {
    const { container, getByRole } = await mount();
    await fireEvent.click(getByRole('button', { name: 'Hide side bar' }));
    expect(container.querySelector('.side-slot.closed')).not.toBeNull(); // hidden, still mounted
    await fireEvent.click(getByRole('button', { name: 'Structure' }));
    expect(container.querySelector('.side-slot:not(.closed)')).not.toBeNull();
    expect(getByRole('button', { name: 'Structure' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('"Browse formats" on the welcome screen opens the Formats view even when the side bar is collapsed', async () => {
    const { container, getByRole } = await mount();
    await fireEvent.click(getByRole('button', { name: 'Hide side bar' }));
    await fireEvent.click(getByRole('button', { name: 'Browse formats' }));
    expect(container.querySelector('.side-slot:not(.closed)')).not.toBeNull();
    expect(getByRole('button', { name: 'Formats' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('starts collapsed on a narrow screen (side bar and inspector as drawers) unless a layout was saved', async () => {
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    const { container, getByRole } = await mount();
    expect(container.querySelector('.side-slot.closed')).not.toBeNull(); // hidden, still mounted
    expect(getByRole('button', { name: 'Show data inspector' })).toBeTruthy();
    expect(getByRole('button', { name: 'Structure' }).getAttribute('aria-pressed')).toBe('false');
    await fireEvent.click(getByRole('button', { name: 'Structure' }));
    expect(container.querySelector('.side-slot.overlay')).not.toBeNull(); // a drawer over the editor
  });
});

describe('resizers', () => {
  it('are separators with value, bounds and orientation; arrows resize by 16 px and the size is remembered', async () => {
    const { container } = await mount();
    const side = sep(container, 'Resize side bar');
    expect(side.getAttribute('aria-orientation')).toBe('vertical');
    expect(val(side)).toBe(300);
    expect(side.getAttribute('aria-valuemin')).toBe('200');
    expect(side.getAttribute('aria-valuemax')).toBe('600');
    expect(side.tabIndex).toBe(0);

    await fireEvent.keyDown(side, { key: 'ArrowRight' });
    expect(val(side)).toBe(316);
    expect(flag('sideWidth')).toBe('316');
    await fireEvent.keyDown(side, { key: 'ArrowLeft' });
    await fireEvent.keyDown(side, { key: 'ArrowLeft' });
    expect(val(side)).toBe(284);
    await fireEvent.keyDown(side, { key: 'Home' });
    expect(val(side)).toBe(200);
    await fireEvent.keyDown(side, { key: 'ArrowLeft' });
    expect(val(side)).toBe(200); // clamped
    await fireEvent.keyDown(side, { key: 'End' });
    expect(val(side)).toBe(600);
    await fireEvent.keyDown(side, { key: 'ArrowRight' });
    expect(val(side)).toBe(600);
    expect(container.querySelector<HTMLElement>('.shell')!.style.gridTemplateColumns).toContain('600px');
  });

  it('the inspector grows to the left', async () => {
    const { container } = await mount();
    const insp = sep(container, 'Resize inspector');
    expect(val(insp)).toBe(320);
    expect(insp.getAttribute('aria-valuemin')).toBe('240');
    expect(insp.getAttribute('aria-valuemax')).toBe('520');
    await fireEvent.keyDown(insp, { key: 'ArrowLeft' });
    expect(val(insp)).toBe(336);
    await fireEvent.keyDown(insp, { key: 'ArrowRight' });
    await fireEvent.keyDown(insp, { key: 'ArrowRight' });
    expect(val(insp)).toBe(304);
    expect(flag('inspectorWidth')).toBe('304');
  });

  it('a double-click resets to the default size and persists it', async () => {
    const { container } = await mount();
    const side = sep(container, 'Resize side bar');
    await fireEvent.keyDown(side, { key: 'End' });
    expect(val(side)).toBe(600);
    await fireEvent.dblClick(side);
    expect(val(side)).toBe(300);
    expect(flag('sideWidth')).toBe('300');
  });

  it('restores saved sizes and ignores malformed ones', async () => {
    localStorage.setItem('binaryviewer.layout.sideWidth', '350');
    localStorage.setItem('binaryviewer.layout.inspectorWidth', 'wide');
    const { container } = await mount();
    expect(val(sep(container, 'Resize side bar'))).toBe(350);
    expect(val(sep(container, 'Resize inspector'))).toBe(320);
  });

  it('dragging with the pointer resizes too', async () => {
    const { container } = await mount();
    const side = sep(container, 'Resize side bar');
    await fireEvent.pointerDown(side, { clientX: 344, button: 0, pointerId: 1 });
    await fireEvent.pointerMove(side, { clientX: 404, pointerId: 1 });
    expect(val(side)).toBe(360);
    await fireEvent.pointerUp(side, { pointerId: 1 });
    await fireEvent.pointerMove(side, { clientX: 500, pointerId: 1 });
    expect(val(side)).toBe(360); // no longer dragging
  });

  it('the problems panel resizes upwards and collapses', async () => {
    const { container, getByRole } = await mount();
    await pick(container, new File([Uint8Array.from([1, 2, 3, 4])], 'a.bin'));
    const panel = await waitFor(() => sep(container, 'Resize problems panel'));
    expect(panel.getAttribute('aria-orientation')).toBe('horizontal');
    expect(val(panel)).toBe(180);
    expect(panel.getAttribute('aria-valuemin')).toBe('80');
    expect(panel.getAttribute('aria-valuemax')).toBe('360'); // 60% of the editor column
    await fireEvent.keyDown(panel, { key: 'ArrowUp' });
    expect(val(panel)).toBe(196);
    expect(flag('problemsHeight')).toBe('196');
    await fireEvent.keyDown(panel, { key: 'End' });
    expect(val(panel)).toBe(360);
    await fireEvent.keyDown(panel, { key: 'ArrowUp' });
    expect(val(panel)).toBe(360);
    await fireEvent.dblClick(panel);
    expect(val(panel)).toBe(180);

    await fireEvent.click(getByRole('button', { name: 'Hide problems panel' }));
    expect(container.querySelector('#panel-problems')).toBeNull();
    expect(container.querySelector('[aria-label="Resize problems panel"]')).toBeNull();
    expect(flag('problemsOpen')).toBe('0');
    await fireEvent.click(getByRole('button', { name: 'Show problems panel' }));
    expect(container.querySelector('#panel-problems')).not.toBeNull();
  });
});

describe('inspector panel', () => {
  it('collapses to a strip and comes back; the state is remembered', async () => {
    const { getByRole, queryByRole } = await mount();
    expect(getByRole('complementary', { name: 'Data inspector' })).toBeTruthy();
    await fireEvent.click(getByRole('button', { name: 'Hide data inspector' }));
    expect(queryByRole('complementary', { name: 'Data inspector' })).toBeNull();
    expect(flag('inspectorOpen')).toBe('0');
    await fireEvent.click(getByRole('button', { name: 'Show data inspector' }));
    expect(getByRole('complementary', { name: 'Data inspector' })).toBeTruthy();
    expect(flag('inspectorOpen')).toBe('1');
  });

  it('starts collapsed when it was left collapsed', async () => {
    localStorage.setItem('binaryviewer.layout.inspectorOpen', '0');
    const { getByRole, queryByRole } = await mount();
    expect(queryByRole('complementary', { name: 'Data inspector' })).toBeNull();
    expect(getByRole('button', { name: 'Show data inspector' })).toBeTruthy();
  });
});

describe('status bar', () => {
  it('shows the format and toggles the byte order like the inspector does', async () => {
    const { container, getByRole, findByLabelText } = await mount();
    const status = container.querySelector('footer.status') as HTMLElement;
    expect(within(status).queryByTitle('Format used to parse the file')).toBeNull(); // no file yet
    await pick(container, new File([Uint8Array.from([0x42, 0x4d, 1, 2, 3, 4])], 'x.bmp'));
    await findByLabelText('Format');
    await waitFor(() => expect(within(status).getByTitle('Format used to parse the file').textContent).toBe('Windows Bitmap'));

    const inspectorBtn = () => getByRole('button', { name: /^Byte order: / });
    const statusBtn = () => within(status).getByRole('button', { name: /^Value byte order: / });
    expect(statusBtn().textContent).toBe('LE');
    expect(inspectorBtn().textContent).toBe('LE');
    await fireEvent.click(statusBtn());
    expect(statusBtn().textContent).toBe('BE');
    expect(statusBtn().getAttribute('aria-label')).toBe('Value byte order: big-endian');
    expect(inspectorBtn().textContent).toBe('BE');
    expect(localStorage.getItem('binaryviewer.inspector.endian')).toBe('be');
    await fireEvent.click(inspectorBtn());
    expect(statusBtn().textContent).toBe('LE');
  });

  it('shows the size of the open document', async () => {
    const { container } = await mount();
    await pick(container, new File([new Uint8Array(1234)], 'big.bin'));
    await waitFor(() => expect(container.querySelector('footer.status .size')?.textContent).toBe('1,234 bytes (0x4D2)'));
  });
});

describe('problems panel', () => {
  it('lists the diagnostics, always expanded, and counts them in its header', async () => {
    const { container, getByRole, findByLabelText, queryByRole } = await mount();
    expect(queryByRole('button', { name: 'Problems' })).toBeNull(); // nothing open
    const bmp = new Uint8Array(30);
    bmp.set([0x42, 0x4d]);
    await pick(container, new File([bmp], 'cut.bmp')); // truncated inside the DIB header
    await findByLabelText('Format');
    await waitFor(() => expect(container.querySelectorAll('.diag .item').length).toBeGreaterThan(0));
    const title = getByRole('button', { name: 'Problems' });
    expect(title.getAttribute('aria-expanded')).toBe('true');
    expect(title.getAttribute('aria-controls')).toBe('panel-problems');
    const panel = getByRole('region', { name: 'Problems' });
    expect(within(panel).queryByRole('button', { name: /Problems/ })).toBeNull(); // no inner collapse header
    expect(container.querySelector('.bottom')!.textContent).toMatch(/[1-9]\d* errors/);

    await fireEvent.click(getByRole('button', { name: 'Hide problems panel' }));
    expect(container.querySelector('.diag')).toBeNull();
    expect(getByRole('button', { name: 'Problems' }).getAttribute('aria-expanded')).toBe('false');
    expect(getByRole('button', { name: 'Problems' }).hasAttribute('aria-controls')).toBe(false);
    expect(container.querySelector('.bottom')!.textContent).toMatch(/[1-9]\d* errors/); // counts stay visible
  });
});

describe('side bar stays mounted while collapsed', () => {
  const bmp = () => {
    const b = new Uint8Array(64);
    b.set([0x42, 0x4d, 64, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0]);
    return b;
  };
  const row = (c: HTMLElement, name: string) => [...c.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((r) => r.querySelector('.nm')?.textContent === name);

  it('keeps the tree (same DOM, expansion state) across collapse and reopen', async () => {
    const { container, getByRole, findByLabelText } = await mount();
    await pick(container, new File([bmp()], 'a.bmp'));
    await findByLabelText('Format');
    await waitFor(() => expect(row(container, 'file')).toBeTruthy());
    const tree = container.querySelector('[role="tree"]')!;
    expect(row(container, 'file')!.getAttribute('aria-expanded')).toBe('true');
    await fireEvent.click(row(container, 'file')!.querySelector('[data-twisty]')!);
    expect(row(container, 'file')!.getAttribute('aria-expanded')).toBe('false');

    await fireEvent.click(getByRole('button', { name: 'Hide side bar' }));
    await fireEvent.click(getByRole('button', { name: 'Structure' }));
    expect(container.querySelector('[role="tree"]')).toBe(tree);
    expect(row(container, 'file')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('a hex click while collapsed still reveals the node in the tree (seen after reopening)', async () => {
    const { container, getByRole, findByLabelText } = await mount();
    await pick(container, new File([bmp()], 'a.bmp'));
    await findByLabelText('Format');
    await waitFor(() => expect(row(container, 'file')).toBeTruthy());
    await fireEvent.click(getByRole('button', { name: 'Hide side bar' }));
    const byte = container.querySelector('.b[data-o="1"]')!;
    await fireEvent.mouseDown(byte);
    await fireEvent.mouseUp(byte);
    await waitFor(() => expect(container.querySelector('[role="treeitem"][aria-selected="true"]')).not.toBeNull());
    await fireEvent.click(getByRole('button', { name: 'Structure' }));
    expect(container.querySelector('[role="treeitem"][aria-selected="true"]')).not.toBeNull();
  });
});

describe('narrow-screen drawers', () => {
  beforeEach(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  });
  const editorEl = (c: HTMLElement) => c.querySelector('main.editor')!;

  it('ignores saved open flags and starts closed', async () => {
    localStorage.setItem('binaryviewer.layout.sideOpen', '1');
    localStorage.setItem('binaryviewer.layout.inspectorOpen', '1');
    const { container, getByRole } = await mount();
    expect(container.querySelector('.side-slot.closed')).not.toBeNull();
    expect(getByRole('button', { name: 'Show data inspector' })).toBeTruthy();
    expect(container.querySelector('.scrim')).toBeNull();
  });

  it('an open drawer shows a scrim, makes the editor inert, and the scrim closes it', async () => {
    const { container, getByRole } = await mount();
    expect(editorEl(container).hasAttribute('inert')).toBe(false);
    await fireEvent.click(getByRole('button', { name: 'Structure' }));
    expect(container.querySelector('.side-slot.overlay')).not.toBeNull();
    expect(editorEl(container).hasAttribute('inert')).toBe(true);
    await fireEvent.click(getByRole('button', { name: 'Close panel' }));
    expect(container.querySelector('.side-slot.closed')).not.toBeNull();
    expect(container.querySelector('.scrim')).toBeNull();
    expect(editorEl(container).hasAttribute('inert')).toBe(false);
  });

  it('Escape closes the open drawer', async () => {
    const { container, getByRole } = await mount();
    await fireEvent.click(getByRole('button', { name: 'Show data inspector' }));
    expect(container.querySelector('.inspector-slot.overlay')).not.toBeNull();
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('.inspector-slot')).toBeNull();
    expect(container.querySelector('.scrim')).toBeNull();
  });

  it('only one drawer is open at a time, and opening one does not persist the flag', async () => {
    const { container, getByRole } = await mount();
    await fireEvent.click(getByRole('button', { name: 'Show data inspector' }));
    await fireEvent.click(getByRole('button', { name: 'Structure' }));
    expect(container.querySelector('.side-slot.overlay')).not.toBeNull();
    expect(container.querySelector('.inspector-slot')).toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Show data inspector' }));
    expect(container.querySelector('.inspector-slot.overlay')).not.toBeNull();
    expect(container.querySelector('.side-slot.overlay')).toBeNull();
    expect(flag('sideOpen')).toBeNull();
    expect(flag('inspectorOpen')).toBeNull();
  });
});
