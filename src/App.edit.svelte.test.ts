// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import App from './App.svelte';
import type { EngineClient } from './worker/engine-client';
import type { SaveHandle } from './core/save';
import type { DetectionInfo } from './worker/protocol';
import { chooseFormat, closePalette, formatShown, openFormatPicker } from './test/format-ui';

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
  const w = window as unknown as Record<string, unknown>;
  delete w.showOpenFilePicker;
  delete w.showSaveFilePicker;
  vi.restoreAllMocks();
});

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function pick(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await fireEvent.change(input);
}

const grid = (c: HTMLElement) => c.querySelector('[role="grid"]') as HTMLElement;
const hexCells = (c: HTMLElement) => [...c.querySelectorAll('.b')].map((e) => e.textContent);
const clickByte = async (c: HTMLElement, o: number) => {
  const el = c.querySelector(`.b[data-o="${o}"]`)!;
  await fireEvent.mouseDown(el);
  await fireEvent.mouseUp(el);
};
const type = async (c: HTMLElement, text: string) => {
  for (const ch of text) await fireEvent.keyDown(grid(c), { key: ch });
};
const cell = (c: HTMLElement, id: string) => c.querySelector(`[data-id="${id}"] td`)?.textContent;
const button = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;
const dirtyMark = (c: HTMLElement) => c.querySelector('[aria-label="Modified"]');
const alertText = (c: HTMLElement) => [...c.querySelectorAll('[role="alert"]')].map((e) => e.textContent).join('|');

async function blobBytes(b: Blob): Promise<number[]> {
  return [...new Uint8Array(await b.arrayBuffer())];
}

/** Recording engine client: open/parse resolve immediately; `specs` offers one format to choose. */
function mockClient(opts: { detections?: DetectionInfo[]; openGate?: Promise<void>; parseGate?: Promise<void>; failOpenAt?: number } = {}) {
  const opens: Array<{ file: Blob | null; name: string }> = [];
  const parses: Array<string | null> = [];
  const client: EngineClient = {
    open: vi.fn(async (file: Blob | null, name: string) => {
      opens.push({ file, name });
      if (opts.openGate && opens.length === 1) await opts.openGate; // only the first open is held
      if (opts.failOpenAt === opens.length) throw new Error('boom');
      return { size: file?.size ?? 0, specs: [{ id: 'x', name: 'Format X' }], specErrors: [], detections: opts.detections ?? [] };
    }),
    parse: vi.fn(async (id: string | null) => {
      parses.push(id);
      if (opts.parseGate) await opts.parseGate;
      return null;
    }),
    expand: vi.fn(),
    cancel: vi.fn(),
    nodeAt: vi.fn(async () => ({ path: null, lazyIndex: null })),
    nodeById: vi.fn(async () => ({ path: null, lazyIndex: null })),
    ranges: vi.fn(async () => []),
    onFatal: vi.fn(),
    dispose: vi.fn(),
  } as unknown as EngineClient;
  return { client, opens, parses };
}

