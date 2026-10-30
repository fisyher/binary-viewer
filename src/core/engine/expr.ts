/**
 * Expression language: hand-written tokenizer + Pratt parser + checked evaluator. No eval/Function.
 *
 * Values: bigint (all integers, exact), number (floats from f4/f8 fields), string, boolean, and
 * ObjValue (structs / arrays exposed by the interpreter).
 *
 * Precedence, lowest to highest (bitwise binds tighter than comparison, like Python/Rust, not C):
 *   ?:   ||   &&   == !=   < <= > >=   |   ^   &   << >>   + -   * / %   unary - ~ !
 * Word aliases: `and`, `or`, `not` mean `&&`, `||`, `!`. `null` is a literal. `&&`, `||` and `?:` short-circuit,
 * so the unevaluated side may reference fields that do not exist (yet).
 * Null semantics: a field skipped by `if` (or failed) is `null`; reading a member of `null`, of a raw-bytes field,
 * or a member a struct does not have, gives `null` (not an error); `==`/`!=` work with null; arithmetic and
 * ordering on null are errors for that one expression.
 * Division and modulo are floor-based (Python/Kaitai semantics). `~x` is -x-1 (infinite precision):
 * mask the result with `&` when a fixed width is wanted. Shift counts must be 0..64. Integer results
 * are limited to +-2^256; larger results are an error rather than unbounded memory growth.
 *
 * Limits: expression length, nesting depth (parens / unary chains / ternaries / call args) and token
 * count are capped. All failures are reported as ExprError (or `{ok:false}` from the safe wrappers).
 */

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExprError';
  }
}

export interface ObjValue {
  readonly isObj: true;
  get(name: string): Value | undefined;
}
export type Value = bigint | number | string | boolean | null | ObjValue;

export function isObj(v: Value): v is ObjValue {
  return typeof v === 'object' && v !== null && (v as ObjValue).isObj === true;
}

export type Expr =
  | { k: 'int'; v: bigint }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'name'; name: string }
  | { k: 'member'; obj: Expr; name: string }
  | { k: 'unary'; op: '-' | '~' | '!'; arg: Expr }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'cond'; c: Expr; a: Expr; b: Expr }
  | { k: 'call'; fn: 'min' | 'max'; args: Expr[] };

export interface ExprLimits {
  maxLength: number;
  maxDepth: number;
  maxTokens: number;
}
export const DEFAULT_EXPR_LIMITS: ExprLimits = { maxLength: 1024, maxDepth: 64, maxTokens: 512 };

const MAX_ARGS = 8;
const MAX_EVAL_DEPTH = 2048;
const INT_LIMIT = 1n << 256n;
const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);

// ---------------------------------------------------------------- tokenizer

type Token =
  | { t: 'int'; v: bigint; pos: number }
  | { t: 'str'; v: string; pos: number }
  | { t: 'id'; v: string; pos: number }
  | { t: 'op'; v: string; pos: number }
  | { t: 'end'; pos: number };

