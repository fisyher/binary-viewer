/**
 * Live checks for spec JSON being edited: separates JSON syntax errors (with line and column) from schema
 * validation issues (with JSON paths). Pure; used by the JSON editor for feedback only. The authoritative
 * validation happens in the library and again in the worker.
 */
import { validateSpec, type SpecIssue } from './engine';
import { MAX_SPEC_FILE_BYTES, exceedsBytes, hasLoneSurrogate, isUserId } from './spec-folder';

export interface SyntaxIssue {
  message: string;
  /** 1-based. */
  line: number;
  column: number;
}

export interface TextCheck {
  syntax: SyntaxIssue | null;
  issues: SpecIssue[];
  /** No syntax error and no issues. */
  valid: boolean;
}

/** 1-based line and column of a character offset (clamped into the text). */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const end = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastBreak = i;
    }
  }
  return { line, column: end - lastBreak };
}

/**
 * Offset of the first JSON syntax error, found by a small scanner. Used when the engine's own message carries no
 * position (Safari, newer V8). Returns text.length for an unterminated document. Depth-limited, never throws.
 */
export function scanJsonError(text: string): number {
  let i = 0;
  const n = text.length;
  const ws = () => {
    while (i < n && [32, 9, 10, 13].includes(text.charCodeAt(i))) i++;
  };
  const fail = (at = i): never => {
    throw at;
  };
  const lit = (word: string) => {
    for (let k = 0; k < word.length; k++) if (text[i + k] !== word[k]) fail(Math.min(i + k, n));
    i += word.length;
  };
  const str = () => {
    i++; // opening quote
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) return void i++;
      if (c < 32) fail();
      if (c === 92) {
        const e = text[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail(Math.min(i + 2, n));
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else fail(Math.min(i + 1, n));
      } else i++;
    }
    fail(n);
  };
  const num = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) fail();
    i += m![0].length;
  };
  const value = (depth: number): void => {
    if (depth > 400) fail();
    ws();
    if (i >= n) fail(n);
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') return void i++;
      for (;;) {
        ws();
        if (i >= n) fail(n);
        if (text[i] !== '"') fail();
        str();
        ws();
        if (i >= n) fail(n);
        if (text[i] !== ':') fail();
        i++;
        value(depth + 1);
        ws();
        if (i >= n) fail(n);
        if (text[i] === ',') i++;
        else if (text[i] === '}') return void i++;
        else fail();
      }
    } else if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') return void i++;
      for (;;) {
        value(depth + 1);
        ws();
        if (i >= n) fail(n);
        if (text[i] === ',') i++;
        else if (text[i] === ']') return void i++;
        else fail();
      }
    } else if (c === '"') str();
    else if (c === 't') lit('true');
    else if (c === 'f') lit('false');
    else if (c === 'n') lit('null');
    else num();
  };
  try {
    value(0);
    ws();
    if (i < n) fail();
    return n;
  } catch (at) {
    return typeof at === 'number' ? at : 0;
  }
}

/** Best-effort location of a `JSON.parse` failure; engines word their messages differently. */
export function jsonErrorLocation(text: string, message: string): { line: number; column: number } {
  const lc = /line (\d+) column (\d+)/i.exec(message);
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) };
  const pos = /position (\d+)/i.exec(message);
  if (pos) return lineColumn(text, Number(pos[1]));
  if (/end of (json )?(input|data)|unexpected end/i.test(message)) return lineColumn(text, text.length);
  return lineColumn(text, scanJsonError(text));
}

export function checkSpecText(text: string): TextCheck {
  if (exceedsBytes(text)) {
    return { syntax: null, issues: [{ path: '$', message: `spec too large (limit ${MAX_SPEC_FILE_BYTES} bytes)` }], valid: false };
  }
  if (hasLoneSurrogate(text)) {
    return { syntax: null, issues: [{ path: '$', message: 'the text contains an unpaired surrogate character (invalid Unicode); remove it' }], valid: false };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { syntax: { message, ...jsonErrorLocation(text, message) }, issues: [], valid: false };
  }
  const r = validateSpec(json);
  const issues: SpecIssue[] = r.ok ? [] : [...r.errors];
  if (r.ok && !isUserId(r.spec.id)) {
    issues.push({ path: '$.id', message: 'user format ids must be lower-case letters, digits, "_" or "-" (1-64 characters) and not a reserved device name' });
  }
  return { syntax: null, issues, valid: issues.length === 0 };
}

/** End offset (exclusive) of the JSON string token starting at `p`, or -1. */
function skipString(text: string, p: number): number {
  for (let j = p + 1; j < text.length; j++) {
    const c = text.charCodeAt(j);
    if (c === 92) j++;
    else if (c === 34) return j + 1;
  }
  return -1;
}

/** End offset (exclusive) of the JSON value starting at `p` (iterative, string-aware), or -1. */
function skipValue(text: string, p: number): number {
  const c = text[p];
  if (c === '"') return skipString(text, p);
  if (c === '{' || c === '[') {
    let depth = 0;
    for (let j = p; j < text.length; ) {
      const ch = text[j];
      if (ch === '"') {
        j = skipString(text, j);
        if (j < 0) return -1;
        continue;
      }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
      j++;
      if (depth === 0) return j;
    }
    return -1;
  }
  let j = p;
  while (j < text.length && !',}] \t\r\n'.includes(text[j]!)) j++;
  return j > p ? j : -1;
}

/**
 * Source ranges of the string VALUES of the top-level keys of a JSON object (the last occurrence of a duplicate
 * key wins, like JSON.parse). Used to rewrite `id` / `name` while keeping every other byte of the text. Null when the
 * text is not a well-formed object (callers fall back to re-serialising).
 */
export function topLevelStringRanges(text: string): Map<string, { start: number; end: number }> | null {
  let i = 0;
  const n = text.length;
  const ws = () => {
    while (i < n && [32, 9, 10, 13].includes(text.charCodeAt(i))) i++;
  };
  ws();
  if (text[i] !== '{') return null;
  i++;
  const out = new Map<string, { start: number; end: number }>();
  ws();
  if (text[i] === '}') return out;
  for (;;) {
    ws();
    if (text[i] !== '"') return null;
    const ks = i;
    i = skipString(text, ks);
    if (i < 0) return null;
    let key: string;
    try {
      key = JSON.parse(text.slice(ks, i)) as string;
    } catch {
      return null;
    }
    ws();
    if (text[i] !== ':') return null;
    i++;
    ws();
    const vs = i;
    i = skipValue(text, vs);
    if (i < 0) return null;
    if (text[vs] === '"') out.set(key, { start: vs, end: i });
    else out.delete(key);
    ws();
    if (text[i] === ',') {
      i++;
      continue;
    }
    return text[i] === '}' ? out : null;
  }
}

/**
 * Replace the top-level string values `id` (and optionally `name`, via `rename`) textually, leaving all other bytes
 * (formatting, key order, comments-free whitespace) untouched. Null when that is not possible.
 */
export function rewriteTopLevelStrings(text: string, id: string, rename?: (oldName: string) => string): string | null {
  const ranges = topLevelStringRanges(text);
  const idr = ranges?.get('id');
  if (!ranges || !idr) return null;
  const edits: { start: number; end: number; value: string }[] = [{ ...idr, value: JSON.stringify(id) }];
  const nr = ranges.get('name');
  if (rename && nr) {
    try {
      edits.push({ ...nr, value: JSON.stringify(rename(JSON.parse(text.slice(nr.start, nr.end)) as string)) });
    } catch {
      return null;
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.value + out.slice(e.end);
  return out;
}
