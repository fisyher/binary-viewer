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