const TWO_CHAR_OPS = new Set(['<<', '>>', '<=', '>=', '==', '!=', '&&', '||']);
const ONE_CHAR_OPS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '<', '>', '?', ':', '(', ')', ',', '.']);

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}
function isIdStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}
function isIdPart(c: string): boolean {
  return isIdStart(c) || isDigit(c);
}
function isHex(c: string): boolean {
  return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

function tokenize(src: string, maxTokens: number): Token[] {
  const toks: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (toks.length >= maxTokens) throw new ExprError(`expression has too many tokens (max ${maxTokens})`);
    const start = i;
    if (isDigit(c)) {
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        i += 2;
        const ds = i;
        while (i < n && isHex(src[i]!)) i++;
        if (i === ds) throw new ExprError(`malformed hex literal at position ${start}`);
        toks.push({ t: 'int', v: BigInt('0x' + src.slice(ds, i)), pos: start });
      } else {
        while (i < n && isDigit(src[i]!)) i++;
        toks.push({ t: 'int', v: BigInt(src.slice(start, i)), pos: start });
      }
      if (i < n && isIdPart(src[i]!)) throw new ExprError(`malformed number at position ${start}`);
      continue;
    }
    if (isIdStart(c)) {
      while (i < n && isIdPart(src[i]!)) i++;
      const word = src.slice(start, i);
      const alias = word === 'and' ? '&&' : word === 'or' ? '||' : word === 'not' ? '!' : null;
      toks.push(alias ? { t: 'op', v: alias, pos: start } : { t: 'id', v: word, pos: start });
      continue;
    }
    if (c === '"') {
      i++;
      let out = '';
      let closed = false;
      while (i < n) {
        const ch = src[i]!;
        if (ch === '"') {
          i++;
          closed = true;
          break;
        }
        if (ch === '\\') {
          const e = src[i + 1];
          i += 2;
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === '0') out += '\0';
          else if (e === '"' || e === '\\') out += e;
          else if (e === 'x') {
            const h = src.slice(i, i + 2);
            if (!/^[0-9a-fA-F]{2}$/.test(h)) throw new ExprError(`bad \\x escape at position ${i - 2}`);
            out += String.fromCharCode(parseInt(h, 16));
            i += 2;
          } else throw new ExprError(`bad escape at position ${i - 2}`);
        } else {
          out += ch;
          i++;
        }
      }
      if (!closed) throw new ExprError(`unterminated string starting at position ${start}`);
      toks.push({ t: 'str', v: out, pos: start });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      toks.push({ t: 'op', v: two, pos: start });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.has(c)) {
      toks.push({ t: 'op', v: c, pos: start });
      i++;
      continue;
    }
    throw new ExprError(`unexpected character '${c}' at position ${i}`);
  }
  toks.push({ t: 'end', pos: n });
  return toks;
}

// ---------------------------------------------------------------- parser

const TERNARY_BP = 2;
const UNARY_BP = 24;
const BIN_BP = new Map<string, number>([
  ['||', 4],
  ['&&', 6],
  ['==', 8],
  ['!=', 8],
  ['<', 10],
  ['<=', 10],
  ['>', 10],
  ['>=', 10],
  ['|', 12],
  ['^', 14],
  ['&', 16],
  ['<<', 18],
  ['>>', 18],
  ['+', 20],
  ['-', 20],
  ['*', 22],
  ['/', 22],
  ['%', 22],
]);

class Parser {
  private i = 0;
  private depth = 0;
  constructor(
    private readonly toks: Token[],
    private readonly maxDepth: number,
  ) {}

  private peek(): Token {
    return this.toks[this.i]!;
  }

  private describe(t: Token): string {
    return t.t === 'end' ? 'end of expression' : `'${t.t === 'int' ? t.v.toString() : t.t === 'str' ? '"' + t.v + '"' : t.v}'`;
  }

  parseAll(): Expr {
    const e = this.expr(0);
    const t = this.peek();
    if (t.t !== 'end') throw new ExprError(`unexpected ${this.describe(t)} at position ${t.pos}`);
    return e;
  }

  private expectOp(op: string): void {
    const t = this.peek();
    if (t.t !== 'op' || t.v !== op) throw new ExprError(`expected '${op}' but found ${this.describe(t)} at position ${t.pos}`);
    this.i++;
  }

  private expr(minBp: number): Expr {
    if (++this.depth > this.maxDepth) throw new ExprError(`expression nested too deeply (max depth ${this.maxDepth})`);
    try {
      let left = this.prefix();
      for (;;) {
        const t = this.peek();
        if (t.t !== 'op') break;
        if (t.v === '?') {
          if (TERNARY_BP <= minBp) break;
          this.i++;
          const a = this.expr(0);
          this.expectOp(':');
          const b = this.expr(TERNARY_BP - 1);
          left = { k: 'cond', c: left, a, b };
          continue;
        }
        const bp = BIN_BP.get(t.v);
        if (bp === undefined || bp <= minBp) break;
        this.i++;
        const r = this.expr(bp);
        left = { k: 'bin', op: t.v, l: left, r };
      }
      return left;
    } finally {
      this.depth--;
    }
  }

