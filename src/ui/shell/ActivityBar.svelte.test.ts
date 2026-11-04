// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ActivityBar from './ActivityBar.svelte';

afterEach(cleanup);

describe('ActivityBar', () => {
  it('names each item with aria-label, shows its label in an aria-hidden tip, and has no title (so it is not shown twice)', () => {
    const { getAllByRole, getByRole } = render(ActivityBar, { view: 'structure', open: true, onSelect: () => {} });
    expect(getByRole('navigation', { name: 'Activity bar' }).getAttribute('data-region')).toBe('activity');
    const items = getAllByRole('button');
    expect(items.map((b) => b.getAttribute('aria-label'))).toEqual(['Structure', 'Formats']);
    for (const b of items) {
      expect(b.hasAttribute('title')).toBe(false);
      const tip = b.querySelector('.tip')!;
      expect(tip.getAttribute('aria-hidden')).toBe('true');
      expect(tip.textContent).toBe(b.getAttribute('aria-label'));
    }
    expect(items.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
  });

  it('still selects on click', async () => {
    const onSelect = vi.fn();
    const { getByRole } = render(ActivityBar, { view: 'structure', open: true, onSelect });
    await fireEvent.click(getByRole('button', { name: 'Formats' }));
    expect(onSelect).toHaveBeenCalledWith('formats');
  });

  // jsdom has no layout or :hover, so the show/hide rules are checked in the stylesheet itself.
  const source = readFileSync(join(process.cwd(), 'src/ui/shell/ActivityBar.svelte'), 'utf8').replace(/\r\n/g, '\n');

  it('the tip shows at once on keyboard focus and after a 400ms delay on hover, and at once with reduced motion', () => {
    expect(source).toMatch(/\.item:focus-visible \.tip \{[^}]*opacity: 1;/);
    const hover = /\.item:hover \.tip \{([^}]*)\}/.exec(source)![1]!;
    expect(hover).toContain('400ms');
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n  \}\n/.exec(source)![1]!;
    expect(reduced).toMatch(/\.item:hover \.tip[^}]*transition-delay: 0s/);
  });

  it('the bar does not clip the tip: no overflow rule, and it stacks above the side bar', () => {
    const bar = /\.activity \{([^}]*)\}/.exec(source)![1]!;
    expect(bar).not.toMatch(/overflow/);
    expect(bar).toMatch(/z-index: [1-9]/);
    expect(/\.tip \{([^}]*)\}/.exec(source)![1]!).toMatch(/z-index: \d+/);
  });
});
