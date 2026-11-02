/**
 * The command palette's registry: every command the app offers, built from a snapshot of the app's state and its
 * actions. Pure (no DOM, no Svelte), so the enabled/disabled logic is unit-testable. App.svelte supplies a context whose
 * fields are getters over its state; the palette reads the commands (and their `disabledReason`s) while it renders, so
 * they stay current while it is open.
 */
import { describeDetection } from '../core/format-status';
import { parseOffset, type OffsetMode } from '../core/parse-offset';
import { sanitizeText } from '../core/tree-model';
import type { DetectionInfo, SpecInfo } from '../worker/protocol';
import { UI_SCALES, type SideView, type ThemePref, type UiScale } from './prefs';
import { SHORTCUTS } from './shortcuts';

export type CommandGroup = 'File' | 'Format' | 'View' | 'Tabs' | 'Help';
/** The order the groups appear in when the query is empty. */
export const GROUP_ORDER: readonly CommandGroup[] = ['File', 'Format', 'View', 'Tabs', 'Help'];

/** One row of a pick list. */
export interface PickItem {
  id: string;
  label: string;
  /** Dimmed text on the right ("Current", "Built-in"). */
  hint?: string;
  /** Keys, shown in the mono face. */
  shortcut?: string;
}

/** What the palette turns into after a command that needs more input. */
export type SubMode =
  | {
      kind: 'offset';
      title: string;
      /** Validate; an error stays in the palette, a result closes it and is run once focus is back. */
      submit: (text: string, base: OffsetMode) => { error: string } | { run: () => void };
    }
  | {
      kind: 'pick';
      title: string;
      placeholder: string;
      /** Shown when the list is empty or nothing matches. */
      empty: string;
      items: PickItem[];
      /** Absent: the list is read-only (Enter does nothing). */
      pick?: (id: string) => void;
    };

export interface Command {
  /** Stable, used to remember recent commands. */
  id: string;
  /** Sentence case. May contain untrusted text (spec names): always render as text. */
  label: string;
  group: CommandGroup;
  shortcut?: string;
  /** Extra words that find the command but are not highlighted. */
  keywords?: string;
  /** Dimmed text on the right ("Current"). A disabled command shows its reason instead. */
  hint?: string;
  /** Listed only when the user has typed something (the long tail: one entry per library spec). */
  searchOnly?: boolean;
  /** Names something that may be gone next time (an open tab): not remembered as a recent command. */
  transient?: boolean;
  /** null when the command can run, else why it cannot. */
  disabledReason?: () => string | null;
  /** Runs once the palette is closed and focus is back where it was. */
  run?: () => void;
  /** Enters a sub-mode instead of running. */
  sub?: () => SubMode;
}

export interface CommandContext {
  hasFile: boolean;
  /** Save and Save as can run (the same rule as the title bar buttons and Ctrl+S). */
  canSave: boolean;
  fileSize: number;
  saving: boolean;
  unreadable: boolean;
  parsing: boolean;
  /** A format spec tab is the shown editor. */
  specActive: boolean;
  sideOpen: boolean;
  sideView: SideView;
  inspectorOpen: boolean;
  problemsOpen: boolean;
  showMinimap: boolean;
  /** Every other 8-byte group of the hex and ASCII columns is banded. */
  hexBanding: boolean;
  /** The UI zoom factor (1 = 100%). */
  uiScale: UiScale;
  theme: ThemePref;
  littleEndian: boolean;
  /** The formats the engine offers for the open file, and its detections and choice (as the Format selector). */
  specs: readonly SpecInfo[];
  detections: readonly DetectionInfo[];
  selectedSpec: string | null;
  /** Open editor tabs (the file and the specs). */
  tabs: ReadonlyArray<{ id: string; label: string; active: boolean }>;
  /** Every spec in the format library. */
  library: ReadonlyArray<{ id: string; name: string; custom: boolean }>;
  actions: {
    newFile(): void;
    openFile(): void;
    save(): void;
    saveAs(): void;
    goToOffset(offset: number): void;
    chooseFormat(specId: string | null): void;
    cancelParse(): void;
    toggleSide(): void;
    showView(view: SideView): void;
    toggleInspector(): void;
    toggleProblems(): void;
    toggleMinimap(): void;
    toggleHexBanding(): void;
    zoomIn(): void;
    zoomOut(): void;
    resetZoom(): void;
    /** Default panel sizes and visibility, tree column widths and minimap; not the theme, the zoom or the recent commands. */
    resetLayout(): void;
    /** Open the region if it is collapsed, then move keyboard focus into it. */
    focusSide(): void;
    focusEditor(): void;
    focusProblems(): void;
    focusInspector(): void;
    setTheme(theme: ThemePref): void;
    setLittleEndian(le: boolean): void;
    selectTab(id: string): void;
    closeSpecTab(): void;
    openSpec(id: string): void;
    openAbout(): void;
  };
}

