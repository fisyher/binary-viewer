/**
 * Main-thread client for the engine worker: request ids, promise plumbing, supersede handling.
 * All methods are main-thread only and return promises; none throws synchronously. A worker-side failure
 * rejects with Error(message); a request replaced by a newer open/parse rejects with SupersededError (callers should
 * ignore it); after a fatal worker failure everything rejects with EngineFatalError. See protocol.ts for the message
 * semantics.
 */
import type { Diagnostic, LazyArray, Node } from '../core/engine';
import type {
  DetectionInfo,
  EngineRequest,
  EngineResponse,
  ParseSnapshot,
  RangeSegment,
  RequestBody,
  ResponseOf,
  SpecInfo,
} from './protocol';

/** The request was replaced by a newer open/parse (or the client was closed). Callers should ignore it. */
export class SupersededError extends Error {
  constructor() {
    super('superseded');
    this.name = 'SupersededError';
  }
}

/** Answer to `open`. */
export interface OpenResult {
  /** Length of the opened document in bytes. */
  size: number;
  specs: SpecInfo[];
  specErrors: string[];
  detections: DetectionInfo[];
}
/** `rejected` has one readable message per text that was not accepted (the worker caps how many it reports). */
export interface SetSpecsResult {
  specs: SpecInfo[];
  rejected: string[];
}
/** Answer to `expand`: the freshly parsed elements, the array's updated lazy state and diagnostics not seen before. */
export interface ExpandResult {
  nodes: Node[];
  lazy: LazyArray | null;
  newErrors: Diagnostic[];
}
/** Answer to `expandRef`: the target node(s) to attach under the ref node (the same nodes if it was opened before). */
export interface RefResult {
  nodes: Node[];
  newErrors: Diagnostic[];
}
/**
 * Result of a node lookup. `path` is the node ids from the root down to the node (inclusive) or null if none matched;
 * `lazyIndex` (nodeAt only) is the element index when the hit is an unexpanded fixed-size lazy array.
 */
export interface Located {
  path: number[] | null;
  lazyIndex: number | null;
}

/** The worker API as used by the app. Obtain one with `createWorkerClient()`. */
export interface EngineClient {
  /**
   * Open a document (`null` = empty in-memory file) and sniff matching formats. Supersedes any pending open/parse and
   * drops the previous parse result. The Blob is read lazily by the worker, so it must stay readable while open.
   */
  open(file: Blob | null, fileName: string): Promise<OpenResult>;
  /** Parse the open document with a built-in/custom spec; `null` clears the result and resolves null. Rejects if no file is open or the id is unknown. */
  parse(specId: string | null): Promise<ParseSnapshot | null>;
  /** Parse the open document with an unsaved spec text (validated in the worker). Supersedes like parse(). */
  parseDraft(specText: string): Promise<ParseSnapshot | null>;
  /** Replace the worker's custom spec set. Never superseded by open/parse. */
  setSpecs(specTexts: string[]): Promise<SetSpecsResult>;
  /** Load elements `[start, start+count)` of the lazy array node `nodeId` (element indices, not bytes). Rejects with SupersededError if a new open/parse replaces the result meanwhile. */
  expand(nodeId: number, start: number, count: number): Promise<ExpandResult>;
  /** Open a `ref` node: parse its target type and get the node(s) to attach under it. */
  expandRef(nodeId: number): Promise<RefResult>;
  /** Abort the running parse; the pending parse() resolves with a partial snapshot (stats.aborted). */
  cancel(): void;
  /** Deepest node covering the absolute byte `offset` (hex click -> tree). Resolves `{path: null}` when nothing matches or there is no result. */
  nodeAt(offset: number): Promise<Located>;
  /** Path from the root to `nodeId` (`path` null if unknown). */
  nodeById(nodeId: number): Promise<Located>;
  /** Leaf byte ranges within the window [start, end) for colouring the hex view; the worker limits the window width and the number of segments. */
  ranges(start: number, end: number): Promise<RangeSegment[]>;
  /**
   * Called once when the worker fails fatally (script failed to load, startup exception, unreadable message).
   * After that every request rejects with EngineFatalError. Fires immediately if it already happened.
   */
  onFatal(cb: (message: string) => void): void;
  /** Reject everything pending with SupersededError and terminate the worker. The client is unusable afterwards. */
  dispose(): void;
}

/** The worker is unusable; the message says why. */
export class EngineFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineFatalError';
  }
}

