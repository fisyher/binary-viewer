import { describe, expect, it } from 'vitest';
import bmpJson from '../../formats/bmp.json';
import { generateMarkdown } from './docs';
import { mkSpec } from './test-helpers';
import { validateSpec } from './validate';

const v = validateSpec(bmpJson);
if (!v.ok) throw new Error('bmp invalid');
const md = generateMarkdown(v.spec);

describe('generateMarkdown (BMP)', () => {
  it('has the name, doc, detection and extensions', () => {
    expect(md).toMatch(/^# Windows Bitmap\n/);
    expect(md).toContain('BITMAPFILEHEADER');
    expect(md).toContain('## Detection');
    expect(md).toContain('Magic bytes: `42 4D` at offset 0x00 (0)');
    expect(md).toContain('Extensions: `.bmp`');
    expect(md).not.toContain('`.dib`');
    expect(md).toContain('Python/Rust precedence');
  });

  it('has one table per type with the required columns', () => {
    for (const t of Object.keys(v.spec.types)) expect(md).toContain(`### ${t}\n`);
    expect(md.match(/\| Field \| Type \| Endian \| Offset\/Position \| Size \| Description \|/g)).toHaveLength(Object.keys(v.spec.types).length);
  });

  it('computes cumulative static offsets and sizes', () => {
    const row = (field: string, type: string) => md.split('\n').find((l) => l.startsWith(`| \`${field}\` | \`${type}\``))!;
    const section = md.slice(md.indexOf('### file_header\n'), md.indexOf('### dib_header\n'));
    const lines = section.split('\n');
    const get = (n: string) => lines.find((l) => l.startsWith(`| \`${n}\``))!;
    expect(get('magic')).toContain('| 0x00 (0) | 2 |');
    expect(get('file_size')).toContain('| little | 0x02 (2) | 4 |');
    expect(get('reserved2')).toContain('| 0x08 (8) | 2 |');
    expect(get('off_bits')).toContain('| 0x0A (10) | 4 |');
    expect(row('size', 'u4')).toContain('0x00 (0)');
  });

  it('shows variable positions, "at" expressions and expression sizes', () => {
    const file = md.slice(md.indexOf('### file\n'), md.indexOf('### file_header\n'));
    expect(file).toMatch(/\| `dib` \|[^\n]*\| 0x0E \(14\) \| variable \|/);
    expect(file).toMatch(/\| `palette` \|[^\n]*\| variable \|/);
    expect(file).toMatch(/\| `pixels` \|[^\n]*\| at `file_header.off_bits` \| `\(dib.size == 40/);
    const dib = md.slice(md.indexOf('### dib_header\n'), md.indexOf('### bitmap_core_body\n'));
    expect(dib).toMatch(/\| `body` \| switch on `size`: `12` → `bitmap_core_body`[^\n]*\| 0x04 \(4\) \| `size - 4` \|/);
  });

  it('lists enums and field notes', () => {
    expect(md).toContain('## Enums');
    expect(md).toContain('| `1` | BI\\_RLE8 |');
    expect(md).toContain('| `0x73524742` | LCS\\_sRGB |');
    expect(md).toContain('Expected value: `BM`');
    expect(md).toContain('Present only if `dib.size == 12`');
  });

  it('matches the stable outline snapshot', () => {
    const outline = md.split('\n').filter((l) => /^#{1,3} /.test(l));
    expect(outline).toMatchInlineSnapshot(`
      [
        "# Windows Bitmap",
        "## Detection",
        "## Structures",
        "### file",
        "### file_header",
        "### dib_header",
        "### bitfield_masks",
        "### bitmap_core_body",
        "### bitmap_info_body",
        "### bitmap_v2_body",
        "### bitmap_v3_body",
        "### bitmap_v4_body",
        "### bitmap_v5_body",
        "### ciexyztriple",
        "### ciexyz",
        "### rgbquad",
        "### rgbtriple",
        "## Enums",
        "### compression",
        "### color_space",
        "### intent",
      ]
    `);
  });
});

describe('generateMarkdown (escaping and bits)', () => {
  it('escapes untrusted text so no HTML or table breakage gets through', () => {
    const spec = mkSpec(
      { root: { doc: '<b>type</b>', fields: [{ name: 'a', type: 'u1', doc: 'x | y <script>alert(1)</script>\nline2' }] } },
      { name: '<img src=x>', doc: '<iframe>' },
    );
    const out = generateMarkdown(spec);
    expect(out).not.toMatch(/<(script|img|iframe|b)\b/);
    expect(out).toContain('x \\| y &lt;script&gt;');
    expect(out).toContain('line2');
    const row = out.split('\n').find((l) => l.startsWith('| `a`'))!;
    expect(row.replace(/\\\|/g, '').split('|').length).toBe(8); // 6 cells + leading/trailing
  });

  it('documents bits, endianness and big-endian suffixes', () => {
    const spec = mkSpec({ root: { fields: [{ name: 'f', type: 'u2be', bits: [{ name: 'lo', offset: 0, width: 4 }, { name: 'bit', offset: 15, width: 1 }] }, { name: 'g', type: 'u4' }] } }, { endian: 'le' });
    const out = generateMarkdown(spec);
    expect(out).toContain('Bits (bit 0 = least significant): `lo` [3:0]; `bit` [15]');
    expect(out).toMatch(/\| `f` \| `u2be` \| big \|/);
    expect(out).toMatch(/\| `g` \| `u4` \| little \| 0x02 \(2\)/);
  });
});

describe('generateMarkdown (injection resistance)', () => {
  const gen = (doc: string, name = 'ok') =>
    generateMarkdown(mkSpec({ root: { doc, fields: [{ name: 'a', type: 'u1', doc }] } }, { doc, name }));

  it('neutralises images and links', () => {
    const out = gen('![x](http://e/t.png) and [l](javascript:alert(1))');
    expect(out).not.toMatch(/(^|[^\\])!\[/);
    expect(out).not.toMatch(/(^|[^\\])\]\(/);
    expect(out).toContain('\\!\\[x\\]\\(http\\://e/t.png\\)');
    expect(out).toContain('\\[l\\]\\(javascript:alert\\(1\\)\\)');
  });

  it('flattens every kind of line break, including a lone CR and U+2028/2029', () => {
    const out = gen('a\rb\r\nc\nd\u2028e\u2029f');
    expect(out).toContain('a b c d e f');
    expect(out).not.toMatch(/[\r\u2028\u2029]/);
    const row = out.split('\n').find((l) => l.startsWith('| `a`'))!;
    expect(row).toContain('a b c d e f');
  });

  it('does not let leading #, -, + or "1." start block structures', () => {
    for (const [doc, escaped] of [
      ['# heading', '\\# heading'],
      ['- item', '\\- item'],
      ['+ item', '\\+ item'],
      ['1. item', '1\\. item'],
      ['2) item', '2\\) item'],
      ['> quote', '&gt; quote'],
    ] as const) {
      const out = gen(doc);
      const lines = out.split('\n');
      expect(lines.some((l) => l === escaped), doc).toBe(true); // the spec-level doc paragraph
      expect(lines.some((l) => /^(#{1,6} |- |\+ |\d+[.)] |> )/.test(l) && l.includes('item') ), doc).toBe(false);
    }
  });

  it('escapes emphasis, code and tilde markers in prose but keeps code spans literal', () => {
    const out = gen('*b* _i_ `c` ~s~');
    expect(out).toContain('\\*b\\* \\_i\\_ \\`c\\` \\~s\\~');
    const spec = mkSpec({ root: { fields: [{ name: 'a', type: 'u1', if: 'a < 1 || b > 2 ? 1 == 1 : 0 == 1' }, { name: 'b', type: 'u1' }] } });
    expect(generateMarkdown(spec)).toContain('`a < 1 || b > 2 ? 1 == 1 : 0 == 1`'.replace('||', '\\|\\|'));
  });

  it('uses a longer fence for code containing backticks', () => {
    const spec = mkSpec({ root: { fields: [{ name: 'a', type: 'str', size: 1, expect: 'a`b``c' }] } });
    expect(generateMarkdown(spec)).toContain('``a`b``c``'.length ? 'Expected value: ```a`b``c```' : '');
  });
});

describe('generateMarkdown (expression note)', () => {
  it('documents precedence and lists asserts', () => {
    const spec = mkSpec({ root: { fields: [{ name: 'a', type: 'u1', assert: [{ expr: '_ > 0', level: 'warning', message: 'must be positive' }] }] } });
    const out = generateMarkdown(spec);
    expect(out).toContain('Bitwise `& | ^` bind tighter than comparisons');
    expect(out).toContain('Check (warning): `_ > 0` \u2014 must be positive.');
  });
});
