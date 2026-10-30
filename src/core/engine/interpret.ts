/**
 * Spec interpreter. Walks a validated FormatSpec over a ByteSource and produces a Node tree.
 *
 * Contract (see also docs/DESIGN.md "Format engine"):
 * - `parse` never throws for bad input or bad data: failures become `Node.error` + `Diagnostic`s.
 * - Reads are exact-size and small: ints/floats read their own width, `bytes` read at most a preview,
 *   `str` reads at most `maxStringBytes`. Nothing reads the whole file.
 * - A field that fails (truncated read, bad expression) stops its enclosing struct, because the cursor can no
 *   longer be trusted; `at` fields do not advance the cursor, so they never stop the struct. Declared
 *   sizes/counts that exceed what remains are clamped, recorded as errors, and parsing continues.
 * - `_io.start/_io.end/_io.size/_io.pos` describe the current substream; `_io.pos` and `at` are absolute.
 * - Once a sequential field has failed, the rest of the struct's sequential fields are skipped, but later fields
 *   that carry `at` are still parsed (their position does not depend on the lost cursor).
 * - A failing `if` expression gives an error node but does not stop the struct (the cursor is unaffected).
 * - Fields skipped by `if` (or failed) are `null` in expressions; see expr.ts.
 * - `assert` expressions run after their field; `_io.pos` there is the parent cursor after the field (for `at`
 *   fields: the unchanged parent cursor). They add validation messages and never stop parsing.
 * - Variable-size arrays: after `eagerElements` kept elements the rest is "skimmed" (parsed, not retained, charged
 *   to `maxSkimNodes` instead of `maxNodes`, no lazies registered) to find where the array ends. If the skim
 *   budget runs out the array gets an error ("incomplete"), its struct stops sequential parsing cleanly (earlier
 *   siblings and `at` fields are kept) and the continuation count is unknown. A step/node/abort Halt during a skim
 *   ends the whole parse with a partial tree and no continuation for that array.
 * - Elements are attached to their array only once fully parsed, so a Halt never leaves a half-built element.
 */
import type { ByteSource } from '../byte-source';
import { MAX_READ } from '../byte-source';
import { hexBytes, readUint, viewOf } from '../inspector/bytes';
import type { EvalEnv, Expr, ObjValue, Value } from './expr';
import { ExprError, DEFAULT_EXPR_LIMITS, evalExpr, parseExpr, toBigInt, toNonNegativeInt, valuesEqual, describeValue } from './expr';
import { staticElemSize } from './layout';
import type { Encoding, FieldDef, FormatSpec } from './schema';
import { ownGet, parseEnumKey, primitiveInfo } from './schema';
import type { PrimitiveInfo } from './schema';

// ------------------------------------------------------------------ public types

export type NodeValue = number | bigint | string | Uint8Array;

export interface LazyArray {
  /** Absolute offset of element 0. */
  start: number;
  /** Total element count, or null when not yet known (variable-size `until`/`eos` arrays placed with `at`). */
  count: number | null;
  elemType: string;
  /** Fixed element size: element i is at `start + i * elemSize`. Null for variable-size elements. */
  elemSize: number | null;
  /** Elements already present in `children` (always 0 for fixed-size lazy arrays). */
  loaded: number;
  /** Variable-size only: file offset where parsing resumes (null once the end was reached). */
  resumeOffset: number | null;
}

export interface Node {
  id: number;
  name: string;
  typeName: string;
  offset: number;
  size: number;
  value?: NodeValue;
  display?: string;
  enumName?: string;
  enumLabel?: string;
  children?: Node[];
  lazy?: LazyArray;
  /** Structural problem (truncation, bad expression, limit, ...). */
  error?: string;
  /** `expect` mismatches; parsing continued. */
  validation?: string[];
  doc?: string;
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  code: 'read' | 'expr' | 'bounds' | 'validation' | 'cycle' | 'limit' | 'aborted' | 'array' | 'spec' | 'lazy' | 'internal' | 'parse';
  message: string;
  path?: string;
  offset?: number;
  nodeId?: number;
}

export interface ParseStats {
  nodes: number;
  steps: number;
  reads: number;
  bytesRead: number;
  /** A limit stopped parsing early (partial tree). */
  truncated: boolean;
  aborted: boolean;
  /** Diagnostics dropped after `maxDiagnostics`. */
  suppressedDiagnostics: number;
}

export interface ParseResult {
  root: Node;
  errors: Diagnostic[];
  stats: ParseStats;
}

export interface Limits {
  /** Max user-type nesting depth. */
  maxDepth: number;
  /** Max nodes kept in the tree (per parse / per expandLazy call). */
  maxNodes: number;
  /** Max bytes returned by the source per parse / per expandLazy call (total I/O budget). */
  maxBytesRead: number;
  /** Max source.read calls per parse / per expandLazy call. */
  maxReads: number;
  /** Max nodes created while skimming (not retained) per parse / per expandLazy call. */
  maxSkimNodes: number;
  /** Max interpreter steps (fields + array elements + expansions). */
  maxSteps: number;
  /** Elements of a repeat kept eagerly; the rest become lazy. Also the threshold for fixed-size lazy arrays. */
  eagerElements: number;
  /** `bytes` fields up to this size are read fully; larger ones only record a preview. */
  fullBytesMax: number;
  previewBytes: number;
  maxStringBytes: number;
  /** Max bytes scanned looking for a string terminator. */
  maxStringScan: number;
  /** Max elements returned by one expandLazy call. */
  maxLazyRange: number;
  maxDiagnostics: number;
  exprMaxLength: number;
  exprMaxDepth: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxDepth: 64,
  maxNodes: 100_000,
  maxBytesRead: 256 * 1024 * 1024,
  maxReads: 1_000_000,
  maxSkimNodes: 1_000_000,
  maxSteps: 2_000_000,
  eagerElements: 1000,
  fullBytesMax: 64,
  previewBytes: 16,
  maxStringBytes: 4096,
  maxStringScan: 1 << 20,
  maxLazyRange: 10_000,
  maxDiagnostics: 1000,
  exprMaxLength: DEFAULT_EXPR_LIMITS.maxLength,
  exprMaxDepth: DEFAULT_EXPR_LIMITS.maxDepth,
};

