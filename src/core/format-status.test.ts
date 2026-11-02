import { describe, expect, it } from 'vitest';
import { describeStatus, statusParts, suggestionHint } from './format-status';
import type { DetectionInfo } from '../worker/protocol';

const det = (specId: string, magicMatched: boolean, reasons: string[] = []): DetectionInfo => ({ specId, name: specId, magicMatched, reasons, score: 1 }) as DetectionInfo;

describe('suggestionHint', () => {
  it('names the extension when the chosen top detection had no magic', () => {
    const d = [det('bmp', false, ['extension .bmp'])];
    expect(suggestionHint(d, 'bmp')).toBe('Suggested from extension only');
  });

  it('is null when magic matched, when another format is chosen, when raw is chosen or nothing was detected', () => {
    expect(suggestionHint([det('bmp', true, ['magic'])], 'bmp')).toBeNull();
    expect(suggestionHint([det('bmp', false, ['extension .bmp'])], 'png')).toBeNull();
    expect(suggestionHint([det('bmp', false, ['extension .bmp'])], null)).toBeNull();
    expect(suggestionHint([], 'bmp')).toBeNull();
  });
});

describe('statusParts', () => {
  it('splits a finished parse into singular/plural counts', () => {
    expect(statusParts({ state: 'done', nodes: 22, errors: 0, warnings: 1 })).toEqual({ lead: null, nodes: '22 nodes', errors: '0 errors', warnings: '1 warning' });
    expect(statusParts({ state: 'done', nodes: 1, errors: 1, warnings: 0 })).toMatchObject({ nodes: '1 node', errors: '1 error', warnings: '0 warnings' });
  });

  it('marks partial trees and has nothing for the other states', () => {
    expect(statusParts({ state: 'truncated', nodes: 5, errors: 0, warnings: 0 })?.lead).toBe('Truncated');
    expect(statusParts({ state: 'aborted', nodes: 5, errors: 0, warnings: 0 })?.lead).toBe('Aborted');
    for (const state of ['idle', 'parsing', 'error'] as const) expect(statusParts({ state })).toBeNull();
  });

  it('describeStatus keeps the full sentence', () => {
    expect(describeStatus({ state: 'done', nodes: 22, errors: 0, warnings: 0 })).toBe('Parsed: 22 nodes, 0 errors, 0 warnings');
  });
});
