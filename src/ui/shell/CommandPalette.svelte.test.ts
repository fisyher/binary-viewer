// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../commands';
import CommandPalette from './CommandPalette.svelte';

afterEach(cleanup);

function setup(over: { commands?: Command[]; recent?: string[] } = {}) {
  const run = vi.fn();
  const onUse = vi.fn();
  const onClose = vi.fn((then?: () => void) => then?.()); // a closed palette runs the command right away
  const commands: Command[] = over.commands ?? [
    { id: 'file.open', label: 'Open file…', group: 'File', run: () => run('open') },
    { id: 'file.save', label: 'Save', group: 'File', shortcut: 'Ctrl+S', disabledReason: () => 'Open a file first', run: () => run('save') },
    {
      id: 'file.goTo',
      label: 'Go to offset…',
      group: 'File',
      sub: () => ({ kind: 'offset', title: 'Go to offset', submit: (t, base) => (t === 'bad' ? { error: 'Invalid hex offset' } : { run: () => run('goto', t, base) }) }),
    },
    { id: 'view.minimap', label: 'Hide minimap', group: 'View', keywords: 'toggle overview', run: () => run('minimap') },
    { id: 'view.side', label: 'Hide side bar', group: 'View', run: () => run('side') },
    { id: 'view.theme.dark', label: 'Theme: Dark', group: 'View', hint: 'Current', run: () => run('dark') },
    {
      id: 'format.choose',
      label: 'Choose format…',
      group: 'Format',
      sub: () => ({
        kind: 'pick',
        title: 'Choose format',
        placeholder: 'Choose a format',
        empty: 'No formats available',
        items: [
          { id: '', label: 'None (raw)', hint: 'Current' },
          { id: 'bmp', label: 'Windows Bitmap (magic)' },
          { id: 'zip', label: 'ZIP' },
        ],
        pick: (id) => run('format', id),
      }),
    },
    {
      id: 'help.shortcuts',
      label: 'Keyboard shortcuts',
      group: 'Help',
      sub: () => ({ kind: 'pick', title: 'Keyboard shortcuts', placeholder: 'Search', empty: 'None', items: [{ id: '0', label: 'Copy the selected bytes', shortcut: 'Ctrl+C' }] }),
    },
    { id: 'spec.x', label: 'Open spec Windows Bitmap', group: 'Tabs', searchOnly: true, run: () => run('spec') },
  ];
  const r = render(CommandPalette, { commands, recent: over.recent ?? [], onUse, onClose });
  const input = r.getByRole('combobox') as HTMLInputElement;
  const options = () => r.queryAllByRole('option');
  const names = () => options().map((o) => o.querySelector('.label')!.textContent);
  const type = (v: string) => fireEvent.input(input, { target: { value: v } });
  const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(input, { key: k, ...init });
  return { ...r, run, onUse, onClose, input, options, names, type, key };
}

