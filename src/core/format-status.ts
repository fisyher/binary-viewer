/** Pure text helpers for the status bar's format and parse items. */
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

/**
 * "Suggested from extension only" when the chosen format is the top detection and no magic matched (the file name was
 * the only evidence); null otherwise.
 */
export function suggestionHint(detections: readonly DetectionInfo[], selected: string | null): string | null {
  const top = detections[0];
  return top && selected === top.specId && !top.magicMatched ? `Suggested from ${detectionBasis(top)} only` : null;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The compact parts of a finished parse for the status bar ("22 nodes", "0 errors", "1 warning"); null while there is no tree summary. */
export interface StatusParts {
  /** "Truncated" / "Aborted" for a partial tree, else null. */
  lead: string | null;
  nodes: string;
  errors: string;
  warnings: string;
}

export function statusParts(s: ParseStatus): StatusParts | null {
  if (s.state !== 'done' && s.state !== 'truncated' && s.state !== 'aborted') return null;
  return {
    lead: s.state === 'truncated' ? 'Truncated' : s.state === 'aborted' ? 'Aborted' : null,
    nodes: count(s.nodes ?? 0, 'node'),
    errors: count(s.errors ?? 0, 'error'),
    warnings: count(s.warnings ?? 0, 'warning'),
  };
}