export interface ParseOptions {
  limits?: Partial<Limits>;
  signal?: AbortSignal;
}

// ------------------------------------------------------------------ internals

class Halt extends Error {
  constructor(
    readonly code: 'limit' | 'aborted',
    message: string,
  ) {
    super(message);
  }
}

/** Thrown when the skim budget runs out; handled by the array being skimmed (not a Halt). */
class SkimOverflow extends Error {}

class FieldError extends Error {
  constructor(
    message: string,
    readonly code: Diagnostic['code'] = 'parse',
  ) {
    super(message);
  }
}

interface Range {
  start: number;
  end: number;
}

class Scope implements ObjValue {
  readonly isObj = true as const;
  readonly fields = new Map<string, Value>();
  readonly root: Scope;
  constructor(
    readonly parent: Scope | null,
    readonly index?: number,
  ) {
    this.root = parent ? parent.root : this;
  }
  get(name: string): Value | undefined {
    return this.fields.get(name);
  }
}

class ListObj implements ObjValue {
  readonly isObj = true as const;
  constructor(private readonly len: number | null) {}
  get(name: string): Value | undefined {
    return name === 'length' && this.len !== null ? BigInt(this.len) : undefined;
  }
}

interface Place {
  stream: Range;
  scope: Scope;
  depth: number;
  path: string;
}

interface Parsed {
  node: Node;
  /** Cursor after this value (offset + consumed). */
  end: number;
  ok: boolean;
  val?: Value;
}

interface ArrayState {
  field: FieldDef;
  pl: Place;
  node: Node;
  kind: 'count' | 'until' | 'eos';
  target: number;
  elemType: string;
  elemFixed: number | null;
  start: number;
  nextIndex: number;
  pos: number;
  done: boolean;
  ok: boolean;
  /** Where skimmed (not retained) elements begin: resume point for expandLazy. */
  boundary: { index: number; pos: number } | null;
}

interface LazyEntry {
  node: Node;
  field: FieldDef;
  pl: Place;
  /** Fixed-size lazy arrays. */
  elemSize: number | null;
  count: number | null;
  /** Variable-size resume state. */
  rs: ArrayState | null;
  lock: Promise<void>;
}

interface Shared {
  spec: FormatSpec;
  source: ByteSource;
  limits: Limits;
  nextId: number;
  exprCache: Map<string, Expr>;
  enumMaps: Map<string, Map<bigint, string>>;
  lazies: Map<number, LazyEntry>;
  result: ParseResult | null;
}

interface Run {
  shared: Shared;
  limits: Limits;
  spec: FormatSpec;
  source: ByteSource;
  signal?: AbortSignal;
  stats: ParseStats;
  diags: Diagnostic[];
  active: Set<string>;
  skim: number;
  skimNodes: number;
}

const internals = new WeakMap<ParseResult, Shared>();
const YIELD_EVERY = 5000;

