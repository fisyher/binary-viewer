/** True on Apple platforms, where the shortcut key is Cmd rather than Ctrl. Reads the browser's platform string once. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || '');
}

/** How the command palette key reads on this platform: "Ctrl K", or "⌘K" on macOS. */
export const paletteKeyHint = (mac = isMac()): string => (mac ? '⌘K' : 'Ctrl K');

/** The same for an accessible name or a title: "Ctrl+K" / "Cmd+K". */
export const paletteKeyName = (mac = isMac()): string => (mac ? 'Cmd+K' : 'Ctrl+K');
