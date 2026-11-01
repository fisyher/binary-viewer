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