/** An in-memory "disk file" with a File System Access style handle. */
function fakeFile(
  initial: number[],
  name = 'disk.bin',
  opts: {
    failWriteAt?: number;
    permission?: string[];
    /** close() waits for this (to hold a save open). */
    gate?: Promise<void>;
    /** getFile() waits for this after a write (holds the window between close() and the re-read). */
    getFileGate?: Promise<void>;
    /** Files handed out before a write become unreadable (slices reject) once it is closed. */
    oldUnreadable?: boolean;
    /** getFile() rejects once the file has been closed after a write. */
    getFileFailsAfterClose?: boolean;
    /** getFile() returns this many extra bytes after a write (the disk differs from what was written). */
    extraOnDisk?: number;
  } = {},
) {
  let data = Uint8Array.from(initial);
  const log = { aborted: 0, closed: 0, writes: 0, permissionQueries: 0 };
  const perms = [...(opts.permission ?? [])];
  const handle: SaveHandle = {
    name,
    getFile: async () => {
      if (log.closed > 0) await opts.getFileGate;
      if (opts.getFileFailsAfterClose && log.closed > 0) throw new Error('NotReadableError');
      const extra = log.closed > 0 && opts.extraOnDisk ? new Array<number>(opts.extraOnDisk).fill(9) : [];
      const file = new File([Uint8Array.from([...data, ...extra])], name);
      if (opts.oldUnreadable) {
        const closedAtCreation = log.closed;
        const slice = file.slice.bind(file);
        file.slice = ((a?: number, b?: number) =>
          log.closed > closedAtCreation
            ? ({ arrayBuffer: async () => { throw new Error('NotReadableError'); } } as unknown as Blob)
            : slice(a, b)) as typeof file.slice;
      }
      return file;
    },
    createWritable: async () => {
      const parts: Uint8Array[] = [];
      return {
        async write(chunk) {
          if (opts.failWriteAt !== undefined && log.writes++ === opts.failWriteAt) throw new Error('disk full');
          parts.push(chunk instanceof Blob ? new Uint8Array(await chunk.arrayBuffer()) : chunk);
        },
        async close() {
          await opts.gate;
          log.closed++;
          data = Uint8Array.from(parts.flatMap((p) => [...p]));
        },
        async abort() {
          log.aborted++;
        },
      };
    },
    queryPermission: async () => (log.permissionQueries++, perms.shift() ?? 'granted'),
    requestPermission: async () => perms.shift() ?? 'granted',
  };
  return { handle, log, bytes: () => [...data] };
}

async function openViaPicker(c: HTMLElement, handle: SaveHandle) {
  (window as unknown as Record<string, unknown>).showOpenFilePicker = async () => [handle];
  await fireEvent.click(button(c, 'Open…'));
  await waitFor(() => expect(c.querySelector('.b[data-o="0"]')).not.toBeNull());
}

