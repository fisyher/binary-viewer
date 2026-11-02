/**
 * Region navigation (F6 / Shift+F6): the shell's landmark regions in visual order, which of them can take focus right now,
 * and which one comes next. Pure ordering logic plus two small DOM lookups; what "focus a region" does is up to App.svelte.
 */
export type RegionId = 'activity' | 'side' | 'editor' | 'bottom' | 'inspector' | 'status';

/** Visual order, left to right and top to bottom. */
export const REGION_ORDER: readonly RegionId[] = ['activity', 'side', 'editor', 'bottom', 'inspector', 'status'];

const IDS = new Set<string>(REGION_ORDER);

/** The regions that can take focus now, in visual order (`shown` says which are on screen and not inert). */
export function visibleRegions(shown: Readonly<Record<RegionId, boolean>>): RegionId[] {
  return REGION_ORDER.filter((id) => shown[id]);
}

/** The region an element is in: its nearest `data-region` ancestor (so the bottom panel inside the editor is "bottom"). */
export function regionOf(el: Element | null): RegionId | null {
  const id = el?.closest?.('[data-region]')?.getAttribute('data-region') ?? null;
  return id !== null && IDS.has(id) ? (id as RegionId) : null;
}

/**
 * The region F6 (forward) or Shift+F6 (`backward`) moves to, wrapping round. `current` is the region focus is in; when
 * focus is in none of the shell's regions (or in one that is not visible) the editor is the target, or the first visible
 * region when the editor is not visible. Null when no region is visible.
 */
export function nextRegion(visible: readonly RegionId[], current: RegionId | null, backward: boolean): RegionId | null {
  if (visible.length === 0) return null;
  const at = current === null ? -1 : visible.indexOf(current);
  if (at < 0) return visible.includes('editor') ? 'editor' : visible[0]!;
  return visible[(at + (backward ? visible.length - 1 : 1)) % visible.length]!;
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

/** The first control in `container` that keyboard focus can go to (not disabled, not inside an inert, hidden or aria-hidden part). */
export function firstFocusable(container: Element | null): HTMLElement | null {
  if (!container) return null;
  for (const el of container.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (!el.closest('[inert], [hidden], [aria-hidden="true"], .hidden')) return el;
  }
  return null;
}
