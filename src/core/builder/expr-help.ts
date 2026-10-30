/** Helpers for the builder's expression inputs: parse feedback and the names worth suggesting at a given field. */
import { DEFAULT_SPEC_LIMITS, parseExpr } from '../engine';
import { findType, type BuilderModel } from './model';

export type ExprFeedback = { ok: true } | { ok: false; error: string };

/** Parse feedback using the same limits as the validator. Empty text is "ok" (the key is simply unset). */
export function exprFeedback(src: string): ExprFeedback {
  if (src.trim() === '') return { ok: true };
  const r = parseExpr(src, { maxLength: DEFAULT_SPEC_LIMITS.maxExprLength, maxDepth: DEFAULT_SPEC_LIMITS.maxExprDepth });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** Context names every expression may use. `_` (the field's own value) only in `assert` and `repeat.until`. */
export const CONTEXT_NAMES = ['_io.size', '_parent', '_root', '_index', '_start', 'lookup'] as const;

/**
 * Suggestions for an expression of field `index` in `typeName`: the EARLIER fields of that type (later ones are not
 * parsed yet, so they read as null), then the context names.
 */
export function exprSuggestions(model: BuilderModel, typeName: string, index: number, opts: { withValue?: boolean } = {}): string[] {
  const t = findType(model, typeName);
  const earlier = t ? t.fields.slice(0, Math.max(0, index)).map((f) => f.name) : [];
  return [...earlier, ...(opts.withValue ? ['_'] : []), ...CONTEXT_NAMES];
}

/** Text of an ExprSource for an input box. */
export function exprToText(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

/** Text from an input box back to an ExprSource: digits become a number, anything else stays an expression, '' unsets. */
export function textToExpr(text: string): number | string | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  if (/^\d{1,15}$/.test(t)) return Number(t);
  return t;
}