function makeRun(shared: Shared, signal?: AbortSignal): Run {
  return {
    shared,
    limits: shared.limits,
    spec: shared.spec,
    source: shared.source,
    signal,
    stats: { nodes: 0, steps: 0, reads: 0, bytesRead: 0, truncated: false, aborted: false, suppressedDiagnostics: 0 },
    diags: [],
    active: new Set(),
    skim: 0,
    skimNodes: 0,
  };
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Convert a thrown value into a field-level failure; Halt propagates. */
function classify(e: unknown): { code: Diagnostic['code']; message: string } {
  if (e instanceof Halt || e instanceof SkimOverflow) throw e;
  if (e instanceof FieldError) return { code: e.code, message: e.message };
  if (e instanceof ExprError) return { code: 'expr', message: e.message };
  return { code: 'internal', message: errMessage(e) };
}

function addDiag(run: Run, d: Diagnostic, force = false): void {
  // Skimmed elements are discarded and re-parsed on expansion; their diagnostics would dangle and repeat.
  if (!force && run.skim > 0) return;
  if (!force && run.diags.length >= run.limits.maxDiagnostics) {
    run.stats.suppressedDiagnostics++;
    return;
  }
  run.diags.push(d);
}

function setError(run: Run, node: Node, path: string, code: Diagnostic['code'], message: string, severity: Diagnostic['severity'] = 'error'): void {
  if (severity === 'warning') (node.validation ??= []).push(message);
  else if (node.error === undefined) node.error = message;
  addDiag(run, { severity, code, message, path, offset: node.offset, nodeId: node.id });
}

function newNode(run: Run, attach: Node | null, name: string, typeName: string, offset: number, size: number): Node {
  if (run.skim === 0) {
    if (run.stats.nodes >= run.limits.maxNodes) throw new Halt('limit', `node limit reached (${run.limits.maxNodes}); the tree is partial`);
    run.stats.nodes++;
  } else if (++run.skimNodes > run.limits.maxSkimNodes) {
    throw new SkimOverflow(`skim budget exhausted (${run.limits.maxSkimNodes} nodes)`);
  }
  const node: Node = { id: run.shared.nextId++, name, typeName, offset, size };
  if (attach) (attach.children ??= []).push(node);
  return node;
}

function errorNode(run: Run, attach: Node, name: string, typeName: string, offset: number, path: string, code: Diagnostic['code'], message: string): Node {
  const n = newNode(run, attach, name, typeName, offset, 0);
  setError(run, n, path, code, message);
  return n;
}

async function tick(run: Run): Promise<void> {
  if (run.signal?.aborted) throw new Halt('aborted', 'parse aborted');
  if (++run.stats.steps > run.limits.maxSteps) throw new Halt('limit', `step budget exhausted (${run.limits.maxSteps}); the tree is partial`);
  if (run.stats.steps % YIELD_EVERY === 0) {
    // Let the event loop run so an AbortSignal fired from a message/timer can be observed.
    await new Promise<void>((r) => setTimeout(r, 0));
    if (run.signal?.aborted) throw new Halt('aborted', 'parse aborted');
  }
}

function getExpr(shared: Shared, src: number | string): Expr {
  if (typeof src === 'number') {
    if (!Number.isSafeInteger(src)) throw new FieldError(`bad number ${src}`, 'spec');
    return { k: 'int', v: BigInt(src) };
  }
  let e = shared.exprCache.get(src);
  if (!e) {
    const r = parseExpr(src, { maxLength: shared.limits.exprMaxLength, maxDepth: shared.limits.exprMaxDepth });
    if (!r.ok) throw new FieldError(`bad expression "${src}": ${r.error}`, 'expr');
    e = r.ast;
    shared.exprCache.set(src, e);
  }
  return e;
}

interface Io {
  start: number;
  end: number;
  pos: number;
  /** The parent cursor is stale (an earlier sequential field failed): `_io.pos` / `_io.eof` are errors. */
  unknownPos?: boolean;
}

function makeEnv(scope: Scope, io: Io, current?: Value, index?: number): EvalEnv {
  const ioObj: ObjValue = {
    isObj: true,
    get(n: string): Value | undefined {
      switch (n) {
        case 'size':
          return BigInt(io.end - io.start);
        case 'pos':
          if (io.unknownPos) throw new ExprError('position unknown after earlier failure');
          return BigInt(io.pos);
        case 'start':
          return BigInt(io.start);
        case 'end':
          return BigInt(io.end);
        case 'eof':
          if (io.unknownPos) throw new ExprError('position unknown after earlier failure');
          return io.pos >= io.end;
        default:
          return undefined;
      }
    },
  };
  return {
    resolve(name: string): Value | undefined {
      switch (name) {
        case '_io':
          return ioObj;
        case '_parent':
          return scope.parent ?? undefined;
        case '_root':
          return scope.root;
        case '_index': {
          const i = index ?? scope.index;
          return i === undefined ? undefined : BigInt(i);
        }
        case '_':
          return current;
        default:
          return scope.fields.get(name);
      }
    },
  };
}

function ev(run: Run, src: number | string, env: EvalEnv): Value {
  return evalExpr(getExpr(run.shared, src), env);
}

async function readAt(run: Run, offset: number, length: number): Promise<Uint8Array> {
  if (length > MAX_READ) throw new FieldError(`read of ${length} bytes exceeds the per-read cap`, 'read');
  if (length === 0) return new Uint8Array(0);
  if (run.signal?.aborted) throw new Halt('aborted', 'parse aborted');
  if (run.stats.reads >= run.limits.maxReads) throw new Halt('limit', `read budget exhausted (${run.limits.maxReads} reads); the tree is partial`);
  if (run.stats.bytesRead + length > run.limits.maxBytesRead) throw new Halt('limit', `I/O budget exhausted (${run.limits.maxBytesRead} bytes); the tree is partial`);
  let data: Uint8Array;
  try {
    data = await run.source.read(offset, length);
  } catch (e) {
    throw new FieldError(`read failed at offset ${offset}: ${errMessage(e)}`, 'read');
  }
  run.stats.reads++;
  run.stats.bytesRead += data.length;
  if (data.length !== length) throw new FieldError(`short read at offset ${offset}: wanted ${length} bytes, got ${data.length}`, 'read');
  return data;
}

function endianFlag(prim: PrimitiveInfo, specEndian: FormatSpec['endian']): boolean {
  if (prim.size === 1) return true; // irrelevant for one byte
  const e = prim.endian ?? specEndian;
  if (e === 'le') return true;
  if (e === 'be') return false;
  throw new FieldError('multi-byte type without byte order and no spec "endian"', 'spec');
}

function formatInt(v: bigint, signed: boolean): string {
  const dec = v.toString();
  if (signed || v < 10n) return dec;
  return `${dec} (0x${v.toString(16).toUpperCase()})`;
}

function enumMap(shared: Shared, name: string): Map<bigint, string> {
  let m = shared.enumMaps.get(name);
  if (!m) {
    m = new Map();
    const def = ownGet(shared.spec.enums, name);
    if (def) {
      for (const [k, label] of Object.entries(def)) {
        const key = parseEnumKey(k);
        if (key !== null) m.set(key, label);
      }
    }
    shared.enumMaps.set(name, m);
  }
  return m;
}

// ------------------------------------------------------------------ string decoding (lossy, never throws)

function decodeString(bytes: Uint8Array, enc: Encoding): string {
  switch (enc) {
    case 'ascii': {
      let s = '';
      for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : '�';
      return s;
    }
    case 'latin1': {
      let s = '';
      for (const b of bytes) s += String.fromCharCode(b);
      return s;
    }
    case 'utf8':
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    default: {
      const le = enc === 'utf16le';
      let s = '';
      let i = 0;
      for (; i + 1 < bytes.length; i += 2) {
        const lo = bytes[le ? i : i + 1]!;
        const hi = bytes[le ? i + 1 : i]!;
        s += String.fromCharCode((hi << 8) | lo);
      }
      if (i < bytes.length) s += '�';
      return s;
    }
  }
}

async function scanTerminated(run: Run, pos: number, end: number, unit: 1 | 2, term: number, le: boolean): Promise<{ content: Uint8Array; consumed: number }> {
  const cap = Math.min(end - pos, run.limits.maxStringScan);
  const keepMax = run.limits.maxStringBytes;
  const pieces: Uint8Array[] = [];
  let kept = 0;
  let offset = 0;
  const keep = (b: Uint8Array): void => {
    if (kept >= keepMax) return;
    const part = b.subarray(0, Math.min(b.length, keepMax - kept));
    pieces.push(part);
    kept += part.length;
  };
  while (offset < cap) {
    if (run.signal?.aborted) throw new Halt('aborted', 'parse aborted');
    const buf = await readAt(run, pos + offset, Math.min(256, cap - offset));
    for (let i = 0; i + unit <= buf.length; i += unit) {
      const u = unit === 1 ? buf[i]! : le ? buf[i]! | (buf[i + 1]! << 8) : (buf[i]! << 8) | buf[i + 1]!;
      if (u === term) {
        keep(buf.subarray(0, i));
        const content = new Uint8Array(kept);
        let o = 0;
        for (const p of pieces) {
          content.set(p, o);
          o += p.length;
        }
        return { content, consumed: offset + i + unit };
      }
    }
    keep(buf);
    offset += buf.length;
  }
  throw new FieldError(`string terminator ${term} not found within ${cap} bytes`, 'parse');
}

function previewString(s: string): string {
  return JSON.stringify(s.length > 64 ? s.slice(0, 64) + '…' : s);
}

// ------------------------------------------------------------------ interpreter

function typeLabel(f: FieldDef): string {
  return typeof f.type === 'string' ? f.type : 'switch';
}

function resolveTypeName(run: Run, f: FieldDef, env: EvalEnv): string {
  if (typeof f.type === 'string') return f.type;
  const sw = f.type;
  const v = ev(run, sw.switch, env);
  for (const [k, tn] of Object.entries(sw.cases)) {
    if (valuesEqual(v, ev(run, k, env))) return tn;
  }
  if (sw.default !== undefined) return sw.default;
  throw new FieldError(`no switch case matches ${describeValue(v)}`, 'parse');
}

async function parseStructBody(run: Run, node: Node, typeName: string, pl: Place, pos: number): Promise<{ end: number; ok: boolean }> {
  const def = ownGet(run.spec.types, typeName);
  if (!def) {
    setError(run, node, pl.path, 'spec', `unknown type "${typeName}"`);
    return { end: pos, ok: false };
  }
  if (pl.depth > run.limits.maxDepth) {
    setError(run, node, pl.path, 'limit', `maximum nesting depth ${run.limits.maxDepth} exceeded`);
    run.stats.truncated = true;
    return { end: pos, ok: false };
  }
  const key = `${typeName}@${pos}`;
  if (run.active.has(key)) {
    setError(run, node, pl.path, 'cycle', `cycle detected: type "${typeName}" re-entered at offset ${pos}`);
    return { end: pos, ok: false };
  }
  run.active.add(key);
  try {
    node.children ??= [];
    let cursor = pos;
    let ok = true;
    let lost = false; // a sequential field failed: only `at` fields are still meaningful
    for (const f of def.fields) {
      if (lost && f.at === undefined) {
        pl.scope.fields.set(f.name, null); // skipped after a failure: defined as null, never parsed
        continue;
      }
      await tick(run);
      const r = await parseField(run, f, node, pl, cursor, lost);
      if (!lost) cursor = r.end;
      node.size = Math.max(node.size, cursor - pos);
      if (!r.ok) {
        ok = false;
        if (f.at === undefined) lost = true;
      }
    }
    return { end: cursor, ok };
  } finally {
    run.active.delete(key);
  }
}

async function parseField(run: Run, f: FieldDef, parent: Node, pl: Place, cursor: number, lost = false): Promise<{ end: number; ok: boolean }> {
  const path = `${pl.path}.${f.name}`;
  let pos = cursor;
  const io0: Io = { start: pl.stream.start, end: pl.stream.end, pos: cursor, unknownPos: lost };
  if (f.if !== undefined) {
    try {
      const c = ev(run, f.if, makeEnv(pl.scope, io0));
      if (typeof c !== 'boolean') throw new FieldError(`"if" must evaluate to a boolean, got ${describeValue(c)}`, 'expr');
      if (!c) {
        pl.scope.fields.set(f.name, null); // skipped fields stay defined as null
        return { end: cursor, ok: true };
      }
    } catch (e) {
      const { code, message } = classify(e);
      errorNode(run, parent, f.name, typeLabel(f), pos, path, code, message);
      pl.scope.fields.set(f.name, null);
      return { end: cursor, ok: true }; // the cursor is unaffected, so the struct carries on
    }
  }
  try {
    if (f.at !== undefined) {
      const a = toNonNegativeInt(ev(run, f.at, makeEnv(pl.scope, io0)), '"at"');
      pos = a;
      if (a > run.source.size) throw new FieldError(`"at" ${a} is outside the file (size ${run.source.size})`, 'bounds');
      if (a < pl.stream.start || a > pl.stream.end) throw new FieldError(`"at" ${a} is outside the enclosing substream [${pl.stream.start}, ${pl.stream.end})`, 'bounds');
    }
    const r = f.repeat !== undefined ? await parseRepeat(run, f, parent, pl, pos) : await parseValue(run, f, f.name, parent, pl, pos, undefined);
    if (r.val !== undefined) pl.scope.fields.set(f.name, r.val);
    else if (!r.ok) pl.scope.fields.set(f.name, null);
    const end = f.at !== undefined ? cursor : r.end;
    if (f.assert && r.ok && r.val !== undefined) runAsserts(run, f, r.node, path, pl, end, r.val, lost);
    return { end, ok: r.ok };
  } catch (e) {
    const { code, message } = classify(e);
    errorNode(run, parent, f.name, typeLabel(f), pos, path, code, message);
    pl.scope.fields.set(f.name, null);
    return { end: cursor, ok: false };
  }
}

function runAsserts(run: Run, f: FieldDef, node: Node, path: string, pl: Place, pos: number, val: Value, lost = false): void {
  for (const a of f.assert ?? []) {
    try {
      const res = ev(run, a.expr, makeEnv(pl.scope, { start: pl.stream.start, end: pl.stream.end, pos, unknownPos: lost }, val));
      if (res === true) continue;
      const base = res === false ? (a.message ?? `assertion failed: ${a.expr}`) : `assertion "${a.expr}" did not evaluate to a boolean`;
      const level = a.level ?? 'error';
      (node.validation ??= []).push(base);
      addDiag(run, { severity: level, code: 'validation', message: `${path}: ${base}`, path, offset: node.offset, nodeId: node.id });
    } catch (e) {
      const { message } = classify(e);
      const msg = `assertion "${a.expr}" could not be evaluated: ${message}`;
      (node.validation ??= []).push(msg);
      addDiag(run, { severity: 'warning', code: 'expr', message: `${path}: ${msg}`, path, offset: node.offset, nodeId: node.id });
    }
  }
}

/** Parse one value (primitive / str / bytes / struct) of field `f` at `pos`. Throws FieldError/ExprError. */
async function parseValue(run: Run, f: FieldDef, name: string, attach: Node, pl: Place, pos: number, index: number | undefined): Promise<Parsed> {
  const stream = pl.stream;
  const io: Io = { start: stream.start, end: stream.end, pos };
  const env = makeEnv(pl.scope, io, undefined, index);
  const typeName = resolveTypeName(run, f, env);
  const path = `${pl.path}.${name}`;
  const avail = stream.end - pos;

  let size: number | null = null;
  let clampMsg: string | undefined;
  if (f.size !== undefined) {
    if (f.size === 'eos') size = avail;
    else {
      const declared = toNonNegativeInt(ev(run, f.size, env), '"size"');
      if (declared > avail) {
        clampMsg = `declared size ${declared} exceeds the ${avail} bytes left in the enclosing stream; clamped`;
        size = avail;
      } else size = declared;
    }
  }
  const finish = (node: Node, end: number, ok: boolean, val?: Value): Parsed => {
    if (clampMsg) setError(run, node, path, 'bounds', clampMsg);
    if (f.doc !== undefined) node.doc = f.doc;
    return { node, end, ok, val };
  };

  const prim = primitiveInfo(typeName);
  if (prim) {
    if (prim.size > avail) {
      const n = errorNode(run, attach, name, typeName, pos, path, 'read', `truncated: ${typeName} needs ${prim.size} bytes at offset ${pos} but only ${avail} remain in the stream`);
      return { node: n, end: pos, ok: false };
    }
    const le = endianFlag(prim, run.spec.endian);
    const bytes = await readAt(run, pos, prim.size);
    const node = newNode(run, attach, name, typeName, pos, prim.size);
    let val: Value;
    if (prim.kind === 'float') {
      const dv = viewOf(bytes);
      const x = prim.size === 4 ? dv.getFloat32(0, le) : dv.getFloat64(0, le);
      node.value = x;
      node.display = String(x);
      val = x;
      checkExpect(run, f, node, path, x, prim.size === 4);
    } else {
      const u = readUint(bytes, 0, prim.size, le)!;
      const big = prim.signed ? BigInt.asIntN(prim.size * 8, u) : u;
      node.value = prim.size === 8 ? big : Number(big);
      val = big;
      node.display = formatInt(big, prim.signed);
      if (f.enum !== undefined) {
        const label = enumMap(run.shared, f.enum).get(big);
        node.enumName = f.enum;
        if (label !== undefined) node.enumLabel = label;
        node.display = label !== undefined ? `${label} (${big})` : `${big} (unknown ${f.enum})`;
      }
      if (f.bits) {
        for (const b of f.bits) {
          const bv = (u >> BigInt(b.offset)) & ((1n << BigInt(b.width)) - 1n);
          const child = newNode(run, node, b.name, 'bits', pos, prim.size);
          child.value = b.width <= 32 ? Number(bv) : bv;
          child.display = `${bv} (bits ${b.offset}..${b.offset + b.width - 1})`;
          if (b.doc !== undefined) child.doc = b.doc;
        }
      }
      checkExpect(run, f, node, path, big);
    }
    return finish(node, pos + prim.size, true, val);
  }

  if (typeName === 'str') {
    const enc: Encoding = f.encoding ?? 'utf8';
    const unit: 1 | 2 = enc === 'utf16le' || enc === 'utf16be' ? 2 : 1;
    const le = enc !== 'utf16be';
    let content: Uint8Array;
    let consumed: number;
    let truncatedStr = false;
    if (size !== null) {
      const want = Math.min(size, run.limits.maxStringBytes);
      truncatedStr = size > want;
      content = await readAt(run, pos, want);
      consumed = size;
      if (f.terminator !== undefined) {
        for (let i = 0; i + unit <= content.length; i += unit) {
          const u = unit === 1 ? content[i]! : le ? content[i]! | (content[i + 1]! << 8) : (content[i]! << 8) | content[i + 1]!;
          if (u === f.terminator) {
            content = content.subarray(0, i);
            break;
          }
        }
      }
    } else if (f.terminator !== undefined) {
      const r = await scanTerminated(run, pos, stream.end, unit, f.terminator, le);
      content = r.content;
      consumed = r.consumed;
    } else throw new FieldError('"str" needs "size" or "terminator"', 'spec');
    const node = newNode(run, attach, name, 'str', pos, consumed);
    const s = decodeString(content, enc);
    node.value = s;
    node.display = previewString(s) + (truncatedStr ? ` (truncated, ${consumed} bytes)` : '');
    checkExpect(run, f, node, path, s);
    return finish(node, pos + consumed, true, s);
  }

  if (typeName === 'bytes') {
    if (size === null) throw new FieldError('"bytes" needs "size"', 'spec');
    const shown = size <= run.limits.fullBytesMax ? size : Math.min(size, run.limits.previewBytes);
    const data = await readAt(run, pos, shown);
    const node = newNode(run, attach, name, 'bytes', pos, size);
    node.value = data;
    node.display = size === 0 ? '(empty)' : hexBytes(data) + (shown < size ? ` … (${size} bytes)` : '');
    return finish(node, pos + size, true, new ListObj(size));
  }

  // user type
  const node = newNode(run, attach, name, typeName, pos, 0);
  const scope = new Scope(pl.scope, index);
  const cpl: Place = { stream: size !== null ? { start: pos, end: pos + size } : stream, scope, depth: pl.depth + 1, path };
  const r = await parseStructBody(run, node, typeName, cpl, pos);
  let end = r.end;
  if (size !== null) {
    end = pos + size;
    node.size = size;
  } else node.size = Math.max(node.size, r.end - pos);
  return finish(node, end, r.ok, scope);
}

function checkExpect(run: Run, f: FieldDef, node: Node, path: string, got: bigint | number | string, f32 = false): void {
  if (f.expect === undefined) return;
  let want: bigint | number | string;
  if (typeof got === 'bigint') {
    const k = typeof f.expect === 'number' ? BigInt(Math.trunc(f.expect)) : parseEnumKey(f.expect);
    if (k === null) return;
    want = k;
  } else want = f.expect;
  if (f32 && typeof want === 'number') want = Math.fround(want); // f4 values are single precision
  if (want === got) return; // note: -0 === 0
  const msg = `expected ${typeof want === 'string' ? JSON.stringify(want) : String(want)}, found ${typeof got === 'string' ? JSON.stringify(got) : String(got)}`;
  (node.validation ??= []).push(msg);
  addDiag(run, { severity: 'error', code: 'validation', message: `${path}: ${msg}`, path, offset: node.offset, nodeId: node.id });
}

// ---- arrays

async function parseRepeat(run: Run, f: FieldDef, attach: Node, pl: Place, pos: number): Promise<Parsed> {
  const rep = f.repeat!;
  const avail = pl.stream.end - pos;
  const env = makeEnv(pl.scope, { start: pl.stream.start, end: pl.stream.end, pos });
  const elemFixed = staticElemSize(run.spec, f);
  if (elemFixed === 0) throw new FieldError(`repeat element of type "${typeLabel(f)}" has zero size`, 'array');
  const perElem = Math.max(1, elemFixed ?? 1);
  const cap = Math.floor(avail / perElem);

  let kind: ArrayState['kind'];
  let target = 0;
  let clampMsg: string | undefined;
  if (rep === 'eos') {
    kind = 'eos';
    if (elemFixed !== null) target = cap;
  } else if ('count' in rep) {
    kind = 'count';
    const c = toBigInt(ev(run, rep.count, env), '"repeat.count"');
    if (c < 0n) throw new FieldError(`repeat count is negative (${c})`, 'array');
    if (c > BigInt(cap)) {
      clampMsg = `repeat count ${c} exceeds the ${cap} element(s) that can fit in the ${avail} remaining bytes; clamped to ${cap}`;
      target = cap;
    } else target = Number(c);
  } else {
    kind = 'until';
    getExpr(run.shared, rep.until); // fail early on bad syntax
  }

  const arr = newNode(run, attach, f.name, `${typeLabel(f)}[]`, pos, 0);
  arr.children = [];
  if (f.doc !== undefined) arr.doc = f.doc;
  const path = `${pl.path}.${f.name}`;
  if (clampMsg) setError(run, arr, path, 'array', clampMsg);

  const st: ArrayState = { field: f, pl, node: arr, kind, target, elemType: typeLabel(f), elemFixed, start: pos, nextIndex: 0, pos, done: false, ok: true, boundary: null };
  if (kind === 'eos' && elemFixed !== null && avail % elemFixed !== 0) {
    setError(run, arr, path, 'array', `${avail % elemFixed} trailing byte(s) do not form a whole ${st.elemType} element`, 'warning');
  }

  // Fixed-size elements with a known count: lazy when large, nothing is parsed up front.
  if (elemFixed !== null && kind !== 'until' && target > run.limits.eagerElements) {
    arr.size = target * elemFixed;
    arr.lazy = { start: pos, count: target, elemType: st.elemType, elemSize: elemFixed, loaded: 0, resumeOffset: null };
    if (run.skim === 0) run.shared.lazies.set(arr.id, { node: arr, field: f, pl, elemSize: elemFixed, count: target, rs: null, lock: Promise.resolve() });
    return { node: arr, end: pos + arr.size, ok: true, val: new ListObj(target) };
  }

  const sequential = f.at === undefined;
  await runArray(run, st, sequential ? Infinity : run.limits.eagerElements, run.limits.eagerElements);
  arr.size = st.pos - st.start;
  if (st.boundary !== null || !st.done) {
    const b = st.boundary ?? { index: st.nextIndex, pos: st.pos };
    const rs: ArrayState = { ...st, nextIndex: b.index, pos: b.pos, done: false, ok: true, boundary: null };
    arr.lazy = {
      start: pos,
      count: st.done && st.ok ? st.nextIndex : kind === 'count' && st.ok ? target : null,
      elemType: st.elemType,
      elemSize: null,
      loaded: b.index,
      resumeOffset: b.pos,
    };
    if (run.skim === 0) run.shared.lazies.set(arr.id, { node: arr, field: f, pl, elemSize: null, count: arr.lazy.count, rs, lock: Promise.resolve() });
  }
  return { node: arr, end: st.pos, ok: st.ok, val: new ListObj(st.ok ? (st.done ? st.nextIndex : kind === 'count' ? target : null) : null) };
}

/** First error message in a (discarded) subtree, depth-first. */
function firstError(node: Node): string | undefined {
  if (node.error !== undefined) return node.error;
  for (const c of node.children ?? []) {
    const e = firstError(c);
    if (e !== undefined) return e;
  }
  return undefined;
}

/**
 * Parse elements until `limitIndex` (exclusive) or the end of the array. Elements with index >= keepBelow are
 * "skimmed": parsed to find where the array ends but not retained.
 */
async function runArray(run: Run, st: ArrayState, limitIndex: number, keepBelow: number): Promise<void> {
  const f = st.field;
  const stream = st.pl.stream;
  const holder: Node = { id: -1, name: '', typeName: '', offset: 0, size: 0, children: [] };
  const path = `${st.pl.path}.${f.name}`;
  // Skim level owned by this array's own context. Skimming this array's elements raises run.skim above it; a failure
  // found there is real for THIS array and is reported at this level. If this array is itself inside an outer skim
  // (ownSkim > 0) its node is discarded, so its diagnostics stay suppressed instead of dangling.
  const ownSkim = run.skim;
  const fail = (code: Diagnostic['code'], msg: string): void => {
    const skim = run.skim;
    run.skim = ownSkim;
    try {
      setError(run, st.node, path, code, msg);
    } finally {
      run.skim = skim;
    }
    st.ok = false;
    st.done = true;
  };
  while (!st.done && st.nextIndex < limitIndex) {
    await tick(run);
    if (st.kind === 'count' && st.nextIndex >= st.target) {
      st.done = true;
      break;
    }
    if (st.kind === 'eos' && (st.pos >= stream.end || (st.elemFixed !== null && stream.end - st.pos < st.elemFixed))) {
      st.done = true; // (a trailing partial fixed-size element was reported as a warning by parseRepeat)
      break;
    }
    const i = st.nextIndex;
    const keep = i < keepBelow;
    if (!keep && st.boundary === null) st.boundary = { index: i, pos: st.pos };
    holder.children = []; // elements are built detached and attached only when complete
    if (!keep) run.skim++;
    let r: Parsed;
    try {
      r = await parseValue(run, f, `${f.name}[${i}]`, holder, st.pl, st.pos, i);
    } catch (e) {
      if (e instanceof Halt) throw e;
      if (e instanceof SkimOverflow) {
        fail('limit', `element ${i}: ${e.message}; the array is incomplete`);
        run.stats.truncated = true;
        r = { node: holder, end: st.pos, ok: false };
      } else {
        const { code, message } = classify(e);
        const n = keep ? errorNode(run, holder, `${f.name}[${i}]`, st.elemType, st.pos, `${path}[${i}]`, code, message) : holder;
        if (!keep) fail(code, `element ${i} failed while skimming: ${message}`);
        r = { node: n, end: st.pos, ok: false };
      }
    } finally {
      if (!keep) run.skim--;
    }
    if (keep) for (const c of holder.children) (st.node.children ??= []).push(c);
    st.nextIndex = i + 1;
    const prev = st.pos;
    st.pos = Math.max(st.pos, r.end);
    if (!r.ok) {
      // A kept element carries its own error node; a skimmed one is discarded, so report it on the array.
      if (!keep && st.ok) fail('array', `element ${i} failed while skimming past the first ${keepBelow} elements: ${firstError(holder) ?? 'unknown error'}`);
      st.ok = false;
      st.done = true;
      break;
    }
    if (r.end <= prev) {
      fail('array', `repeat element ${i} consumed no bytes (zero-size elements are not allowed)`);
      break;
    }
    if (st.kind === 'until') {
      try {
        const env = makeEnv(st.pl.scope, { start: stream.start, end: stream.end, pos: st.pos }, r.val, i);
        const u = ev(run, (f.repeat as { until: string }).until, env);
        if (typeof u !== 'boolean') throw new FieldError(`"until" must evaluate to a boolean, got ${describeValue(u)}`, 'expr');
        if (u) st.done = true;
        else if (st.pos >= stream.end) fail('array', `"until" condition never became true before the end of the stream (after ${i + 1} element(s))`);
      } catch (e) {
        const { code, message } = classify(e);
        fail(code, message);
      }
    }
  }
  st.node.size = Math.max(st.node.size, st.pos - st.start);
}

// ------------------------------------------------------------------ public API

export async function parse(spec: FormatSpec, source: ByteSource, opts: ParseOptions = {}): Promise<ParseResult> {
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const shared: Shared = { spec, source, limits, nextId: 1, exprCache: new Map(), enumMaps: new Map(), lazies: new Map(), result: null };
  const run = makeRun(shared, opts.signal);
  const rootName = typeof spec.root === 'string' ? spec.root : '(root)';
  const root: Node = { id: shared.nextId++, name: rootName, typeName: rootName, offset: 0, size: 0, children: [] };
  run.stats.nodes = 1;
  const result: ParseResult = { root, errors: run.diags, stats: run.stats };
  shared.result = result;
  internals.set(result, shared);
  try {
    if (!Number.isSafeInteger(source.size) || source.size < 0) throw new FieldError(`invalid source size ${source.size}`, 'bounds');
    await tick(run);
    const pl: Place = { stream: { start: 0, end: source.size }, scope: new Scope(null), depth: 0, path: rootName };
    await parseStructBody(run, root, rootName, pl, 0);
  } catch (e) {
    handleTop(run, root, e);
  }
  return result;
}

function handleTop(run: Run, node: Node, e: unknown): void {
  if (e instanceof Halt) {
    run.stats.truncated = true;
    if (e.code === 'aborted') run.stats.aborted = true;
    addDiag(run, { severity: 'error', code: e.code, message: e.message }, true);
    if (node.error === undefined) node.error = e.message;
  } else {
    const { code, message } = classify(e);
    addDiag(run, { severity: 'error', code, message: `unexpected failure: ${message}` }, true);
  }
}

function pushResultDiag(result: ParseResult, shared: Shared | undefined, d: Diagnostic): void {
  const max = shared?.limits.maxDiagnostics ?? DEFAULT_LIMITS.maxDiagnostics;
  if (result.errors.length >= max) result.stats.suppressedDiagnostics++;
  else result.errors.push(d);
}

export interface LazyRange {
  start: number;
  count: number;
}

/**
 * Parse a window of elements of a lazy array node.
 * - Fixed-size arrays: returns freshly parsed nodes (not attached to the tree; the caller caches them).
 * - Variable-size arrays: resumes parsing, appends to `node.children`, updates `node.lazy`, and returns the
 *   requested slice. Calls on the same node are serialised.
 * Never throws for bad input; problems are returned as error nodes and appended to `result.errors`.
 * A limit or abort during expansion yields a SHORT (partial) result and sets `result.stats.truncated` (and
 * `aborted`); those flags are sticky, meaning "some expansion was partial", and a retry may complete the rest.
 */
export async function expandLazy(result: ParseResult, nodeId: number, range: LazyRange, opts: { signal?: AbortSignal } = {}): Promise<Node[]> {
  const shared = internals.get(result);
  const entry = shared?.lazies.get(nodeId);
  if (!shared || !entry) {
    pushResultDiag(result, shared, { severity: 'error', code: 'lazy', message: `node ${nodeId} is not a lazy array of this parse result` });
    return [];
  }
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.count) || range.start < 0 || range.count < 0) {
    pushResultDiag(result, shared, { severity: 'error', code: 'lazy', message: `invalid range {start:${range.start}, count:${range.count}}`, nodeId });
    return [];
  }
  if (entry.count !== null && range.start > entry.count) {
    pushResultDiag(result, shared, { severity: 'error', code: 'lazy', message: `range start ${range.start} is beyond the array's ${entry.count} element(s)`, nodeId });
    return [];
  }
  const count = Math.min(range.count, shared.limits.maxLazyRange);
  const prev = entry.lock;
  let release!: () => void;
  entry.lock = new Promise<void>((r) => (release = r));
  await prev;
  const run = makeRun(shared, opts.signal);
  try {
    const out = entry.elemSize !== null ? await expandFixed(run, entry, range.start, count) : await expandVariable(run, entry, range.start, count);
    return out;
  } catch (e) {
    handleTop(run, { id: -1, name: '', typeName: '', offset: 0, size: 0 }, e);
    return [];
  } finally {
    for (const d of run.diags) pushResultDiag(result, shared, d);
    // A Halt (limit/abort) in this expansion only touched the throwaway run stats; surface it on the result.
    if (run.stats.truncated) result.stats.truncated = true;
    if (run.stats.aborted) result.stats.aborted = true;
    release();
  }
}