describe('App editing', () => {
  it('editing shows in the hex view and the inspector, marks the file dirty and warns on unload', async () => {
    const { container } = render(App, { createClient: () => mockClient().client });
    await pick(container, new File([new Uint8Array(32)], 'a.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="1"]')).not.toBeNull());
    expect(dirtyMark(container)).toBeNull();
    const addSpy = vi.spyOn(window, 'addEventListener');

    await clickByte(container, 1);
    await type(container, '41');
    await waitFor(() => expect(hexCells(container)[1]).toBe('41'));
    await waitFor(() => expect(dirtyMark(container)).not.toBeNull());
    expect(container.querySelectorAll('.b.mod')).toHaveLength(1);
    expect(addSpy.mock.calls.some(([t]) => t === 'beforeunload')).toBe(true);

    // inspector at the edited byte
    await fireEvent.mouseDown(container.querySelector('.b[data-o="1"]')!);
    await waitFor(() => expect(cell(container, 'uint8')).toBe('65'));

    // beforeunload prevented while dirty
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);

    // undo back to clean: dirty indicator and the unload guard go away
    await fireEvent.keyDown(grid(container), { key: 'z', ctrlKey: true });
    await waitFor(() => expect(dirtyMark(container)).toBeNull());
    const ev2 = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);
  });

  it('the inspector updates when the selected byte is edited', async () => {
    const { container } = render(App, { createClient: () => mockClient().client });
    await pick(container, new File([new Uint8Array(32)], 'a.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="1"]')).not.toBeNull());
    await clickByte(container, 0);
    await waitFor(() => expect(cell(container, 'uint8')).toBe('0'));
    await type(container, 'ff');
    await waitFor(() => expect(hexCells(container)[0]).toBe('FF'));
    await clickByte(container, 0);
    await waitFor(() => expect(cell(container, 'uint8')).toBe('255'));
  });

  it('New creates an empty "Untitled" document; typing appends; no format is detected', async () => {
    const m = mockClient();
    const { container, getByText } = render(App, { createClient: () => m.client });
    await fireEvent.click(button(container, 'New'));
    getByText('Untitled');
    getByText('Empty file (0 bytes)');
    await waitFor(() => expect(m.opens).toHaveLength(1));
    expect(m.opens[0]!.name).toBe('Untitled');
    expect(formatShown(container)).toBe('No format');

    await type(container, 'de');
    await type(container, 'ad');
    await waitFor(() => expect(hexCells(container).slice(0, 2)).toEqual(['DE', 'AD']));
    expect(dirtyMark(container)).not.toBeNull();
    expect(container.querySelector('.size')?.textContent).toContain('2 bytes');
    expect(formatShown(container)).toBe('No format'); // still None after editing
  });

  it('asks before discarding unsaved edits when opening another file or starting a new one', async () => {
    const { container, queryByRole, getByText } = render(App, { createClient: () => mockClient().client });
    await pick(container, new File([new Uint8Array(8)], 'one.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    await pick(container, new File([new Uint8Array(8)], 'clean.bin')); // clean: no prompt
    await waitFor(() => getByText('clean.bin'));
    expect(queryByRole('alertdialog')).toBeNull();

    await clickByte(container, 0);
    await type(container, 'ab');
    await waitFor(() => expect(dirtyMark(container)).not.toBeNull());

    await pick(container, new File([new Uint8Array(8)], 'two.bin'));
    const dlg = await waitFor(() => {
      const d = queryByRole('alertdialog');
      expect(d).not.toBeNull();
      return d!;
    });
    expect(dlg.textContent).toContain('unsaved changes');
    expect(container.textContent).toContain('clean.bin'); // nothing changed yet
    await fireEvent.click(button(dlg as HTMLElement, 'Cancel'));
    expect(queryByRole('alertdialog')).toBeNull();
    expect(hexCells(container)[0]).toBe('AB');

    await fireEvent.click(button(container, 'New'));
    await fireEvent.click(button(queryByRole('alertdialog') as HTMLElement, 'Discard changes'));
    await waitFor(() => getByText('Untitled'));
    expect(dirtyMark(container)).toBeNull();

    // and for Open via a picker
    await type(container, 'cc');
    await waitFor(() => expect(dirtyMark(container)).not.toBeNull());
    await pick(container, new File([new Uint8Array(8)], 'two.bin'));
    await fireEvent.click(button(queryByRole('alertdialog') as HTMLElement, 'Discard changes'));
    await waitFor(() => getByText('two.bin'));
    expect(dirtyMark(container)).toBeNull();
  });

  it('re-parses after edits with the chosen format, debounced (no pile-up while typing)', async () => {
    const m = mockClient();
    const { container } = render(App, { createClient: () => m.client });
    await pick(container, new File([new Uint8Array(32)], 'a.bin'));
    await waitFor(() => expect(m.opens).toHaveLength(1));
    await chooseFormat(container, 'Format X');
    await waitFor(() => expect(m.parses.at(-1)).toBe('x'));
    const parsesBefore = m.parses.length;

    await clickByte(container, 0);
    for (const ch of ['1', '1', '2', '2', '3', '3']) {
      await type(container, ch);
      await tick(20);
    }
    expect(m.opens).toHaveLength(1); // nothing yet: still inside the debounce window
    await waitFor(() => expect(m.opens).toHaveLength(2), { timeout: 1500 });
    await waitFor(() => expect(m.parses.length).toBe(parsesBefore + 1));
    expect(m.parses.at(-1)).toBe('x');
    // The worker is handed the edited document, lazily.
    const blob = m.opens[1]!.file!;
    expect(blob.size).toBe(32);
    expect((await blobBytes(blob)).slice(0, 4)).toEqual([0x11, 0x22, 0x33, 0]);
    await tick(450);
    expect(m.opens).toHaveLength(2); // exactly one re-parse for the whole burst
  });
});

