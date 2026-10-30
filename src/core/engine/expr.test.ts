import { describe, expect, it } from 'vitest';
import type { EvalEnv, ObjValue, Value } from './expr';
import { evaluate, freeNames, parseExpr, toNonNegativeInt, toSafeNumber } from './expr';

function ok(src: string, env?: EvalEnv): Value {
  const r = evaluate(src, env);
  if (!r.ok) throw new Error(`"${src}" failed: ${r.error}`);
  return r.value;
}
function fails(src: string, pattern: RegExp, env?: EvalEnv): void {
  const r = evaluate(src, env);
  expect(r.ok, `"${src}" should fail`).toBe(false);
  if (!r.ok) expect(r.error).toMatch(pattern);
}
const obj = (m: Record<string, Value>): ObjValue => ({ isObj: true, get: (n) => (Object.hasOwn(m, n) ? m[n] : undefined) });
const envOf = (m: Record<string, Value>): EvalEnv => ({ resolve: (n) => (Object.hasOwn(m, n) ? m[n] : undefined) });

describe('precedence and associativity', () => {
  it.each([
    ['1 + 2 * 3', 7n],
    ['(1 + 2) * 3', 9n],
    ['2 * 3 + 4 * 5', 26n],
    ['10 - 3 - 2', 5n],
    ['1 << 2 + 1', 8n],
    ['1 | 2 & 3', 3n],
    ['6 ^ 3 & 1', 7n],
    ['-2 * 3', -6n],
    ['2 - -3', 5n],
    ['~0 & 0xFF', 255n],
    ['1 + 2 == 3 ? 10 : 20', 10n],
    ['false ? 1 : false ? 2 : 3', 3n],
    ['0x10 + 0xff', 271n],
  ])('%s = %s', (src, want) => {
    expect(ok(src)).toBe(want);
  });

  it('comparison and logic', () => {
    expect(ok('1 < 2 == true')).toBe(true);
    expect(ok('true || false && false')).toBe(true);
    expect(ok('!(1 >= 2)')).toBe(true);
    expect(ok('3 != 3')).toBe(false);
  });

  it('short-circuits && and ||', () => {
    expect(ok('false && 1 / 0 == 0')).toBe(false);
    expect(ok('true || 1 / 0 == 0')).toBe(true);
  });

  it('requires booleans for logic', () => {
    fails('1 && 2', /needs booleans/);
    fails('!1', /needs booleans/);
    fails('1 ? 2 : 3', /needs booleans/);
  });
});

describe('integers are exact BigInt', () => {
  it('does not lose precision above 2^53', () => {
    expect(ok('0xFFFFFFFFFFFFFFFF + 1')).toBe(18446744073709551616n);
    expect(ok('9007199254740993 * 3')).toBe(27021597764222979n);
  });
  it('uses floor division and modulo', () => {
    expect(ok('7 / 2')).toBe(3n);
    expect(ok('-7 / 2')).toBe(-4n);
    expect(ok('-7 % 3')).toBe(2n);
    expect(ok('7 % -3')).toBe(-2n);
  });
  it('allows shifts up to 64 and rejects wider ones', () => {
    expect(ok('1 << 64')).toBe(18446744073709551616n);
    fails('1 << 65', /shift count 65/);
    fails('1 >> 100', /shift count/);
    fails('1 << (0 - 1)', /shift count/);
  });
  it('rejects results beyond 256 bits instead of growing without bound', () => {
    fails('(1 << 64) * (1 << 64) * (1 << 64) * (1 << 64) * (1 << 64)', /overflow/);
  });
});

describe('errors are diagnostics, never crashes', () => {
  it('division and modulo by zero', () => {
    fails('1 / 0', /division by zero/);
    fails('5 % 0', /modulo by zero/);
  });
  it('unknown names, members and functions', () => {
    fails('foo + 1', /unknown name 'foo'/);
    expect(ok('a.b', envOf({ a: obj({}) }))).toBeNull(); // missing members read as null
    fails('a.b', /cannot read/, envOf({ a: 1n }));
    fails('foo(1)', /unknown function/);
  });
  it('type mismatches', () => {
    fails('"a" - 1', /needs integers/);
    fails('1 == "a"', /cannot compare/);
  });
  it.each(['', '1 +', ')', '(', '1 2', '0x', '12abc', '@', '"abc', '1 ? 2', 'a.', 'min()', 'min(1,', '"\\q"', '"\\x4"'])('malformed input %j is rejected', (src) => {
    const r = parseExpr(src);
    expect(r.ok).toBe(false);
  });
  it('rejects non-string input', () => {
    expect(parseExpr(undefined as unknown as string).ok).toBe(false);
  });
});

