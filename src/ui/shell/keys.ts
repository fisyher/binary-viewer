/**
 * App-wide keyboard shortcuts, decided in one place. App.svelte listens on the window (bubbling phase), so a focused
 * control that already handled the key and called preventDefault() (HexView, the spec editors) wins; the app only
 * looks at what is left.
 *
 * Ctrl+K and F1 open the command palette (Cmd+K on macOS). Ctrl+Shift+P is deliberately not used: Firefox reserves
 * it for a private window, and pages cannot override it. Ctrl+S saves the open file.
 */
export type GlobalKey = 'palette' | 'save';

type KeyInfo = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'> & Partial<Pick<KeyboardEvent, 'code'>>;

/** The IME "process" key code: a key pressed while an input method is composing, even when `isComposing` is false. */
export const IME_KEYCODE = 229;

/** True for a key press that belongs to an input method; it must not run anything. */
export const isImeKey = (e: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean => e.isComposing || e.keyCode === IME_KEYCODE;

/**
 * The shortcut a key press is, if any. A held key repeats `keydown`: callers must still preventDefault a repeat (so the
 * browser stays out of it) but should not act on `e.repeat`.
 */
export function globalKey(e: KeyInfo): GlobalKey | null {
  if (e.isComposing || e.altKey) return null;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'F1') return mod || e.shiftKey ? null : 'palette';
  if (!mod || e.shiftKey) return null;
  const k = e.key.toLowerCase();
  if (k === 'k') return 'palette';
  // A layout without Latin letters (Cyrillic, Greek, ...) reports another character; the physical K key still counts.
  if (e.code === 'KeyK' && !/^[a-z]$/i.test(e.key)) return 'palette';
  if (k === 's') return 'save';
  return null;
}
