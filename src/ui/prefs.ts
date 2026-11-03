const ENDIAN_KEY = 'binaryviewer.inspector.endian';

/** Saved inspector byte order; little-endian unless "be" was stored. Storage errors are ignored. */
export function loadLittleEndian(): boolean {
  try {
    return localStorage.getItem(ENDIAN_KEY) !== 'be';
  } catch {
    return true;
  }
}

export function saveLittleEndian(le: boolean): void {
  try {
    localStorage.setItem(ENDIAN_KEY, le ? 'le' : 'be');
  } catch {
    // storage unavailable (private mode, quota, disabled): the choice just won't persist
  }
}

const REWRITE_KEY = 'binaryviewer.builder.hideRewriteNotice';

/** True when the user chose "Don't show again" for the builder's canonical-rewrite notice. Storage errors read as false. */
export function loadHideRewriteNotice(): boolean {
  try {
    return localStorage.getItem(REWRITE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveHideRewriteNotice(): void {
  try {
    localStorage.setItem(REWRITE_KEY, '1');
  } catch {
    // storage unavailable: the notice just shows again next time
  }
}

// ---- Theme and layout ----

export type ThemePref = 'system' | 'light' | 'dark';

const THEME_KEY = 'binaryviewer.theme';

/** Saved theme choice; 'system' (follow the OS) unless light or dark was stored. Storage errors read as 'system'. */
export function loadTheme(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function saveTheme(theme: ThemePref): void {
  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // storage unavailable: the choice just won't persist
  }
}

/** Apply a theme choice to the document: 'system' removes the attribute so the media query decides. */
export function applyTheme(theme: ThemePref, root: HTMLElement = document.documentElement): void {
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

const LAYOUT_PREFIX = 'binaryviewer.layout.';

/** A saved panel size in px, or `fallback` when missing, malformed or not a finite number. */
export function loadSize(name: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(LAYOUT_PREFIX + name));
    return localStorage.getItem(LAYOUT_PREFIX + name) !== null && Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

export function saveSize(name: string, px: number): void {
  try {
    localStorage.setItem(LAYOUT_PREFIX + name, String(Math.round(px)));
  } catch {
    // not persisted
  }
}

/** A saved panel open/closed flag, or `fallback` when nothing valid was stored. */
export function loadFlag(name: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(LAYOUT_PREFIX + name);
    return v === '1' ? true : v === '0' ? false : fallback;
  } catch {
    return fallback;
  }
}

export function saveFlag(name: string, on: boolean): void {
  try {
    localStorage.setItem(LAYOUT_PREFIX + name, on ? '1' : '0');
  } catch {
    // not persisted
  }
}

/** Forget a saved panel size (it reads as missing again). */
export function clearSize(name: string): void {
  try {
    localStorage.removeItem(LAYOUT_PREFIX + name);
  } catch {
    // not persisted
  }
}

export type SideView = 'structure' | 'formats';

export function loadSideView(): SideView {
  try {
    return localStorage.getItem(LAYOUT_PREFIX + 'sideView') === 'formats' ? 'formats' : 'structure';
  } catch {
    return 'structure';
  }
}

export function saveSideView(v: SideView): void {
  try {
    localStorage.setItem(LAYOUT_PREFIX + 'sideView', v);
  } catch {
    // not persisted
  }
}

/** Whether the structure minimap beside the hex grid is shown (on unless switched off). */
export function loadShowMinimap(): boolean {
  return loadFlag('showMinimap', true);
}

export function saveShowMinimap(on: boolean): void {
  saveFlag('showMinimap', on);
}

/** Whether every other 8-byte group of the hex and ASCII columns gets a faint background (on unless switched off). */
export function loadHexBanding(): boolean {
  return loadFlag('hexBanding', true);
}

export function saveHexBanding(on: boolean): void {
  saveFlag('hexBanding', on);
}

/** Structure tree column widths (px) the user dragged; null = the default width (Name and Value flex). */
export type TreeColumn = 'name' | 'value' | 'type' | 'offset' | 'size';
/** Every data column of the tree, left to right (the narrow badge cell at the end is not resizable). */
export const TREE_COLUMNS: readonly TreeColumn[] = ['name', 'value', 'type', 'offset', 'size'];
export const TREE_COLUMN_MIN: Record<TreeColumn, number> = { name: 80, value: 60, type: 40, offset: 50, size: 36 };
export const TREE_COLUMN_MAX = 800;
const TREE_COLUMN_KEY: Record<TreeColumn, string> = {
  name: 'treeNameWidth',
  value: 'treeValueWidth',
  type: 'treeTypeWidth',
  offset: 'treeOffsetWidth',
  size: 'treeSizeWidth',
};
const treeColumnKey = (c: TreeColumn) => TREE_COLUMN_KEY[c];

/** The width a column takes when asked for something that is not a number (the least the default layout gives it). */
export const TREE_COLUMN_DEFAULT: Record<TreeColumn, number> = { name: 150, value: 90, type: 70, offset: 80, size: 50 };
/** Default widths (px) in the narrow tree layout, which has no Type column. */
export const TREE_COLUMN_DEFAULT_NARROW = { name: 100, value: 56, offset: 52, size: 30 } as const;

export function clampTreeColumn(c: TreeColumn, px: number): number {
  if (!Number.isFinite(px)) return TREE_COLUMN_DEFAULT[c];
  return Math.min(TREE_COLUMN_MAX, Math.max(TREE_COLUMN_MIN[c], Math.round(px)));
}

export function loadTreeColumn(c: TreeColumn): number | null {
  const v = loadSize(treeColumnKey(c), 0);
  return v > 0 ? clampTreeColumn(c, v) : null;
}

export function saveTreeColumn(c: TreeColumn, px: number | null): void {
  if (px === null) clearSize(treeColumnKey(c));
  else saveSize(treeColumnKey(c), clampTreeColumn(c, px));
}

// ---- Zoom ----

/** The UI sizes: a factor on every size in the app (1 = 100%). */
export const UI_SCALES = [0.9, 1, 1.15, 1.3] as const;
export type UiScale = (typeof UI_SCALES)[number];
const SCALE_KEY = 'binaryviewer.uiScale';

/** Saved zoom; 1 unless one of UI_SCALES was stored. Storage errors read as 1. */
export function loadUiScale(): UiScale {
  try {
    const v = Number(localStorage.getItem(SCALE_KEY));
    return UI_SCALES.find((s) => s === v) ?? 1;
  } catch {
    return 1;
  }
}

export function saveUiScale(scale: UiScale): void {
  try {
    if (scale === 1) localStorage.removeItem(SCALE_KEY);
    else localStorage.setItem(SCALE_KEY, String(scale));
  } catch {
    // storage unavailable: the choice just won't persist
  }
}

/** The next larger (`+1`) or smaller (`-1`) zoom, or the same one at the end of the list. */
export function stepUiScale(scale: UiScale, dir: 1 | -1): UiScale {
  const i = UI_SCALES.indexOf(scale) + dir;
  return UI_SCALES[Math.min(UI_SCALES.length - 1, Math.max(0, i))]!;
}

/**
 * Apply a zoom to the document with CSS `zoom` on the root (everything scales, dialogs included). `--ui-scale` lets
 * viewport-sized boxes (`100dvh`, which `zoom` would scale too) divide it back out.
 */
export function applyUiScale(scale: UiScale, root: HTMLElement = document.documentElement): void {
  if (scale === 1) {
    root.style.removeProperty('zoom');
    root.style.removeProperty('--ui-scale');
  } else {
    root.style.setProperty('zoom', String(scale));
    root.style.setProperty('--ui-scale', String(scale));
  }
}

// ---- Command palette ----

const RECENT_KEY = 'binaryviewer.recentCommands';
export const MAX_RECENT_COMMANDS = 5;

/** The ids of the most recently used palette commands, newest first. Anything that is not a short string list reads as empty. */
export function loadRecentCommands(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(v)) return [];
    const ids = v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200);
    return [...new Set(ids)].slice(0, MAX_RECENT_COMMANDS);
  } catch {
    return [];
  }
}

export function saveRecentCommands(ids: readonly string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, MAX_RECENT_COMMANDS)));
  } catch {
    // not persisted
  }
}

/** `id` moved to the front of `recent` (no duplicates, at most MAX_RECENT_COMMANDS). */
export function withRecentCommand(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter((x) => x !== id)].slice(0, MAX_RECENT_COMMANDS);
}