describe('limits', () => {
  it('caps expression length', () => {
    const r = parseExpr('1+'.repeat(600) + '1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too long/);
  });
  it('survives 10k-deep parenthesis nesting (default limits)', () => {
    const src = '('.repeat(10_000) + '1' + ')'.repeat(10_000);
    const r = parseExpr(src);
    expect(r.ok).toBe(false);
  });
  it('enforces the depth cap itself even when the length cap is lifted', () => {
    const src = '('.repeat(10_000) + '1' + ')'.repeat(10_000);
    const r = parseExpr(src, { maxLength: 1_000_000, maxTokens: 1_000_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/nested too deeply/);
  });
  it('caps unary chains and ternary nesting', () => {
    const big = { maxLength: 1_000_000, maxTokens: 1_000_000 };
    expect(parseExpr('-'.repeat(10_000) + '1', big).ok).toBe(false);
    expect(parseExpr('true?'.repeat(5000) + '1' + ':1'.repeat(5000), big).ok).toBe(false);
  });
  it('accepts nesting within the cap', () => {
    expect(ok('('.repeat(30) + '1' + ')'.repeat(30))).toBe(1n);
  });
  it('caps token count', () => {
    const r = parseExpr('1+'.repeat(300) + '1', { maxLength: 100_000, maxTokens: 100 });
    expect(r.ok).toBe(false);
  });
  it('honours a custom depth', () => {
    expect(parseExpr('((((1))))', { maxDepth: 3 }).ok).toBe(false);
    expect(parseExpr('((((1))))', { maxDepth: 10 }).ok).toBe(true);
  });
});

describe('names, members, strings, functions', () => {
  it('resolves dotted paths through struct values', () => {
    const env = envOf({ a: obj({ x: 5n, inner: obj({ y: 7n }) }) });
    expect(ok('a.x * 2', env)).toBe(10n);
    expect(ok('a.inner.y + a.x', env)).toBe(12n);
  });
  it('strings: comparison, concatenation, escapes', () => {
    expect(ok('"abc" == "abc"')).toBe(true);
    expect(ok('"a" + "b"')).toBe('ab');
    expect(ok('"\\x41\\n"')).toBe('A\n');
  });
  it('min / max', () => {
    expect(ok('min(3, 1, 2)')).toBe(1n);
    expect(ok('max(1, 2) + 1')).toBe(3n);
    expect(ok('max(-5, -9)')).toBe(-5n);
  });
  it('freeNames collects only roots of paths', () => {
    const p = parseExpr('a.b + min(c, 1) * _io.size');
    expect(p.ok && [...freeNames(p.ast)].sort()).toEqual(['_io', 'a', 'c']);
  });
});

describe('conversion helpers', () => {
  it('toNonNegativeInt', () => {
    expect(toNonNegativeInt(5n, 'x')).toBe(5);
    expect(() => toNonNegativeInt(-1n, 'size')).toThrow(/negative/);
    expect(() => toNonNegativeInt(2n ** 53n, 'size')).toThrow(/maximum safe integer/);
    expect(() => toNonNegativeInt('a', 'size')).toThrow(/integer/);
  });
  it('toSafeNumber', () => {
    expect(toSafeNumber(-5n, 'x')).toBe(-5);
    expect(() => toSafeNumber(2n ** 60n, 'x')).toThrow(/safe integer/);
  });
});

describe('word operators, null and short-circuiting', () => {
  it('and / or / not are aliases', () => {
    expect(ok('true and not false')).toBe(true);
    expect(ok('false or 1 < 2')).toBe(true);
    expect(ok('not (1 == 1) or false')).toBe(false);
    expect(ok('1 < 2 and 2 < 3 ? 7 : 8')).toBe(7n);
  });
  it('null literal and comparison', () => {
    expect(ok('null == null')).toBe(true);
    expect(ok('1 != null')).toBe(true);
    expect(ok('1 == null')).toBe(false);
    fails('null < 1', /cannot order null/);
    fails('null + 1', /needs integers, got null/);
  });
  it('members of null and of missing members read as null', () => {
    const env = envOf({ n: null, s: obj({ x: 1n }) });
    expect(ok('n.a.b', env)).toBeNull();
    expect(ok('s.nope', env)).toBeNull();
    expect(ok('s.nope == null and s.x == 1', env)).toBe(true);
    fails('s.nope + 1', /needs integers/, env);
  });
  it('&&, || and ?: do not evaluate the unused side', () => {
    const env = envOf({});
    expect(ok('false and missing == 1', env)).toBe(false);
    expect(ok('true or missing == 1', env)).toBe(true);
    expect(ok('true ? 1 : missing', env)).toBe(1n);
    expect(ok('false ? missing : 2', env)).toBe(2n);
    fails('true and missing == 1', /unknown name 'missing'/, env);
  });
});

describe('the 256-bit integer cap holds everywhere', () => {
  it('rejects oversized literals and operator results', () => {
    const big = '0x1' + '0'.repeat(64); // 2^256
    fails(big, /overflow/);
    fails(`-${big}`, /overflow/);
    fails(`min(${big}, 1)`, /overflow/);
    fails(`max(1, ${big})`, /overflow/);
    fails(`${big} | 1`, /overflow/);
    fails(`~(${big})`, /overflow/);
    expect(ok('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF')).toBe(2n ** 256n - 1n);
  });
});
