/** Pure text helpers for the format bar. */
import type { DetectionInfo } from '../worker/protocol';

/** "magic + extension", "magic" or "extension" (extension-only is only a suggestion). */
export function detectionBasis(d: DetectionInfo): string {
  const ext = d.reasons.some((r) => r.startsWith('extension .') && !r.includes('magic did not match'));
  if (d.magicMatched && ext) return 'magic + extension';
  if (d.magicMatched) return 'magic';
  return 'extension';
}

export function describeDetection(d: DetectionInfo): string {
  return `${d.name} (${detectionBasis(d)})`;
}

export type ParseState = 'idle' | 'parsing' | 'done' | 'truncated' | 'aborted' | 'error';

export interface ParseStatus {
  state: ParseState;
  nodes?: number;
  errors?: number;
  warnings?: number;
  message?: string;
}

export function describeStatus(s: ParseStatus): string {
  const counts = `${s.nodes ?? 0} nodes, ${s.errors ?? 0} errors, ${s.warnings ?? 0} warnings`;
  switch (s.state) {
    case 'idle':
      return '';
    case 'parsing':
      return 'Parsing…';
    case 'done':
      return `Parsed: ${counts}`;
    case 'truncated':
      return `Truncated (limit reached, partial tree): ${counts}`;
    case 'aborted':
      return `Aborted (partial tree): ${counts}`;
    case 'error':
      return s.message ?? 'Parse failed';
  }
}