describe('CommandPalette: structure and ARIA', () => {
  it('is a modal dialog with a focused combobox that controls a listbox of options', () => {
    const { getByRole, input, options } = setup();
    expect(getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    expect(getByRole('dialog').getAttribute('aria-label')).toBe('Command palette');
    expect(document.activeElement).toBe(input);
    const list = getByRole('listbox');
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(options().length).toBeGreaterThan(0);
    const selected = options().filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(input.getAttribute('aria-activedescendant')).toBe(selected[0]!.id);
    expect(new Set(options().map((o) => o.id)).size).toBe(options().length);
  });

  it('with an empty query lists the commands in groups (sentence-case names), not the search-only ones', () => {
    const { container, names, getAllByRole } = setup();
    const groups = [...container.querySelectorAll('.group')].map((g) => g.textContent);
    expect(groups).toEqual(['File', 'Format', 'View', 'Help']);
    expect(getAllByRole('group')).toHaveLength(4);
    expect(names()).not.toContain('Open spec Windows Bitmap');
    expect(names()).toContain('Hide minimap');
  });

  it('shows the shortcut in the mono face and a disabled command with its reason, aria-disabled', () => {
    const { options } = setup();
    const save = options().find((o) => o.textContent?.includes('Save'))!;
    expect(save.querySelector('kbd')!.textContent).toBe('Ctrl+S');
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(save.querySelector('.note')!.textContent).toBe('Open a file first');
    expect(options().find((o) => o.textContent?.includes('Theme: Dark'))!.querySelector('.note')!.textContent).toBe('Current');
  });

  it('starts on the first row, even a disabled one; Enter there runs nothing, not the next command', async () => {
    const run = vi.fn();
    const { options, key, onClose } = setup({
      commands: [
        { id: 'a', label: 'Alpha', group: 'File', disabledReason: () => 'no', run: () => run('a') },
        { id: 'b', label: 'Bravo', group: 'File', run: () => run('b') },
      ],
    });
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
    await key('Enter');
    expect(run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('CommandPalette: matching', () => {
  it('filters with a fuzzy match, best first, and highlights the matched letters as text', async () => {
    const { names, type, options } = setup();
    await type('hide');
    expect(names().sort()).toEqual(['Hide minimap', 'Hide side bar']);
    const hit = options()[0]!.querySelectorAll('.hit');
    expect([...hit].map((h) => h.textContent).join('')).toBe('Hide');
    await type('mnmp');
    expect(names()).toEqual(['Hide minimap']);
    expect([...options()[0]!.querySelectorAll('.hit')].map((h) => h.textContent).join('')).toBe('mnmp');
    expect(options()[0]!.textContent).toContain('Hide minimap');
  });

  it('lists the search-only commands once there is a query, with their group', async () => {
    const { names, type, options } = setup();
    await type('bitmap');
    expect(names()).toEqual(['Open spec Windows Bitmap']);
    expect(options()[0]!.querySelector('.note')!.textContent).toBe('Tabs');
  });

  it('finds a command by its keywords, after the label matches', async () => {
    const { names, type } = setup();
    await type('overview');
    expect(names()).toEqual(['Hide minimap']);
  });

  it('says so when nothing matches, and collapses the listbox', async () => {
    const { type, input, container, queryAllByRole, getByRole } = setup();
    await type('qqqq');
    expect(queryAllByRole('option')).toHaveLength(0);
    expect(container.querySelector('.none')!.textContent).toBe('No matching commands');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    expect(getByRole('status').textContent).toBe('No matching commands');
  });

  it('never turns names into markup', async () => {
    const evil = '<img src=x onerror=alert(1)> name';
    const { type, options, container } = setup({ commands: [{ id: 'e', label: `Open spec ${evil}`, group: 'Tabs', run() {} }] });
    await type('img');
    expect(options()).toHaveLength(1);
    expect(options()[0]!.textContent).toContain(evil);
    expect(container.querySelector('img')).toBeNull();
  });

  it('announces the number of results', async () => {
    const { type, getByRole } = setup();
    await type('hide');
    expect(getByRole('status').textContent).toBe('2 results.');
    await type('minimap');
    expect(getByRole('status').textContent).toBe('1 result.');
  });
});

describe('CommandPalette: recent commands', () => {
  it('lists the recent ones first under their own heading, without repeating them below', () => {
    const { container, names } = setup({ recent: ['view.minimap', 'file.open', 'gone'] });
    expect([...container.querySelectorAll('.group')][0]!.textContent).toBe('Recent');
    expect(names().slice(0, 2)).toEqual(['Hide minimap', 'Open file…']);
    expect(names().filter((n) => n === 'Hide minimap')).toHaveLength(1);
  });

  it('reports a chosen command through onUse', async () => {
    const { options, onUse, key } = setup();
    await fireEvent.click(options().find((o) => o.textContent?.includes('Hide minimap'))!);
    expect(onUse).toHaveBeenCalledWith('view.minimap');
    await key('Escape');
  });
});

describe('CommandPalette: keyboard', () => {
  const selectedName = (o: HTMLElement[]) => o.find((x) => x.getAttribute('aria-selected') === 'true')!.querySelector('.label')!.textContent;

  it('Down and Up move, wrap around, and keep aria-activedescendant in step', async () => {
    const { key, options, input, names } = setup();
    const n = names().length;
    const first = selectedName(options());
    await key('ArrowDown');
    expect(selectedName(options())).toBe(names()[1]);
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[1]!.id);
    await key('ArrowUp');
    expect(selectedName(options())).toBe(first);
    await key('ArrowUp');
    expect(selectedName(options())).toBe(names()[n - 1]);
    await key('ArrowDown');
    expect(selectedName(options())).toBe(names()[0]);
  });

  it('Home and End jump to the ends, PageDown and PageUp move by a page and stop at the ends', async () => {
    const { key, options, names } = setup();
    const n = names().length;
    await key('End');
    expect(selectedName(options())).toBe(names()[n - 1]);
    await key('Home');
    expect(selectedName(options())).toBe(names()[0]);
    await key('PageDown');
    expect(selectedName(options())).toBe(names()[Math.min(8, n - 1)]);
    await key('PageDown');
    await key('PageDown');
    expect(selectedName(options())).toBe(names()[n - 1]);
    await key('PageUp');
    await key('PageUp');
    await key('PageUp');
    expect(selectedName(options())).toBe(names()[0]);
  });

  it('the arrow keys are prevented (the caret stays put) and typing resets the selection to the first command', async () => {
    const { key, type, options } = setup();
    expect(await key('ArrowDown')).toBe(false); // fireEvent returns false when preventDefault was called
    await key('ArrowDown');
    await type('hide');
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('Enter runs the selected command: closes first, then runs, and reports it', async () => {
    const { type, key, run, onClose, onUse } = setup();
    await type('minimap');
    await key('Enter');
    expect(onUse).toHaveBeenCalledWith('view.minimap');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('minimap');
  });

  it('a disabled command is not runnable, by Enter or by click', async () => {
    const { type, key, run, onClose, options, onUse } = setup();
    await type('save');
    expect(options()[0]!.getAttribute('aria-disabled')).toBe('true');
    await key('Enter');
    await fireEvent.click(options()[0]!);
    expect(run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onUse).not.toHaveBeenCalled();
  });

  it('Enter with nothing listed does nothing', async () => {
    const { type, key, onClose } = setup();
    await type('qqqq');
    await key('Enter');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape closes without running anything', async () => {
    const { key, onClose, run } = setup();
    await key('Escape');
    expect(onClose).toHaveBeenCalledWith();
    expect(run).not.toHaveBeenCalled();
  });

  it('Ctrl+K and F1 close it again', async () => {
    const { key, onClose } = setup();
    await key('k', { ctrlKey: true });
    await key('F1');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('ignores keys during IME composition and leaves Ctrl+A / Ctrl+Backspace to the input', async () => {
    const { key, onClose, run } = setup();
    await key('Enter', { isComposing: true });
    await key('Escape', { isComposing: true });
    expect(await key('a', { ctrlKey: true })).toBe(true);
    expect(await key('Backspace', { ctrlKey: true })).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('Tab stays inside the palette', async () => {
    const { key, input } = setup();
    expect(await key('Tab')).toBe(false);
    expect(await key('Tab', { shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(input);
  });
});

describe('CommandPalette: mouse', () => {
  it('a click on a row runs it; hovering moves the selection', async () => {
    const { options, run } = setup();
    const row = options().find((o) => o.textContent?.includes('Hide side bar'))!;
    await fireEvent.mouseMove(row);
    expect(row.getAttribute('aria-selected')).toBe('true');
    await fireEvent.click(row);
    expect(run).toHaveBeenCalledWith('side');
  });

  it('a press on the backdrop closes; a press inside the panel does not', async () => {
    const { container, getByRole, onClose } = setup();
    await fireEvent.mouseDown(getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.mouseDown(container.querySelector('.backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pressing a row keeps the focus in the input', async () => {
    const { options, input } = setup();
    expect(await fireEvent.mouseDown(options()[0]!)).toBe(false);
    expect(document.activeElement).toBe(input);
  });
});

describe('CommandPalette: Go to offset sub-mode', () => {
  async function enter() {
    const s = setup();
    await s.type('go to');
    await s.key('Enter');
    await waitFor(() => expect(s.getByRole('dialog').getAttribute('aria-label')).toBe('Go to offset'));
    return s;
  }

  it('turns the input into an offset field with a hex/dec toggle and no list', async () => {
    const { input, queryByRole, getByRole, onClose, onUse } = await enter();
    expect(onUse).not.toHaveBeenCalled(); // remembered once it completes
    expect(onClose).not.toHaveBeenCalled(); // entering a sub-mode keeps the palette open
    expect(queryByRole('listbox')).toBeNull();
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('Offset in hex, e.g. 1F or 0x1F');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(input);
    const base = getByRole('button', { name: 'Offset base: hexadecimal' });
    await fireEvent.click(base);
    expect(getByRole('button', { name: 'Offset base: decimal' }).textContent).toBe('Dec');
    expect(input.placeholder).toBe('Offset in decimal');
    expect(document.activeElement).toBe(input);
  });

  it('Enter with a valid offset closes and runs the jump with the chosen base', async () => {
    const { type, key, run, onClose } = await enter();
    await type('1F4');
    await key('Enter');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('goto', '1F4', 'hex');
  });

  it('uses decimal after the toggle', async () => {
    const { type, key, run, getByRole } = await enter();
    await fireEvent.click(getByRole('button', { name: 'Offset base: hexadecimal' }));
    await type('500');
    await key('Enter');
    expect(run).toHaveBeenCalledWith('goto', '500', 'dec');
  });

  it('shows an error inline (announced, linked to the input) and stays open; typing clears it', async () => {
    const { input, type, key, getByRole, queryByRole, onClose, run } = await enter();
    await type('bad');
    await key('Enter');
    const alert = getByRole('alert');
    expect(alert.textContent).toBe('Invalid hex offset');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(alert.id);
    expect(onClose).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    await type('1');
    expect(queryByRole('alert')).toBeNull();
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('ArrowDown and Home keep their text-field meaning there; Backspace on an empty field goes back to the commands', async () => {
    const { key, type, queryAllByRole, getByRole } = await enter();
    expect(await key('Home')).toBe(true);
    await type('1');
    await key('Backspace');
    expect(getByRole('dialog').getAttribute('aria-label')).toBe('Go to offset'); // input was not empty
    await type('');
    await key('Backspace');
    await waitFor(() => expect(getByRole('dialog').getAttribute('aria-label')).toBe('Command palette'));
    expect(queryAllByRole('option').length).toBeGreaterThan(0);
  });

  it('Escape still closes from the sub-mode', async () => {
    const { key, onClose } = await enter();
    await key('Escape');
    expect(onClose).toHaveBeenCalledWith();
  });
});

describe('CommandPalette: pick lists', () => {
  async function enter(q: string) {
    const s = setup();
    await s.type(q);
    await s.key('Enter');
    await waitFor(() => expect(s.getByRole('dialog').getAttribute('aria-label')).not.toBe('Command palette'));
    return s;
  }

  it('Choose format lists the formats, fuzzy-filters them and runs the pick after closing', async () => {
    const { names, type, key, run, onClose, input, getByRole } = await enter('choose');
    expect(getByRole('dialog').getAttribute('aria-label')).toBe('Choose format');
    expect(input.placeholder).toBe('Choose a format');
    expect(names()).toEqual(['None (raw)', 'Windows Bitmap (magic)', 'ZIP']);
    await type('bmp');
    expect(names()).toEqual(['Windows Bitmap (magic)']);
    await key('Enter');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('format', 'bmp');
  });

  it('picks None (empty id) too and shows the Current hint', async () => {
    const { options, key, run } = await enter('choose');
    expect(options()[0]!.querySelector('.note')!.textContent).toBe('Current');
    await key('Enter');
    expect(run).toHaveBeenCalledWith('format', '');
  });

  it('says so when no item matches', async () => {
    const { type, container } = await enter('choose');
    await type('zzzz');
    expect(container.querySelector('.none')!.textContent).toBe('No matches');
  });

  it('a list without a pick action is read-only: Enter and clicks do nothing, the keys are shown', async () => {
    const { options, key, onClose } = await enter('keyboard');
    expect(options()[0]!.querySelector('kbd')!.textContent).toBe('Ctrl+C');
    await key('Enter');
    await fireEvent.click(options()[0]!);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('CommandPalette: review fixes', () => {
  it('a held Ctrl+K or F1 (key repeat) does not toggle it closed, but the browser default is still prevented', async () => {
    const { key, onClose } = setup();
    expect(await key('k', { ctrlKey: true, repeat: true })).toBe(false);
    expect(await key('F1', { repeat: true })).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    await key('k', { ctrlKey: true });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+S is swallowed (no browser Save page) and does nothing else', async () => {
    const { key, onClose, run } = setup();
    expect(await key('s', { ctrlKey: true })).toBe(false);
    expect(await key('s', { metaKey: true })).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('closes on the physical K key of a non-Latin layout', async () => {
    const { key, onClose } = setup();
    await key('л', { ctrlKey: true, code: 'KeyK' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Enter with keyCode 229 (an input method confirming) runs nothing', async () => {
    const { key, onClose, run, type } = setup();
    await type('minimap');
    await key('Enter', { keyCode: 229 });
    expect(onClose).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    await key('Enter');
    expect(run).toHaveBeenCalledWith('minimap');
  });

  it('keeps one live region for the whole life of the palette and only changes its text', async () => {
    const { getAllByRole, type } = setup();
    const regions = () => getAllByRole('status');
    expect(regions()).toHaveLength(1);
    const first = regions()[0]!;
    expect(first.textContent).toMatch(/\d+ results/);
    await type('hide');
    expect(regions()).toHaveLength(1);
    expect(regions()[0]).toBe(first);
    expect(first.textContent).toBe('2 results.');
    await type('qqqq');
    expect(regions()).toHaveLength(1);
    expect(regions()[0]).toBe(first);
    expect(first.textContent).toBe('No matching commands');
    await type('hide');
    expect(regions()[0]).toBe(first);
    expect(first.textContent).toBe('2 results.');
  });

  describe('recent commands', () => {
    it('does not remember the long tail or tab switches', async () => {
      const run = vi.fn();
      const commands: Command[] = [
        { id: 'spec.a', label: 'Open spec A', group: 'Tabs', searchOnly: true, run },
        { id: 'tab.spec:a', label: 'Switch to A', group: 'Tabs', transient: true, run },
        { id: 'view.side', label: 'Hide side bar', group: 'View', run },
      ];
      const s = setup({ commands });
      await s.type('open spec');
      await s.key('Enter');
      await s.type('switch');
      await s.key('Enter');
      expect(run).toHaveBeenCalledTimes(2);
      expect(s.onUse).not.toHaveBeenCalled();
      await s.type('hide');
      await s.key('Enter');
      expect(s.onUse).toHaveBeenCalledTimes(1);
      expect(s.onUse).toHaveBeenCalledWith('view.side');
    });

    it('a sub-mode is remembered when it completes, not when it is entered or abandoned', async () => {
      const s = setup();
      await s.type('go to');
      await s.key('Enter');
      await waitFor(() => expect(s.getByRole('dialog').getAttribute('aria-label')).toBe('Go to offset'));
      expect(s.onUse).not.toHaveBeenCalled();

      await s.type('bad');
      await s.key('Enter'); // an error keeps it open and is not a use
      expect(s.onUse).not.toHaveBeenCalled();
      await s.type('1F');
      await s.key('Enter');
      expect(s.onUse).toHaveBeenCalledTimes(1);
      expect(s.onUse).toHaveBeenCalledWith('file.goTo');
    });

    it('an abandoned sub-mode is not remembered', async () => {
      const s = setup();
      await s.type('choose');
      await s.key('Enter');
      await waitFor(() => expect(s.getByRole('dialog').getAttribute('aria-label')).toBe('Choose format'));
      await s.key('Escape');
      expect(s.onUse).not.toHaveBeenCalled();
    });

    it('a pick list is remembered when something is picked; a read-only list when it is opened', async () => {
      const a = setup();
      await a.type('choose');
      await a.key('Enter');
      await waitFor(() => expect(a.getByRole('dialog').getAttribute('aria-label')).toBe('Choose format'));
      expect(a.onUse).not.toHaveBeenCalled();
      await a.key('Enter');
      expect(a.onUse).toHaveBeenCalledWith('format.choose');
      cleanup();

      const b = setup();
      await b.type('keyboard');
      await b.key('Enter');
      expect(b.onUse).toHaveBeenCalledWith('help.shortcuts');
    });
  });

  describe('many results', () => {
    const many = (n: number): Command[] => Array.from({ length: n }, (_, i) => ({ id: `spec.${i}`, label: `Open spec Format ${i}`, group: 'Tabs' as const, searchOnly: true, run() {} }));

    it('renders at most 50 rows and says how many more matches there are', async () => {
      const { type, options, getByRole, container } = setup({ commands: many(500) });
      await type('format');
      expect(options()).toHaveLength(50);
      expect(getByRole('status').textContent).toBe('50 results. 450 more matches. Keep typing to narrow them.');
      expect(container.querySelector('.none')!.textContent).toBe('450 more matches. Keep typing to narrow them.');
      await type('format 499');
      expect(options().length).toBeLessThan(50);
      expect(container.querySelector('.none')).toBeNull();
      expect(getByRole('status').textContent).toMatch(/^\d+ results?\.$/);
    });

    it('caps pick lists too, and searching 500 entries is quick', async () => {
      const items = Array.from({ length: 500 }, (_, i) => ({ id: String(i), label: `Spec number ${i}` }));
      const { type, options, key } = setup({
        commands: [{ id: 'p', label: 'Pick one', group: 'Tabs', sub: () => ({ kind: 'pick', title: 'Pick', placeholder: 'Pick', empty: 'none', items, pick() {} }) }],
      });
      await key('Enter');
      await waitFor(() => expect(options().length).toBe(50));
      const t0 = performance.now();
      for (const q of ['s', 'sp', 'spe', 'spec n', 'spec nu', 'spec num', 'spec numb']) await type(q);
      expect(performance.now() - t0).toBeLessThan(3000); // generous: a sanity check, not a benchmark
      expect(options().length).toBe(50);
    });
  });
});
