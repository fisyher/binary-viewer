import { describe, expect, it } from 'vitest';
import { MemoryByteSource } from '../byte-source';
import { buildDocModel, generateHtml, generateMarkdown } from './docs';
import { evaluate, parseExpr } from './expr';
import { expandLazy, expandRef, findNodeAt, parse } from './interpret';
import { ENCODINGS } from './schema';
import { find, mem, mkSpec, rawSpec } from './test-helpers';
import { validateSpec } from './validate';

const f = (name: string, type: unknown, extra: Record<string, unknown> = {}) => ({ name, type, ...extra });
const codes = (r: { errors: Array<{ code: string }> }) => r.errors.map((e) => e.code);

function counting(bytes: number[]) {
  const inner = new MemoryByteSource(Uint8Array.from(bytes));
  const reads: Array<{ offset: number; length: number }> = [];
  return { source: { size: inner.size, read: (o: number, l: number) => (reads.push({ offset: o, length: l }), inner.read(o, l)) }, reads };
}

// ---------------------------------------------------------------------------------------------------- _start

describe('_start', () => {
  const spec = mkSpec({
    hdr: { fields: [f('s', 'value', { value: '_start' }), f('x', 'u1'), f('p', 'value', { value: '_parent.base + _start' })] },
    root: {
      fields: [f('base', 'u1'), f('hdr', 'hdr', { at: 2 }), f('sized', 'hdr', { size: 2 }), f('rootstart', 'value', { value: '_start' }), f('seen', 'value', { value: 'hdr._start * 100 + sized._start' })],
    },
  });
  it('is the absolute offset where each struct begins, also through member access', async () => {
    const r = await parse(spec, mem([5, 9, 7, 8, 9, 10]));
    expect(r.errors).toEqual([]);
    expect(find(r.root, 'hdr.s').value).toBe(2);
    expect(find(r.root, 'sized.s').value).toBe(1); // sequential cursor after `base`
    expect(find(r.root, 'rootstart').value).toBe(0);
    expect(find(r.root, 'seen').value).toBe(2 * 100 + 1);
    expect(find(r.root, 'hdr.p').value).toBe(5 + 2);
  });
  it('is a reserved expression name for the validator and not a field name', () => {
    const bad = validateSpec({ schemaVersion: 1, id: 'x', name: 'X', root: 'root', types: { root: { fields: [{ name: '_start', type: 'u1' }] } } });
    expect(bad.ok).toBe(false);
    const ok = validateSpec({ schemaVersion: 1, id: 'x', name: 'X', root: 'root', types: { root: { fields: [{ name: 'a', type: 'u1' }, { name: 'b', type: 'u1', if: '_start == 0' }] } } });
    expect(ok.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------- ifMagic

describe('ifMagic', () => {
  const spec = (magic: Record<string, unknown>, extra: Record<string, unknown> = {}, build = mkSpec) =>
    build({
      root: {
        fields: [f('a', 'u1'), f('opt', 'u2', { ifMagic: { at: 1, bytes: '41 42', ...magic }, ...extra }), f('seen', 'value', { value: 'opt == null ? 1 : 0' }), f('tail', 'u1')],
      },
    });
  it('parses the field when the bytes match, skips it (null) when they do not', async () => {
    const yes = await parse(spec({}), mem([0, 0x41, 0x42, 9]));
    expect(yes.errors).toEqual([]);
    expect(find(yes.root, 'opt').value).toBe(0x4241 + 0); // bytes 41 42 le
    expect(find(yes.root, 'seen').value).toBe(0);
    const no = await parse(spec({}), mem([0, 0x41, 0x43, 9]));
    expect(no.errors).toEqual([]);
    expect(no.root.children!.some((c) => c.name === 'opt')).toBe(false);
    expect(find(no.root, 'seen').value).toBe(1);
    expect(find(no.root, 'tail').offset).toBe(1); // cursor not advanced for the skipped field
  });
  it('applies a mask', async () => {
    const r = await parse(spec({ bytes: '41 00', mask: 'FF 00' }), mem([0, 0x41, 0x99, 9]));
    expect(find(r.root, 'opt').value).toBe(0x9941);
  });
  it('is a quiet no for negative, past-EOF, unsafe and null positions (no error, no diagnostics)', async () => {
    for (const at of ['0 - 3', 100, '9007199254740993', 'zero']) {
      const s = mkSpec({ root: { fields: [f('zero', 'u1', { if: 'false' }), f('opt', 'u1', { ifMagic: { at, bytes: '00' } })] } });
      const r = await parse(s, mem([0, 0, 0]));
      expect(r.errors, String(at)).toEqual([]);
      expect(r.root.children!.some((c) => c.name === 'opt'), String(at)).toBe(false);
    }
  });
  it('treats a partially out-of-range read as no', async () => {
    const r = await parse(spec({ at: 3 }), mem([0, 0x41, 0x42, 0x41]));
    expect(r.errors).toEqual([]);
    expect(r.root.children!.some((c) => c.name === 'opt')).toBe(false);
  });
  it('stays inside the enclosing substream', async () => {
    const s = mkSpec({
      inner: { fields: [f('x', 'u1', { ifMagic: { at: 3, bytes: '41' } })] },
      root: { fields: [f('sub', 'inner', { size: 2 }), f('rest', 'bytes', { size: 'eos' })] },
    });
    const r = await parse(s, mem([1, 2, 3, 0x41]));
    expect(find(r.root, 'sub').children).toEqual([]); // offset 3 is outside the 2-byte substream
  });
  it('combines with if: if is evaluated first (no read when it is false)', async () => {
    const c = counting([0, 0x41, 0x42, 9]);
    const s = mkSpec({ root: { fields: [f('a', 'u1'), f('opt', 'u1', { if: 'a == 1', ifMagic: { at: 1, bytes: '41' } })] } });
    const r = await parse(s, c.source);
    expect(r.errors).toEqual([]);
    expect(c.reads).toEqual([{ offset: 0, length: 1 }]); // only `a`; the magic was never read
    const r2 = await parse(s, mem([1, 0x41]));
    expect(find(r2.root, 'opt').value).toBe(0x41);
    const r3 = await parse(s, mem([1, 0x42]));
    expect(r3.root.children!.some((x) => x.name === 'opt')).toBe(false);
  });
  it('an expression that cannot be evaluated is reported like a bad `if` (not quiet)', async () => {
    const r = await parse(spec({ at: 'nope' }, {}, rawSpec), mem([0, 0x41, 0x42, 9]));
    expect(codes(r)).toEqual(['expr']);
    expect(find(r.root, 'tail').offset).toBe(1); // the struct carries on
  });
  it('is validated: bytes 1..64, mask, keys, at required', () => {
    const v = (m: unknown) =>
      validateSpec({ schemaVersion: 1, id: 'x', name: 'X', root: 'root', types: { root: { fields: [{ name: 'a', type: 'u1', ifMagic: m }] } } });
    expect(v({ at: 0, bytes: '41' }).ok).toBe(true);
    expect(v({ at: 0, bytes: '41'.repeat(64) }).ok).toBe(true);
    expect(v({ at: 0, bytes: '41'.repeat(65) }).ok).toBe(false);
    expect(v({ at: 0, bytes: '41', mask: '00' }).ok).toBe(false);
    expect(v({ at: 0, bytes: '41', mask: 'FF FF' }).ok).toBe(false);
    expect(v({ bytes: '41' }).ok).toBe(false);
    expect(v({ at: 0, bytes: '41', x: 1 }).ok).toBe(false);
    expect(v({ at: 'nope', bytes: '41' }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------- value

describe('value fields', () => {
  it('consume nothing, define the name, and display the value at the cursor', async () => {
    const s = mkSpec({
      root: { fields: [f('a', 'u1'), f('dbl', 'value', { value: 'a * 2', doc: 'twice a' }), f('b', 'u1'), f('data', 'bytes', { size: 'dbl' })] },
    });
    const r = await parse(s, mem([2, 7, 1, 2, 3, 4, 5]));
    expect(r.errors).toEqual([]);
    const n = find(r.root, 'dbl');
    expect(n).toMatchObject({ typeName: 'value', offset: 1, size: 0, value: 4, display: '4', doc: 'twice a' });
    expect(find(r.root, 'b').offset).toBe(1); // cursor unchanged
    expect(find(r.root, 'data').size).toBe(4);
  });
  it('supports bigint, string, bool, null and struct results', async () => {
    const s = mkSpec({
      pair: { fields: [f('x', 'u1')] },
      root: {
        fields: [
          f('p', 'pair'),
          f('big', 'value', { value: '0xFFFFFFFFFFFFFFFFFF' }),
          f('str', 'value', { value: '"hi"' }),
          f('flag', 'value', { value: 'p.x == 3' }),
          f('nil', 'value', { value: 'null' }),
          f('copy', 'value', { value: 'p' }),
          f('viaCopy', 'value', { value: 'copy.x + 1' }),
        ],
      },
    });
    const r = await parse(s, mem([3]));
    expect(r.errors).toEqual([]);
    expect(find(r.root, 'big').value).toBe(0xffffffffffffffffffn);
    expect(find(r.root, 'str')).toMatchObject({ value: 'hi', display: '"hi"' });
    expect(find(r.root, 'flag').display).toBe('true');
    expect(find(r.root, 'nil').display).toBe('null');
    expect(find(r.root, 'copy').display).toBe('(struct)');
    expect(find(r.root, 'viaCopy').value).toBe(4);
  });
  it('an expression error is reported on the node, the value is null, and the struct goes on', async () => {
    const s = mkSpec({ root: { fields: [f('a', 'u1', { if: 'false' }), f('bad', 'value', { value: 'a + 1' }), f('seen', 'value', { value: 'bad == null' }), f('z', 'u1')] } });
    const r = await parse(s, mem([9]));
    const bad = find(r.root, 'bad');
    expect(bad.error).toMatch(/needs integers/);
    expect(bad.size).toBe(0);
    expect(r.errors.filter((e) => e.nodeId === bad.id)).toHaveLength(1);
    expect(find(r.root, 'seen').value).toBeUndefined();
    expect(find(r.root, 'seen').display).toBe('true');
    expect(find(r.root, 'z').value).toBe(9);
  });
  it('works with if and assert (_ is the value)', async () => {
    const s = mkSpec({
      root: {
        fields: [
          f('a', 'u1'),
          f('on', 'value', { value: 'a * 3', if: 'a > 0', assert: [{ expr: '_ == 7', message: 'not seven' }] }),
          f('off', 'value', { value: '1', if: 'a > 100' }),
          f('offseen', 'value', { value: 'off == null' }),
        ],
      },
    });
    const r = await parse(s, mem([2]));
    expect(find(r.root, 'on').validation).toEqual(['not seven']);
    expect(r.errors.map((e) => e.code)).toEqual(['validation']);
    expect(r.root.children!.some((c) => c.name === 'off')).toBe(false);
    expect(find(r.root, 'offseen').display).toBe('true');
  });
  it('the value key and the value type go together; value fields take no bytes or placement', () => {
    const v = (fld: Record<string, unknown>) => {
      const x = validateSpec({ schemaVersion: 1, id: 'x', name: 'X', root: 'root', types: { root: { fields: [{ name: 'a', type: 'u1' }, { name: 'v', ...fld }] } } });
      return x.ok ? [] : x.errors.map((e) => `${e.path}: ${e.message}`);
    };
    expect(v({ type: 'value', value: 'a' })).toEqual([]);
    expect(v({ type: 'u1', value: 'a' }).join()).toMatch(/only valid on a field of type "value"/);
    expect(v({ type: 'value' }).join()).toMatch(/needs "value"/);
    expect(v({ type: 'value', value: 'a +' }).join()).toMatch(/bad expression/);
    expect(v({ type: 'value', value: 'nope' }).join()).toMatch(/unknown name/);
    expect(v({ type: 'value', value: 'a', size: 2 }).join()).toMatch(/size/);
    expect(v({ type: 'value', value: 'a', repeat: 'eos' }).length).toBeGreaterThan(0);
    expect(v({ type: 'value', value: 'a', at: 0 }).length).toBeGreaterThan(0);
    expect(v({ type: 'value', value: 'a', encoding: 'ascii' }).length).toBeGreaterThan(0);
    expect(v({ type: { switch: 'a', cases: { '1': 'value' } } }).join()).toMatch(/not inside a switch/);
  });
  it('is zero-size for layout (docs cursor does not advance)', () => {
    const s = mkSpec({ root: { fields: [f('a', 'u2'), f('v', 'value', { value: 'a' }), f('b', 'u1')] } });
    const rows = buildDocModel(s).types[0]!.fields;
    expect(rows[1]!.position).toEqual({ kind: 'computed' });
    expect(rows[2]!.position).toEqual({ kind: 'offset', offset: 2 });
  });
});

// ---------------------------------------------------------------------------------------------------- lookup

describe('lookup', () => {
  const spec = (valueExpr: string, extra: Record<string, unknown> = {}) =>
    mkSpec({
      item: { fields: [f('id', 'u1'), f('v', 'u1')] },
      root: { fields: [f('n', 'u1'), f('items', 'item', { repeat: { count: 'n' } }), f('hit', 'value', { value: valueExpr, ...extra })] },
    });
  const data = [3, 1, 10, 2, 20, 3, 30];
  it('returns the first matching element, members are readable', async () => {
    const r = await parse(spec('lookup(items, "id", 2).v'), mem(data));
    expect(r.errors).toEqual([]);
    expect(find(r.root, 'hit').value).toBe(20);
    const first = await parse(spec('lookup(items, "id", 1).v'), mem([2, 1, 10, 1, 11]));
    expect(find(first.root, 'hit').value).toBe(10);
  });
  it('uses == semantics and is null on a miss', async () => {
    const r = await parse(spec('lookup(items, "id", 99) == null'), mem(data));
    expect(find(r.root, 'hit').display).toBe('true');
    const noMember = await parse(spec('lookup(items, "nope", 1) == null'), mem(data));
    expect(find(noMember.root, 'hit').display).toBe('true');
    const wrongType = await parse(spec('lookup(items, "id", "2") == null'), mem(data));
    expect(find(wrongType.root, 'hit').display).toBe('true');
  });
  it('a null list gives null; a non-array is an error', async () => {
    const s = mkSpec({ root: { fields: [f('items', 'u1', { if: 'false' }), f('a', 'value', { value: 'lookup(items, "id", 1)' }), f('b', 'u1'), f('c', 'value', { value: 'lookup(b, "id", 1)' })] } });
    const r = await parse(s, mem([1]));
    expect(find(r.root, 'a').display).toBe('null');
    expect(find(r.root, 'c').error).toMatch(/needs an array/);
  });
  it('only searches kept (eagerly parsed) elements; lazy and skimmed ones are not searched', async () => {
    // fixed-size elements beyond eagerElements become lazy (never parsed)
    const r = await parse(spec('lookup(items, "id", 5) == null'), mem([5, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]), { limits: { eagerElements: 2 } });
    expect(find(r.root, 'hit').display).toBe('true');
    // variable-size elements: the first eagerElements are kept (searchable), the rest is skimmed
    const s = mkSpec({
      item: { fields: [f('id', 'u1'), f('l', 'u1'), f('d', 'bytes', { size: 'l' })] },
      root: { fields: [f('items', 'item', { repeat: 'eos' }), f('hit', 'value', { value: 'lookup(items, "id", 4) == null' })] },
    });
    const r2 = await parse(s, mem([1, 0, 2, 0, 3, 0, 4, 0]), { limits: { eagerElements: 2 } });
    expect(find(r2.root, 'hit').display).toBe('true');
    const s3 = mkSpec({
      item: { fields: [f('id', 'u1'), f('l', 'u1'), f('d', 'bytes', { size: 'l' })] },
      root: { fields: [f('items', 'item', { repeat: 'eos' }), f('hit', 'value', { value: 'lookup(items, "id", 2).l' })] },
    });
    const r3 = await parse(s3, mem([1, 0, 2, 1, 7, 3, 0, 4, 0]), { limits: { eagerElements: 2 } });
    expect(find(r3.root, 'hit').value).toBe(1); // element 1 was kept
  });
  it('the scan budget bounds the work (error on that expression only)', async () => {
    const r = await parse(spec('lookup(items, "id", 3).v'), mem(data), { limits: { maxLookupScan: 2 } });
    expect(find(r.root, 'hit').error).toMatch(/scan budget exhausted/);
    expect(r.stats.truncated).toBe(false);
  });
  it('the member must be a string literal and there must be 3 arguments (parse-time)', () => {
    expect(parseExpr('lookup(a, b, 1)').ok).toBe(false);
    expect(parseExpr('lookup(a, 1, 1)').ok).toBe(false);
    expect(parseExpr('lookup(a, "x")').ok).toBe(false);
    expect(parseExpr('lookup(a, "x", 1, 2)').ok).toBe(false);
    expect(parseExpr('lookup(a, "x", 1)').ok).toBe(true);
    expect(parseExpr('lookup(a, "x", 1).y').ok).toBe(true);
    const v = validateSpec({ schemaVersion: 1, id: 'x', name: 'X', root: 'root', types: { root: { fields: [{ name: 'a', type: 'u1' }, { name: 'v', type: 'value', value: 'lookup(a, a, 1)' }] } } });
    expect(v.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------- ref

describe('ref', () => {
  // root: sub (4-byte substream: tag u1, off u1 -> ref blob, comp u1, d u1 -> ref data), blob at off
  const spec = mkSpec({
    blob: { fields: [f('b0', 'u1'), f('b1', 'u1')] },
    data: { fields: [f('body', 'bytes', { size: '_parent.comp' }), f('again', 'u1', { ref: { type: 'blob', at: '0' } })] },
    entry: { fields: [f('tag', 'u1'), f('off', 'u1', { ref: { type: 'blob', at: 'off', doc: 'the blob' } }), f('comp', 'u1'), f('d', 'u1', { ref: { type: 'data', at: '_' } })] },
    root: { fields: [f('sub', 'entry', { size: 4 }), f('pad', 'bytes', { size: 3 })] },
  });
  const bytes = [0xee, 6, 2, 8, 0, 0, 0xb0, 0xb1, 0xd0, 0xd1, 0xd2];
  //                tag off comp d  pad pad pad? -> sub=[0..4) pad=[4..7); blob at 6 spans [6,8); data at 8 body 2 bytes [8,10), again at 10
  it('records {typeName, offset} on the node and parses nothing', async () => {
    const r = await parse(spec, mem(bytes));
    expect(r.errors).toEqual([]);
    const off = find(r.root, 'sub.off');
    expect(off.ref).toEqual({ typeName: 'blob', offset: 6 });
    expect(off.children).toBeUndefined();
    expect(find(r.root, 'sub.d').ref).toEqual({ typeName: 'data', offset: 8 });
    expect(r.stats.nodes).toBe(1 + 1 + 4 + 1); // root, sub, 4 fields, pad
  });
  it('expandRef parses the target outside the substream and attaches it under the node', async () => {
    const r = await parse(spec, mem(bytes));
    const off = find(r.root, 'sub.off');
    const nodes = await expandRef(r, off.id);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ typeName: 'blob', offset: 6, size: 2 });
    expect(find(nodes[0]!, 'b1').value).toBe(0xb1);
    expect(off.children).toEqual(nodes); // attached
    expect(off.ref?.loaded).toBe(true);
    expect(r.errors).toEqual([]);
    // idempotent: same node objects, no re-parse
    const again = await expandRef(r, off.id);
    expect(again[0]).toBe(nodes[0]);
    expect(off.children).toHaveLength(1);
    // findNodeAt sees the expanded subtree: the deepest node covering offset 7 is blob.b1
    expect(findNodeAt(r.root, 7)?.name).toBe('b1');
  });
  it('the owning struct scope is _parent of the target (and _ is the field value)', async () => {
    const r = await parse(spec, mem(bytes));
    const d = find(r.root, 'sub.d');
    const [target] = await expandRef(r, d.id);
    expect(find(target!, 'body').size).toBe(2); // _parent.comp
    expect(find(target!, 'body').offset).toBe(8);
    expect(r.errors).toEqual([]);
  });
  it('refs inside an expanded target are not followed automatically but can be opened on demand', async () => {
    const r = await parse(spec, mem(bytes));
    const [target] = await expandRef(r, find(r.root, 'sub.d').id);
    const again = find(target!, 'again');
    expect(again.ref).toEqual({ typeName: 'blob', offset: 0 });
    expect(again.children).toBeUndefined();
    const nodes = await expandRef(r, again.id);
    expect(nodes[0]).toMatchObject({ typeName: 'blob', offset: 0 });
  });
  it('an out-of-range target is a warning and no ref; offset == size is allowed', async () => {
    const s = mkSpec({ blob: { fields: [f('b', 'u1', { if: 'false' })] }, root: { fields: [f('p', 'u1', { ref: { type: 'blob', at: 'p' } })] } });
    const bad = await parse(s, mem([9]));
    expect(find(bad.root, 'p').ref).toBeUndefined();
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0]).toMatchObject({ severity: 'warning', code: 'ref' });
    expect(find(bad.root, 'p').validation?.[0]).toMatch(/outside the file/);
    const edge = await parse(s, mem([1]));
    expect(edge.errors).toEqual([]);
    expect(find(edge.root, 'p').ref).toEqual({ typeName: 'blob', offset: 1 });
    const neg = await parse(mkSpec({ blob: { fields: [] }, root: { fields: [f('p', 'u1', { ref: { type: 'blob', at: 'p - 5' } })] } }), mem([1]));
    expect(neg.errors[0]).toMatchObject({ severity: 'warning', code: 'ref' });
  });
  it('works on value fields and with fresh budgets per expansion', async () => {
    const s = mkSpec({
      blob: { fields: [f('a', 'u1'), f('b', 'u1'), f('c', 'u1')] },
      root: { fields: [f('x', 'u1'), f('ptr', 'value', { value: 'x', ref: { type: 'blob', at: '_' } })] },
    });
    const r = await parse(s, mem([1, 7, 8, 9]), { limits: { maxNodes: 4 } }); // root + x + ptr leave one node of a shared budget
    expect(r.stats.truncated).toBe(false);
    const [t] = await expandRef(r, find(r.root, 'ptr').id);
    expect(t!.children).toHaveLength(3); // would have exceeded maxNodes if it shared the parse budget
    expect(r.stats.nodes).toBe(3);
  });
  it('a budget stop during expansion gives a partial, still attached target and sets truncated', async () => {
    const s = mkSpec({
      blob: { fields: [f('a', 'u1'), f('b', 'u1'), f('c', 'u1')] },
      root: { fields: [f('x', 'u1', { ref: { type: 'blob', at: '0' } })] },
    });
    const r = await parse(s, mem([1, 2, 3]), { limits: { maxNodes: 2, maxSteps: 100 } });
    const x = find(r.root, 'x');
    const nodes = await expandRef(r, x.id);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.children!.length).toBeLessThan(3);
    expect(r.stats.truncated).toBe(true);
  });
  it('unknown or non-ref nodes are reported, not thrown', async () => {
    const r = await parse(spec, mem(bytes));
    expect(await expandRef(r, 999_999)).toEqual([]);
    expect(await expandRef(r, find(r.root, 'sub.tag').id)).toEqual([]);
    expect(r.errors.filter((e) => e.code === 'ref')).toHaveLength(2);
  });
  it('an aborted expansion leaves the ref unopened', async () => {
    const r = await parse(spec, mem(bytes));
    const ctl = new AbortController();
    ctl.abort();
    const off = find(r.root, 'sub.off');
    expect(await expandRef(r, off.id, { signal: ctl.signal })).toEqual([]);
    expect(off.ref?.loaded).toBeUndefined();
    expect((await expandRef(r, off.id)).length).toBe(1); // a retry works
  });
  it('refs inside lazily expanded array elements are expandable', async () => {
    const s = mkSpec({
      blob: { fields: [f('a', 'u1')] },
      item: { fields: [f('p', 'u1', { ref: { type: 'blob', at: 'p' } })] },
      root: { fields: [f('items', 'item', { repeat: { count: 5 } })] },
    });
    const r = await parse(s, mem([0, 1, 2, 3, 4]), { limits: { eagerElements: 2 } });
    const arr = find(r.root, 'items');
    expect(arr.lazy).toBeDefined();
    const page = await expandLazy(r, arr.id, { start: 3, count: 1 });
    const p = find(page[0]!, 'p');
    expect(p.ref).toEqual({ typeName: 'blob', offset: 3 });
    const [t] = await expandRef(r, p.id);
    expect(find(t!, 'a').value).toBe(3);
  });
  it('the number of retained refs is capped', async () => {
    const s = mkSpec({
      blob: { fields: [] },
      root: { fields: [f('a', 'u1', { ref: { type: 'blob', at: '0' } }), f('b', 'u1', { ref: { type: 'blob', at: '0' } })] },
    });
    const r = await parse(s, mem([1, 2]), { limits: { maxRefs: 1 } });
    expect(find(r.root, 'a').ref).toBeDefined();
    expect(find(r.root, 'b').ref).toBeUndefined();
    expect(r.errors[0]).toMatchObject({ severity: 'warning', code: 'limit' });
  });
  it('is validated', () => {
    const v = (ref: unknown, extra: Record<string, unknown> = {}) => {
      const x = validateSpec({ schemaVersion: 1, id: 'x', name: 'X', root: 'root', types: { t: { fields: [] }, root: { fields: [{ name: 'a', type: 'u1', ref, ...extra }] } } });
      return x.ok ? [] : x.errors.map((e) => `${e.path}: ${e.message}`);
    };
    expect(v({ type: 't', at: 'a' })).toEqual([]);
    expect(v({ type: 't', at: 0, doc: 'hi' })).toEqual([]);
    expect(v({ type: 'nope', at: 'a' }).join()).toMatch(/unknown "nope"/);
    expect(v({ type: 't' }).join()).toMatch(/at.*required/);
    expect(v({ type: 't', at: 'zz' }).join()).toMatch(/unknown name/);
    expect(v({ type: 't', at: 'a', x: 1 }).join()).toMatch(/unknown key/);
    expect(v({ type: 't', at: 'a' }, { repeat: 'eos' }).join()).toMatch(/repeat/);
    expect(v('t').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------- fatal

describe('fatal expect', () => {
  it('a mismatch stops the struct like a read error and names expected vs actual', async () => {
    const s = mkSpec({ root: { fields: [f('magic', 'u2', { expect: 0x1234, fatal: true }), f('after', 'u1'), f('placed', 'u1', { at: 0 })] } });
    const r = await parse(s, mem([0x35, 0x12, 9]));
    const m = find(r.root, 'magic');
    expect(m.error).toBe('expected 4660, found 4661');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ severity: 'error', code: 'validation', nodeId: m.id });
    expect(r.root.children!.some((c) => c.name === 'after')).toBe(false);
    expect(find(r.root, 'placed').value).toBe(0x35); // positioned fields still parse
  });
  it('a match, and a non-fatal mismatch, carry on', async () => {
    const s = mkSpec({ root: { fields: [f('magic', 'u2', { expect: 0x1234, fatal: true }), f('after', 'u1')] } });
    const ok = await parse(s, mem([0x34, 0x12, 9]));
    expect(ok.errors).toEqual([]);
    expect(find(ok.root, 'after').value).toBe(9);
    const soft = mkSpec({ root: { fields: [f('magic', 'u2', { expect: 0x1234 }), f('after', 'u1')] } });
    const r = await parse(soft, mem([0, 0, 9]));
    expect(find(r.root, 'after').value).toBe(9);
    expect(find(r.root, 'magic').validation).toHaveLength(1);
  });
  it('works for str and float fields', async () => {
    const s = mkSpec({ root: { fields: [f('m', 'str', { size: 2, encoding: 'ascii', expect: 'BM', fatal: true }), f('after', 'u1')] } });
    const r = await parse(s, mem([0x42, 0x58, 1]));
    expect(find(r.root, 'm').error).toBe('expected "BM", found "BX"');
    expect(r.root.children!.some((c) => c.name === 'after')).toBe(false);
    const fl = mkSpec({ root: { fields: [f('x', 'f4', { expect: 1, fatal: true }), f('after', 'u1')] } });
    const r2 = await parse(fl, mem([0, 0, 0, 0, 5]));
    expect(find(r2.root, 'x').error).toMatch(/expected 1, found 0/);
  });
  it('a failed repeat element ends the array', async () => {
    const s = mkSpec({
      rec: { fields: [f('tag', 'u1', { expect: 1, fatal: true }), f('v', 'u1')] },
      root: { fields: [f('recs', 'rec', { repeat: 'eos' }), f('after', 'u1')] },
    });
    const r = await parse(s, mem([1, 10, 1, 11, 2, 12, 1, 13]));
    const arr = find(r.root, 'recs');
    expect(arr.children).toHaveLength(3); // elements 0, 1 ok; element 2 failed; the array stops
    expect(arr.children![2]!.children![0]!.error).toBe('expected 1, found 2');
    expect(find(arr.children![2]!, 'tag').error).toBeDefined();
    expect(r.root.children!.some((c) => c.name === 'after')).toBe(false); // the struct lost its cursor
  });
  it('a failed element while skimming is reported on the array', async () => {
    const s = mkSpec({
      rec: { fields: [f('tag', 'u1', { expect: 1, fatal: true }), f('l', 'u1'), f('d', 'bytes', { size: 'l' })] },
      root: { fields: [f('recs', 'rec', { repeat: 'eos' })] },
    });
    const r = await parse(s, mem([1, 0, 1, 0, 1, 0, 9, 0]), { limits: { eagerElements: 2 } });
    const arr = find(r.root, 'recs');
    expect(arr.error).toMatch(/expected 1, found 9/);
  });
  it('is validated: only with expect, boolean', () => {
    const v = (fld: Record<string, unknown>) => validateSpec({ schemaVersion: 1, id: 'x', name: 'X', root: 'root', types: { root: { fields: [{ name: 'a', type: 'u1', ...fld }] } } }).ok;
    expect(v({ expect: 1, fatal: true })).toBe(true);
    expect(v({ expect: 1, fatal: false })).toBe(true);
    expect(v({ fatal: true })).toBe(false);
    expect(v({ expect: 1, fatal: 'yes' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------- cp437

describe('cp437', () => {
  it('is an encoding everywhere it is enumerated', () => {
    expect(ENCODINGS).toContain('cp437');
    expect(validateSpec({ schemaVersion: 1, id: 'x', name: 'X', root: 'root', types: { root: { fields: [{ name: 's', type: 'str', size: 1, encoding: 'cp437' }] } } }).ok).toBe(true);
  });
  it('decodes the high half with the IBM table and ASCII below', async () => {
    const s = mkSpec({ root: { fields: [f('s', 'str', { size: 6, encoding: 'cp437' })] } });
    const r = await parse(s, mem([0x82, 0xe1, 0x41, 0xb0, 0xff, 0x09]));
    expect(find(r.root, 's').value).toBe('éßA░ \t');
  });
  it('maps all 256 bytes to 256 distinct characters', async () => {
    const all = Array.from({ length: 256 }, (_, i) => i);
    const s = mkSpec({ root: { fields: [f('s', 'str', { size: 256, encoding: 'cp437' })] } });
    const r = await parse(s, mem(all));
    const text = find(r.root, 's').value as string;
    expect([...text]).toHaveLength(256);
    expect(new Set(text).size).toBe(256);
    for (let i = 0; i < 0x80; i++) expect(text.charCodeAt(i)).toBe(i);
    expect(text[0x80]).toBe('Ç');
    expect(text[0xfe]).toBe('■');
  });
  it('works with terminators and expect', async () => {
    const s = mkSpec({ root: { fields: [f('s', 'str', { terminator: 0, encoding: 'cp437', expect: 'é' })] } });
    const r = await parse(s, mem([0x82, 0]));
    expect(r.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------- validator extras

describe('size with repeat', () => {
  const v = (fld: Record<string, unknown>) => {
    const x = validateSpec({ schemaVersion: 1, id: 'x', name: 'X', root: 'root', types: { e: { fields: [{ name: 'q', type: 'u1' }] }, root: { fields: [{ name: 'a', type: 'e', ...fld }] } } });
    return x.ok ? [] : x.errors;
  };
  it('is rejected with a hint to use a wrapper type', () => {
    const errs = v({ size: 2, repeat: { count: 3 } });
    expect(errs).toHaveLength(1);
    expect(errs[0]!.path).toBe('$.types.root.fields[0].size');
    expect(errs[0]!.message).toMatch(/own type and repeat that/);
    expect(v({ size: 'eos', repeat: 'eos' }).length).toBe(1);
    expect(v({ size: 2 })).toEqual([]);
    expect(v({ repeat: { count: 3 } })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------- docs

describe('docs for the new features', () => {
  const spec = mkSpec({
    rec: { fields: [f('sig', 'u4', { expect: 0x06054b50, fatal: true }), f('n', 'u2')] },
    other: { fields: [f('x', 'u1')] },
    root: {
      fields: [
        f('opt', 'u1', { ifMagic: { at: '_start + 2', bytes: '41 42', mask: 'FF FF' } }),
        f('eocd', 'rec', { find: { bytes: '50 4B 05 06', mask: 'FF FF FF FF', from: '_io.end', window: 65557, direction: 'backward', accept: ['n == 0', 'true'] } }),
        f('calc', 'value', { value: 'eocd.n * 2' }),
        f('ptr', 'u4', { ref: { type: 'other', at: 'ptr', doc: 'where it lives' } }),
        f('last', 'u1'),
      ],
    },
  });
  const md = generateMarkdown(spec);
  const row = (name: string) => md.split('\n').find((l) => l.startsWith(`| \`${name}\` |`))!;
  it('markdown describes find, ifMagic, value, ref and fatal', () => {
    expect(row('eocd')).toContain('found by searching backward from `_io.end` (window 65557 bytes) for `50 4B 05 06`');
    expect(row('eocd')).toContain('Search mask: `FF FF FF FF`');
    expect(row('eocd')).toContain('1. `n == 0`; 2. `true`');
    expect(row('opt')).toContain('Present only if the bytes `41 42` (mask `FF FF`) are at `_start + 2`');
    expect(row('calc')).toContain('| computed (no bytes) |');
    expect(row('calc')).toContain('Computed value (no bytes): `eocd.n * 2`');
    expect(row('ptr')).toContain('Reference: can be opened as `other` at file offset `ptr` — where it lives');
    expect(md).toMatch(/\| `sig` .* Expected value: `.*` \(a mismatch stops parsing\)/);
    // placed / computed / guarded fields do not move the static cursor: `last` follows `ptr` (u4) at offset 0 + ... variable (ifMagic)
    expect(row('last')).toContain('variable (depends on earlier data)');
  });
  it('the doc model carries the new data', () => {
    const fields = buildDocModel(spec).types.find((t) => t.name === 'root')!.fields;
    expect(fields[1]!.position).toMatchObject({ kind: 'find', direction: 'backward', window: 65557 });
    expect(fields[1]!.findAccept).toEqual(['n == 0', 'true']);
    expect(fields[2]!.value).toBe('eocd.n * 2');
  });
  it('is injection-safe in Markdown and HTML', () => {
    const evil = mkSpec({
      root: {
        fields: [
          f('v', 'value', { value: '"</td><script>alert(1)</script>`|"', doc: '<img src=x onerror=alert(1)>' }),
          f('a', 'u1', { ifMagic: { at: '"<b>x</b>"', bytes: '41' }, ref: { type: 'root', at: '"`|x"', doc: '<script>' } }),
        ],
      },
    });
    const m = generateMarkdown(evil);
    const outsideCode = m.replace(/``.*?``|`[^`]*`/g, '');
    expect(outsideCode).not.toMatch(/<script>|<img |<\/td>/); // code spans are literal; prose is escaped
    expect(m.split('\n').filter((l) => l.startsWith('| `'))).toHaveLength(2); // table rows stay single-line
    const html = generateHtml(evil);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ---------------------------------------------------------------------------------------------------- review fixes

describe('review fixes', () => {
  const SIG = [0x50, 0x4b, 0x05, 0x06];

  it('lookup inside find probes spends the real run budget (not a fresh one per probe)', async () => {
    const s = mkSpec({
      item: { fields: [f('id', 'u1')] },
      rec: { fields: [f('sig', 'u4'), f('k', 'value', { value: 'lookup(_parent.items, "id", 99) == null' })] },
      root: {
        fields: [
          f('items', 'item', { repeat: { count: 10 } }),
          f('eocd', 'rec', { find: { bytes: '50 4B 05 06', from: '_io.end', window: 1000, direction: 'backward', accept: ['k == null'] } }),
        ],
      },
    });
    const bytes = [...Array(10).fill(1), ...Array.from({ length: 8 }, () => SIG).flat()];
    // each probe scans 10 elements; the shared budget of 50 runs out in the 6th nearest probe (its k is null)
    const r = await parse(s, mem(bytes), { limits: { maxLookupScan: 50 } });
    expect(find(r.root, 'eocd').offset).toBe(10 + 2 * 4);
    // with plenty of budget no probe fails, so nothing is accepted
    const ok = await parse(s, mem(bytes), { limits: { maxLookupScan: 5_000_000 } });
    expect(find(ok.root, 'eocd').error).toMatch(/was accepted/);
  });

  it('probes use a private id counter', async () => {
    const s = mkSpec({
      rec: { fields: [f('sig', 'u4'), f('n', 'u2')] },
      root: { fields: [f('eocd', 'rec', { find: { bytes: '50 4B 05 06', from: '_io.end', window: 1000, direction: 'backward', accept: ['n == 99'] } })] },
    });
    const bytes = Array.from({ length: 20 }, () => [...SIG, 1, 0]).flat();
    const r = await parse(s, mem(bytes));
    expect(find(r.root, 'eocd').error).toBeDefined();
    expect(find(r.root, 'eocd').id).toBe(2); // 20 probes of 3 nodes each did not consume ids
  });

  it('reloading a lazy page does not accumulate retained refs or warnings', async () => {
    const s = mkSpec({
      blob: { fields: [f('a', 'u1')] },
      item: { fields: [f('p', 'u1', { ref: { type: 'blob', at: 'p' } })] },
      root: { fields: [f('items', 'item', { repeat: { count: 6 } })] },
    });
    const r = await parse(s, mem([0, 1, 2, 3, 4, 5]), { limits: { eagerElements: 2, maxRefs: 3 } });
    const arr = find(r.root, 'items');
    let last: Awaited<ReturnType<typeof expandLazy>> = [];
    for (let i = 0; i < 4; i++) last = await expandLazy(r, arr.id, { start: 0, count: 3 });
    expect(r.errors).toEqual([]); // no "too many references" warnings
    const refs = last.map((n) => find(n, 'p'));
    expect(refs.every((p) => p.ref !== undefined)).toBe(true);
    expect((await expandRef(r, refs[2]!.id)).length).toBe(1); // the newest load is the live one
    // a genuinely new element beyond the cap is still refused
    const more = await expandLazy(r, arr.id, { start: 3, count: 1 });
    expect(find(more[0]!, 'p').ref).toBeUndefined();
    expect(r.errors).toHaveLength(1);
  });

  it('a real I/O failure in ifMagic is reported on the field; a short read is a quiet no', async () => {
    const s = mkSpec({ root: { fields: [f('a', 'u1'), f('opt', 'u1', { ifMagic: { at: 1, bytes: '41' } }), f('tail', 'u1', { at: 0 })] } });
    const failing = {
      size: 3,
      read: async (o: number, l: number) => {
        if (o === 1) throw new Error('disk gone');
        return new Uint8Array(l);
      },
    };
    const r = await parse(s, failing);
    expect(find(r.root, 'opt').error).toMatch(/read failed at offset 1: disk gone/);
    expect(codes(r)).toEqual(['read']);
    expect(find(r.root, 'tail').offset).toBe(0); // the struct carries on
    const short = { size: 3, read: async (o: number, l: number) => (o === 1 ? new Uint8Array(0) : new Uint8Array(l)) };
    const q = await parse(s, short);
    expect(q.errors).toEqual([]);
    expect(q.root.children!.some((c) => c.name === 'opt')).toBe(false);
    // a budget stop still propagates
    const h = await parse(s, mem([0, 0x41, 0]), { limits: { maxReads: 1 } });
    expect(h.stats.truncated).toBe(true);
  });

  it('expandRef nodes are capped cumulatively per parse result', async () => {
    const s = mkSpec({
      blob: { fields: [f('a', 'u1'), f('b', 'u1'), f('c', 'u1')] },
      root: { fields: [f('x', 'u1', { ref: { type: 'blob', at: '0' } }), f('y', 'u1', { ref: { type: 'blob', at: '0' } }), f('z', 'u1', { ref: { type: 'blob', at: '0' } })] },
    });
    const r = await parse(s, mem([1, 2, 3]), { limits: { maxRefNodesTotal: 6 } });
    expect((await expandRef(r, find(r.root, 'x').id))[0]!.children).toHaveLength(3); // 4 nodes used
    const second = await expandRef(r, find(r.root, 'y').id); // only 2 left: partial
    expect(second[0]!.children!.length).toBeLessThan(3);
    expect(r.stats.truncated).toBe(true);
    expect(await expandRef(r, find(r.root, 'z').id)).toEqual([]);
    expect(r.errors.some((e) => e.code === 'limit' && /expansion budget exhausted/.test(e.message))).toBe(true);
  });

  it('findNodeAt prefers the primary tree over an expanded ref target that overlaps it', async () => {
    const s = mkSpec({
      blob: { fields: [f('b0', 'u1'), f('b1', 'u1')] },
      root: { fields: [f('ptr', 'u1', { ref: { type: 'blob', at: '1' } }), f('pad', 'bytes', { size: 2 })] },
    });
    const r = await parse(s, mem([1, 7, 8, 9, 10]));
    const [t] = await expandRef(r, find(r.root, 'ptr').id);
    expect(t!.fromRef).toBe(true);
    expect(findNodeAt(r.root, 1)?.name).toBe('pad'); // the real owner, not blob.b0
    expect(findNodeAt(r.root, 2)?.name).toBe('pad');
    expect(findNodeAt(r.root, 3)).toBeNull(); // nothing covers 3
    const far = mkSpec({
      blob: { fields: [f('b0', 'u1'), f('b1', 'u1')] },
      root: { fields: [f('ptr', 'u1', { ref: { type: 'blob', at: '3' } })] },
    });
    const r2 = await parse(far, mem([3, 0, 0, 7, 8]));
    await expandRef(r2, find(r2.root, 'ptr').id);
    expect(findNodeAt(r2.root, 4)?.name).toBe('b1'); // no primary node there: the ref subtree is found
  });

  it('findNodeAt: a target inside a container ancestor of the ref node wins; a sibling owner still wins', async () => {
    const s = mkSpec({
      blob: { fields: [f('b0', 'u1'), f('b1', 'u1')] },
      hdr: { fields: [f('ptr', 'u1', { ref: { type: 'blob', at: '3' } })] },
      root: { fields: [f('h', 'hdr', { size: 8 }), f('tail', 'u1')] },
    });
    const r = await parse(s, mem([3, 0, 0, 7, 8, 0, 0, 0, 9]));
    expect(findNodeAt(r.root, 3)?.name).toBe('h'); // before opening: the enclosing container
    await expandRef(r, find(r.root, 'h.ptr').id);
    // the container h (an ancestor of the ref node) merely encloses the target bytes: the target is the better answer
    expect(findNodeAt(r.root, 3)?.name).toBe('b0');
    expect(findNodeAt(r.root, 4)?.name).toBe('b1');
    expect(findNodeAt(r.root, 1)?.name).toBe('h'); // bytes outside the target are unchanged
    expect(findNodeAt(r.root, 8)?.name).toBe('tail');
    // an unrelated leaf that owns the bytes still beats the target
    const s2 = mkSpec({
      blob: { fields: [f('b0', 'u1'), f('b1', 'u1')] },
      root: { fields: [f('ptr', 'u1', { ref: { type: 'blob', at: '1' } }), f('pad', 'bytes', { size: 4 })] },
    });
    const r2 = await parse(s2, mem([1, 7, 8, 9, 10]));
    await expandRef(r2, find(r2.root, 'ptr').id);
    expect(findNodeAt(r2.root, 1)?.name).toBe('pad');
    // the ref node itself (self) yields to its target as well
    const s3 = mkSpec({ blob: { fields: [f('b0', 'u1')] }, root: { fields: [f('ptr', 'u1', { ref: { type: 'blob', at: '0' } })] } });
    const r3 = await parse(s3, mem([0]));
    await expandRef(r3, find(r3.root, 'ptr').id);
    expect(findNodeAt(r3.root, 0)?.name).toBe('b0');
  });

  it('after a lazy page reload the old page nodes can no longer be opened (the UI replaces them)', async () => {
    const s = mkSpec({
      blob: { fields: [f('a', 'u1')] },
      item: { fields: [f('p', 'u1', { ref: { type: 'blob', at: 'p' } })] },
      root: { fields: [f('items', 'item', { repeat: { count: 6 } })] },
    });
    const r = await parse(s, mem([0, 1, 2, 3, 4, 5]), { limits: { eagerElements: 2 } });
    const arr = find(r.root, 'items');
    const first = find((await expandLazy(r, arr.id, { start: 0, count: 1 }))[0]!, 'p');
    const second = find((await expandLazy(r, arr.id, { start: 0, count: 1 }))[0]!, 'p');
    expect(await expandRef(r, first.id)).toEqual([]);
    expect(r.errors.at(-1)?.message).toMatch(/not a reference of this parse result/);
    expect((await expandRef(r, second.id)).length).toBe(1);
  });

  it('concurrent expandRef calls on one node share one expansion', async () => {
    const s = mkSpec({ blob: { fields: [f('a', 'u1')] }, root: { fields: [f('x', 'u1', { ref: { type: 'blob', at: '0' } })] } });
    const r = await parse(s, mem([1]));
    const x = find(r.root, 'x');
    const [a, b] = await Promise.all([expandRef(r, x.id), expandRef(r, x.id)]);
    expect(a[0]).toBe(b[0]);
    expect(x.children).toHaveLength(1);
  });

  it('lookup spends a budget carried by the environment in place (shared across evaluations)', () => {
    const list = {
      isObj: true as const,
      get: () => undefined,
      lookup: (_m: string, _v: unknown, budget: { left: number }) => {
        budget.left -= 3;
        return null;
      },
    };
    const shared = { resolve: (n: string) => (n === 'l' ? list : undefined), scan: { left: 5 } };
    expect(evaluate('lookup(l, "x", 1)', shared)).toEqual({ ok: true, value: null });
    expect(shared.scan.left).toBe(2);
  });
});
