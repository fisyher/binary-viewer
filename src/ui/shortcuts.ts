/** Keyboard shortcuts that exist in the code (HexView, SpecJsonEditor, BuilderView); shown on the start screen and in About. */
export interface Shortcut {
  keys: string;
  action: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: 'Insert', action: 'Toggle insert / overwrite while editing' },
  { keys: 'Ctrl+Z / Ctrl+Y', action: 'Undo / redo (Ctrl+Shift+Z also redoes)' },
  { keys: 'Ctrl+C', action: 'Copy the selected bytes' },
  { keys: 'Ctrl+Home / Ctrl+End', action: 'Jump to the start / end of the file' },
  { keys: 'Ctrl+S', action: 'Save the format spec (in a spec tab)' },
];

/** The few shown on the start screen. */
export const START_SHORTCUTS: readonly Shortcut[] = SHORTCUTS.slice(0, 3);
