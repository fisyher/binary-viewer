// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, loadFlag, loadShowMinimap, loadSideView, loadSize, loadTheme, saveFlag, saveShowMinimap, saveSideView, saveSize, saveTheme } from './prefs';

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
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
