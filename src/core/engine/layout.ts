/** Static (spec-only) size analysis, shared by the interpreter (lazy arrays) and the docs generator. */
import { parseExpr } from './expr';
import type { ExprSource, FieldDef, FormatSpec } from './schema';
import { ownGet, primitiveInfo } from './schema';

/** A non-negative safe integer if `src` is a plain literal, else null. */
export function constInt(src: ExprSource | undefined): number | null {
  if (src === undefined) return null;
  if (typeof src === 'number') return Number.isSafeInteger(src) && src >= 0 ? src : null;
  const p = parseExpr(src);
  if (p.ok && p.ast.k === 'int' && p.ast.v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(p.ast.v);
  return null;
}

const memos = new WeakMap<FormatSpec, Map<string, number | null>>();

/**
 * Size in bytes of ONE element described by this field, ignoring its own `at`/`if`/`repeat`.
 * Null when it depends on data (switch, expression size, str/bytes without literal size, ...).
 */
export function staticElemSize(spec: FormatSpec, f: FieldDef): number | null {
  if (typeof f.type !== 'string') return null;
  if (f.size !== undefined) return f.size === 'eos' ? null : constInt(f.size);
  const prim = primitiveInfo(f.type);
  if (prim) return prim.size;
  if (f.type === 'str' || f.type === 'bytes') return null;
  return staticTypeSize(spec, f.type);
}

/** Bytes a field advances its parent cursor by (0 for `at`), or null when not statically known. */
export function staticAdvance(spec: FormatSpec, f: FieldDef): number | null {
  if (f.if !== undefined) return null;
  if (f.at !== undefined) return 0;
  const e = staticElemSize(spec, f);
  if (e === null) return null;
  if (f.repeat === undefined) return e;
  if (typeof f.repeat === 'object' && 'count' in f.repeat) {
    const n = constInt(f.repeat.count);
    if (n !== null && Number.isSafeInteger(n * e)) return n * e;
  }
  return null;
}

/** Sequential extent of a user type, or null when it varies. */
export function staticTypeSize(spec: FormatSpec, typeName: string, visiting: Set<string> = new Set()): number | null {
  let memo = memos.get(spec);
  if (!memo) memos.set(spec, (memo = new Map()));
  if (memo.has(typeName)) return memo.get(typeName)!;
  if (visiting.has(typeName)) return null;
  const def = ownGet(spec.types, typeName);
  if (!def) return null;
  visiting.add(typeName);
  let total: number | null = 0;
  for (const f of def.fields) {
    // staticElemSize recurses through staticTypeSize; pass the visiting set via a local walk.
    let adv: number | null;
    if (f.if !== undefined) adv = null;
    else if (f.at !== undefined) adv = 0;
    else {
      const e: number | null =
        typeof f.type === 'string' && f.size === undefined && primitiveInfo(f.type) === null && f.type !== 'str' && f.type !== 'bytes'
          ? staticTypeSize(spec, f.type, visiting)
          : staticElemSize(spec, f);
      if (e === null) adv = null;
      else if (f.repeat === undefined) adv = e;
      else if (typeof f.repeat === 'object' && 'count' in f.repeat) {
        const n = constInt(f.repeat.count);
        adv = n !== null && Number.isSafeInteger(n * e) ? n * e : null;
      } else adv = null;
    }
    if (adv === null) {
      total = null;
      break;
    }
    total += adv;
    if (!Number.isSafeInteger(total)) {
      total = null;
      break;
    }
  }
  visiting.delete(typeName);
  // Only memoise definitive answers computed from the outermost call (cycle-truncated nulls are not final).
  if (visiting.size === 0) memo.set(typeName, total);
  return total;
}
