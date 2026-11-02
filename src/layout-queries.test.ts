import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Under the UI zoom (CSS zoom on <html>) a viewport media query still tests the raw window, so it disagrees with the layout.
// Width breakpoints therefore use a container query on <body> (@container page), whose width is in the zoomed CSS px.
describe('width breakpoints follow the zoomed layout', () => {
  const files = ['ui/StatusBar.svelte', 'ui/shell/GoTo.svelte', 'ui/Minimap.svelte', 'ui/shell/Welcome.svelte', 'ui/AboutDialog.svelte', 'ui/shell/CommandPalette.svelte', 'ui/shell/TitleBar.svelte'];

  it.each(files)('%s has no viewport width media query', (f) => {
    expect(read(f)).not.toMatch(/@media\s*\(\s*(max|min)-width/);
  });

  it('the page container is declared on body in app.css', () => {
    expect(read('app.css')).toMatch(/body \{[^}]*container: page \/ inline-size;/);
  });

  it.each([
    ['ui/StatusBar.svelte', 720],
    ['ui/shell/GoTo.svelte', 720],
    ['ui/Minimap.svelte', 599],
    ['ui/shell/Welcome.svelte', 600],
    ['ui/AboutDialog.svelte', 480],
    ['ui/shell/CommandPalette.svelte', 480],
  ])('%s keeps its breakpoint (%i px) as @container page', (f, px) => {
    expect(read(f)).toContain(`@container page (max-width: ${px}px)`);
  });

  it('App.svelte builds its narrow query from the zoom: 900 * zoom - 1 screen px', () => {
    expect(read('App.svelte')).toContain('Math.floor(900 * scale) - 1');
  });
});
