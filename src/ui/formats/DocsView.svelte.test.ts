// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import bmpJson from '../../formats/bmp.json';
import { validateSpec, type FormatSpec } from '../../core/engine';
import { mkSpec } from '../../core/engine/test-helpers';
import DocsView from './DocsView.svelte';

afterEach(cleanup);

const bmp = (() => {
  const r = validateSpec(bmpJson);
  if (!r.ok) throw new Error('bmp invalid');
  return r.spec;
})();

describe('DocsView', () => {
  it('renders field tables per type, detection, enums and asserts for the BMP spec', () => {
    const { container, getByText } = render(DocsView, { spec: bmp });
    expect(getByText('Windows Bitmap')).toBeTruthy();
    expect(container.querySelectorAll('section[data-type]')).toHaveLength(Object.keys(bmp.types).length);
    expect(container.textContent).toContain('Magic and detection');
    expect(container.textContent).toContain('42 4D');
    expect(container.textContent).toContain('.bmp');
    expect(container.querySelector('section[data-type="file_header"] table')).not.toBeNull();
    expect(container.textContent).toContain('Python/Rust precedence');
  });

  it('shows enums and asserts', () => {
    const spec = mkSpec(
      { root: { fields: [{ name: 'k', type: 'u1', enum: 'kinds', assert: [{ expr: '_ < 9', message: 'k too big' }] }] } },
      { enums: { kinds: { '1': 'one', '2': 'two' } } },
    );
    const { container } = render(DocsView, { spec });
    expect(container.querySelector('section[data-enum="kinds"]')?.textContent).toContain('two');
    expect(container.textContent).toContain('Check (error)');
    expect(container.textContent).toContain('k too big');
  });

  it('documents link and jumps with hostile labels as literal text', () => {
    const spec = mkSpec({
      tgt: { fields: [{ name: 'data', type: 'bytes', size: 1 }] },
      root: {
        fields: [
          { name: 'p', type: 'u1', link: { at: '_', size: '2', label: '<img src=x onerror=alert(1)>' } },
          { name: 'q', type: 'u1', ref: { type: 'tgt', at: '_', jumps: [{ label: '<b>d</b>', path: 'data' }] } },
        ],
      },
    });
    const { container } = render(DocsView, { spec });
    expect(container.querySelector('img, b')).toBeNull();
    expect(container.textContent).toContain('Link: jumps to offset _ (2 bytes) — <img src=x onerror=alert(1)>.');
    expect(container.textContent).toContain('Jump shortcuts: <b>d</b> → data.');
  });

  it('renders hostile spec text as literal text, never as markup', () => {
    const spec: FormatSpec = mkSpec(
      {
        root: {
          doc: '<img src=x onerror=alert(1)>',
          fields: [
            { name: 'f', type: 'u1', doc: '"><script>alert(1)</script>', enum: 'e', assert: [{ expr: '_ == 1', message: '<b>bold</b> javascript:alert(1)' }] },
          ],
        },
      },
      { id: 'evil', name: '<script>alert("name")</script>', doc: '<a href="javascript:alert(1)">click</a>', enums: { e: { '1': '<svg onload=alert(1)>' } } },
    );
    const { container } = render(DocsView, { spec });
    expect(container.querySelector('script, img, svg, b, a')).toBeNull();
    expect(container.querySelector('h2')!.textContent).toBe('<script>alert("name")</script>');
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.textContent).toContain('<a href="javascript:alert(1)">click</a>');
    expect(container.textContent).toContain('<svg onload=alert(1)>');
    expect(container.textContent).toContain('<b>bold</b> javascript:alert(1)');
    for (const el of container.querySelectorAll('*')) {
      for (const a of el.getAttributeNames()) expect(a.startsWith('on')).toBe(false);
      expect(el.getAttribute('href')).toBeNull();
    }
  });

  it('shows control and bidi characters visibly instead of raw', () => {
    const bidi = String.fromCharCode(0x202e);
    const spec = mkSpec({ root: { fields: [{ name: 'f', type: 'u1' }] } }, { name: 'a' + bidi + 'b' + String.fromCharCode(7) + 'c' });
    const { container } = render(DocsView, { spec });
    const title = container.querySelector('h2')!.textContent!;
    expect(title).toBe('a\\u{202E}b\\u{0007}c');
    expect(title).not.toContain(bidi);
  });

  it('clicking a type name jumps to that type section', async () => {
    const spec = mkSpec({ root: { fields: [{ name: 'hdr', type: 'header' }, { name: 'n', type: 'u1' }] }, header: { fields: [{ name: 'a', type: 'u2' }] } });
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { container } = render(DocsView, { spec });
    const link = [...container.querySelectorAll<HTMLButtonElement>('button.type-link')].find((b) => b.textContent === 'header')!;
    expect(link).toBeDefined();
    await fireEvent.click(link);
    expect(scroll).toHaveBeenCalledOnce();
    expect(scroll.mock.contexts[0]).toBe(container.querySelector('section[data-type="header"]'));
    expect(document.activeElement).toBe(container.querySelector('section[data-type="header"]'));
    // Built-in types are not links.
    expect([...container.querySelectorAll('button.type-link')].some((b) => b.textContent === 'u1')).toBe(false);
  });

  it('explains why there is nothing to show for an invalid spec', () => {
    const { container } = render(DocsView, { spec: null });
    expect(container.textContent).toContain('Fix the validation errors');
  });
});
