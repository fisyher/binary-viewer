/** Undo/redo over immutable values (models). Capped; every function returns a new History. */

export interface History<T> {
  past: readonly T[];
  present: T;
  future: readonly T[];
  cap: number;
}

export const DEFAULT_HISTORY_CAP = 100;

export function createHistory<T>(present: T, cap = DEFAULT_HISTORY_CAP): History<T> {
  return { past: [], present, future: [], cap: Math.max(1, cap) };
}

/** Record `next` as the new present. A value identical to the present is ignored; redo is discarded. */
export function pushState<T>(h: History<T>, next: T): History<T> {
  if (Object.is(next, h.present)) return h;
  const past = [...h.past, h.present];
  while (past.length > h.cap) past.shift();
  return { ...h, past, present: next, future: [] };
}

export const canUndo = <T>(h: History<T>): boolean => h.past.length > 0;
export const canRedo = <T>(h: History<T>): boolean => h.future.length > 0;

export function undo<T>(h: History<T>): History<T> {
  const prev = h.past[h.past.length - 1];
  if (prev === undefined) return h;
  return { ...h, past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}

export function redo<T>(h: History<T>): History<T> {
  const next = h.future[0];
  if (next === undefined) return h;
  return { ...h, past: [...h.past, h.present], present: next, future: h.future.slice(1) };
}

/** Start over from `present` (used when the text was changed elsewhere). */
export function resetHistory<T>(h: History<T>, present: T): History<T> {
  return createHistory(present, h.cap);
}
