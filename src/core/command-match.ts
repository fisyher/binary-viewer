/**
 * Fuzzy matching for the command palette: a case-insensitive subsequence match with a score that prefers a prefix,
 * word starts and contiguous runs. Pure; works on characters (a code point plus any combining marks, or a ZWJ
 * sequence, is one step, so a surrogate pair or an accented letter is never cut in half) and reports the matched
 * ranges in UTF-16 code unit indices of the original text, ready to slice for highlighting.
 */

export interface Match {
  /** Higher is better. */
  score: number;
  /** Matched stretches, `[start, end)` in UTF-16 code unit indices of the text, sorted and not touching. */
  ranges: Array<[number, number]>;
}

/** Only this many leading characters of a text are matched; the text is untrusted (spec names) and the match is quadratic. */
const MAX_TEXT = 200;
/** Only this many characters of the query count. */
const MAX_QUERY = 100;

const PREFIX_BONUS = 8;
const WORD_START_BONUS = 6;
const RUN_BONUS = 7;
const GAP_PENALTY = 0.2;
const LEADING_PENALTY = 0.1;
const LENGTH_PENALTY = 0.01;

const isWordChar = (cp: string) => /[\p{L}\p{N}]/u.test(cp);
const MARK = /^\p{M}$/u;
const ZWJ = '‍';

/** Characters of `text` (base code point + combining marks, ZWJ sequences) with the UTF-16 index each starts at. */
function characters(text: string, max: number): { chars: string[]; at: number[] } {
  const chars: string[] = [];
  const at: number[] = [];
  let i = 0;
  for (const cp of text) {
    const last = chars.length - 1;
    if (last >= 0 && (MARK.test(cp) || cp === ZWJ || chars[last]!.endsWith(ZWJ))) chars[last] += cp;
    else {
      if (chars.length >= max) break;
      chars.push(cp);
      at.push(i);
    }
    i += cp.length;
  }
  return { chars, at };
}

// Scratch tables, reused between calls (a search runs this for every command on every keystroke).
let dpBuf = new Float64Array(0);
let parentBuf = new Int32Array(0);
const NEG = -Infinity;

/** Match `query` against `text`; null when the query is not a subsequence. An empty query matches everything with score 0. */
export function fuzzyMatch(query: string, text: string): Match | null {
  // Whitespace in the query only separates words; it is not matched.
  const q = characters(query.replace(/\s+/gu, ''), MAX_QUERY).chars.map((c) => c.toLowerCase());
  const m = q.length;
  if (m === 0) return { score: 0, ranges: [] };
  const { chars: cps, at } = characters(text, MAX_TEXT);
  const n = cps.length;
  const low = cps.map((c) => c.toLowerCase());
  // A query letter without marks also finds the same letter carrying marks (e matches a decomposed é).
  const baseLow = cps.map((c) => String.fromCodePoint(c.codePointAt(0)!).toLowerCase());
  const eq = (i: number, j: number) => low[j] === q[i] || baseLow[j] === q[i];

  // Quick reject: the greedy scan finds a subsequence exactly when one exists.
  let qi = 0;
  for (let j = 0; j < n && qi < m; j++) if (eq(qi, j)) qi++;
  if (qi < m) return null;

  // Score of matching text position j as the next query character: 1, plus a bonus for a prefix or a word start.
  const base = (j: number): number => {
    let s = 1;
    if (j === 0) s += PREFIX_BONUS;
    else {
      const prev = String.fromCodePoint(cps[j - 1]!.codePointAt(0)!);
      const cur = String.fromCodePoint(cps[j]!.codePointAt(0)!);
      const camel = prev !== prev.toUpperCase() && cur === cur.toUpperCase() && cur !== cur.toLowerCase();
      if (!isWordChar(prev) || camel) s += WORD_START_BONUS;
    }
    return s;
  };

  // dp[i*n+j]: best score with query[0..i] matched and query[i] at text position j. parent: where query[i-1] was.
  if (dpBuf.length < m * n) {
    dpBuf = new Float64Array(m * n);
    parentBuf = new Int32Array(m * n);
  }
  const dp = dpBuf;
  const parent = parentBuf;
  dp.fill(NEG, 0, m * n);
  parent.fill(-1, 0, m * n);
  for (let j = 0; j < n; j++) if (eq(0, j)) dp[j] = base(j) - LEADING_PENALTY * Math.min(j, 30);
  for (let i = 1; i < m; i++) {
    const row = i * n;
    const prev = row - n;
    // Best earlier start with a gap: prev[k] + GAP*k - GAP*(j-1), maximised over k <= j-2 as j advances.
    let bestGap = NEG;
    let bestK = -1;
    for (let j = 1; j < n; j++) {
      const k = j - 2;
      if (k >= 0 && dp[prev + k]! !== NEG && dp[prev + k]! + GAP_PENALTY * k > bestGap) {
        bestGap = dp[prev + k]! + GAP_PENALTY * k;
        bestK = k;
      }
      if (!eq(i, j)) continue;
      let best = NEG;
      let from = -1;
      if (dp[prev + j - 1]! !== NEG) {
        best = dp[prev + j - 1]! + RUN_BONUS;
        from = j - 1;
      }
      if (bestK >= 0) {
        const viaGap = bestGap - GAP_PENALTY * (j - 1);
        if (viaGap > best) {
          best = viaGap;
          from = bestK;
        }
      }
      if (from >= 0) {
        dp[row + j] = best + base(j);
        parent[row + j] = from;
      }
    }
  }

  const last = (m - 1) * n;
  let end = -1;
  for (let j = 0; j < n; j++) if (dp[last + j]! !== NEG && (end < 0 || dp[last + j]! > dp[last + end]!)) end = j;
  if (end < 0) return null; // unreachable after the quick reject, kept for safety

  const picked: number[] = [];
  for (let i = m - 1, j = end; i >= 0; i--) {
    picked.push(j);
    j = parent[i * n + j]!;
  }
  picked.reverse();

  const ranges: Array<[number, number]> = [];
  for (const j of picked) {
    const s = at[j]!;
    const e = s + cps[j]!.length;
    const lastRange = ranges[ranges.length - 1];
    if (lastRange && lastRange[1] === s) lastRange[1] = e;
    else ranges.push([s, e]);
  }
  return { score: dp[last + end]! - LENGTH_PENALTY * n, ranges };
}

export interface Ranked<T> {
  item: T;
  match: Match;
}

/** The items whose text matches `query`, best first (ties keep the input order). An empty query keeps everything in order. */
export function rankMatches<T>(query: string, items: readonly T[], textOf: (item: T) => string): Ranked<T>[] {
  const out: Array<Ranked<T> & { i: number }> = [];
  items.forEach((item, i) => {
    const match = fuzzyMatch(query, textOf(item));
    if (match) out.push({ item, match, i });
  });
  if (query.trim() !== '') out.sort((a, b) => b.match.score - a.match.score || a.i - b.i);
  return out.map(({ item, match }) => ({ item, match }));
}

export interface Segment {
  text: string;
  hit: boolean;
}

/** Cut `text` into alternating plain and matched segments for rendering (as text, never as markup). Ranges outside the text are ignored. */
export function splitByRanges(text: string, ranges: ReadonlyArray<readonly [number, number]>): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (const [s0, e0] of ranges) {
    const s = Math.max(pos, Math.min(s0, text.length));
    const e = Math.min(e0, text.length);
    if (e <= s) continue;
    if (s > pos) out.push({ text: text.slice(pos, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    pos = e;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}