async function expandFixed(run: Run, entry: LazyEntry, start: number, count: number): Promise<Node[]> {
  const total = entry.count ?? 0;
  const end = Math.min(total, start + count);
  const holder: Node = { id: -1, name: '', typeName: '', offset: 0, size: 0, children: [] };
  const lz = entry.node.lazy!;
  try {
  for (let i = start; i < end; i++) {
    await tick(run);
    const pos = lz.start + i * entry.elemSize!;
    const tmp: Node = { id: -1, name: '', typeName: '', offset: 0, size: 0, children: [] }; // detached until complete
    try {
      await parseValue(run, entry.field, `${entry.field.name}[${i}]`, tmp, entry.pl, pos, i);
    } catch (e) {
      if (e instanceof Halt) throw e;
      const { code, message } = classify(e);
      errorNode(run, tmp, `${entry.field.name}[${i}]`, lz.elemType, pos, `${entry.pl.path}.${entry.field.name}[${i}]`, code, message);
    }
    for (const c of tmp.children ?? []) holder.children!.push(c);
  }
  } catch (e) {
    if (!(e instanceof Halt)) throw e;
    handleTop(run, { id: -1, name: '', typeName: '', offset: 0, size: 0 }, e); // keep what was collected
  }
  return holder.children ?? [];
}

