import { describe, expect, it } from 'vitest';
import { globalKey, isImeKey } from './keys';

const key = (key: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing', boolean>> & { code?: string } = {}) =>
  globalKey({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...mods });

describe('globalKey', () => {
  it('opens the palette with Ctrl+K, Cmd+K and F1', () => {
    expect(key('k', { ctrlKey: true })).toBe('palette');
    expect(key('K', { ctrlKey: true })).toBe('palette');
    expect(key('k', { metaKey: true })).toBe('palette');
    expect(key('F1')).toBe('palette');
  });

  it('saves with Ctrl+S or Cmd+S', () => {
    expect(key('s', { ctrlKey: true })).toBe('save');
    expect(key('S', { metaKey: true })).toBe('save');
  });

  it('does not claim Ctrl+Shift+P (Firefox keeps it), plain letters or other modifier mixes', () => {
    expect(key('p', { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(key('P', { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(key('k')).toBeNull();
    expect(key('s')).toBeNull();
    expect(key('k', { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(key('s', { ctrlKey: true, altKey: true })).toBeNull();
    expect(key('k', { ctrlKey: true, altKey: true })).toBeNull();
    expect(key('F1', { ctrlKey: true })).toBeNull();
    expect(key('F1', { altKey: true })).toBeNull();
    expect(key('F1', { shiftKey: true })).toBeNull();
    expect(key('F2')).toBeNull();
  });

  it('matches the physical K key on layouts without Latin letters, but not a Latin letter on another key', () => {
    expect(key('л', { ctrlKey: true, code: 'KeyK' })).toBe('palette'); // Cyrillic
    expect(key('κ', { metaKey: true, code: 'KeyK' })).toBe('palette'); // Greek
    expect(key('л', { ctrlKey: true, code: 'KeyL' })).toBeNull();
    expect(key('t', { ctrlKey: true, code: 'KeyK' })).toBeNull(); // Dvorak: the K key types t, which is not ours
    expect(key('л', { code: 'KeyK' })).toBeNull(); // no modifier
  });

  it('F6 moves to the next region and Shift+F6 to the previous one; with other modifiers it is left to the browser', () => {
    expect(key('F6')).toBe('region-next');
    expect(key('F6', { shiftKey: true })).toBe('region-prev');
    expect(key('F6', { ctrlKey: true })).toBeNull();
    expect(key('F6', { metaKey: true })).toBeNull();
    expect(key('F6', { altKey: true })).toBeNull();
    expect(key('F6', { isComposing: true })).toBeNull();
  });

  it('classifies IME keys', () => {
    expect(isImeKey({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeKey({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeKey({ isComposing: false, keyCode: 13 })).toBe(false);
  });

  it('ignores keys pressed during IME composition', () => {
    expect(key('k', { ctrlKey: true, isComposing: true })).toBeNull();
  });
});
