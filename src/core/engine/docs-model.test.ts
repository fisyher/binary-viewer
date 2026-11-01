import { describe, expect, it } from 'vitest';
import bmpJson from '../../formats/bmp.json';
import { buildDocModel, escapeHtml, generateHtml, generateMarkdown, htmlPieces, mdPieces } from './docs';
import { mkSpec } from './test-helpers';
import { validateSpec } from './validate';

const v = validateSpec(bmpJson);
if (!v.ok) throw new Error('bmp invalid');

describe('buildDocModel', () => {
  const m = buildDocModel(v.spec);

  it('describes the spec as plain data', () => {
    expect(m.title).toBe('Windows Bitmap');
    expect(m.id).toBe('bmp');
    expect(m.extensions).toContain('.bmp');
    expect(m.detect[0]).toMatchObject({ bytes: '42 4D', where: 'offset 0x00 (0)' });
    expect(m.precedenceNote).toContain('Python/Rust precedence');
    expect(m.types.map((t) => t.name)).toEqual(Object.keys(v.spec.types));
    expect(m.rootType).toBe(v.spec.root);
    expect(JSON.parse(JSON.stringify(m))).toEqual(m); // structured data only
  });

  it('computes positions, sizes and endianness per field', () => {
    const hdr = m.types.find((t) => t.name === 'file_header')!;
    const f = hdr.fields[1]!;
    expect(f.position).toEqual({ kind: 'offset', offset: 2 });
    expect(f.size.base).toEqual({ kind: 'static', bytes: 4 });
    expect(f.endian).toBe('little');
    expect(hdr.fields[0]!.endian).toBe('—');
  });

  it('keeps asserts, enums, bits and switch types', () => {
    const spec = mkSpec(
      {
        root: {
          fields: [
            { name: 'kind', type: 'u1', enum: 'k', assert: [{ expr: '_ < 9', message: 'too big', level: 'warning' }] },
            { name: 'flags', type: 'u1', bits: [{ name: 'a', offset: 0, width: 1 }, { name: 'b', offset: 4, width: 4 }] },
            { name: 'body', type: { switch: 'kind', cases: { '1': 'u1' }, default: 'u2' } },
          ],
        },
      },
      { enums: { k: { '1': 'one', '2': 'two' } } },
    );
    const mm = buildDocModel(spec);
    const [kind, flags, body] = mm.types[0]!.fields;
    expect(kind!.asserts).toEqual([{ level: 'warning', expr: '_ < 9', message: 'too big' }]);
    expect(kind!.enum).toEqual({ name: 'k', preview: ['one', 'two'], more: false });
    expect(flags!.bits.map((b) => b.range)).toEqual(['0', '7:4']);
    expect(body!.type).toMatchObject({ kind: 'switch', on: 'kind', default: 'u2' });
    expect(mm.enums).toEqual([{ name: 'k', entries: [{ key: '1', label: 'one' }, { key: '2', label: 'two' }] }]);
  });
});

const hostile = mkSpec(
  {
    root: {
      doc: '<script>alert(2)</script>',
      fields: [
        { name: 'x', type: 'u1', doc: '"><img src=x onerror=alert(1)>', assert: [{ expr: '_ == 1', message: '<b onclick="x">' }] },
        { name: 'link', type: 'u1', doc: '[click](javascript:alert(1)) javascript:alert(1) \' & "' },
      ],
    },
  },
  { id: 'evil', name: '<script>alert(1)</script>', doc: '"><img onerror=alert(1)> javascript:alert(1)' },
);

describe('generateHtml', () => {
  const html = generateHtml(hostile);

  it('escapes every text value', () => {
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b onclick');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&#39;');
  });

  it('produces no links and no attributes from spec text', () => {
    expect(html).not.toMatch(/<a[\s>]/i);
    expect(html).not.toMatch(/href\s*=/i);
    // Every tag is one of ours, with no attributes except the fixed ones on html/meta.
    const tags = [...html.matchAll(/<([^>]*)>/g)].map((m) => m[1]!);
    for (const t of tags) expect(t).toMatch(/^(!DOCTYPE html|\/?(html|head|body|title|style|table|thead|tbody|tr|th|td|code|h1|h2|h3|p|ul|li|blockquote)|html lang="en"|meta [^<]*)$/);
    expect(html.match(/</g)!.length).toBe(tags.length); // no stray "<" from spec text
    // javascript: only ever appears as inert text inside an element.
    expect(html).not.toMatch(/="[^"]*javascript:/i);
  });

  it('embeds a strict CSP and inline CSS only', () => {
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).toMatch(/<style>[^<]+<\/style>/);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('renders the BMP spec with its tables', () => {
    const bmp = generateHtml(v.spec);
    expect(bmp).toContain('<h1>Windows Bitmap</h1>');
    expect(bmp).toContain('<h3>file_header</h3>');
    expect(bmp.match(/<table>/g)!.length).toBeGreaterThanOrEqual(Object.keys(v.spec.types).length);
  });
});

describe('label pieces', () => {
  const hostile = [{ text: '<img src=x onerror=1> & more\nline' }, { text: '<b>x</b>', code: true }];
  it('are escaped in Markdown', () => {
    const out = mdPieces(hostile);
    expect(out).toContain('&lt;img src=x onerror=1&gt; &amp; more line');
    expect(out).not.toContain('<img');
    expect(out).toContain('`<b>x</b>`');
  });
  it('are escaped in HTML', () => {
    const out = htmlPieces(hostile);
    expect(out).toContain('&lt;img src=x onerror=1&gt; &amp; more\nline');
    expect(out).not.toContain('<img');
    expect(out).toContain('<code>&lt;b&gt;x&lt;/b&gt;</code>');
  });
});

describe('escapeHtml', () => {
  it('escapes & < > " \'', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('generateMarkdown from the model', () => {
  it('still neutralises hostile text', () => {
    const md = generateMarkdown(hostile);
    expect(md).not.toContain('<script');
    expect(md).not.toMatch(/\]\(javascript:/);
  });
});