  private prefix(): Expr {
    const t = this.peek();
    this.i++;
    let e: Expr;
    switch (t.t) {
      case 'int':
        e = { k: 'int', v: t.v };
        break;
      case 'str':
        e = { k: 'str', v: t.v };
        break;
      case 'id': {
        const next = this.peek();
        if (next.t === 'op' && next.v === '(') {
          if (t.v !== 'min' && t.v !== 'max') throw new ExprError(`unknown function '${t.v}' at position ${t.pos}`);
          this.i++;
          const args: Expr[] = [];
          for (;;) {
            args.push(this.expr(0));
            if (args.length > MAX_ARGS) throw new ExprError(`too many arguments to ${t.v} (max ${MAX_ARGS})`);
            const sep = this.peek();
            if (sep.t === 'op' && sep.v === ',') {
              this.i++;
              continue;
            }
            break;
          }
          this.expectOp(')');
          e = { k: 'call', fn: t.v, args };
        } else if (t.v === 'true' || t.v === 'false') {
          e = { k: 'bool', v: t.v === 'true' };
        } else if (t.v === 'null') {
          e = { k: 'null' };
        } else {
          e = { k: 'name', name: t.v };
        }
        break;
      }
      case 'op':
        if (t.v === '(') {
          e = this.expr(0);
          this.expectOp(')');
        } else if (t.v === '-' || t.v === '~' || t.v === '!') {
          e = { k: 'unary', op: t.v, arg: this.expr(UNARY_BP) };
        } else {
          throw new ExprError(`unexpected ${this.describe(t)} at position ${t.pos}`);
        }
        break;
      default:
        throw new ExprError(`unexpected ${this.describe(t)} at position ${t.pos}`);
    }
    for (;;) {
      const d = this.peek();
      if (d.t === 'op' && d.v === '.') {
        this.i++;
        const nm = this.peek();
        if (nm.t !== 'id') throw new ExprError(`expected a name after '.' at position ${nm.pos}`);
        this.i++;
        e = { k: 'member', obj: e, name: nm.v };
      } else break;
    }
    return e;
  }
}

export type ParseExprResult = { ok: true; ast: Expr } | { ok: false; error: string };

/** Parse an expression. Never throws. */
export function parseExpr(src: string, limits: Partial<ExprLimits> = {}): ParseExprResult {
  const lim = { ...DEFAULT_EXPR_LIMITS, ...limits };
  try {
    if (typeof src !== 'string') throw new ExprError('expression must be a string');
    if (src.length > lim.maxLength) throw new ExprError(`expression too long (${src.length} > ${lim.maxLength} characters)`);
    const toks = tokenize(src, lim.maxTokens);
    return { ok: true, ast: new Parser(toks, lim.maxDepth).parseAll() };
  } catch (e) {
    if (e instanceof ExprError) return { ok: false, error: e.message };
    if (e instanceof RangeError) return { ok: false, error: 'expression too deeply nested' };
    throw e;
  }
}

