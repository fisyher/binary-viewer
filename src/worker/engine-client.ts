/** Main-thread client for the engine worker: request ids, promise plumbing, supersede handling. */
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

export interface OpenResult {
  size: number;
  specs: SpecInfo[];
  specErrors: string[];
  detections: DetectionInfo[];
}
export interface ExpandResult {
  nodes: Node[];
  lazy: LazyArray | null;
  newErrors: Diagnostic[];
}
export interface Located {
  path: number[] | null;
  lazyIndex: number | null;
}

export interface EngineClient {
  open(file: Blob | null, fileName: string): Promise<OpenResult>;
  parse(specId: string | null): Promise<ParseSnapshot | null>;
  expand(nodeId: number, start: number, count: number): Promise<ExpandResult>;
  /** Abort the running parse; the pending parse() resolves with a partial snapshot (stats.aborted). */
  cancel(): void;
  nodeAt(offset: number): Promise<Located>;
  nodeById(nodeId: number): Promise<Located>;
  ranges(start: number, end: number): Promise<RangeSegment[]>;
  /**
   * Called once when the worker fails fatally (script failed to load, startup exception, unreadable message).
   * After that every request rejects with EngineFatalError. Fires immediately if it already happened.
   */
  onFatal(cb: (message: string) => void): void;
  dispose(): void;
}

/** The worker is unusable; the message says why. */
export class EngineFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineFatalError';
  }
}

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
      rejectWhere(() => true, () => new SupersededError());
      return send<'open'>({ type: 'open', file, fileName });
    },
    async parse(specId) {
      // A parse supersedes everything in flight, including a pending open (same rule as the worker's handler).
      rejectWhere((k) => k !== 'cancel', () => new SupersededError());
      return (await send<'parse'>({ type: 'parse', specId })).snapshot;
    },
    expand: async (nodeId, start, count) => {
      const { nodes, lazy, newErrors } = await send<'expand'>({ type: 'expand', nodeId, start, count });
      return { nodes, lazy, newErrors };
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
