/**
 * Markdown documentation generated from a spec. Spec text is untrusted: prose is flattened to one line and every
 * Markdown special (\\ ` * _ [ ] ( ) ! # ~ > < & |) is escaped (`& < >` as entities), so no HTML, links, images,
 * headings, lists or table breakage can be injected. Code spans never go through the prose escaper: their content
 * is literal, only newlines and pipes are neutralised and the fence is made longer than any backtick run inside.
 */
import { staticAdvance, staticElemSize, constInt } from './layout';
import type { FieldDef, FormatSpec } from './schema';
import { primitiveInfo } from './schema';

const LINE_BREAKS = /\r\n|[\r\n\u2028\u2029]/g;

/** Escape prose for Markdown (single line). */
function esc(text: string): string {
  let t = text
    .replace(LINE_BREAKS, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]()!#~|]/g, (c) => '\\' + c);
  // Block-level markers at the start of the text (lists, ordered lists, setext/rules, block quotes handled by '>').
  // Neutralise autolinks: bare URLs (escape the colon), www. hosts and e-mail addresses.
  t = t.replace(/:(?=\/\/)/g, '\\:').replace(/(?<![A-Za-z0-9])www\./gi, (m) => m.slice(0, -1) + '\\.').replace(/@/g, '\\@');
  t = t.replace(/^(\s*)([-+=])(?=\s|$)/, '$1\\$2').replace(/^(\s*\d+)([.)])(?=\s|$)/, '$1\\$2');
  return t;
}

/** Identifier-like names (type/enum names are validated) are emitted verbatim; anything else is escaped. */
function ident(name: string): string {
  return /^[A-Za-z0-9_]+$/.test(name) ? name : esc(name);
}

