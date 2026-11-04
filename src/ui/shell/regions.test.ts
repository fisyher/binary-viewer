// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { REGION_ORDER, firstFocusable, nextRegion, regionOf, visibleRegions, type RegionId } from './regions';

const all = Object.fromEntries(REGION_ORDER.map((r) => [r, true])) as Record<RegionId, boolean>;

describe('visibleRegions', () => {
  it('keeps the visual order and drops what is not shown', () => {
    expect(visibleRegions(all)).toEqual(['activity', 'side', 'editor', 'bottom', 'inspector', 'status']);
    expect(visibleRegions({ ...all, side: false, inspector: false })).toEqual(['activity', 'editor', 'bottom', 'status']);
    expect(visibleRegions({ activity: false, side: false, editor: false, bottom: false, inspector: false, status: false })).toEqual([]);
  });
});

describe('nextRegion', () => {
  const v = visibleRegions(all);

  it('moves forward and backward through the regions, wrapping round', () => {
    expect(nextRegion(v, 'activity', false)).toBe('side');
    expect(nextRegion(v, 'editor', false)).toBe('bottom');
    expect(nextRegion(v, 'status', false)).toBe('activity');
    expect(nextRegion(v, 'status', true)).toBe('inspector');
    expect(nextRegion(v, 'activity', true)).toBe('status');
  });

  it('skips regions that are not visible', () => {
    const some = visibleRegions({ ...all, side: false, bottom: false });
    expect(nextRegion(some, 'activity', false)).toBe('editor');
    expect(nextRegion(some, 'editor', false)).toBe('inspector');
    expect(nextRegion(some, 'editor', true)).toBe('activity');
  });

  it('goes to the editor when focus is in none of the regions, or in one that is no longer visible', () => {
    expect(nextRegion(v, null, false)).toBe('editor');
    expect(nextRegion(v, null, true)).toBe('editor');
    expect(nextRegion(visibleRegions({ ...all, side: false }), 'side', false)).toBe('editor');
  });

  it('falls back to the first visible region without an editor, and to null without any', () => {
    expect(nextRegion(visibleRegions({ ...all, editor: false }), null, false)).toBe('activity');
    expect(nextRegion([], null, false)).toBeNull();
    expect(nextRegion(['status'], 'status', false)).toBe('status');
  });
});

describe('regionOf', () => {
  it('uses the nearest data-region ancestor, so a panel inside the editor is its own region', () => {
    document.body.innerHTML = `
      <main data-region="editor"><button id="a">a</button><section data-region="bottom"><button id="b">b</button></section></main>
      <div data-region="bogus"><button id="c">c</button></div>
      <button id="d">d</button>`;
    expect(regionOf(document.getElementById('a'))).toBe('editor');
    expect(regionOf(document.getElementById('b'))).toBe('bottom');
    expect(regionOf(document.getElementById('c'))).toBeNull();
    expect(regionOf(document.getElementById('d'))).toBeNull();
    expect(regionOf(null)).toBeNull();
  });
});

describe('firstFocusable', () => {
  it('skips disabled, inert, hidden and aria-hidden controls', () => {
    document.body.innerHTML = `
      <div id="box">
        <button disabled>off</button>
        <div inert><button>inert</button></div>
        <div class="hidden"><button>hidden</button></div>
        <div aria-hidden="true"><button>aria</button></div>
        <input tabindex="-1" />
        <button id="want">ok</button>
      </div>`;
    expect(firstFocusable(document.getElementById('box'))?.id).toBe('want');
    expect(firstFocusable(null)).toBeNull();
    document.body.innerHTML = '<div id="e"><p>nothing</p></div>';
    expect(firstFocusable(document.getElementById('e'))).toBeNull();
  });
});