describe('App saving', () => {
  it('Save writes back to the opened handle, rebases onto the new file and clears dirty', async () => {
    const m = mockClient();
    const disk = fakeFile([0, 1, 2, 3, 4, 5, 6, 7]);
    const { container } = render(App, { createClient: () => m.client });
    await openViaPicker(container, disk.handle);
    await clickByte(container, 2);
    await type(container, 'ee');
    await waitFor(() => expect(dirtyMark(container)).not.toBeNull());

    await fireEvent.click(button(container, 'Save'));
    await waitFor(() => expect(dirtyMark(container)).toBeNull());
    expect(disk.log.closed).toBe(1);
    expect(disk.bytes()).toEqual([0, 1, 0xee, 3, 4, 5, 6, 7]);
    expect(container.textContent).not.toContain('Saving');
    // rebased: no more edited marks, view still shows the content
    await waitFor(() => expect(container.querySelectorAll('.b.mod')).toHaveLength(0));
    expect(hexCells(container)[2]).toBe('EE');
    // the worker was pointed at the new file straight away
    await waitFor(() => expect(m.opens.length).toBeGreaterThanOrEqual(2));
    expect(await blobBytes(m.opens.at(-1)!.file!)).toEqual([0, 1, 0xee, 3, 4, 5, 6, 7]);
    // and editing continues on the new base
    await type(container, '9');
    await waitFor(() => expect(dirtyMark(container)).not.toBeNull());
    await fireEvent.keyDown(grid(container), { key: 'z', ctrlKey: true });
    await waitFor(() => expect(dirtyMark(container)).toBeNull());
  });

  it('a mid-write failure aborts the write, keeps the edits and stays dirty', async () => {
    const disk = fakeFile([0, 1, 2, 3], 'disk.bin', { failWriteAt: 0 });
    const { container } = render(App, { createClient: () => mockClient().client });
    await openViaPicker(container, disk.handle);
    await clickByte(container, 0);
    await type(container, 'aa');
    await waitFor(() => expect(dirtyMark(container)).not.toBeNull());
    await fireEvent.click(button(container, 'Save'));
    await waitFor(() => expect(alertText(container)).toContain('disk full'));
    expect(disk.log.aborted).toBe(1);
    expect(disk.log.closed).toBe(0);
    expect(disk.bytes()).toEqual([0, 1, 2, 3]); // original untouched
    expect(dirtyMark(container)).not.toBeNull();
    expect(hexCells(container)[0]).toBe('AA'); // edits kept
    expect((button(container, 'Save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a permission denial shows an error and writes nothing', async () => {
    const disk = fakeFile([0, 1, 2, 3], 'disk.bin', { permission: ['prompt', 'denied'] });
    const { container } = render(App, { createClient: () => mockClient().client });
    await openViaPicker(container, disk.handle);
    await clickByte(container, 0);
    await type(container, 'aa');
    await fireEvent.click(button(container, 'Save'));
    await waitFor(() => expect(alertText(container)).toContain('Permission'));
    expect(disk.log.closed).toBe(0);
    expect(dirtyMark(container)).not.toBeNull();
  });

  it('Save on a file without a handle (picked/dropped) goes through Save As; cancelling the picker is a silent no-op', async () => {
    const target = fakeFile([], 'new.bin');
    const picker = vi
      .fn<() => Promise<SaveHandle>>()
      .mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'))
      .mockResolvedValueOnce(target.handle);
    (window as unknown as Record<string, unknown>).showSaveFilePicker = picker;
    const { container } = render(App, { createClient: () => mockClient().client });
    await pick(container, new File([new Uint8Array([1, 2, 3])], 'dropped.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    await clickByte(container, 0);
    await type(container, '7f');
    await waitFor(() => expect(dirtyMark(container)).not.toBeNull());

    await fireEvent.click(button(container, 'Save'));
    await waitFor(() => expect(picker).toHaveBeenCalledTimes(1));
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'dropped.bin' });
    await tick();
    expect(alertText(container)).toBe('');
    expect(dirtyMark(container)).not.toBeNull();

    await fireEvent.click(button(container, 'Save'));
    await waitFor(() => expect(dirtyMark(container)).toBeNull());
    expect(target.bytes()).toEqual([0x7f, 2, 3]);
    expect(container.textContent).toContain('new.bin');

    // The returned handle is kept: the next Save writes in place without another picker.
    await clickByte(container, 1);
    await type(container, '55');
    await waitFor(() => expect(dirtyMark(container)).not.toBeNull());
    await fireEvent.click(button(container, 'Save'));
    await waitFor(() => expect(dirtyMark(container)).toBeNull());
    expect(picker).toHaveBeenCalledTimes(2);
    expect(target.bytes()).toEqual([0x7f, 0x55, 3]);
  });

  it('without the File System Access API, Save downloads the document and marks it saved', async () => {
    const created: Blob[] = [];
    URL.createObjectURL = (b: Blob | MediaSource) => (created.push(b as Blob), 'blob:x');
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { container } = render(App, { createClient: () => mockClient().client });
    await fireEvent.click(button(container, 'New'));
    await type(container, 'abcd');
    await waitFor(() => expect(dirtyMark(container)).not.toBeNull());
    await fireEvent.click(button(container, 'Save'));
    await waitFor(() => expect(dirtyMark(container)).toBeNull());
    expect(click).toHaveBeenCalledTimes(1);
    expect(await blobBytes(created[0]!)).toEqual([0xab, 0xcd]);
    expect(revoke).not.toHaveBeenCalled(); // revoked later, not right after click()
  });
});

describe('App saving: safety', () => {
  function gated() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    return { gate, release };
  }

  it('an edit queued at the instant of Save is part of the saved file', async () => {
    const disk = fakeFile([0, 1, 2, 3, 4, 5, 6, 7]);
    const { container } = render(App, { createClient: () => mockClient().client });
    await openViaPicker(container, disk.handle);
    await clickByte(container, 2);
    // Dispatch synchronously so the edit is still queued (not applied) when Save's handler runs.
    for (const k of ['4', '1']) grid(container).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    button(container, 'Save').click();
    await waitFor(() => expect(disk.log.closed).toBe(1));
    expect(disk.bytes()).toEqual([0, 1, 0x41, 3, 4, 5, 6, 7]);
    await waitFor(() => expect(dirtyMark(container)).toBeNull());
    expect(hexCells(container)[2]).toBe('41');
  });

  it('New, Open and drop are blocked while a save runs; the finishing save only touches its own document', async () => {
    const g = gated();
    const disk = fakeFile([0, 1, 2, 3], 'disk.bin', { gate: g.gate });
    const { container, queryByRole } = render(App, { createClient: () => mockClient().client });
    await openViaPicker(container, disk.handle);
    await clickByte(container, 0);
    await type(container, 'aa');
    await waitFor(() => expect(dirtyMark(container)).not.toBeNull());
    await fireEvent.click(button(container, 'Save'));
    await waitFor(() => expect(container.textContent).toContain('Saving'));
    expect(button(container, 'New').disabled).toBe(true);
    expect(button(container, 'Open…').disabled).toBe(true);

    await pick(container, new File([new Uint8Array([9, 9, 9])], 'other.bin'));
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown };
    drop.dataTransfer = { items: [], files: [new File([new Uint8Array([8])], 'dropped.bin')], types: ['Files'] };
    window.dispatchEvent(drop);
    await tick(30);
    expect(queryByRole('alertdialog')).toBeNull();
    expect(container.querySelector('.file')?.textContent).toBe('disk.bin');
    expect(alertText(container)).toContain('Wait for the save to finish');

    g.release();
    await waitFor(() => expect(dirtyMark(container)).toBeNull());
    expect(disk.bytes()).toEqual([0xaa, 1, 2, 3]);
    expect(container.querySelector('.file')?.textContent).toBe('disk.bin');
    expect(hexCells(container).slice(0, 4)).toEqual(['AA', '01', '02', '03']);
  });

  it('a debounced re-parse does not fire against the old base during a save', async () => {
    const m = mockClient();
    const g = gated();
    const disk = fakeFile([0, 1, 2, 3], 'disk.bin', { gate: g.gate });
    const { container } = render(App, { createClient: () => m.client });
    await openViaPicker(container, disk.handle);
    await waitFor(() => expect(m.opens).toHaveLength(1));
    await clickByte(container, 0);
    await type(container, 'bb');
    await fireEvent.click(button(container, 'Save')); // well inside the 300 ms debounce
    await tick(450);
    expect(m.opens).toHaveLength(1); // nothing re-opened while the save is pending
    g.release();
    await waitFor(() => expect(m.opens).toHaveLength(2));
    expect(await blobBytes(m.opens[1]!.file!)).toEqual([0xbb, 1, 2, 3]); // the new file, not the old base
    await tick(450);
    expect(m.opens).toHaveLength(2);
  });

  it('if the file cannot be re-read after a successful write, says so and freezes the document', async () => {
    const disk = fakeFile([0, 1, 2, 3], 'disk.bin', { getFileFailsAfterClose: true });
    const { container } = render(App, { createClient: () => mockClient().client });
    await openViaPicker(container, disk.handle);
    await clickByte(container, 0);
    await type(container, 'cc');
    await fireEvent.click(button(container, 'Save'));
    await waitFor(() => expect(alertText(container)).toContain('Saved, but the file could not be re-read'));
    expect(alertText(container)).toContain('reopen');
    expect(disk.bytes()).toEqual([0xcc, 1, 2, 3]);
    expect(dirtyMark(container)).toBeNull(); // nothing is lost: it is on disk
    expect(button(container, 'Save').disabled).toBe(true);
    expect(button(container, 'Save As…').disabled).toBe(true);
    await clickByte(container, 1);
    await type(container, 'dd');
    await tick(20);
    expect(dirtyMark(container)).toBeNull(); // frozen

    await pick(container, new File([new Uint8Array([5, 6])], 'next.bin'));
    await waitFor(() => expect(container.querySelector('.file')?.textContent).toBe('next.bin'));
    expect(button(container, 'Save').disabled).toBe(false);
    expect(alertText(container)).toBe('');
  });

  it('if the file on disk differs from what was written, tells the user and reloads from disk', async () => {
    const disk = fakeFile([0, 1, 2, 3], 'disk.bin', { extraOnDisk: 2 });
    const { container } = render(App, { createClient: () => mockClient().client });
    await openViaPicker(container, disk.handle);
    await clickByte(container, 0);
    await type(container, 'ee');
    await fireEvent.click(button(container, 'Save'));
    await waitFor(() => expect(alertText(container)).toContain('differs from what was written'));
    await waitFor(() => expect(container.querySelector('.size')?.textContent).toContain('6 bytes'));
    expect(dirtyMark(container)).toBeNull();
    await waitFor(() => expect(hexCells(container).slice(0, 6)).toEqual(['EE', '01', '02', '03', '09', '09']));
  });

  it('a download save releases the edit store and reports that it started', async () => {
    URL.createObjectURL = () => 'blob:y';
    URL.revokeObjectURL = () => {};
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { container, findByText } = render(App, { createClient: () => mockClient().client });
    await pick(container, new File([new Uint8Array(8)], 'a.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="1"]')).not.toBeNull());
    await clickByte(container, 1);
    await type(container, '7e');
    await waitFor(() => expect(container.querySelectorAll('.b.mod')).toHaveLength(1));
    await fireEvent.click(button(container, 'Save'));
    await findByText(/Download started/);
    expect(dirtyMark(container)).toBeNull();
    expect(container.querySelectorAll('.b.mod')).toHaveLength(0); // rebased: pieces and store reset
    expect(hexCells(container)[1]).toBe('7E');
    await fireEvent.keyDown(grid(container), { key: 'z', ctrlKey: true }); // history was cleared
    await tick(20);
    expect(hexCells(container)[1]).toBe('7E');
  });
});

describe('App saving: engine and load follow-ups', () => {
  const stubDownload = () => {
    URL.createObjectURL = () => 'blob:z';
    URL.revokeObjectURL = () => {};
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  };

  it('a save that fails inside the debounce window leaves the view re-parsed on the edited bytes, not stuck', async () => {
    const m = mockClient();
    const disk = fakeFile([0, 1, 2, 3], 'disk.bin', { failWriteAt: 0 });
    const { container } = render(App, { createClient: () => m.client });
    await openViaPicker(container, disk.handle);
    await waitFor(() => expect(m.opens).toHaveLength(1));
    await clickByte(container, 0);
    await type(container, 'aa');
    await fireEvent.click(button(container, 'Save')); // before the 300 ms re-parse fires
    await waitFor(() => expect(alertText(container)).toContain('disk full'));
    await waitFor(() => expect(m.opens).toHaveLength(2));
    expect(await blobBytes(m.opens[1]!.file!)).toEqual([0xaa, 1, 2, 3]);
    expect(container.querySelector('[role="status"]')?.textContent ?? '').not.toMatch(/Parsing/i);
    await tick(450);
    expect(m.opens).toHaveLength(2);
  });

  it('a download save re-parses afterwards', async () => {
    stubDownload();
    const m = mockClient();
    const { container } = render(App, { createClient: () => m.client });
    await pick(container, new File([new Uint8Array(4)], 'a.bin'));
    await waitFor(() => expect(m.opens).toHaveLength(1));
    await clickByte(container, 0);
    await type(container, '5a');
    await fireEvent.click(button(container, 'Save'));
    await waitFor(() => expect(container.textContent).toContain('Download started'));
    await waitFor(() => expect(m.opens).toHaveLength(2));
    expect(await blobBytes(m.opens[1]!.file!)).toEqual([0x5a, 0, 0, 0]);
  });

  it('Save right after opening keeps the detected formats (the interrupted detection is re-run)', async () => {
    stubDownload();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m = mockClient({ openGate: gate, detections: [{ specId: 'x', name: 'Format X', score: 1, reasons: ['extension'], magicMatched: true }] });
    const { container } = render(App, { createClient: () => m.client });
    await pick(container, new File([new Uint8Array(4)], 'a.x'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    await fireEvent.click(button(container, 'Save')); // the first open() is still pending
    await waitFor(() => expect(formatShown(container)).toBe('Format X'));
    expect(await openFormatPicker(container)).toContain('Format X (magic)');
    await closePalette();
    release(); // the superseded first open finishes late and must not clobber anything
    await tick(30);
    expect(formatShown(container)).toBe('Format X');
  });

  it('a clipboard write that never settles does not block Save', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise(() => {}) } });
    const disk = fakeFile([0, 1, 2, 3]);
    const { container } = render(App, { createClient: () => mockClient().client });
    await openViaPicker(container, disk.handle);
    await clickByte(container, 0);
    await fireEvent.keyDown(grid(container), { key: 'c', ctrlKey: true });
    await type(container, 'aa');
    await fireEvent.click(button(container, 'Save'));
    await waitFor(() => expect(disk.log.closed).toBe(1));
    expect(disk.bytes()).toEqual([0xaa, 1, 2, 3]);
  });

  it('typing while a file is still being read asks before that file replaces the document', async () => {
    const { container, queryByRole } = render(App, { createClient: () => mockClient().client });
    await pick(container, new File([new Uint8Array(8)], 'one.bin'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    let release!: () => void;
    const slow = {
      name: 'slow.bin',
      size: 4,
      slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>((r) => (release = () => r(new ArrayBuffer(1)))) }),
    };
    await pick(container, slow as unknown as File); // clean at this point: no prompt, but the read is pending
    await clickByte(container, 0);
    await type(container, 'aa');
    await waitFor(() => expect(dirtyMark(container)).not.toBeNull());
    release();
    const dlg = await waitFor(() => {
      const d = queryByRole('alertdialog');
      expect(d).not.toBeNull();
      return d!;
    });
    expect(container.querySelector('.file')?.textContent).toBe('one.bin');
    await fireEvent.click(button(dlg as HTMLElement, 'Cancel'));
    expect(container.querySelector('.file')?.textContent).toBe('one.bin');
    expect(hexCells(container)[0]).toBe('AA');
    expect(dirtyMark(container)).not.toBeNull();
  });

  it('a read that fails while the old file is unreadable (after close) heals itself after the rebase', async () => {
    let release!: () => void;
    const getFileGate = new Promise<void>((r) => (release = r));
    const initial = new Array<number>(200 * 1024).fill(0);
    initial[0x30000] = 0x5a;
    const disk = fakeFile(initial, 'big.bin', { getFileGate, oldUnreadable: true });
    const { container } = render(App, { createClient: () => mockClient().client });
    await openViaPicker(container, disk.handle);
    await clickByte(container, 0);
    await type(container, 'aa');
    await fireEvent.click(button(container, 'Save'));
    await waitFor(() => expect(disk.log.closed).toBe(1)); // closed; getFile() is held: the window
    const input = container.querySelector('input[aria-label="Go to offset"]') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '30000' } });
    await fireEvent.click(button(container, 'Go'));
    await waitFor(() => expect(alertText(container)).toContain('Read failed'));
    release();
    await waitFor(() => expect(alertText(container)).not.toContain('Read failed'));
    await waitFor(() => expect(container.querySelector('.b[data-o="196608"]')?.textContent).toBe('5A'));
    expect(dirtyMark(container)).toBeNull();
  });
});

