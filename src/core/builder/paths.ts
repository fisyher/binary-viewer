/**
 * Map validation issue paths (`$.types.file.fields[2].size.cases.1`) to builder locations, so the UI can highlight
 * the offending meta key, type, field, enum or detect rule. Field and detect locations are index based.
 */
import type { SpecIssue } from '../engine';

export type IssueLoc =
  | { kind: 'meta'; key: string }
  | { kind: 'detect'; index: number; key: string }
  | { kind: 'type'; type: string; key: string }
  | { kind: 'field'; type: string; index: number; key: string; rest: string }
  | { kind: 'enum'; name: string; entry: string };

export interface LocatedIssue {
  loc: IssueLoc;
  issue: SpecIssue;
}

/** `key` of a field location is the first path segment below the field (`size`, `type`, `repeat`, `assert`, `name`, ...); '' = the field itself. */
export function locateIssue(path: string): IssueLoc {
  const p = path === '$' ? '' : path.startsWith('$.') ? path.slice(2) : path;
  let m = /^types\.([^.[]+)(.*)$/.exec(p);
  if (m) {
    const type = m[1]!;
    const rest = m[2]!;
    const f = /^\.fields\[(\d+)\](?:\.([^.[]+))?(.*)$/.exec(rest);
    if (f) return { kind: 'field', type, index: Number(f[1]), key: f[2] ?? '', rest: f[3] ?? '' };
    return { kind: 'type', type, key: /^\.([^.[]+)/.exec(rest)?.[1] ?? '' };
  }
  m = /^enums\.([^.]+)(?:\.(.*))?$/.exec(p);
  if (m) return { kind: 'enum', name: m[1]!, entry: m[2] ?? '' };
  m = /^detect\[(\d+)\](?:\.([^.[]+))?/.exec(p);
  if (m) return { kind: 'detect', index: Number(m[1]), key: m[2] ?? '' };
  if (p.startsWith('extensions')) return { kind: 'meta', key: 'extensions' };
  return { kind: 'meta', key: /^[^.[]*/.exec(p)?.[0] ?? '' };
}

export function locateIssues(issues: readonly SpecIssue[]): LocatedIssue[] {
  return issues.map((issue) => ({ loc: locateIssue(issue.path), issue }));
}

/** Issues on a field (all keys), or on one key of it. */
export function fieldIssues(list: readonly LocatedIssue[], type: string, index: number, key?: string): LocatedIssue[] {
  return list.filter((x) => x.loc.kind === 'field' && x.loc.type === type && x.loc.index === index && (key === undefined || x.loc.key === key));
}

/** Issues anywhere in a type, including its fields. */
export function typeIssues(list: readonly LocatedIssue[], type: string): LocatedIssue[] {
  return list.filter((x) => (x.loc.kind === 'type' || x.loc.kind === 'field') && x.loc.type === type);
}

export const metaIssues = (list: readonly LocatedIssue[], key: string): LocatedIssue[] => list.filter((x) => x.loc.kind === 'meta' && x.loc.key === key);
export const detectIssues = (list: readonly LocatedIssue[], index: number): LocatedIssue[] => list.filter((x) => x.loc.kind === 'detect' && x.loc.index === index);
export const enumIssues = (list: readonly LocatedIssue[], name: string): LocatedIssue[] => list.filter((x) => x.loc.kind === 'enum' && x.loc.name === name);
