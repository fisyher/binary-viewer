import { describe, expect, it } from 'vitest';
import { fuzzyMatch, rankMatches, splitByRanges } from './command-match';

const hits = (text: string, q: string) => {
  const m = fuzzyMatch(q, text);
  return m ? m.ranges.map(([s, e]) => text.slice(s, e)) : null;
};

describe('fuzzyMatch', () => {
  it('matches a case-insensitive subsequence and reports the ranges', () => {
    expect(hits('Show Structure', 'shst')).toEqual(['Sh', 'St']);
    expect(hits('Go to offset…', 'GO')).toEqual(['Go']);
    expect(fuzzyMatch('xyz', 'Show Structure')).toBeNull();
    expect(fuzzyMatch('ab', 'ba')).toBeNull(); // order matters
  });

  it('merges adjacent matches into one range', () => {
    expect(fuzzyMatch('minimap', 'Hide minimap')!.ranges).toEqual([[5, 12]]);
  });

  it('matches everything with an empty or blank query', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, ranges: [] });
    expect(fuzzyMatch('   ', 'anything')).toEqual({ score: 0, ranges: [] });
  });

  it('ignores whitespace in the query', () => {
    expect(hits('Go to offset…', 'go to')).toEqual(['Go', 'to']);
    expect(fuzzyMatch('side bar', 'Hide sidebar')).not.toBeNull();
  });

  it('prefers a prefix over a word start over a mid-word match', () => {
    const prefix = fuzzyMatch('sh', 'Show side bar')!.score;
    const wordStart = fuzzyMatch('sh', 'Toggle show')!.score;
    const mid = fuzzyMatch('sh', 'Fresh')!.score;
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(mid);
  });

  it('prefers a contiguous run over scattered letters', () => {
    expect(fuzzyMatch('map', 'xminimap')!.score).toBeGreaterThan(fuzzyMatch('map', 'xmxaxp')!.score);
  });

  it('treats camelCase humps as word starts', () => {
    expect(fuzzyMatch('ob', 'fooBar')!.score).toBeLessThan(fuzzyMatch('fb', 'fooBar')!.score);
    expect(fuzzyMatch('b', 'fooBar')!.score).toBeGreaterThan(fuzzyMatch('b', 'foobar')!.score);
  });

  it('picks the best alignment, not the first one', () => {
    // "ab" appears early as scattered letters and later as a run at a word start; the run wins.
    const m = fuzzyMatch('ab', 'zzazb ab')!;
    expect(m.ranges).toEqual([[6, 8]]);
  });

  it('indexes by UTF-16 units but steps by code points', () => {
    const text = '😀 Größe öffnen';
    const m = fuzzyMatch('öff', text)!;
    expect(m.ranges.map(([s, e]) => text.slice(s, e))).toEqual(['öff']);
    expect(hits(text, '😀g')).toEqual(['😀', 'G']);
    expect(hits(text, 'ÖFF')).toEqual(['öff']);
  });

  it('is not fooled by characters that change length when lowercased', () => {
    expect(() => fuzzyMatch('i', 'İstanbul')).not.toThrow();
    expect(fuzzyMatch('x', 'İstanbul')).toBeNull();
  });

  it('is safe on untrusted text: markup, regex characters, very long names', () => {
    expect(hits('<img src=x onerror=alert(1)>', 'img')).toEqual(['img']);
    expect(hits('a.*b(c', '.*')).toEqual(['.*']);
    expect(fuzzyMatch('(', 'no paren')).toBeNull();
    const long = 'a'.repeat(100_000) + 'z';
    expect(fuzzyMatch('z', long)).toBeNull(); // only the leading part of a text is matched
    expect(fuzzyMatch('aaaa', long)).not.toBeNull();
    expect(fuzzyMatch('q'.repeat(10_000), 'q'.repeat(150))).not.toBeNull(); // the query is capped
  });
});