describe('App: engine status and detection follow-ups', () => {
  const formatBar = (c: HTMLElement) => c.querySelector('footer.status')?.textContent ?? ''; // the parse state is in the status bar

  it('a parse in flight when a save ends unreadable does not leave "Parsing" behind', async () => {
    let release!: () => void;
    const parseGate = new Promise<void>((r) => (release = r));
    const m = mockClient({ parseGate });
    const disk = fakeFile([0, 1, 2, 3], 'disk.bin', { getFileFailsAfterClose: true });
    const { container } = render(App, { createClient: () => m.client });
    await openViaPicker(container, disk.handle);
    await chooseFormat(container, 'Format X');
    await waitFor(() => expect(formatBar(container)).toMatch(/Parsing/i));
    await clickByte(container, 0);
    await type(container, 'aa');
    await fireEvent.click(button(container, 'Save'));
    await waitFor(() => expect(alertText(container)).toContain('Saved, but the file could not be re-read'));
    expect(formatBar(container)).not.toMatch(/Parsing/i);
    release();
    await tick(30);
    expect(formatBar(container)).not.toMatch(/Parsing/i);
  });

  it('a failing re-parse open() shows an error instead of staying on "Parsing"', async () => {
    let release!: () => void;
    const parseGate = new Promise<void>((r) => (release = r));
    const m = mockClient({ parseGate, failOpenAt: 2 });
    const { container } = render(App, { createClient: () => m.client });
    await pick(container, new File([new Uint8Array(8)], 'a.bin'));
    await waitFor(() => expect(m.opens).toHaveLength(1));
    await chooseFormat(container, 'Format X');
    await waitFor(() => expect(formatBar(container)).toMatch(/Parsing/i));
    await clickByte(container, 0);
    await type(container, 'aa');
    await waitFor(() => expect(m.opens).toHaveLength(2), { timeout: 1500 });
    await waitFor(() => expect(formatBar(container)).toMatch(/boom/));
    expect(formatBar(container)).not.toMatch(/Parsing/i);
    release();
  });

  it('typing before the first open() returns still ends with the detected format selected', async () => {
    let release!: () => void;
    const openGate = new Promise<void>((r) => (release = r));
    const m = mockClient({ openGate, detections: [{ specId: 'x', name: 'Format X', score: 1, reasons: ['extension'], magicMatched: true }] });
    const { container } = render(App, { createClient: () => m.client });
    await pick(container, new File([new Uint8Array(4)], 'a.x'));
    await waitFor(() => expect(container.querySelector('.b[data-o="0"]')).not.toBeNull());
    await clickByte(container, 0);
    await type(container, 'aa'); // the first open() is still pending
    await waitFor(() => expect(m.opens).toHaveLength(2), { timeout: 1500 });
    await waitFor(() => expect(formatShown(container)).toBe('Format X'));
    release();
    await tick(30);
    expect(formatShown(container)).toBe('Format X');
  });
});