async function expandVariable(run: Run, entry: LazyEntry, start: number, count: number): Promise<Node[]> {
  const rs = entry.rs;
  const node = entry.node;
  const lz = node.lazy!;
  if (!rs) return [];
  // Never parse more than maxLazyRange elements beyond what is already loaded in one call.
  const reach = rs.nextIndex + run.limits.maxLazyRange;
  if (start >= reach && !rs.done) {
    addDiag(run, { severity: 'error', code: 'lazy', message: `range start ${start} is more than ${run.limits.maxLazyRange} elements beyond the ${rs.nextIndex} loaded; expand closer to the loaded part first`, nodeId: node.id });
    return [];
  }
  const want = Math.min(start + count, reach);
  if (!rs.done && rs.nextIndex < want) {
    try {
      await runArray(run, rs, want, Infinity);
    } catch (e) {
      if (!(e instanceof Halt)) throw e;
      // Transient (limit/abort): report it, but do not mark the array itself, so a retry can succeed.
      handleTop(run, { id: -1, name: '', typeName: '', offset: 0, size: 0 }, e);
    } finally {
      lz.loaded = node.children?.length ?? 0;
      lz.resumeOffset = rs.done ? null : rs.pos;
      if (rs.done) lz.count = rs.nextIndex;
      entry.count = lz.count;
    }
  }
  return (node.children ?? []).slice(start, want);
}

