import { describe, expect, it } from 'vitest';
import type { Node } from './engine';
import { linkByteRange, linkLabel, resolveNodePath } from './tree-model';

let id = 1;
const n = (name: string, offset: number, size: number, extra: Partial<Node> = {}): Node => ({ id: id++, name, typeName: 'u1', offset, size, ...extra });

describe('link helpers', () => {
  it('linkByteRange is inclusive, null for caret-only, absent or nonsensical links', () => {
    expect(linkByteRange(n('a', 0, 1, { link: { offset: 10, size: 4 } }))).toEqual({ start: 10, end: 13 });
    expect(linkByteRange(n('a', 0, 1, { link: { offset: 10, size: 0 } }))).toBeNull();
    expect(linkByteRange(n('a', 0, 1))).toBeNull();
    expect(linkByteRange(n('a', 0, 1, { link: { offset: -1, size: 2 } }))).toBeNull();
    expect(linkByteRange(n('a', 0, 1, { link: { offset: 1.5, size: 2 } }))).toBeNull();
  });

  it('linkLabel is "→ label" (sanitised and shortened) or "→ 0xOFFSET"', () => {
    expect(linkLabel(n('a', 0, 1, { link: { offset: 255, size: 1 } }))).toBe('→ 0xFF');
    expect(linkLabel(n('a', 0, 1, { link: { offset: 255, size: 1, label: 'data' } }))).toBe('→ data');
    expect(linkLabel(n('a', 0, 1, { link: { offset: 255, size: 1, label: '  ' } }))).toBe('→ 0xFF');
    expect(linkLabel(n('a', 0, 1, { link: { offset: 1, size: 1, label: 'a‮b' } }))).toBe('→ a\\u{202E}b');
    expect(linkLabel(n('a', 0, 1, { link: { offset: 1, size: 1, label: 'x'.repeat(100) } })).length).toBeLessThanOrEqual(2 + 41);
    expect(linkLabel(n('a', 0, 1))).toBe('');
  });
});

describe('resolveNodePath', () => {
  const data = n('data', 12, 4);
  const extra = n('extra', 8, 4, { children: [n('blocks', 8, 4)] });
  const target = n('local_entry', 0, 16, { children: [n('header', 0, 12, { children: [extra] }), data] });

  it('follows child names and returns the chain after the start', () => {
    expect(resolveNodePath(target, 'data')).toEqual([data]);
    expect(resolveNodePath(target, 'header.extra.blocks')?.map((x) => x.name)).toEqual(['header', 'extra', 'blocks']);
  });

  it('is null for missing steps, empty segments and bits children; never follows prototype names', () => {
    expect(resolveNodePath(target, 'descriptor')).toBeNull();
    expect(resolveNodePath(target, 'header.nope')).toBeNull();
    expect(resolveNodePath(target, '')).toBeNull();
    expect(resolveNodePath(target, 'data.x')).toBeNull();
    expect(resolveNodePath(target, '__proto__')).toBeNull();
    const withBits = n('f', 0, 2, { children: [n('flag', 0, 2, { typeName: 'bits' })] });
    expect(resolveNodePath(withBits, 'flag')).toBeNull();
  });
});
