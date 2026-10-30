import { MemoryByteSource } from '../byte-source';
import type { Node } from './interpret';
import type { FormatSpec } from './schema';
import { validateSpec, formatIssues } from './validate';

export function mem(bytes: ArrayLike<number>): MemoryByteSource {
  return new MemoryByteSource(Uint8Array.from(bytes));
}

/** Build and validate a small spec; throws with readable issues if the test spec itself is invalid. */
export function mkSpec(types: Record<string, unknown>, extra: Record<string, unknown> = {}): FormatSpec {
  const raw = { schemaVersion: 1, id: 't', name: 'T', endian: 'le', root: 'root', types, ...extra };
  const r = validateSpec(raw);
  if (!r.ok) throw new Error('test spec invalid:\n' + formatIssues(r.errors));
  return r.spec;
}

/** Like mkSpec but skips validation (for exercising interpreter defences against hostile specs). */
export function rawSpec(types: Record<string, unknown>, extra: Record<string, unknown> = {}): FormatSpec {
  return { schemaVersion: 1, id: 't', name: 'T', endian: 'le', root: 'root', types, ...extra } as unknown as FormatSpec;
}

/** Find a node by a path like "a.b[2].c" (array elements are named "name[i]" so "[2]" is part of the name). */
export function find(root: Node, path: string): Node {
  let cur = root;
  for (const part of path.split('.')) {
    const next = cur.children?.find((c) => c.name === part);
    if (!next) throw new Error(`no node "${part}" under "${cur.name}" (children: ${(cur.children ?? []).map((c) => c.name).join(', ')})`);
    cur = next;
  }
  return cur;
}

export function le32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
export function le16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