/** Inline code span with literal content. */
function code(text: string): string {
  const t = text.replace(LINE_BREAKS, ' ').replace(/\|/g, '\\|');
  if (t.length === 0) return '` `';
  let longest = 0;
  for (const m of t.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(longest + 1);
  const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
  return fence + pad + t + pad + fence;
}

function hexOff(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(2, '0')} (${n})`;
}

function typeCell(f: FieldDef): string {
  if (typeof f.type === 'string') return code(f.type);
  return `switch on ${code(f.type.switch)}: ` + Object.entries(f.type.cases).map(([k, v]) => `${code(k)} → ${code(v)}`).join(', ') + (f.type.default !== undefined ? `, default → ${code(f.type.default)}` : '');
}

function endianCell(spec: FormatSpec, f: FieldDef): string {
  const names = typeof f.type === 'string' ? [f.type] : [...Object.values(f.type.cases), ...(f.type.default !== undefined ? [f.type.default] : [])];
  const out = new Set<string>();
  for (const n of names) {
    const p = primitiveInfo(n);
    if (p && p.size > 1) out.add((p.endian ?? spec.endian ?? 'unspecified') === 'le' ? 'little' : (p.endian ?? spec.endian) === 'be' ? 'big' : 'unspecified');
    else if (n === 'str') {
      if (f.encoding === 'utf16le') out.add('little');
      else if (f.encoding === 'utf16be') out.add('big');
    }
  }
  return out.size === 0 ? '—' : [...out].join(' / ');
}

function sizeCell(spec: FormatSpec, f: FieldDef): string {
  const elem = staticElemSize(spec, f);
  let base: string;
  if (f.size === 'eos') base = 'to end of stream';
  else if (typeof f.size === 'string' && constInt(f.size) === null) base = code(f.size);
  else if (elem !== null) base = `${elem}`;
  else if (f.terminator !== undefined && f.size === undefined) base = `until terminator ${f.terminator}`;
  else base = 'variable';
  if (f.repeat === undefined) return base;
  if (f.repeat === 'eos') return `${base} × until end of stream`;
  if ('count' in f.repeat) return `${base} × ${code(String(f.repeat.count))}`;
  return `${base} × until ${code(f.repeat.until)}`;
}

function descCell(f: FieldDef, enumValues: (name: string) => string): string {
  const parts: string[] = [];
  if (f.doc) parts.push(esc(f.doc));
  if (f.if !== undefined) parts.push(`Present only if ${code(f.if)}.`);
  if (f.enum !== undefined) parts.push(`Enum ${code(f.enum)}${enumValues(f.enum)}.`);
  for (const a of f.assert ?? []) parts.push(`Check (${a.level ?? 'error'}): ${code(a.expr)}${a.message ? ' \u2014 ' + esc(a.message) : ''}.`);
  if (f.expect !== undefined) parts.push(`Expected value: ${code(String(f.expect))}.`);
  if (f.bits) {
    parts.push(
      'Bits (bit 0 = least significant): ' +
        f.bits.map((b) => `${code(b.name)} [${b.offset + b.width - 1 === b.offset ? b.offset : `${b.offset + b.width - 1}:${b.offset}`}]${b.doc ? ' ' + esc(b.doc) : ''}`).join('; ') +
        '.',
    );
  }
  return parts.join(' ');
}

export function generateMarkdown(spec: FormatSpec): string {
  const out: string[] = [];
  out.push(`# ${esc(spec.name)}`, '');
  out.push(
    '> Expression note: operators follow Python/Rust precedence, not C. Bitwise `& | ^` bind tighter than comparisons, so `flags & 4 == 4` means `(flags & 4) == 4`. ' +
      'Order, loosest first: `?:`, `||`/`or`, `&&`/`and`, `==` `!=`, `<` `<=` `>` `>=`, `|`, `^`, `&`, `<<` `>>`, `+` `-`, `*` `/` `%`, unary. Use parentheses when unsure.',
    '',
  );
  out.push(`Spec id: ${code(spec.id)} (schema version ${spec.schemaVersion}). Default byte order: ${spec.endian === 'le' ? 'little-endian' : spec.endian === 'be' ? 'big-endian' : 'none declared (explicit per type)'}.`, '');
  if (spec.doc) out.push(esc(spec.doc), '');

  out.push('## Detection', '');
  const rules = spec.detect ?? [];
  if (rules.length === 0) out.push('- Magic bytes: none');
  for (const r of rules) {
    out.push(`- Magic bytes: ${code(r.bytes.trim())} at ${r.at >= 0 ? `offset ${hexOff(r.at)}` : `${-r.at} bytes before the end of the file`}${r.mask ? `, mask ${code(r.mask.trim())}` : ''}`);
  }
  const exts = spec.extensions ?? [];
  out.push(`- Extensions: ${exts.length ? exts.map((e) => code('.' + e)).join(', ') : 'none'}`, '');

  const enumValues = (name: string): string => {
    const e = spec.enums && Object.hasOwn(spec.enums, name) ? spec.enums[name] : undefined;
    return e ? ` (${Object.values(e).slice(0, 4).map(esc).join(', ')}${Object.keys(e).length > 4 ? ', …' : ''})` : '';
  };

  out.push('## Structures', '', `Root type: ${code(spec.root)}. Offsets are relative to the start of the containing structure.`, '');
  for (const [tn, def] of Object.entries(spec.types)) {
    out.push(`### ${ident(tn)}`, '');
    if (def.doc) out.push(esc(def.doc), '');
    out.push('| Field | Type | Endian | Offset/Position | Size | Description |', '| --- | --- | --- | --- | --- | --- |');
    let cursor: number | null = 0;
    for (const f of def.fields) {
      let pos: string;
      if (f.at !== undefined) pos = `at ${code(String(f.at))}`;
      else if (cursor === null) pos = 'variable';
      else pos = hexOff(cursor);
      out.push(`| ${code(f.name)} | ${typeCell(f)} | ${endianCell(spec, f)} | ${pos} | ${sizeCell(spec, f)} | ${descCell(f, enumValues)} |`);
      if (f.at === undefined && cursor !== null) {
        const adv = staticAdvance(spec, f);
        cursor = adv === null ? null : cursor + adv;
      }
    }
    out.push('');
  }

  const enums = Object.entries(spec.enums ?? {});
  if (enums.length > 0) {
    out.push('## Enums', '');
    for (const [en, vals] of enums) {
      out.push(`### ${ident(en)}`, '', '| Value | Name |', '| --- | --- |');
      for (const [k, label] of Object.entries(vals)) out.push(`| ${code(k)} | ${esc(label)} |`);
      out.push('');
    }
  }
  return out.join('\n');
}
