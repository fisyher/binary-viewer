/**
 * Markdown documentation generated from a spec. Spec text is untrusted: prose is flattened to one line and every
 * Markdown special (\\ ` * _ [ ] ( ) ! # ~ > < & |) is escaped (`& < >` as entities), so no HTML, links, images,
 * headings, lists or table breakage can be injected. Code spans never go through the prose escaper: their content
 * is literal, only newlines and pipes are neutralised and the fence is made longer than any backtick run inside.
 */
import { isPlaced, staticAdvance, staticElemSize, constInt } from './layout';
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

/** A piece of plain (unescaped) label text; `code` pieces are rendered as code. Each renderer escapes for itself. */
export interface DocTextPiece {
  text: string;
  code?: boolean;
}

/** Shared wording of the position column, so Markdown, HTML and the in-app view cannot drift apart. */
export function positionPieces(p: DocPosition): DocTextPiece[] {
  switch (p.kind) {
    case 'at':
      return [{ text: 'at ' }, { text: p.expr, code: true }, { text: ' (absolute file offset)' }];
    case 'find':
      return [
        { text: `found by searching ${p.direction} from ` },
        { text: p.from, code: true },
        { text: ` (window ${p.window} bytes) for ` },
        { text: p.bytes, code: true },
      ];
    case 'computed':
      return [{ text: 'computed (no bytes)' }];
    case 'variable':
      return [{ text: 'variable (depends on earlier data)' }];
    default:
      return [{ text: hexOff(p.offset) }];
  }
}

/** Explanation of the position column, shown under "Structures" in every renderer. */
export const POSITION_NOTE_PIECES: DocTextPiece[] = [
  { text: 'Offsets of sequential fields are relative to the start of the containing structure. ' },
  { text: 'at', code: true },
  { text: ' gives an absolute file offset; ' },
  { text: 'find', code: true },
  { text: ' places the field where a signature search finds it; computed (' },
  { text: 'value', code: true },
  { text: ') fields take no bytes; variable means the position depends on data read earlier.' },
];

// ---------------------------------------------------------------------------------------------------------------
// Doc model: plain, renderer-neutral data (raw, UNESCAPED strings). Every renderer must escape for its own target.
// ---------------------------------------------------------------------------------------------------------------

// Doc model types: strings are raw (unescaped) spec text or short derived labels. See `buildDocModel`.
export type DocTypeRef = { kind: 'simple'; name: string } | { kind: 'switch'; on: string; cases: { key: string; type: string }[]; default?: string };
export type DocPosition =
  | { kind: 'at'; expr: string }
  | { kind: 'find'; direction: 'backward' | 'forward'; from: string; window: number; bytes: string }
  | { kind: 'offset'; offset: number }
  | { kind: 'computed' }
  | { kind: 'variable' };
export type DocSizeBase = { kind: 'eos' } | { kind: 'expr'; expr: string } | { kind: 'static'; bytes: number } | { kind: 'terminator'; terminator: string } | { kind: 'variable' };
export type DocRepeat = { kind: 'eos' } | { kind: 'count'; expr: string } | { kind: 'until'; expr: string };

export interface DocAssert {
  level: 'warning' | 'error';
  expr: string;
  message?: string;
}
export interface DocBit {
  name: string;
  /** "3" or "7:4" (bit 0 = least significant). */
  range: string;
  doc?: string;
}
export interface DocField {
  name: string;
  type: DocTypeRef;
  /** "little", "big", "little / big", or "—" when byte order does not apply. */
  endian: string;
  position: DocPosition;
  size: { base: DocSizeBase; repeat?: DocRepeat };
  doc?: string;
  ifExpr?: string;
  /** `preview` is the first few labels; undefined when the enum is not defined in the spec. */
  enum?: { name: string; preview?: string[]; more: boolean };
  asserts: DocAssert[];
  expect?: string;
  /** `expect` mismatch stops parsing (`fatal`). */
  fatal?: boolean;
  /** `find`: mask and acceptance tiers (the rest is in `position`). */
  findMask?: string;
  findAccept?: string[];
  ifMagic?: { at: string; bytes: string; mask?: string };
  /** `value` fields: the expression. */
  value?: string;
  ref?: { type: string; at: string; doc?: string; jumps?: Array<{ label: string; path: string }> };
  /** `link`: expressions for the offset and size of the location this field points at. */
  link?: { at: string; size?: string; label?: string };
  bits: DocBit[];
}
export interface DocType {
  name: string;
  doc?: string;
  fields: DocField[];
}
export interface DocDetectRule {
  /** Offset text, e.g. "offset 0x00 (0)" or "4 bytes before the end of the file". */
  where: string;
  bytes: string;
  mask?: string;
}
export interface DocEnum {
  name: string;
  entries: { key: string; label: string }[];
}
/** Renderer-neutral documentation of a spec; `generateMarkdown` and `generateHtml` are two renderers of it. */
export interface DocModel {
  title: string;
  doc?: string;
  id: string;
  schemaVersion: number;
  /** "little-endian", "big-endian" or "none declared (explicit per type)". */
  defaultEndian: string;
  precedenceNote: string;
  detect: DocDetectRule[];
  extensions: string[];
  rootType: string;
  types: DocType[];
  enums: DocEnum[];
}

