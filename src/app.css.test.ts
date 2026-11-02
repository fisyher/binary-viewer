import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** The custom properties declared inside the first rule whose selector starts with `selector`. */
function declarations(selector: string): Record<string, string> {
  const start = css.indexOf(selector + ' {');
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim().replace(/\/\*.*\*\//, '').trim()]));
}

describe('app.css themes', () => {
  const systemDark = declarations(":root:not([data-theme='light'])");
  const forcedDark = declarations(":root[data-theme='dark']");

  it('the system-dark block and the forced-dark block declare the same custom properties and values', () => {
    expect(Object.keys(systemDark).length).toBeGreaterThan(20);
    // color-scheme is not a custom property; compare the tokens only
    expect(forcedDark).toEqual(systemDark);
  });

  it('dark overrides every token that light defines, except the structural ones shared by both', () => {
    const light = declarations(':root,\n:root[data-theme=\'light\']');
    const shared = new Set(['--sel-fg', '--node-edge']); // derived from other tokens, identical in both themes
    for (const name of Object.keys(light)) if (!shared.has(name)) expect(forcedDark, name).toHaveProperty(name);
  });
});

// ---- Contrast: the focus ring and the structure colours (WCAG relative luminance) ----
const hexRgb = (h: string): [number, number, number] => {
  expect(h).toMatch(/^#[0-9a-f]{6}$/i);
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const luminance = (rgb: readonly number[]) => {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(hexRgb(a)), luminance(hexRgb(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const themes = {
  light: declarations(":root,\n:root[data-theme='light']"),
  dark: declarations(":root[data-theme='dark']"),
};

describe.each(Object.entries(themes))('%s theme contrast', (_name, t) => {
  it('the focus ring (--signal) is 3:1 or more on the ground, chrome and deep chrome backgrounds', () => {
    for (const bg of ['--ground', '--chrome', '--chrome-deep']) expect(contrast(t['--signal']!, t[bg]!), bg).toBeGreaterThanOrEqual(3);
  });

  it('every structure colour is 3:1 or more on the ground (they are marks, not text)', () => {
    for (let i = 1; i <= 4; i++) expect(contrast(t[`--struct-${i}`]!, t['--ground']!), `--struct-${i}`).toBeGreaterThanOrEqual(3);
  });

  it('every pair of structure colours differs by 1.4:1 or more in luminance, so they do not rely on hue alone', () => {
    for (let i = 1; i <= 4; i++) {
      for (let j = i + 1; j <= 4; j++) expect(contrast(t[`--struct-${i}`]!, t[`--struct-${j}`]!), `--struct-${i} / --struct-${j}`).toBeGreaterThanOrEqual(1.4);
    }
  });

  it('each tint is its colour at partial opacity (same red, green and blue)', () => {
    for (let i = 1; i <= 4; i++) {
      const rgb = hexRgb(t[`--struct-${i}`]!);
      const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(t[`--struct-${i}-tint`]!);
      expect(m, `--struct-${i}-tint`).not.toBeNull();
      expect(m!.slice(1, 4).map(Number)).toEqual(rgb);
      expect(Number(m![4])).toBeLessThan(0.5);
    }
  });

  it('the selection and node highlights are tints of the signal colour', () => {
    const rgb = hexRgb(t['--signal']!);
    for (const name of ['--sel-bg', '--node-bg']) {
      const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(t[name]!);
      expect(m, name).not.toBeNull();
      expect(m!.slice(1, 4).map(Number), name).toEqual(rgb);
    }
  });
});
