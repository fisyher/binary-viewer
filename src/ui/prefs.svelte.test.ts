// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UI_SCALES,
  applyTheme,
  applyUiScale,
  clampTreeColumn,
  loadFlag,
  loadHexBanding,
  loadRecentCommands,
  loadShowMinimap,
  loadSideView,
  loadSize,
  loadTheme,
  loadTreeColumn,
  loadUiScale,
  saveFlag,
  saveHexBanding,
  saveRecentCommands,
  saveShowMinimap,
  saveSideView,
  saveSize,
  saveTheme,
  saveTreeColumn,
  saveUiScale,
  stepUiScale,
  withRecentCommand,
} from './prefs';

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('style');
  vi.restoreAllMocks();
});

describe('theme preference', () => {
  it('defaults to system and round-trips light and dark', () => {
    expect(loadTheme()).toBe('system');
    saveTheme('dark');
    expect(loadTheme()).toBe('dark');
    saveTheme('light');
    expect(loadTheme()).toBe('light');
    saveTheme('system');
    expect(localStorage.getItem('binaryviewer.theme')).toBeNull();
    expect(loadTheme()).toBe('system');
  });

  it('reads an unknown stored value as system', () => {
    localStorage.setItem('binaryviewer.theme', 'sepia');
    expect(loadTheme()).toBe('system');
  });

  it('applyTheme sets data-theme for light/dark and removes it for system', () => {
    const root = document.documentElement;
    applyTheme('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    applyTheme('light');
    expect(root.getAttribute('data-theme')).toBe('light');
    applyTheme('system');
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('survives unavailable storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(loadTheme()).toBe('system');
    expect(() => saveTheme('dark')).not.toThrow();
    expect(loadSize('x', 7)).toBe(7);
    expect(loadFlag('x', true)).toBe(true);
    expect(loadSideView()).toBe('structure');
    expect(() => saveSize('x', 1)).not.toThrow();
    expect(() => saveFlag('x', true)).not.toThrow();
    expect(() => saveSideView('formats')).not.toThrow();
  });
});

describe('minimap preference', () => {
  it('is on by default and round-trips', () => {
    expect(loadShowMinimap()).toBe(true);
    saveShowMinimap(false);
    expect(loadShowMinimap()).toBe(false);
    saveShowMinimap(true);
    expect(loadShowMinimap()).toBe(true);
  });
});

describe('layout preferences', () => {
  it('sizes: saved value, fallback for missing, malformed, zero or negative', () => {
    expect(loadSize('w', 300)).toBe(300);
    saveSize('w', 345.6);
    expect(loadSize('w', 300)).toBe(346);
    for (const bad of ['', 'abc', '0', '-5', 'Infinity']) {
      localStorage.setItem('binaryviewer.layout.w', bad);
      expect(loadSize('w', 300), bad).toBe(300);
    }
  });

  it('flags: saved value or the fallback', () => {
    expect(loadFlag('f', true)).toBe(true);
    expect(loadFlag('f', false)).toBe(false);
    saveFlag('f', false);
    expect(loadFlag('f', true)).toBe(false);
    saveFlag('f', true);
    expect(loadFlag('f', false)).toBe(true);
    localStorage.setItem('binaryviewer.layout.f', 'maybe');
    expect(loadFlag('f', true)).toBe(true);
  });

  it('side bar view defaults to structure', () => {
    expect(loadSideView()).toBe('structure');
    saveSideView('formats');
    expect(loadSideView()).toBe('formats');
    localStorage.setItem('binaryviewer.layout.sideView', 'other');
    expect(loadSideView()).toBe('structure');
  });
});

describe('recent commands', () => {
  it('round-trips, newest first, at most five', () => {
    expect(loadRecentCommands()).toEqual([]);
    let r: string[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) r = withRecentCommand(r, id);
    expect(r).toEqual(['f', 'e', 'd', 'c', 'b']);
    saveRecentCommands(r);
    expect(loadRecentCommands()).toEqual(r);
  });

  it('moves a repeated command to the front without duplicating it', () => {
    expect(withRecentCommand(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('reads malformed storage as empty or keeps only the valid strings', () => {
    localStorage.setItem('binaryviewer.recentCommands', '{not json');
    expect(loadRecentCommands()).toEqual([]);
    localStorage.setItem('binaryviewer.recentCommands', '{"a":1}');
    expect(loadRecentCommands()).toEqual([]);
    localStorage.setItem('binaryviewer.recentCommands', JSON.stringify(['a', 3, '', 'a', null, 'b', 'x'.repeat(500)]));
    expect(loadRecentCommands()).toEqual(['a', 'b']);
  });

  it('survives unavailable storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(loadRecentCommands()).toEqual([]);
    expect(() => saveRecentCommands(['a'])).not.toThrow();
  });
});

describe('hex banding preference', () => {
  it('is on by default and round-trips', () => {
    expect(loadHexBanding()).toBe(true);
    saveHexBanding(false);
    expect(loadHexBanding()).toBe(false);
    expect(localStorage.getItem('binaryviewer.layout.hexBanding')).toBe('0');
    saveHexBanding(true);
    expect(loadHexBanding()).toBe(true);
  });
});

describe('UI scale preference', () => {
  it('defaults to 1 and round-trips each allowed value', () => {
    expect(loadUiScale()).toBe(1);
    for (const s of UI_SCALES) {
      saveUiScale(s);
      expect(loadUiScale()).toBe(s);
    }
    saveUiScale(1);
    expect(localStorage.getItem('binaryviewer.uiScale')).toBeNull();
  });

  it('reads anything that is not one of the allowed values as 1', () => {
    for (const v of ['2', '0', '-1', '1.2', 'big', '', 'NaN', 'Infinity']) {
      localStorage.setItem('binaryviewer.uiScale', v);
      expect(loadUiScale(), v).toBe(1);
    }
  });

  it('steps through the list and stops at both ends', () => {
    expect(stepUiScale(1, 1)).toBe(1.15);
    expect(stepUiScale(1.15, 1)).toBe(1.3);
    expect(stepUiScale(1.3, 1)).toBe(1.3);
    expect(stepUiScale(1, -1)).toBe(0.9);
    expect(stepUiScale(0.9, -1)).toBe(0.9);
  });

  it('applyUiScale sets zoom and --ui-scale on the root, and removes them at 100%', () => {
    const root = document.documentElement;
    applyUiScale(1.15);
    expect(root.style.getPropertyValue('--ui-scale')).toBe('1.15');
    expect(root.style.getPropertyValue('zoom')).toBe('1.15');
    applyUiScale(1);
    expect(root.style.getPropertyValue('--ui-scale')).toBe('');
    expect(root.style.getPropertyValue('zoom')).toBe('');
  });

  it('survives unavailable storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(loadUiScale()).toBe(1);
    expect(() => saveUiScale(1.3)).not.toThrow();
  });
});

describe('tree column widths', () => {
  it('are null until saved, then round-trip within the limits', () => {
    expect(loadTreeColumn('name')).toBeNull();
    saveTreeColumn('name', 220);
    saveTreeColumn('value', 140);
    expect(loadTreeColumn('name')).toBe(220);
    expect(loadTreeColumn('value')).toBe(140);
    saveTreeColumn('name', null);
    expect(loadTreeColumn('name')).toBeNull();
    expect(localStorage.getItem('binaryviewer.layout.treeNameWidth')).toBeNull();
  });

  it('a width that is not a number falls back to the default instead of poisoning the layout', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(clampTreeColumn('name', bad)).toBe(150);
      expect(clampTreeColumn('value', bad)).toBe(90);
    }
  });

  it('clamp to the minimums (Name 80, Value 60) and a maximum, also when read back', () => {
    expect(clampTreeColumn('name', 10)).toBe(80);
    expect(clampTreeColumn('value', 10)).toBe(60);
    expect(clampTreeColumn('value', 99999)).toBe(800);
    localStorage.setItem('binaryviewer.layout.treeNameWidth', '5');
    expect(loadTreeColumn('name')).toBe(80);
    localStorage.setItem('binaryviewer.layout.treeValueWidth', 'wide');
    expect(loadTreeColumn('value')).toBeNull();
  });
});
