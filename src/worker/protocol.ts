/**
 * Typed message protocol between the main thread and the engine worker.
 *
 * Every request carries a numeric `id`; the response to it carries the same `id`.
 * Ordering rules (enforced by the worker's handler, see engine-handler.ts):
 * - `open` and `parse` supersede any older in-flight `open`/`parse` (a `parse` therefore also supersedes a pending `open`): the old one is aborted and gets NO response.
 *   The client rejects its own pending promises for superseded requests with SupersededError.
 * - `cancel` aborts the running parse only; that parse still answers with a partial snapshot (stats.aborted).
 * - Everything else (`expand`, `nodeAt`, `nodeById`, `ranges`) works on the current parse result.
 * All payloads are structured-cloneable (Node values may be BigInt / Uint8Array).
 */
import type { Diagnostic, LazyArray, Node, ParseStats } from '../core/engine';

export interface SpecInfo {
  id: string;
  name: string;
}

export interface DetectionInfo {
  specId: string;
  name: string;
  score: number;
  reasons: string[];
  magicMatched: boolean;
}

export interface ParseSnapshot {
  specId: string;
  root: Node;
  errors: Diagnostic[];
  stats: ParseStats;
}

/** A leaf byte range [start, end) belonging to the top-level field with index `group`. */
export interface RangeSegment {
  start: number;
  end: number;
  group: number;
}

export type EngineRequest =
  /** `file` null means an empty in-memory source (new file). */
  | { id: number; type: 'open'; file: Blob | null; fileName: string }
  /** `specId` null = "None (raw)": drop the current result. */
  | { id: number; type: 'parse'; specId: string | null }
  | { id: number; type: 'expand'; nodeId: number; start: number; count: number }
  | { id: number; type: 'cancel' }
  | { id: number; type: 'nodeAt'; offset: number }
  | { id: number; type: 'nodeById'; nodeId: number }
  | { id: number; type: 'ranges'; start: number; end: number };

export type EngineResponse =
  | { id: number; type: 'open'; size: number; specs: SpecInfo[]; specErrors: string[]; detections: DetectionInfo[] }
  | { id: number; type: 'parse'; snapshot: ParseSnapshot | null }
  | { id: number; type: 'expand'; nodes: Node[]; lazy: LazyArray | null; newErrors: Diagnostic[] }
  | { id: number; type: 'cancel' }
  /** `path` = node ids from the root to the node (inclusive); null when nothing matched. */
  | { id: number; type: 'located'; path: number[] | null; lazyIndex: number | null }
  | { id: number; type: 'ranges'; segments: RangeSegment[] }
  | { id: number; type: 'error'; message: string };

export type ResponseOf<T extends EngineResponse['type']> = Extract<EngineResponse, { type: T }>;

/** A request without its id (the client assigns ids). */
export type RequestBody = EngineRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;
