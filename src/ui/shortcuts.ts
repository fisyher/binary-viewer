/** Keyboard shortcuts that exist in the code (App, HexView, SpecJsonEditor, BuilderView); shown on the start screen and in About. */
export interface Shortcut {
  keys: string;
  action: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: 'Ctrl+K / F1', action: 'Open the command palette (Cmd+K on macOS)' },
  { keys: 'F6 / Shift+F6', action: 'Move focus to the next / previous region (activity bar, side bar, editor, Problems, inspector, status bar)' },
  { keys: 'Insert', action: 'Toggle insert / overwrite while editing' },
  { keys: 'Ctrl+Z / Ctrl+Y', action: 'Undo / redo (Ctrl+Shift+Z also redoes)' },
  { keys: 'Ctrl+C', action: 'Copy the selected bytes' },
  { keys: 'Ctrl+Home / Ctrl+End', action: 'Jump to the start / end of the file' },
  { keys: 'Ctrl+S', action: 'Save the file, or the format spec in a spec tab' },
  { keys: 'Ctrl+= / Ctrl+-', action: 'Zoom the interface in / out (90%, 100%, 115%, 130%)' },
  { keys: 'Ctrl+0', action: 'Reset the zoom to 100%' },
  { keys: 'Shift+F10 / Menu', action: 'On a focused panel or column divider: open its context menu (Reset layout)' },
];

/** The few shown on the start screen (the palette has its own line there). */
export const START_SHORTCUTS: readonly Shortcut[] = SHORTCUTS.slice(2, 5);
