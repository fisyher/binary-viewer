import { BYTES_PER_ROW } from './hex-format';

/** Anchor + caret selection model; both are byte offsets and the range is inclusive. */
export interface Selection {
  anchor: number;
  caret: number;
}

export type CaretMove =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'pageUp'
  | 'pageDown'
  | 'rowStart'
  | 'rowEnd'
  | 'fileStart'
  | 'fileEnd';

export function selectionRange(sel: Selection): { start: number; end: number; length: number } {
  const start = Math.min(sel.anchor, sel.caret);
  const end = Math.max(sel.anchor, sel.caret);
  return { start, end, length: end - start + 1 };
}

/**
 * New caret offset after a navigation key. Result is always within [0, size-1]
 * (or 0 for an empty source). `pageRows` is the number of rows a page jump covers.
 */
export function moveCaret(
  caret: number,
  move: CaretMove,
  size: number,
  pageRows: number,
  bytesPerRow = BYTES_PER_ROW,
): number {
  if (size <= 0) return 0;
  const last = size - 1;
  const page = Math.max(1, pageRows) * bytesPerRow;
  let next: number;
  switch (move) {
    case 'left':
      next = caret - 1;
      break;
    case 'right':
      next = caret + 1;
      break;
    case 'up':
      next = caret - bytesPerRow;
      break;
    case 'down':
      next = caret + bytesPerRow;
      break;
    case 'pageUp':
      next = caret - page;
      break;
    case 'pageDown':
      next = caret + page;
      break;
    case 'rowStart':
      next = caret - (caret % bytesPerRow);
      break;
    case 'rowEnd':
      next = caret - (caret % bytesPerRow) + bytesPerRow - 1;
      break;
    case 'fileStart':
      next = 0;
      break;
    case 'fileEnd':
      next = last;
      break;
  }
  return Math.min(last, Math.max(0, next));
}

/**
 * Apply a navigation key to a selection. With no selection the move starts from
 * offset 0. `extend` (shift) keeps the anchor; otherwise the selection collapses to the caret.
 */
export function navigate(
  selection: Selection | null,
  move: CaretMove,
  size: number,
  pageRows: number,
  extend: boolean,
): Selection {
  const caret = moveCaret(selection?.caret ?? 0, move, size, pageRows);
  return { anchor: extend ? (selection?.anchor ?? 0) : caret, caret };
}
