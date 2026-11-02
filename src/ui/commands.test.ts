import { describe, expect, it, vi } from 'vitest';
import type { DetectionInfo, SpecInfo } from '../worker/protocol';
import { GROUP_ORDER, buildCommands, type Command, type CommandContext } from './commands';
import { SHORTCUTS } from './shortcuts';

function ctx(over: Partial<Omit<CommandContext, 'actions'>> = {}) {
  const calls: string[] = [];
  const log =
    (name: string) =>
    (...args: unknown[]) =>
      calls.push([name, ...args].join(':'));
  const actions = Object.fromEntries(
    [
      'newFile', 'openFile', 'save', 'saveAs', 'goToOffset', 'chooseFormat', 'cancelParse', 'toggleSide', 'showView', 'toggleInspector',
      'toggleProblems', 'toggleMinimap', 'focusSide', 'focusEditor', 'focusProblems', 'focusInspector', 'setTheme', 'setLittleEndian', 'selectTab', 'closeSpecTab', 'openSpec', 'openAbout',
    ].map((n) => [n, log(n)]),
  ) as unknown as CommandContext['actions'];
  const c: CommandContext = {
    hasFile: true,
    canSave: true,
    fileSize: 0x400,
    saving: false,
    unreadable: false,
    parsing: false,
    specActive: false,
    sideOpen: true,
    sideView: 'structure',
    inspectorOpen: true,
    problemsOpen: true,
    showMinimap: true,
    theme: 'system',
    littleEndian: true,
    specs: [],
    detections: [],
    selectedSpec: null,
    tabs: [{ id: 'file', label: 'a.bin', active: true }],
    library: [],
    actions,
    ...over,
  };
  if (!('canSave' in over)) c.canSave = c.hasFile && !c.saving && !c.unreadable;
  return { c, calls, commands: buildCommands(c) };
}

const find = (cs: Command[], id: string) => {
  const c = cs.find((x) => x.id === id);
  if (!c) throw new Error('no command ' + id);
  return c;
};
const reason = (cs: Command[], id: string) => find(cs, id).disabledReason?.() ?? null;