/**
 * Deepest node whose byte range covers `offset` (for hex-click -> tree selection), or null.
 * Lazy arrays are returned as-is when the offset lies inside their (unexpanded) range.
 * Children are searched even when the parent's own range does not cover the offset, because `at` fields
 * place children outside their parent's sequential extent. At equal depth the narrowest range wins, then the
 * earliest child. Nodes returned by `expandLazy` for fixed-size arrays are detached from the tree, so pass such a
 * node (or a holder containing them) as `root` to search inside it.
 */
export function findNodeAt(root: Node, offset: number): Node | null {
  if (!Number.isFinite(offset)) return null;
  const r = search(root, offset, 0);
  return r ? r.node : null;
}

function search(node: Node, offset: number, depth: number): { node: Node; depth: number } | null {
  let best: { node: Node; depth: number } | null = null;
  if (node.children) {
    for (const c of node.children) {
      if (c.typeName === 'bits') continue; // bit fields share their integer's range; select the integer
      const r = search(c, offset, depth + 1);
      if (r && (best === null || r.depth > best.depth || (r.depth === best.depth && r.node.size < best.node.size))) best = r;
    }
  }
  if (best) return best;
  if (node.size > 0 && offset >= node.offset && offset < node.offset + node.size) return { node, depth };
  return null;
}

/** Element index of a fixed-size lazy array that covers `offset`, or null. */
export function lazyElementIndexAt(node: Node, offset: number): number | null {
  const lz = node.lazy;
  if (!lz || lz.elemSize === null || lz.count === null || offset < lz.start) return null;
  const i = Math.floor((offset - lz.start) / lz.elemSize);
  return i < lz.count ? i : null;
}