/** The message channel under a client (a Worker in the app, a fake in tests). */
export interface Transport {
  post(req: EngineRequest): void;
  onMessage(cb: (res: EngineResponse) => void): void;
  onError(cb: (message: string) => void): void;
  close(): void;
}

type Kind = EngineRequest['type'];
interface Pending {
  kind: Kind;
  resolve(res: EngineResponse): void;
  reject(e: unknown): void;
}

/** Build a client over any Transport. Request ids are assigned here, per client, starting at 1. */
export function createClient(t: Transport): EngineClient {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let fatal: EngineFatalError | null = null;
  let fatalCb: ((message: string) => void) | null = null;

  function rejectWhere(pred: (k: Kind) => boolean, err: () => unknown): void {
    for (const [id, p] of [...pending]) {
      if (pred(p.kind)) {
        pending.delete(id);
        p.reject(err());
      }
    }
  }

  t.onMessage((res) => {
    const p = pending.get(res.id);
    if (!p) return; // stale: already superseded
    pending.delete(res.id);
    if (res.type === 'error') p.reject(new Error(res.message));
    else p.resolve(res);
  });
  t.onError((message) => {
    if (fatal) return;
    fatal = new EngineFatalError(message);
    rejectWhere(() => true, () => fatal);
    fatalCb?.(message);
  });

  function send<T extends EngineResponse['type']>(req: RequestBody): Promise<ResponseOf<T>> {
    if (fatal) return Promise.reject(fatal);
    const id = nextId++;
    return new Promise<ResponseOf<T>>((resolve, reject) => {
      pending.set(id, { kind: req.type, resolve: resolve as (r: EngineResponse) => void, reject });
      t.post({ ...req, id } as EngineRequest);
    });
  }

  return {
    open(file, fileName) {
      rejectWhere((k) => k !== 'setSpecs', () => new SupersededError());
      return send<'open'>({ type: 'open', file, fileName });
    },
    async parse(specId) {
      // A parse supersedes everything in flight, including a pending open (same rule as the worker's handler).
      rejectWhere((k) => k !== 'cancel' && k !== 'setSpecs', () => new SupersededError());
      return (await send<'parse'>({ type: 'parse', specId })).snapshot;
    },
    async parseDraft(specText) {
      rejectWhere((k) => k !== 'cancel' && k !== 'setSpecs', () => new SupersededError());
      return (await send<'parse'>({ type: 'parseDraft', specText })).snapshot;
    },
    setSpecs: async (specTexts) => {
      const { specs, rejected } = await send<'setSpecs'>({ type: 'setSpecs', specTexts });
      return { specs, rejected };
    },
    expand: async (nodeId, start, count) => {
      const { nodes, lazy, newErrors } = await send<'expand'>({ type: 'expand', nodeId, start, count });
      return { nodes, lazy, newErrors };
    },
    expandRef: async (nodeId) => {
      const { nodes, newErrors } = await send<'expandRef'>({ type: 'expandRef', nodeId });
      return { nodes, newErrors };
    },
    cancel() {
      send<'cancel'>({ type: 'cancel' }).catch(() => {});
    },
    nodeAt: async (offset) => {
      const { path, lazyIndex } = await send<'located'>({ type: 'nodeAt', offset });
      return { path, lazyIndex };
    },
    nodeById: async (nodeId) => {
      const { path, lazyIndex } = await send<'located'>({ type: 'nodeById', nodeId });
      return { path, lazyIndex };
    },
    ranges: async (start, end) => (await send<'ranges'>({ type: 'ranges', start, end })).segments,
    onFatal(cb) {
      fatalCb = cb;
      if (fatal) cb(fatal.message);
    },
    dispose() {
      rejectWhere(() => true, () => new SupersededError());
      t.close();
    },
  };
}

/** Real client: runs src/worker/engine.worker.ts in a module Worker. Throws if Workers are unavailable. */
export function createWorkerClient(): EngineClient {
  const worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
  return createClient({
    post: (req) => worker.postMessage(req),
    onMessage: (cb) => worker.addEventListener('message', (e: MessageEvent<EngineResponse>) => cb(e.data)),
    onError: (cb) => {
      worker.addEventListener('error', (e) => cb(e.message || 'engine worker failed'));
      worker.addEventListener('messageerror', () => cb('engine worker sent an unreadable message'));
    },
    close: () => worker.terminate(),
  });
}