describe('fuzzyMatch: surrogate pairs and combining marks', () => {
  const sliceAll = (text: string, q: string) => fuzzyMatch(q, text)!.ranges.map(([s, e]) => text.slice(s, e));
  const halves = /^[\uDC00-\uDFFF́]|[\uD800-\uDBFF]$/;

  it('never cuts an emoji or other astral character in half', () => {
    const text = 'a\u{1F600}b\u{1D11E}c';
    expect(sliceAll(text, '\u{1F600}')).toEqual(['\u{1F600}']);
    expect(sliceAll(text, 'a\u{1F600}b\u{1D11E}')).toEqual(['a\u{1F600}b\u{1D11E}']);
    for (const q of ['a', 'b', 'c', '\u{1D11E}c']) {
      for (const [s, e] of fuzzyMatch(q, text)!.ranges) expect(text.slice(s, e)).not.toMatch(halves);
    }
    expect(fuzzyMatch('\uD83D', text)).toBeNull(); // a lone surrogate matches nothing
  });

  it('keeps a ZWJ sequence and a variation selector whole', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const text = `x ${family} y`;
    expect(sliceAll(text, family)).toEqual([family]);
    expect(sliceAll(text, 'y')).toEqual(['y']);
    expect(sliceAll('❤️ love', '❤')).toEqual(['❤️']);
  });

  it('treats a base letter and its combining marks as one character', () => {
    const text = 'Café menu'; // e + combining acute
    expect(sliceAll(text, 'cafe')).toEqual(['Café']);
    expect(sliceAll(text, 'é')).toEqual(['é']);
    for (const q of ['cafe', 'e', 'menu']) {
      for (const [s, e] of fuzzyMatch(q, text)!.ranges) expect(text.slice(s, e)).not.toMatch(/^́/);
    }
  });

  it('a mark does not turn the next letter into a word start', () => {
    const mid = fuzzyMatch('t', 'ét')!.score;
    const start = fuzzyMatch('t', 'e t')!.score;
    expect(start).toBeGreaterThan(mid);
  });

  it('highlighting with these ranges yields whole characters', () => {
    const text = 'Open \u{1F600} café';
    const m = fuzzyMatch('o\u{1F600}e', text)!;
    const segs = splitByRanges(text, m.ranges);
    expect(segs.map((x) => x.text).join('')).toBe(text);
    for (const x of segs) expect(x.text).not.toMatch(halves);
  });
});

describe('rankMatches', () => {
  const labels = ['Hide side bar', 'Show Structure', 'Hide minimap', 'Open file…'];

  it('keeps the input order for an empty query', () => {
    expect(rankMatches('', labels, (s) => s).map((r) => r.item)).toEqual(labels);
  });

  it('drops non-matches and puts the best match first', () => {
    const r = rankMatches('hide', labels, (s) => s).map((r) => r.item);
    expect([...r].sort()).toEqual(['Hide minimap', 'Hide side bar']);
    expect(rankMatches('str', labels, (s) => s)[0]!.item).toBe('Show Structure');
    expect(rankMatches('mini', labels, (s) => s)[0]!.item).toBe('Hide minimap');
  });

  it('is stable for equal scores', () => {
    const r = rankMatches('a', ['a1', 'a2', 'a3'], (s) => s).map((x) => x.item);
    expect(r).toEqual(['a1', 'a2', 'a3']);
  });
});

describe('splitByRanges', () => {
  it('cuts text into plain and matched segments', () => {
    expect(splitByRanges('Hide minimap', [[0, 1], [5, 12]])).toEqual([
      { text: 'H', hit: true },
      { text: 'ide ', hit: false },
      { text: 'minimap', hit: true },
    ]);
  });

  it('returns the whole text without ranges and ignores bad ranges', () => {
    expect(splitByRanges('abc', [])).toEqual([{ text: 'abc', hit: false }]);
    expect(splitByRanges('abc', [[5, 9], [2, 1]])).toEqual([{ text: 'abc', hit: false }]);
    expect(splitByRanges('abc', [[1, 99]])).toEqual([
      { text: 'a', hit: false },
      { text: 'bc', hit: true },
    ]);
    expect(splitByRanges('', [])).toEqual([]);
  });

  it('never produces markup: segments are plain strings', () => {
    const segs = splitByRanges('<b>x</b>', [[0, 3]]);
    expect(segs.map((s) => s.text).join('')).toBe('<b>x</b>');
  });
});
