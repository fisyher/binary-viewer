/**
 * Typed message protocol between the main thread and the engine worker.
 *
 * Every request carries a numeric `id`; the response to it carries the same `id`.
 * Ordering rules (enforced by the worker's handler, see engine-handler.ts):
 * - `open` and `parse` supersede any older in-flight `open`/`parse` (a `parse` therefore also supersedes a pending `open`): the old one is aborted and gets NO response.
 *   The client rejects its own pending promises for superseded requests with SupersededError.
 * - `parseDraft` (parse with an unsaved spec text, validated in the worker) supersedes exactly like `parse` and answers with a `parse` response.
 * - `setSpecs` replaces the custom spec set. It does not supersede anything (a running parse keeps the spec it started with).
 * - `cancel` aborts the running parse only; that parse still answers with a partial snapshot (stats.aborted).
 * - Everything else (`expand`, `expandRef`, `nodeAt`, `nodeById`, `ranges`) works on the current parse result.
 * - `expandRef` opens a `ref` node: the worker parses the target type, attaches it under the node in its own tree and
 *   returns the new node(s); the client attaches the same nodes to its copy. Opening twice returns the same nodes.
 * All payloads are structured-cloneable (Node values may be BigInt / Uint8Array).
 * The worker owns the authoritative ParseResult and the ByteSource; the main thread holds a cloned copy of the tree and
 * refers to nodes by `Node.id` (stable for one parse result). Offsets are absolute file offsets in bytes; node ids,
 * counts and offsets from the main thread are re-validated by the worker (invalid ones answer with an `error` response).
 * Any request except `cancel` may be answered with `{type: 'error'}` (client: the promise rejects with Error(message)).
 * Without a parse result, `expand` and `expandRef` answer with an error; `nodeAt`, `nodeById` and `ranges` answer
 * with an empty/null result.
 */
import type { Diagnostic, LazyArray, Node, ParseStats } from '../core/engine';

/** A selectable format as shown in the UI. */
export interface SpecInfo {
  id: string;
  name: string;
  /** True for user-created specs (as opposed to built-ins). */
  custom?: boolean;
}

/** One format that looks like a match for the opened file, from magic/extension sniffing (see detect.ts). */
export interface DetectionInfo {
  specId: string;
  name: string;
  /** Ranking value (higher is a better match); only meaningful for comparing candidates within one `open` response. */
  score: number;
  reasons: string[];
  magicMatched: boolean;
}

/**
 * The initial parse result as copied to the main thread. `errors` holds every diagnostic so far; later ones arrive
 * as `newErrors` on `expand`/`expandRef` responses (each diagnostic is delivered once).
 */
export interface ParseSnapshot {
  specId: string;
  root: Node;
  errors: Diagnostic[];
  stats: ParseStats;
}

/**
 * A leaf byte range [start, end) (absolute offsets), clipped to the requested window, belonging to the child of the
 * root with index `group` (used for colouring). Nodes of type `bits` are not included.
 */
export interface RangeSegment {
  start: number;
  end: number;
  group: number;
}

/**
 * Messages main thread -> worker. `expand` `start`/`count` are element indices of the lazy array `nodeId` (not
 * bytes; the interpreter caps `count`); `nodeAt` `offset` is an absolute byte offset; `ranges` is the window
 * [start, end) in bytes (at most MAX_RANGE_WINDOW wide, results capped at MAX_SEGMENTS; both in engine-handler.ts).
 */
export type EngineRequest =
  /** `file` null means an empty in-memory source (new file). */
  | { id: number; type: 'open'; file: Blob | null; fileName: string }
  /** `specId` null = "None (raw)": drop the current result. */
  | { id: number; type: 'parse'; specId: string | null }
  /** Unsaved spec JSON text: validated (loadSpec) in the worker, then parsed against the open document. */
  | { id: number; type: 'parseDraft'; specText: string }
  /** Raw JSON texts of the user's specs. The worker re-validates each one; invalid ones are left out and reported. */
  | { id: number; type: 'setSpecs'; specTexts: string[] }
  | { id: number; type: 'expand'; nodeId: number; start: number; count: number }
  | { id: number; type: 'expandRef'; nodeId: number }
  | { id: number; type: 'cancel' }
  | { id: number; type: 'nodeAt'; offset: number }
  | { id: number; type: 'nodeById'; nodeId: number }
  | { id: number; type: 'ranges'; start: number; end: number };

/**
 * Messages worker -> main thread, one per request (matched by `id`), except superseded open/parse requests, which
 * get none. `nodeAt` and `nodeById` both answer with `located`. `expand.lazy` is the array node's updated LazyArray
 * state (null when the node is unknown). For variable-size arrays the returned `nodes` are also appended to the
 * worker's tree, so the client must append them to its copy; fixed-size pages are detached and only returned. A
 * limit or abort during expansion gives a short `nodes` list, with the reason in `newErrors`.
 */
export type EngineResponse =
  | { id: number; type: 'open'; size: number; specs: SpecInfo[]; specErrors: string[]; detections: DetectionInfo[] }
  | { id: number; type: 'parse'; snapshot: ParseSnapshot | null }
  /** `rejected`: one readable message per text that was not accepted. */
  | { id: number; type: 'setSpecs'; specs: SpecInfo[]; rejected: string[] }
  | { id: number; type: 'expand'; nodes: Node[]; lazy: LazyArray | null; newErrors: Diagnostic[] }
  | { id: number; type: 'expandRef'; nodes: Node[]; newErrors: Diagnostic[] }
  | { id: number; type: 'cancel' }
  /** `path` = node ids from the root to the node (inclusive); null when nothing matched. */
  | { id: number; type: 'located'; path: number[] | null; lazyIndex: number | null }
  | { id: number; type: 'ranges'; segments: RangeSegment[] }
  | { id: number; type: 'error'; message: string };

/** Narrow EngineResponse to the member with the given `type`. */
export type ResponseOf<T extends EngineResponse['type']> = Extract<EngineResponse, { type: T }>;

/** A request without its id (the client assigns ids). */
export type RequestBody = EngineRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;