const PRECEDENCE_NOTE =
  'Expression note: operators follow Python/Rust precedence, not C. Bitwise & | ^ bind tighter than comparisons, so flags & 4 == 4 means (flags & 4) == 4. ' +
  'Order, loosest first: ?:, ||/or, &&/and, == !=, < <= > >=, |, ^, &, << >>, + -, * / %, unary. Use parentheses when unsure.';

function modelEndian(spec: FormatSpec, f: FieldDef): string {
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

function modelSize(spec: FormatSpec, f: FieldDef): DocField['size'] {
  const elem = staticElemSize(spec, f);
  let base: DocSizeBase;
  if (f.size === 'eos') base = { kind: 'eos' };
  else if (typeof f.size === 'string' && constInt(f.size) === null) base = { kind: 'expr', expr: f.size };
  else if (elem !== null) base = { kind: 'static', bytes: elem };
  else if (f.terminator !== undefined && f.size === undefined) base = { kind: 'terminator', terminator: String(f.terminator) };
  else base = { kind: 'variable' };
  if (f.repeat === undefined) return { base };
  if (f.repeat === 'eos') return { base, repeat: { kind: 'eos' } };
  if ('count' in f.repeat) return { base, repeat: { kind: 'count', expr: String(f.repeat.count) } };
  return { base, repeat: { kind: 'until', expr: f.repeat.until } };
}

/**
 * Build the renderer-neutral documentation model of a spec. Static analysis only: nothing is parsed against a file, and
 * positions/sizes that depend on data come out as expressions or `variable`. Pure and synchronous. The spec should have
 * passed `validateSpec` (an unvalidated one may throw or produce odd output). Values are raw and UNESCAPED, so any
 * renderer must escape for its target (text may come from an untrusted spec).
 */
export function buildDocModel(spec: FormatSpec): DocModel {
  const exts = spec.extensions ?? [];
  const types: DocType[] = [];
  for (const [tn, def] of Object.entries(spec.types)) {
    const fields: DocField[] = [];
    let cursor: number | null = 0;
    for (const f of def.fields) {
      let position: DocPosition;
      if (f.type === 'value') position = { kind: 'computed' };
      else if (f.at !== undefined) position = { kind: 'at', expr: String(f.at) };
      else if (f.find !== undefined) {
        position = { kind: 'find', direction: f.find.direction === 'forward' ? 'forward' : 'backward', from: String(f.find.from), window: Number(f.find.window), bytes: String(f.find.bytes).trim() };
      } else if (cursor === null) position = { kind: 'variable' };
      else position = { kind: 'offset', offset: cursor };
      const e = f.enum !== undefined && spec.enums && Object.hasOwn(spec.enums, f.enum) ? spec.enums[f.enum] : undefined;
      const field: DocField = {
        name: f.name,
        type:
          typeof f.type === 'string'
            ? { kind: 'simple', name: f.type }
            : { kind: 'switch', on: f.type.switch, cases: Object.entries(f.type.cases).map(([key, type]) => ({ key, type })), ...(f.type.default !== undefined ? { default: f.type.default } : {}) },
        endian: modelEndian(spec, f),
        position,
        size: modelSize(spec, f),
        asserts: (f.assert ?? []).map((a) => ({ level: a.level ?? 'error', expr: a.expr, ...(a.message ? { message: a.message } : {}) })),
        bits: (f.bits ?? []).map((b) => ({
          name: b.name,
          range: b.width === 1 ? String(b.offset) : `${b.offset + b.width - 1}:${b.offset}`,
          ...(b.doc ? { doc: b.doc } : {}),
        })),
      };
      if (f.doc) field.doc = f.doc;
      if (f.if !== undefined) field.ifExpr = f.if;
      if (f.enum !== undefined) field.enum = { name: f.enum, ...(e ? { preview: Object.values(e).slice(0, 4) } : {}), more: e ? Object.keys(e).length > 4 : false };
      if (f.expect !== undefined) field.expect = String(f.expect);
      if (f.fatal === true) field.fatal = true;
      if (f.find?.mask !== undefined) field.findMask = String(f.find.mask).trim();
      if (Array.isArray(f.find?.accept)) field.findAccept = f.find!.accept.map(String);
      if (f.ifMagic !== undefined) field.ifMagic = { at: String(f.ifMagic.at), bytes: String(f.ifMagic.bytes).trim(), ...(f.ifMagic.mask !== undefined ? { mask: String(f.ifMagic.mask).trim() } : {}) };
      if (f.value !== undefined) field.value = String(f.value);
      if (f.ref !== undefined) {
        field.ref = { type: String(f.ref.type), at: String(f.ref.at), ...(f.ref.doc ? { doc: f.ref.doc } : {}) };
        if (Array.isArray(f.ref.jumps) && f.ref.jumps.length > 0) field.ref.jumps = f.ref.jumps.map((j) => ({ label: String(j.label), path: String(j.path) }));
      }
      if (f.link !== undefined) {
        field.link = { at: String(f.link.at), ...(f.link.size !== undefined ? { size: String(f.link.size) } : {}), ...(f.link.label !== undefined ? { label: String(f.link.label) } : {}) };
      }
      fields.push(field);
      if (!isPlaced(f) && cursor !== null) {
        const adv = staticAdvance(spec, f);
        cursor = adv === null ? null : cursor + adv;
      }
    }
    types.push({ name: tn, ...(def.doc ? { doc: def.doc } : {}), fields });
  }
  return {
    title: spec.name,
    ...(spec.doc ? { doc: spec.doc } : {}),
    id: spec.id,
    schemaVersion: spec.schemaVersion,
    defaultEndian: spec.endian === 'le' ? 'little-endian' : spec.endian === 'be' ? 'big-endian' : 'none declared (explicit per type)',
    precedenceNote: PRECEDENCE_NOTE,
    detect: (spec.detect ?? []).map((r) => ({
      where: r.at >= 0 ? `offset ${hexOff(r.at)}` : `${-r.at} bytes before the end of the file`,
      bytes: r.bytes.trim(),
      ...(r.mask ? { mask: r.mask.trim() } : {}),
    })),
    extensions: exts.map((e) => '.' + e),
    rootType: spec.root,
    types,
    enums: Object.entries(spec.enums ?? {}).map(([name, vals]) => ({ name, entries: Object.entries(vals).map(([key, label]) => ({ key, label })) })),
  };
}

// ---- Markdown ----

function mdType(t: DocTypeRef): string {
  if (t.kind === 'simple') return code(t.name);
  return `switch on ${code(t.on)}: ` + t.cases.map((c) => `${code(c.key)} → ${code(c.type)}`).join(', ') + (t.default !== undefined ? `, default → ${code(t.default)}` : '');
}

/** Markdown for label pieces. Plain pieces are flattened to one line and `& < >` become entities; they are not fully prose-escaped so that labels like `0x0E (14)` stay readable. */
export function mdPieces(ps: DocTextPiece[]): string {
  return ps.map((x) => (x.code ? code(x.text) : x.text.replace(LINE_BREAKS, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))).join('');
}

function mdPosition(p: DocPosition): string {
  return mdPieces(positionPieces(p));
}

function mdSize(s: DocField['size']): string {
  const b = s.base;
  const base =
    b.kind === 'eos' ? 'to end of stream' : b.kind === 'expr' ? code(b.expr) : b.kind === 'static' ? `${b.bytes}` : b.kind === 'terminator' ? `until terminator ${b.terminator}` : 'variable';
  if (!s.repeat) return base;
  if (s.repeat.kind === 'eos') return `${base} × until end of stream`;
  if (s.repeat.kind === 'count') return `${base} × ${code(s.repeat.expr)}`;
  return `${base} × until ${code(s.repeat.expr)}`;
}

function mdDesc(f: DocField): string {
  const parts: string[] = [];
  if (f.doc) parts.push(esc(f.doc));
  if (f.value !== undefined) parts.push(`Computed value (no bytes): ${code(f.value)}.`);
  if (f.ifExpr !== undefined) parts.push(`Present only if ${code(f.ifExpr)}.`);
  if (f.ifMagic) parts.push(`Present only if the bytes ${code(f.ifMagic.bytes)}${f.ifMagic.mask ? ` (mask ${code(f.ifMagic.mask)})` : ''} are at ${code(f.ifMagic.at)}.`);
  if (f.findMask !== undefined) parts.push(`Search mask: ${code(f.findMask)}.`);
  if (f.findAccept) parts.push('Search candidates are tried nearest first and accepted by the first condition that holds: ' + f.findAccept.map((a, i) => `${i + 1}. ${code(a)}`).join('; ') + '.');
  if (f.ref) parts.push(`Reference: can be opened as ${code(f.ref.type)} at file offset ${code(f.ref.at)}${f.ref.doc ? ' — ' + esc(f.ref.doc) : ''}.`);
  if (f.ref?.jumps) parts.push('Jump shortcuts: ' + f.ref.jumps.map((j) => `${esc(j.label)} → ${code(j.path)}`).join('; ') + '.');
  if (f.link) parts.push(`Link: jumps to file offset ${code(f.link.at)}${f.link.size !== undefined ? ` (${code(f.link.size)} bytes)` : ''}${f.link.label ? ' — ' + esc(f.link.label) : ''}.`);
  if (f.enum) {
    const vals = f.enum.preview ? ` (${f.enum.preview.map(esc).join(', ')}${f.enum.more ? ', …' : ''})` : '';
    parts.push(`Enum ${code(f.enum.name)}${vals}.`);
  }
  for (const a of f.asserts) parts.push(`Check (${a.level}): ${code(a.expr)}${a.message ? ' — ' + esc(a.message) : ''}.`);
  if (f.expect !== undefined) parts.push(`Expected value: ${code(f.expect)}${f.fatal ? ' (a mismatch stops parsing)' : ''}.`);
  if (f.bits.length > 0) {
    parts.push('Bits (bit 0 = least significant): ' + f.bits.map((b) => `${code(b.name)} [${b.range}]${b.doc ? ' ' + esc(b.doc) : ''}`).join('; ') + '.');
  }
  return parts.join(' ');
}

/**
 * Markdown reference for a spec. Safe for untrusted specs: all spec text is escaped (see the file header), so no raw
 * HTML, links or table breaks can be injected. Offsets of sequential fields are relative to the containing structure;
 * `at` fields show an absolute file offset, `find` fields where a search places them, `value` fields are computed
 * (no bytes) and `variable` means the position depends on earlier data. Same input gives the same output.
 */
export function generateMarkdown(spec: FormatSpec): string {
  const m = buildDocModel(spec);
  const out: string[] = [];
  out.push(`# ${esc(m.title)}`, '');
  out.push(
    '> Expression note: operators follow Python/Rust precedence, not C. Bitwise `& | ^` bind tighter than comparisons, so `flags & 4 == 4` means `(flags & 4) == 4`. ' +
      'Order, loosest first: `?:`, `||`/`or`, `&&`/`and`, `==` `!=`, `<` `<=` `>` `>=`, `|`, `^`, `&`, `<<` `>>`, `+` `-`, `*` `/` `%`, unary. Use parentheses when unsure.',
    '',
  );
  out.push(`Spec id: ${code(m.id)} (schema version ${m.schemaVersion}). Default byte order: ${m.defaultEndian}.`, '');
  if (m.doc) out.push(esc(m.doc), '');

  out.push('## Detection', '');
  if (m.detect.length === 0) out.push('- Magic bytes: none');
  for (const r of m.detect) out.push(`- Magic bytes: ${code(r.bytes)} at ${r.where}${r.mask ? `, mask ${code(r.mask)}` : ''}`);
  out.push(`- Extensions: ${m.extensions.length ? m.extensions.map((e) => code(e)).join(', ') : 'none'}`, '');

  out.push('## Structures', '', `Root type: ${code(m.rootType)}. ${mdPieces(POSITION_NOTE_PIECES)}`, '');
  for (const t of m.types) {
    out.push(`### ${ident(t.name)}`, '');
    if (t.doc) out.push(esc(t.doc), '');
    out.push('| Field | Type | Endian | Offset/Position | Size | Description |', '| --- | --- | --- | --- | --- | --- |');
    for (const f of t.fields) out.push(`| ${code(f.name)} | ${mdType(f.type)} | ${f.endian} | ${mdPosition(f.position)} | ${mdSize(f.size)} | ${mdDesc(f)} |`);
    out.push('');
  }

  if (m.enums.length > 0) {
    out.push('## Enums', '');
    for (const e of m.enums) {
      out.push(`### ${ident(e.name)}`, '', '| Value | Name |', '| --- | --- |');
      for (const en of e.entries) out.push(`| ${code(en.key)} | ${esc(en.label)} |`);
      out.push('');
    }
  }
  return out.join('\n');
}

// ---- HTML ----

/** Escape `& < > " '` for HTML element content or a quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'));
}

const h = escapeHtml;
const hcode = (s: string) => `<code>${h(s)}</code>`;

function htmlType(t: DocTypeRef): string {
  if (t.kind === 'simple') return hcode(t.name);
  return `switch on ${hcode(t.on)}: ` + t.cases.map((c) => `${hcode(c.key)} → ${hcode(c.type)}`).join(', ') + (t.default !== undefined ? `, default → ${hcode(t.default)}` : '');
}

/** HTML for label pieces: every piece is escaped, code pieces are wrapped in `<code>`. */
export function htmlPieces(ps: DocTextPiece[]): string {
  return ps.map((x) => (x.code ? hcode(x.text) : h(x.text))).join('');
}

function htmlPosition(p: DocPosition): string {
  return htmlPieces(positionPieces(p));
}

function htmlSize(s: DocField['size']): string {
  const b = s.base;
  const base =
    b.kind === 'eos' ? 'to end of stream' : b.kind === 'expr' ? hcode(b.expr) : b.kind === 'static' ? `${b.bytes}` : b.kind === 'terminator' ? `until terminator ${h(b.terminator)}` : 'variable';
  if (!s.repeat) return base;
  if (s.repeat.kind === 'eos') return `${base} × until end of stream`;
  if (s.repeat.kind === 'count') return `${base} × ${hcode(s.repeat.expr)}`;
  return `${base} × until ${hcode(s.repeat.expr)}`;
}

function htmlDesc(f: DocField): string {
  const parts: string[] = [];
  if (f.doc) parts.push(h(f.doc));
  if (f.value !== undefined) parts.push(`Computed value (no bytes): ${hcode(f.value)}.`);
  if (f.ifExpr !== undefined) parts.push(`Present only if ${hcode(f.ifExpr)}.`);
  if (f.ifMagic) parts.push(`Present only if the bytes ${hcode(f.ifMagic.bytes)}${f.ifMagic.mask ? ` (mask ${hcode(f.ifMagic.mask)})` : ''} are at ${hcode(f.ifMagic.at)}.`);
  if (f.findMask !== undefined) parts.push(`Search mask: ${hcode(f.findMask)}.`);
  if (f.findAccept) parts.push('Search candidates are tried nearest first and accepted by the first condition that holds: ' + f.findAccept.map((a, i) => `${i + 1}. ${hcode(a)}`).join('; ') + '.');
  if (f.ref) parts.push(`Reference: can be opened as ${hcode(f.ref.type)} at file offset ${hcode(f.ref.at)}${f.ref.doc ? ' — ' + h(f.ref.doc) : ''}.`);
  if (f.ref?.jumps) parts.push('Jump shortcuts: ' + f.ref.jumps.map((j) => `${h(j.label)} → ${hcode(j.path)}`).join('; ') + '.');
  if (f.link) parts.push(`Link: jumps to file offset ${hcode(f.link.at)}${f.link.size !== undefined ? ` (${hcode(f.link.size)} bytes)` : ''}${f.link.label ? ' — ' + h(f.link.label) : ''}.`);
  if (f.enum) {
    const vals = f.enum.preview ? ` (${f.enum.preview.map(h).join(', ')}${f.enum.more ? ', …' : ''})` : '';
    parts.push(`Enum ${hcode(f.enum.name)}${vals}.`);
  }
  for (const a of f.asserts) parts.push(`Check (${h(a.level)}): ${hcode(a.expr)}${a.message ? ' — ' + h(a.message) : ''}.`);
  if (f.expect !== undefined) parts.push(`Expected value: ${hcode(f.expect)}${f.fatal ? ' (a mismatch stops parsing)' : ''}.`);
  if (f.bits.length > 0) parts.push('Bits (bit 0 = least significant): ' + f.bits.map((b) => `${hcode(b.name)} [${h(b.range)}]${b.doc ? ' ' + h(b.doc) : ''}`).join('; ') + '.');
  return parts.join(' ');
}

const HTML_CSS =
  'body{font-family:system-ui,sans-serif;max-width:70rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#1f2937}' +
  'table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}th,td{border:1px solid #d1d5db;padding:.25rem .5rem;text-align:left;vertical-align:top}' +
  'th{background:#f3f4f6}code{font-family:ui-monospace,Consolas,monospace;background:#f3f4f6;padding:0 .2em}blockquote{margin:1rem 0;padding:.5rem 1rem;border-left:4px solid #d1d5db;color:#4b5563}';

/**
 * Standalone HTML document for export. Every spec-derived value is HTML-escaped, no links are produced, and a strict
 * CSP (no scripts, no network, inline styles only) is embedded.
 */
export function generateHtml(spec: FormatSpec): string {
  const m = buildDocModel(spec);
  const o: string[] = [];
  o.push(
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${h(m.title)}</title>`,
    `<style>${HTML_CSS}</style>`,
    '</head>',
    '<body>',
    `<h1>${h(m.title)}</h1>`,
    `<blockquote>${h(m.precedenceNote)}</blockquote>`,
    `<p>Spec id: ${hcode(m.id)} (schema version ${m.schemaVersion}). Default byte order: ${h(m.defaultEndian)}.</p>`,
  );
  if (m.doc) o.push(`<p>${h(m.doc)}</p>`);
  o.push('<h2>Detection</h2>', '<ul>');
  if (m.detect.length === 0) o.push('<li>Magic bytes: none</li>');
  for (const r of m.detect) o.push(`<li>Magic bytes: ${hcode(r.bytes)} at ${h(r.where)}${r.mask ? `, mask ${hcode(r.mask)}` : ''}</li>`);
  o.push(`<li>Extensions: ${m.extensions.length ? m.extensions.map(hcode).join(', ') : 'none'}</li>`, '</ul>');
  o.push('<h2>Structures</h2>', `<p>Root type: ${hcode(m.rootType)}. ${htmlPieces(POSITION_NOTE_PIECES)}</p>`);
  for (const t of m.types) {
    o.push(`<h3>${h(t.name)}</h3>`);
    if (t.doc) o.push(`<p>${h(t.doc)}</p>`);
    o.push('<table>', '<thead><tr><th>Field</th><th>Type</th><th>Endian</th><th>Offset/Position</th><th>Size</th><th>Description</th></tr></thead>', '<tbody>');
    for (const f of t.fields) {
      o.push(`<tr><td>${hcode(f.name)}</td><td>${htmlType(f.type)}</td><td>${h(f.endian)}</td><td>${htmlPosition(f.position)}</td><td>${htmlSize(f.size)}</td><td>${htmlDesc(f)}</td></tr>`);
    }
    o.push('</tbody>', '</table>');
  }
  if (m.enums.length > 0) {
    o.push('<h2>Enums</h2>');
    for (const e of m.enums) {
      o.push(`<h3>${h(e.name)}</h3>`, '<table>', '<thead><tr><th>Value</th><th>Name</th></tr></thead>', '<tbody>');
      for (const en of e.entries) o.push(`<tr><td>${hcode(en.key)}</td><td>${h(en.label)}</td></tr>`);
      o.push('</tbody>', '</table>');
    }
  }
  o.push('</body>', '</html>', '');
  return o.join('\n');
}