/** Names that are looked up in the environment (roots of dotted paths). */
export function freeNames(e: Expr, out: Set<string> = new Set()): Set<string> {
  switch (e.k) {
    case 'name':
      out.add(e.name);
      break;
    case 'member':
      freeNames(e.obj, out);
      break;
    case 'unary':
      freeNames(e.arg, out);
      break;
    case 'bin':
      freeNames(e.l, out);
      freeNames(e.r, out);
      break;
    case 'cond':
      freeNames(e.c, out);
      freeNames(e.a, out);
      freeNames(e.b, out);
      break;
    case 'call':
      for (const a of e.args) freeNames(a, out);
      break;
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------- evaluation

export interface EvalEnv {
  /** Resolve a bare name; undefined means unknown. */
  resolve(name: string): Value | undefined;
}

function typeOf(v: Value): string {
  if (v === null) return 'null';
  if (typeof v === 'bigint') return 'integer';
  if (typeof v === 'number') return 'float';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  return 'struct';
}

export function describeValue(v: Value): string {
  if (v === null) return 'null';
  if (isObj(v)) return 'struct';
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

function checkInt(v: bigint): bigint {
  if (v >= INT_LIMIT || v <= -INT_LIMIT) throw new ExprError('integer overflow (result exceeds 256 bits)');
  return v;
}

function needInt(v: Value, op: string): bigint {
  if (typeof v !== 'bigint') throw new ExprError(`operator '${op}' needs integers, got ${typeOf(v)}`);
  return v;
}

function needBool(v: Value, op: string): boolean {
  if (typeof v !== 'boolean') throw new ExprError(`operator '${op}' needs booleans, got ${typeOf(v)}`);
  return v;
}

function shiftCount(v: bigint): bigint {
  if (v < 0n || v > 64n) throw new ExprError(`shift count ${v} out of range (0..64)`);
  return v;
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}
function floorMod(a: bigint, b: bigint): bigint {
  const r = a % b;
  return r !== 0n && r < 0n !== b < 0n ? r + b : r;
}

function compare(op: string, a: Value, b: Value): boolean {
  if (a === null || b === null) {
    if (op !== '==' && op !== '!=') throw new ExprError(`cannot order null with '${op}'`);
    return (a === b) === (op === '==');
  }
  let c: number;
  if (typeof a === 'bigint' && typeof b === 'bigint') c = a < b ? -1 : a > b ? 1 : 0;
  else if ((typeof a === 'bigint' || typeof a === 'number') && (typeof b === 'bigint' || typeof b === 'number')) {
    const x = Number(a);
    const y = Number(b);
    if (Number.isNaN(x) || Number.isNaN(y)) return op === '!=';
    c = x < y ? -1 : x > y ? 1 : 0;
  } else if (typeof a === 'string' && typeof b === 'string') c = a < b ? -1 : a > b ? 1 : 0;
  else if (typeof a === 'boolean' && typeof b === 'boolean' && (op === '==' || op === '!=')) c = a === b ? 0 : 1;
  else throw new ExprError(`cannot compare ${typeOf(a)} with ${typeOf(b)} using '${op}'`);
  switch (op) {
    case '==':
      return c === 0;
    case '!=':
      return c !== 0;
    case '<':
      return c < 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    default:
      return c >= 0;
  }
}

/** Equality used by `switch` case matching. */
export function valuesEqual(a: Value, b: Value): boolean {
  try {
    return compare('==', a, b);
  } catch {
    return false;
  }
}

function evalBin(op: string, a: Value, b: Value): Value {
  switch (op) {
    case '+':
      if (typeof a === 'string' && typeof b === 'string') return a + b;
      return checkInt(needInt(a, op) + needInt(b, op));
    case '-':
      return checkInt(needInt(a, op) - needInt(b, op));
    case '*':
      return checkInt(needInt(a, op) * needInt(b, op));
    case '/': {
      const d = needInt(b, op);
      if (d === 0n) throw new ExprError('division by zero');
      return floorDiv(needInt(a, op), d);
    }
    case '%': {
      const d = needInt(b, op);
      if (d === 0n) throw new ExprError('modulo by zero');
      return floorMod(needInt(a, op), d);
    }
    case '<<':
      return checkInt(needInt(a, op) << shiftCount(needInt(b, op)));
    case '>>':
      return needInt(a, op) >> shiftCount(needInt(b, op));
    case '&':
      return needInt(a, op) & needInt(b, op);
    case '|':
      return needInt(a, op) | needInt(b, op);
    case '^':
      return needInt(a, op) ^ needInt(b, op);
    default:
      return compare(op, a, b);
  }
}

function evalNode(e: Expr, env: EvalEnv, depth: number): Value {
  if (depth > MAX_EVAL_DEPTH) throw new ExprError('expression too deeply nested to evaluate');
  const d = depth + 1;
  switch (e.k) {
    case 'int':
      return checkInt(e.v);
    case 'str':
    case 'bool':
      return e.v;
    case 'null':
      return null;
    case 'name': {
      const v = env.resolve(e.name);
      if (v === undefined) throw new ExprError(`unknown name '${e.name}'`);
      return v;
    }
    case 'member': {
      const o = evalNode(e.obj, env, d);
      if (o === null) return null;
      if (!isObj(o)) throw new ExprError(`cannot read '.${e.name}' of a ${typeOf(o)}`);
      const v = o.get(e.name);
      return v === undefined ? null : v;
    }
    case 'unary': {
      const v = evalNode(e.arg, env, d);
      if (e.op === '!') return !needBool(v, '!');
      const i = needInt(v, e.op);
      return checkInt(e.op === '-' ? -i : ~i);
    }
    case 'bin': {
      if (e.op === '&&' || e.op === '||') {
        const l = needBool(evalNode(e.l, env, d), e.op);
        if (e.op === '&&' ? !l : l) return l;
        return needBool(evalNode(e.r, env, d), e.op);
      }
      const res = evalBin(e.op, evalNode(e.l, env, d), evalNode(e.r, env, d));
      return typeof res === 'bigint' ? checkInt(res) : res;
    }
    case 'cond':
      return needBool(evalNode(e.c, env, d), '?:') ? evalNode(e.a, env, d) : evalNode(e.b, env, d);
    case 'call': {
      let best: bigint | undefined;
      for (const a of e.args) {
        const v = needInt(evalNode(a, env, d), e.fn);
        if (best === undefined || (e.fn === 'min' ? v < best : v > best)) best = v;
      }
      return checkInt(best!);
    }
  }
}

/** Evaluate; throws ExprError. */
export function evalExpr(e: Expr, env: EvalEnv): Value {
  return evalNode(e, env, 0);
}

export type EvalResult = { ok: true; value: Value } | { ok: false; error: string };

const EMPTY_ENV: EvalEnv = { resolve: () => undefined };

/** Parse and evaluate in one go. Never throws for bad input. */
export function evaluate(src: string, env: EvalEnv = EMPTY_ENV, limits: Partial<ExprLimits> = {}): EvalResult {
  const p = parseExpr(src, limits);
  if (!p.ok) return p;
  try {
    return { ok: true, value: evalExpr(p.ast, env) };
  } catch (e) {
    if (e instanceof ExprError) return { ok: false, error: e.message };
    if (e instanceof RangeError) return { ok: false, error: 'expression too deeply nested to evaluate' };
    throw e;
  }
}

/** Non-negative integer that fits a safe Number (sizes, counts, offsets). Throws ExprError. */
export function toNonNegativeInt(v: Value, what: string): number {
  const b = toBigInt(v, what);
  if (b < 0n) throw new ExprError(`${what} is negative (${b})`);
  if (b > MAX_SAFE_BIG) throw new ExprError(`${what} ${b} exceeds the maximum safe integer (2^53-1)`);
  return Number(b);
}

export function toBigInt(v: Value, what: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  throw new ExprError(`${what} must be an integer, got ${isObj(v) ? 'struct' : describeValue(v)}`);
}

/** Signed BigInt -> Number, erroring above 2^53. */
export function toSafeNumber(v: bigint, what: string): number {
  if (v > MAX_SAFE_BIG || v < -MAX_SAFE_BIG) throw new ExprError(`${what} ${v} exceeds the safe integer range (2^53)`);
  return Number(v);
}
