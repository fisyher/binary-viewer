import { describe, expect, it } from 'vitest';
import { specText } from '../test/spec-fixtures';
import { checkSpecText, jsonErrorLocation, lineColumn, scanJsonError } from './spec-text';

describe('lineColumn', () => {
  it('is 1-based and clamps', () => {
    expect(lineColumn('ab\ncd', 0)).toEqual({ line: 1, column: 1 });
    expect(lineColumn('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
    expect(lineColumn('ab\ncd', 99)).toEqual({ line: 2, column: 3 });
    expect(lineColumn('ab', -5)).toEqual({ line: 1, column: 1 });
  });
});

describe('jsonErrorLocation', () => {
  it('understands both V8 wordings and EOF', () => {
    expect(jsonErrorLocation('x', 'Unexpected token } in JSON at position 3 (line 2 column 5)')).toEqual({ line: 2, column: 5 });
    expect(jsonErrorLocation('a\nbcd', 'Unexpected token in JSON at position 3')).toEqual({ line: 2, column: 2 });
    expect(jsonErrorLocation('a\nb', 'Unexpected end of JSON input')).toEqual({ line: 2, column: 2 });
    expect(jsonErrorLocation('abc', 'weird')).toEqual({ line: 1, column: 1 });
  });
});

describe('checkSpecText', () => {
  it('accepts a valid spec', () => {
    expect(checkSpecText(specText('ok'))).toEqual({ syntax: null, issues: [], valid: true });
  });

  it('reports the position of a syntax error', () => {
    const r = checkSpecText('{\n  "id": "x",\n  "name": oops\n}');
    expect(r.valid).toBe(false);
    expect(r.syntax).not.toBeNull();
    expect(r.syntax!.line).toBe(3);
    expect(r.syntax!.column).toBeGreaterThanOrEqual(10);
    expect(r.issues).toEqual([]);
  });

  it('reports an unterminated document at its end', () => {
    const r = checkSpecText('{\n  "id": "x"');
    expect(r.syntax).toMatchObject({ line: 2 });
  });

  it('reports schema issues with JSON paths', () => {
    const r = checkSpecText(specText('ok', { root: 'missing', types: { root: { fields: [{ name: 'a', type: 'nope' }] } } }));
    expect(r.syntax).toBeNull();
    expect(r.valid).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
    for (const i of r.issues) expect(i.path).toMatch(/^\$/);
    expect(r.issues.some((i) => i.path.includes('fields[0]'))).toBe(true);
  });

  it('flags ids that are fine for the engine but not allowed for user specs', () => {
    const r = checkSpecText(specText('Upper'));
    expect(r.issues).toEqual([{ path: '$.id', message: expect.stringMatching(/lower-case/) }]);
  });

  it('refuses oversized text without parsing it', () => {
    expect(checkSpecText(' '.repeat(1_048_577)).issues[0]!.message).toMatch(/too large/);
  });
});

describe('scanJsonError', () => {
  it('finds the first offending character', () => {
    expect(scanJsonError('{"a":1,}')).toBe(7);
    expect(scanJsonError('[1 2]')).toBe(3);
    expect(scanJsonError('{"a": oops}')).toBe(6);
    expect(scanJsonError('{"a":"x')).toBe(7);
    expect(scanJsonError('{"a":1} x')).toBe(8);
    expect(scanJsonError('{"a":"\\q"}')).toBe(7);
  });

  it('survives hostile nesting without throwing', () => {
    expect(() => scanJsonError('['.repeat(200_000))).not.toThrow();
  });

  it('is used when the engine message has no position', () => {
    expect(jsonErrorLocation('{\n "a": oops\n}', 'Unexpected identifier "oops"')).toEqual({ line: 2, column: 7 });
  });
});

describe('size checks without encoding', () => {
  it('exceedsBytes decides cheaply when it can and exactly when it must', async () => {
    const { exceedsBytes } = await import('./spec-folder');
    expect(exceedsBytes('x'.repeat(1_048_577))).toBe(true);
    expect(exceedsBytes('x'.repeat(1_048_576))).toBe(false);
    expect(exceedsBytes('x'.repeat(300_000))).toBe(false);
    expect(exceedsBytes('€'.repeat(400_000))).toBe(true); // 3 bytes each: 1.2 MB
    expect(exceedsBytes('€'.repeat(300_000))).toBe(false); // 900 kB
  });
});