const text = (s: string, max = 80) => sanitizeText(s, max);
const NO_FILE = 'Open a file first';
const SAVING = 'A save is in progress';
const UNREADABLE = 'The file can no longer be read; open it again';

export function buildCommands(c: CommandContext): Command[] {
  const a = c.actions;
  const when = (reason: () => string | null) => ({ disabledReason: reason });
  const needsFile = when(() => (c.hasFile ? null : NO_FILE));
  const notSaving = when(() => (c.saving ? SAVING : null));
  const canSave = when(() => (c.canSave ? null : !c.hasFile ? NO_FILE : c.saving ? SAVING : UNREADABLE));
  const onOff = (on: boolean, what: string) => `${on ? 'Hide' : 'Show'} ${what}`;

  const formatItems = (): PickItem[] => {
    const custom = new Set(c.specs.filter((s) => s.custom).map((s) => s.id));
    const tag = (id: string) => (custom.has(id) ? ' (custom)' : '');
    const detected = new Set(c.detections.map((d) => d.specId));
    const item = (id: string | null, label: string): PickItem => ({
      id: id ?? '',
      label,
      hint: c.selectedSpec === id ? 'Current' : undefined,
    });
    return [
      item(null, 'None (raw)'),
      ...c.detections.map((d) => item(d.specId, text(describeDetection(d), 120) + tag(d.specId))),
      ...c.specs.filter((s) => !detected.has(s.id)).map((s) => item(s.id, text(s.name, 120) + tag(s.id))),
    ];
  };

  return [
    { id: 'file.open', label: 'Open file…', group: 'File', ...notSaving, run: a.openFile },
    { id: 'file.new', label: 'New file', group: 'File', ...notSaving, run: a.newFile },
    // In a spec tab these still save the binary file (Ctrl+S there saves the spec), so the label says so.
    { id: 'file.save', label: c.specActive ? 'Save file' : 'Save', group: 'File', keywords: 'write', shortcut: c.specActive ? undefined : 'Ctrl+S', ...canSave, run: a.save },
    { id: 'file.saveAs', label: c.specActive ? 'Save file as…' : 'Save as…', group: 'File', keywords: 'write', ...canSave, run: a.saveAs },
    {
      id: 'file.goTo',
      label: 'Go to offset…',
      group: 'File',
      keywords: 'jump address',
      disabledReason: () => (!c.hasFile ? NO_FILE : c.fileSize === 0 ? 'The file is empty' : null),
      sub: () => ({
        kind: 'offset',
        title: 'Go to offset',
        submit: (t, base) => {
          const r = parseOffset(t, c.fileSize, base);
          return r.ok ? { run: () => a.goToOffset(r.offset) } : { error: r.error };
        },
      }),
    },

    {
      id: 'format.choose',
      label: 'Choose format…',
      group: 'Format',
      keywords: 'parse spec',
      ...needsFile,
      sub: () => ({
        kind: 'pick',
        title: 'Choose format',
        placeholder: 'Choose a format',
        empty: 'No formats available',
        items: formatItems(),
        pick: (id) => a.chooseFormat(id === '' ? null : id),
      }),
    },
    { id: 'format.cancel', label: 'Cancel parsing', group: 'Format', ...when(() => (c.parsing ? null : 'Nothing is being parsed')), run: a.cancelParse },

    { id: 'view.side', label: onOff(c.sideOpen, 'side bar'), group: 'View', keywords: 'toggle panel', run: a.toggleSide },
    { id: 'view.structure', label: 'Show Structure', group: 'View', keywords: 'tree', hint: c.sideOpen && c.sideView === 'structure' ? 'Shown' : undefined, run: () => a.showView('structure') },
    { id: 'view.formats', label: 'Show Formats', group: 'View', keywords: 'library specs', hint: c.sideOpen && c.sideView === 'formats' ? 'Shown' : undefined, run: () => a.showView('formats') },
    { id: 'view.inspector', label: onOff(c.inspectorOpen, 'data inspector'), group: 'View', keywords: 'toggle panel values', run: a.toggleInspector },
    { id: 'view.problems', label: onOff(c.problemsOpen, 'Problems panel'), group: 'View', keywords: 'toggle diagnostics errors warnings', ...needsFile, run: a.toggleProblems },
    { id: 'view.minimap', label: onOff(c.showMinimap, 'minimap'), group: 'View', keywords: 'toggle overview', run: a.toggleMinimap },
    { id: 'view.banding', label: 'Toggle hex row banding', group: 'View', keywords: 'stripes alternate groups columns hex ascii', hint: c.hexBanding ? 'On' : 'Off', run: a.toggleHexBanding },
    { id: 'view.zoomIn', label: 'Zoom in', group: 'View', keywords: 'larger bigger scale size text', shortcut: 'Ctrl+=', ...when(() => (c.uiScale >= UI_SCALES[UI_SCALES.length - 1]! ? 'Already at the largest size' : null)), run: a.zoomIn },
    { id: 'view.zoomOut', label: 'Zoom out', group: 'View', keywords: 'smaller scale size text', shortcut: 'Ctrl+-', ...when(() => (c.uiScale <= UI_SCALES[0]! ? 'Already at the smallest size' : null)), run: a.zoomOut },
    { id: 'view.zoomReset', label: 'Reset zoom', group: 'View', keywords: 'scale size 100%', shortcut: 'Ctrl+0', ...when(() => (c.uiScale === 1 ? 'Already at 100%' : null)), run: a.resetZoom },
    { id: 'view.resetLayout', label: 'Reset layout', group: 'View', keywords: 'default panels sizes columns restore', run: a.resetLayout },
    { id: 'view.focus.side', label: 'Focus side bar', group: 'View', keywords: 'region navigate tree structure formats', run: a.focusSide },
    { id: 'view.focus.editor', label: 'Focus editor', group: 'View', keywords: 'region navigate hex bytes', run: a.focusEditor },
    { id: 'view.focus.problems', label: 'Focus Problems', group: 'View', keywords: 'region navigate panel diagnostics errors warnings', ...needsFile, run: a.focusProblems },
    { id: 'view.focus.inspector', label: 'Focus inspector', group: 'View', keywords: 'region navigate data values', run: a.focusInspector },
    ...(['system', 'light', 'dark'] as const).map(
      (t): Command => ({
        id: `view.theme.${t}`,
        label: `Theme: ${t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark'}`,
        group: 'View',
        keywords: 'appearance colour color mode',
        hint: c.theme === t ? 'Current' : undefined,
        run: () => a.setTheme(t),
      }),
    ),
    { id: 'view.endian.le', label: 'Byte order: little-endian', group: 'View', keywords: 'endianness inspector', hint: c.littleEndian ? 'Current' : undefined, run: () => a.setLittleEndian(true) },
    { id: 'view.endian.be', label: 'Byte order: big-endian', group: 'View', keywords: 'endianness inspector', hint: c.littleEndian ? undefined : 'Current', run: () => a.setLittleEndian(false) },

    ...c.tabs.filter((t) => !t.active).map((t): Command => ({ id: `tab.${t.id}`, label: `Switch to ${text(t.label, 60)}`, group: 'Tabs', transient: true, run: () => a.selectTab(t.id) })),
    { id: 'tab.closeSpec', label: 'Close spec tab', group: 'Tabs', ...when(() => (c.specActive ? null : 'No spec tab is shown')), run: a.closeSpecTab },
    {
      id: 'tab.openSpec',
      label: 'Open format spec…',
      group: 'Tabs',
      keywords: 'library edit',
      sub: () => ({
        kind: 'pick',
        title: 'Open format spec',
        placeholder: 'Open a format spec',
        empty: 'The format library is empty',
        items: c.library.map((s) => ({ id: s.id, label: text(s.name, 120), hint: s.custom ? 'Custom' : 'Built-in' })),
        pick: a.openSpec,
      }),
    },
    ...c.library.map((s): Command => ({ id: `spec.${s.id}`, label: `Open spec ${text(s.name, 60)}`, group: 'Tabs', searchOnly: true, run: () => a.openSpec(s.id) })),

    { id: 'help.about', label: 'About Binary Viewer', group: 'Help', run: a.openAbout },
    {
      id: 'help.shortcuts',
      label: 'Keyboard shortcuts',
      group: 'Help',
      keywords: 'keys help',
      sub: () => ({
        kind: 'pick',
        title: 'Keyboard shortcuts',
        placeholder: 'Search the shortcuts',
        empty: 'No shortcuts match',
        items: SHORTCUTS.map((s, i) => ({ id: String(i), label: s.action, shortcut: s.keys })),
      }),
    },
  ];
}