describe('buildCommands', () => {
  it('has unique ids, sentence-case labels without arrows, and only known groups', () => {
    const { commands } = ctx({ library: [{ id: 'bmp', name: 'Windows Bitmap', custom: false }], tabs: [{ id: 'file', label: 'a.bin', active: false }, { id: 'spec:x', label: 'X', active: true }] });
    expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length);
    for (const c of commands) {
      expect(GROUP_ORDER).toContain(c.group);
      expect(c.label).not.toMatch(/→|->/);
      expect(c.label).toBe(c.label.trim());
      expect(c.label[0]).toMatch(/[A-Z]/);
    }
  });

  it('offers every command the brief lists', () => {
    const { commands } = ctx();
    const labels = commands.map((c) => c.label);
    for (const l of [
      'Open file…', 'New file', 'Save', 'Save as…', 'Go to offset…', 'Choose format…', 'Cancel parsing', 'Hide side bar', 'Show Structure', 'Show Formats',
      'Hide data inspector', 'Hide Problems panel', 'Hide minimap', 'Theme: System', 'Theme: Light', 'Theme: Dark', 'Byte order: little-endian',
      'Byte order: big-endian', 'Focus side bar', 'Focus editor', 'Focus Problems', 'Focus inspector', 'Close spec tab', 'Open format spec…', 'About Binary Viewer', 'Keyboard shortcuts',
    ]) expect(labels).toContain(l);
  });

  it('toggle labels follow the state', () => {
    const { commands } = ctx({ sideOpen: false, inspectorOpen: false, problemsOpen: false, showMinimap: false });
    const labels = commands.map((c) => c.label);
    expect(labels).toEqual(expect.arrayContaining(['Show side bar', 'Show data inspector', 'Show Problems panel', 'Show minimap']));
    expect(labels).not.toContain('Hide minimap');
  });

  it('marks the current theme and byte order with a hint', () => {
    const { commands } = ctx({ theme: 'dark', littleEndian: false });
    expect(find(commands, 'view.theme.dark').hint).toBe('Current');
    expect(find(commands, 'view.theme.light').hint).toBeUndefined();
    expect(find(commands, 'view.endian.be').hint).toBe('Current');
    expect(find(commands, 'view.endian.le').hint).toBeUndefined();
  });

  it('runs the actions of the plain commands', () => {
    const { commands, calls } = ctx();
    for (const id of ['file.open', 'file.new', 'file.save', 'file.saveAs', 'view.side', 'view.minimap', 'view.inspector', 'view.problems', 'help.about']) find(commands, id).run!();
    find(commands, 'view.structure').run!();
    find(commands, 'view.formats').run!();
    find(commands, 'view.theme.light').run!();
    find(commands, 'view.endian.be').run!();
    expect(calls).toEqual([
      'openFile', 'newFile', 'save', 'saveAs', 'toggleSide', 'toggleMinimap', 'toggleInspector', 'toggleProblems', 'openAbout',
      'showView:structure', 'showView:formats', 'setTheme:light', 'setLittleEndian:false',
    ]);
  });

  it('the Focus commands are in the View group and run their actions', () => {
    const { commands, calls } = ctx();
    for (const id of ['view.focus.side', 'view.focus.editor', 'view.focus.problems', 'view.focus.inspector']) {
      expect(find(commands, id).group, id).toBe('View');
      find(commands, id).run!();
    }
    expect(calls).toEqual(['focusSide', 'focusEditor', 'focusProblems', 'focusInspector']);
    expect(reason(ctx({ hasFile: false, fileSize: 0 }).commands, 'view.focus.problems')).toBe('Open a file first');
    expect(reason(ctx({ hasFile: false, fileSize: 0 }).commands, 'view.focus.side')).toBeNull();
  });

  describe('enabled / disabled', () => {
    it('everything that needs a file says so without one', () => {
      const { commands } = ctx({ hasFile: false, fileSize: 0 });
      for (const id of ['file.save', 'file.saveAs', 'file.goTo', 'format.choose', 'view.problems']) expect(reason(commands, id), id).toBe('Open a file first');
      for (const id of ['file.open', 'file.new', 'view.side', 'view.minimap', 'view.inspector', 'help.about', 'tab.openSpec']) expect(reason(commands, id), id).toBeNull();
    });

    it('Save and Save as follow the title bar buttons: saving and unreadable disable them', () => {
      expect(reason(ctx().commands, 'file.save')).toBeNull();
      expect(reason(ctx().commands, 'file.saveAs')).toBeNull();
      const saving = ctx({ saving: true }).commands;
      expect(reason(saving, 'file.save')).toBe('A save is in progress');
      expect(reason(saving, 'file.saveAs')).toBe('A save is in progress');
      expect(reason(saving, 'file.open')).toBe('A save is in progress');
      expect(reason(saving, 'file.new')).toBe('A save is in progress');
      const unreadable = ctx({ unreadable: true }).commands;
      expect(reason(unreadable, 'file.save')).toMatch(/can no longer be read/);
      expect(reason(unreadable, 'file.saveAs')).toMatch(/can no longer be read/);
      expect(reason(unreadable, 'file.open')).toBeNull(); // opening another file is the way out
    });

    it('Save and Save as follow the single canSave rule', () => {
      const blocked = ctx({ canSave: false }).commands;
      expect(reason(blocked, 'file.save')).not.toBeNull();
      expect(reason(blocked, 'file.saveAs')).not.toBeNull();
    });

    it('in a spec tab Save says it saves the file and no longer claims Ctrl+S', () => {
      const file = ctx().commands;
      expect(find(file, 'file.save')).toMatchObject({ label: 'Save', shortcut: 'Ctrl+S' });
      const spec = ctx({ specActive: true }).commands;
      expect(find(spec, 'file.save').label).toBe('Save file');
      expect(find(spec, 'file.save').shortcut).toBeUndefined();
      expect(find(spec, 'file.saveAs').label).toBe('Save file as…');
    });

    it('Go to offset needs a non-empty file', () => {
      expect(reason(ctx({ fileSize: 0 }).commands, 'file.goTo')).toBe('The file is empty');
    });

    it('Cancel parsing is available only while parsing', () => {
      expect(reason(ctx().commands, 'format.cancel')).toBe('Nothing is being parsed');
      expect(reason(ctx({ parsing: true }).commands, 'format.cancel')).toBeNull();
    });

    it('Close spec tab is available only while a spec tab is shown', () => {
      expect(reason(ctx().commands, 'tab.closeSpec')).toBe('No spec tab is shown');
      expect(reason(ctx({ specActive: true }).commands, 'tab.closeSpec')).toBeNull();
    });

    it('reads the state when asked, not when built (so an open palette stays current)', () => {
      const state = { hasFile: false };
      const x = ctx();
      Object.defineProperty(x.c, 'hasFile', { get: () => state.hasFile });
      Object.defineProperty(x.c, 'canSave', { get: () => state.hasFile });
      const commands = buildCommands(x.c);
      expect(reason(commands, 'file.save')).toBe('Open a file first');
      state.hasFile = true;
      expect(reason(commands, 'file.save')).toBeNull();
    });
  });

  describe('Go to offset', () => {
    const sub = (over?: Partial<Omit<CommandContext, 'actions'>>) => {
      const x = ctx(over);
      const mode = find(x.commands, 'file.goTo').sub!();
      if (mode.kind !== 'offset') throw new Error('expected an offset mode');
      return { ...x, mode };
    };

    it('is an offset sub-mode, not a plain command', () => {
      const { commands } = ctx();
      expect(find(commands, 'file.goTo').run).toBeUndefined();
      expect(sub().mode.title).toBe('Go to offset');
    });

    it('parses hex (with or without 0x) and decimal and defers the jump', () => {
      const { mode, calls } = sub();
      const hex = mode.submit('1F4', 'hex');
      expect('run' in hex).toBe(true);
      expect(calls).toEqual([]); // nothing happens until the palette has closed
      if ('run' in hex) hex.run();
      const prefixed = mode.submit('0x10', 'hex');
      if ('run' in prefixed) prefixed.run();
      const dec = mode.submit('100', 'dec');
      if ('run' in dec) dec.run();
      expect(calls).toEqual(['goToOffset:500', 'goToOffset:16', 'goToOffset:100']);
    });

    it('returns the parser error text and does not run', () => {
      const { mode, calls } = sub();
      expect(mode.submit('', 'hex')).toEqual({ error: 'Enter an offset' });
      expect(mode.submit('zz', 'hex')).toEqual({ error: 'Invalid hex offset (e.g. 1F or 0x1F)' });
      expect(mode.submit('12a', 'dec')).toEqual({ error: 'Invalid decimal offset' });
      expect(mode.submit('400', 'hex')).toEqual({ error: 'Out of range (last offset is 0x3FF)' });
      expect(calls).toEqual([]);
    });
  });

  describe('Choose format', () => {
    const specs: SpecInfo[] = [
      { id: 'bmp', name: 'Windows Bitmap', custom: false } as SpecInfo,
      { id: 'mine', name: 'My <b>format</b>', custom: true } as SpecInfo,
      { id: 'zip', name: 'ZIP', custom: false } as SpecInfo,
    ];
    const detections: DetectionInfo[] = [{ specId: 'bmp', name: 'Windows Bitmap', magicMatched: true, reasons: ['magic matched'] } as DetectionInfo];

    it('lists None, the detections first, then the other formats, marking custom ones and the current choice', () => {
      const x = ctx({ specs, detections, selectedSpec: 'bmp' });
      const mode = find(x.commands, 'format.choose').sub!();
      if (mode.kind !== 'pick') throw new Error('expected a pick list');
      expect(mode.items.map((i) => i.label)).toEqual(['None (raw)', 'Windows Bitmap (magic)', 'My <b>format</b> (custom)', 'ZIP']);
      expect(mode.items.map((i) => i.hint)).toEqual([undefined, 'Current', undefined, undefined]);
    });

    it('picking runs chooseFormat; None means null', () => {
      const x = ctx({ specs, detections });
      const mode = find(x.commands, 'format.choose').sub!();
      if (mode.kind !== 'pick') throw new Error();
      mode.pick!('zip');
      mode.pick!('');
      expect(x.calls).toEqual(['chooseFormat:zip', 'chooseFormat:']);
    });

    it('marks None as current when no format is selected', () => {
      const x = ctx({ specs, detections, selectedSpec: null });
      const mode = find(x.commands, 'format.choose').sub!();
      if (mode.kind !== 'pick') throw new Error();
      expect(mode.items[0]).toMatchObject({ label: 'None (raw)', hint: 'Current' });
    });
  });

  describe('Tabs', () => {
    it('offers Switch to for each tab except the active one', () => {
      const { commands, calls } = ctx({
        tabs: [
          { id: 'file', label: 'a.bin', active: false },
          { id: 'spec:one', label: 'One', active: true },
          { id: 'spec:two', label: 'Two', active: false },
        ],
      });
      const labels = commands.filter((c) => c.id.startsWith('tab.') && c.label.startsWith('Switch to')).map((c) => c.label);
      expect(labels).toEqual(['Switch to a.bin', 'Switch to Two']);
      expect(find(commands, 'tab.spec:two').transient).toBe(true);
      find(commands, 'tab.spec:two').run!();
      expect(calls).toEqual(['selectTab:spec:two']);
    });

    it('lists the library in the Open format spec sub-mode and as search-only commands', () => {
      const x = ctx({ library: [{ id: 'bmp', name: 'Windows Bitmap', custom: false }, { id: 'mine', name: 'Mine', custom: true }] });
      const mode = find(x.commands, 'tab.openSpec').sub!();
      if (mode.kind !== 'pick') throw new Error();
      expect(mode.items).toEqual([
        { id: 'bmp', label: 'Windows Bitmap', hint: 'Built-in' },
        { id: 'mine', label: 'Mine', hint: 'Custom' },
      ]);
      mode.pick!('mine');
      const direct = find(x.commands, 'spec.bmp');
      expect(direct.label).toBe('Open spec Windows Bitmap');
      expect(direct.searchOnly).toBe(true);
      direct.run!();
      expect(x.calls).toEqual(['openSpec:mine', 'openSpec:bmp']);
    });

    it('cleans untrusted names (control characters, length) before they become labels', () => {
      const evil = 'Evil\u0000‮ name' + 'x'.repeat(500);
      const { commands } = ctx({ library: [{ id: 'e', name: evil, custom: true }], tabs: [{ id: 'spec:e', label: evil, active: false }] });
      for (const c of commands.filter((c) => c.id === 'spec.e' || c.id === 'tab.spec:e')) {
        expect(c.label.length).toBeLessThan(100);
        expect(c.label).not.toMatch(/[\u0000‮]/);
      }
    });
  });

  it('Keyboard shortcuts is a read-only list of src/ui/shortcuts.ts', () => {
    const mode = find(ctx().commands, 'help.shortcuts').sub!();
    if (mode.kind !== 'pick') throw new Error();
    expect(mode.pick).toBeUndefined();
    expect(mode.items.map((i) => i.shortcut)).toEqual(SHORTCUTS.map((s) => s.keys));
    expect(mode.items.some((i) => i.shortcut?.includes('Ctrl+K'))).toBe(true);
  });

  it('about runs the opener action once', () => {
    const x = ctx();
    const spy = vi.fn();
    x.c.actions.openAbout = spy;
    find(buildCommands(x.c), 'help.about').run!();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
