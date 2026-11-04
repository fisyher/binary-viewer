/**
 * The UI zoom as the page applies it (CSS `zoom` on <html>, and the same number in `--ui-scale`; see `applyUiScale`): how many
 * screen pixels one CSS pixel of the page takes. Pointer coordinates (clientX, clientY, getBoundingClientRect) are in screen
 * pixels, while layout sizes (px widths and heights) are in the zoomed page's own CSS pixels, so a drag distance must be divided by
 * this before it changes a size. Read from the root's `--ui-scale` rather than measured from a (thin, rounded) element.
 * 1 when it is missing or not a sensible number.
 */
export function visualScale(root: HTMLElement = document.documentElement): number {
  const k = parseFloat(root.style.getPropertyValue('--ui-scale') || getComputedStyle(root).getPropertyValue('--ui-scale'));
  return Number.isFinite(k) && k >= 0.5 && k <= 4 ? k : 1;
}
