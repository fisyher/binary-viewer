/**
 * Format detection: magic bytes outrank extension. All reads are small and bounds-checked.
 *
 * Scoring: magic match (every `detect` rule matches) = 100 + min(significant magic bytes, 16), where a byte is
 * significant if its mask byte is non-zero (an all-zero mask is rejected as invalid, it would match everything);
 * extension match = +30 without a magic match, but only +10 when the spec has magic rules that did not
 * match (so a mismatching file named *.bmp ranks below any real magic match). Specs with no evidence
 * are not returned.
 */
import type { ByteSource } from '../byte-source';
import type { DetectRule, FormatSpec } from './schema';
import { parseHexBytes } from './schema';

export interface DetectResult {
  specId: string;
  score: number;
  reasons: string[];
  magicMatched: boolean;
}

export const SCORE_MAGIC = 100;
export const SCORE_EXTENSION = 30;
export const SCORE_EXTENSION_MAGIC_MISMATCH = 10;

async function matchRule(rule: DetectRule, source: ByteSource): Promise<{ ok: boolean; reason: string; length: number }> {
  const want = parseHexBytes(rule.bytes, 64);
  const mask = rule.mask === undefined ? null : parseHexBytes(rule.mask, 64);
  if (!want || (rule.mask !== undefined && (!mask || mask.length !== want.length || mask.every((b) => b === 0)))) {
    return { ok: false, reason: 'invalid detect rule', length: 0 };
  }
  const significant = mask ? mask.reduce((n, b) => n + (b !== 0 ? 1 : 0), 0) : want.length;
  if (!Number.isSafeInteger(rule.at)) return { ok: false, reason: 'invalid detect offset', length: significant };
  const off = rule.at >= 0 ? rule.at : source.size + rule.at;
  const where = rule.at >= 0 ? `offset ${rule.at}` : `${-rule.at} bytes before end`;
  if (off < 0 || off + want.length > source.size) return { ok: false, reason: `magic at ${where}: out of bounds`, length: significant };
  let got: Uint8Array;
  try {
    got = await source.read(off, want.length);
  } catch {
    return { ok: false, reason: `magic at ${where}: read failed`, length: significant };
  }
  if (got.length !== want.length) return { ok: false, reason: `magic at ${where}: short read`, length: significant };
  for (let i = 0; i < want.length; i++) {
    const m = mask ? mask[i]! : 0xff;
    if ((got[i]! & m) !== (want[i]! & m)) return { ok: false, reason: `magic at ${where}: mismatch`, length: significant };
  }
  return { ok: true, reason: `magic ${rule.bytes.trim()} at ${where}`, length: significant };
}

function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** Rank specs for a file. Highest score first; ties keep the order of `specs`. */
export async function detect(specs: readonly FormatSpec[], fileName: string, source: ByteSource): Promise<DetectResult[]> {
  const ext = extensionOf(fileName);
  const results: DetectResult[] = [];
  for (const spec of specs) {
    const reasons: string[] = [];
    let score = 0;
    let magicMatched = false;
    const rules = spec.detect ?? [];
    let magicBytes = 0;
    if (rules.length > 0) {
      let all = true;
      for (const rule of rules) {
        const m = await matchRule(rule, source);
        reasons.push(m.reason);
        magicBytes += m.length;
        if (!m.ok) all = false;
      }
      magicMatched = all;
      if (all) score += SCORE_MAGIC + Math.min(magicBytes, 16);
    }
    const extMatch = ext !== '' && (spec.extensions ?? []).some((e) => e.toLowerCase() === ext);
    if (extMatch) {
      if (magicMatched || rules.length === 0) {
        score += SCORE_EXTENSION;
        reasons.push(`extension .${ext}`);
      } else {
        score += SCORE_EXTENSION_MAGIC_MISMATCH;
        reasons.push(`extension .${ext} (but magic did not match)`);
      }
    }
    if (score > 0) results.push({ specId: spec.id, score, reasons, magicMatched });
  }
  return results.map((r, i) => ({ r, i })).sort((a, b) => b.r.score - a.r.score || a.i - b.i).map((x) => x.r);
}
