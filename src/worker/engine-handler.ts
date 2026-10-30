/**
 * Pure message handler for the engine worker. All environment access is injected so it can be unit-tested
 * without a real Worker. The handler owns the current ByteSource and ParseResult.
 */
import { BlobByteSource, MemoryByteSource, type ByteSource } from '../core/byte-source';
import * as realEngine from '../core/engine';
import type { FormatSpec, Node, ParseResult } from '../core/engine';
import type { DetectionInfo, EngineRequest, EngineResponse, RangeSegment } from './protocol';

export type EngineApi = Pick<typeof realEngine, 'detect' | 'parse' | 'expandLazy' | 'findNodeAt' | 'lazyElementIndexAt'>;

export interface HandlerDeps {
  specs: readonly FormatSpec[];
  specErrors: readonly string[];
  post(res: EngineResponse): void;
  engine?: EngineApi;
  makeSource?(file: Blob | null): ByteSource;
}

/** Largest byte window a `ranges` request may cover, and the most segments it returns. */
export const MAX_RANGE_WINDOW = 1 << 20;
export const MAX_SEGMENTS = 4096;

interface TreeIndex {
  nodes: Map<number, Node>;
  parent: Map<number, number>;
}

function buildIndex(root: Node): TreeIndex {
  const nodes = new Map<number, Node>();
  const parent = new Map<number, number>();
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    nodes.set(n.id, n);
    for (const c of n.children ?? []) {
      parent.set(c.id, n.id);
      stack.push(c);
    }
  }
  return { nodes, parent };
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

export function createEngineHandler(deps: HandlerDeps) {
  const engine: EngineApi = deps.engine ?? realEngine;
  const makeSource = deps.makeSource ?? ((f: Blob | null) => (f ? new BlobByteSource(f) : new MemoryByteSource(new Uint8Array(0))));
  const names = new Map(deps.specs.map((s) => [s.id, s.name] as const));

  let source: ByteSource | null = null;
  let result: ParseResult | null = null;
  let index: TreeIndex | null = null;
  let extents: Map<Node, { lo: number; hi: number }> | null = null;
  let errorsSent = 0; // diagnostics of `result` already delivered to the client
  let generation = 0; // bumped by open/parse; responses from older generations are dropped
  let parseCtl: AbortController | null = null;
  let lifeCtl: AbortController | null = null; // aborted when the result it belongs to is superseded

  function supersede(): number {
    parseCtl?.abort();
    lifeCtl?.abort();
    parseCtl = lifeCtl = null;
    result = null;
    index = null;
    extents = null;
    errorsSent = 0;
    return ++generation;
  }

  const getIndex = (r: ParseResult) => (index ??= buildIndex(r.root));

  function pathTo(r: ParseResult, id: number): number[] | null {
    const idx = getIndex(r);
    if (!idx.nodes.has(id)) return null;
    const path: number[] = [];
    let cur: number | undefined = id;
    for (let guard = 0; cur !== undefined && guard < 10_000; guard++) {
      path.push(cur);
      cur = idx.parent.get(cur);
    }
    return path.reverse();
  }

  // Per-node byte extent of each subtree (children may sit outside their parent via `at`, so the parent's own
  // range is not a safe bound). Built once per result, dropped when a variable-size expansion adds children.
  function getExtents(root: Node): Map<Node, { lo: number; hi: number }> {
    if (extents) return extents;
    const m = new Map<Node, { lo: number; hi: number }>();
    const walk = (n: Node): { lo: number; hi: number } => {
      let lo = n.size > 0 ? n.offset : Infinity;
      let hi = n.size > 0 ? n.offset + n.size : -Infinity;
      for (const c of n.children ?? []) {
        if (c.typeName === 'bits') continue;
        const e = walk(c);
        if (e.lo < lo) lo = e.lo;
        if (e.hi > hi) hi = e.hi;
      }
      const e = { lo, hi };
      m.set(n, e);
      return e;
    };
    walk(root);
    return (extents = m);
  }

  function collectRanges(root: Node, start: number, end: number): RangeSegment[] {
    const ext = getExtents(root);
    const out: RangeSegment[] = [];
    const visit = (n: Node, group: number): void => {
      if (n.typeName === 'bits') return;
      const e = ext.get(n);
      if (!e || e.lo >= end || e.hi <= start) return; // subtree cannot touch the window
      if (n.children && n.children.length > 0) {
        for (const c of n.children) visit(c, group);
        return;
      }
      out.push({ start: Math.max(start, n.offset), end: Math.min(end, n.offset + n.size), group });
    };
    (root.children ?? []).forEach((c, g) => visit(c, g));
    // The cap applies in window order, not traversal order.
    return out.sort((a, b) => a.start - b.start).slice(0, MAX_SEGMENTS);
  }

  async function dispatch(req: EngineRequest): Promise<EngineResponse | null> {
    const id = req.id;
    switch (req.type) {
      case 'open': {
        const gen = supersede();
        const fileName = typeof req.fileName === 'string' ? req.fileName : '';
        source = makeSource(req.file);
        const found = await engine.detect(deps.specs, fileName, source);
        if (gen !== generation) return null;
        const detections: DetectionInfo[] = found.map((d) => ({ ...d, name: names.get(d.specId) ?? d.specId }));
        return {
          id,
          type: 'open',
          size: source.size,
          specs: deps.specs.map((s) => ({ id: s.id, name: s.name })),
          specErrors: [...deps.specErrors],
          detections,
        };
      }
      case 'parse': {
        const gen = supersede();
        if (req.specId === null) return { id, type: 'parse', snapshot: null };
        const spec = deps.specs.find((s) => s.id === req.specId);
        if (!spec) return { id, type: 'error', message: `unknown format "${String(req.specId)}"` };
        if (!source) return { id, type: 'error', message: 'no file is open' };
        const ctl = (parseCtl = new AbortController());
        lifeCtl = new AbortController();
        const r = await engine.parse(spec, source, { signal: ctl.signal });
        if (gen !== generation) return null;
        result = r;
        errorsSent = r.errors.length; // the snapshot carries them all
        return { id, type: 'parse', snapshot: { specId: spec.id, root: r.root, errors: r.errors, stats: r.stats } };
      }
      case 'cancel':
        parseCtl?.abort();
        return { id, type: 'cancel' };
      case 'expand': {
        if (!result) return { id, type: 'error', message: 'no parse result' };
        if (!isCount(req.nodeId) || !isCount(req.start) || !isCount(req.count)) return { id, type: 'error', message: 'invalid expand range' };
        const gen = generation;
        const r = result;
        const arr = getIndex(r).nodes.get(req.nodeId);
        const childrenBefore = arr?.children?.length ?? 0;
        const nodes = await engine.expandLazy(r, req.nodeId, { start: req.start, count: req.count }, { signal: lifeCtl?.signal });
        if (gen !== generation) return null;
        const lazy = arr?.lazy ?? null;
        if ((arr?.children?.length ?? 0) !== childrenBefore) {
          // Variable-size expansion appended children; fixed-size page loads leave the tree untouched.
          index = null;
          extents = null;
        }
        // Overlapping expands share one cursor, advanced synchronously after the await, so no error is sent twice.
        const newErrors = r.errors.slice(errorsSent);
        errorsSent = r.errors.length;
        return { id, type: 'expand', nodes, lazy, newErrors };
      }
      case 'nodeAt': {
        if (!result) return { id, type: 'located', path: null, lazyIndex: null };
        if (!isCount(req.offset)) return { id, type: 'error', message: 'invalid offset' };
        const node = engine.findNodeAt(result.root, req.offset);
        if (!node) return { id, type: 'located', path: null, lazyIndex: null };
        return { id, type: 'located', path: pathTo(result, node.id), lazyIndex: node.lazy ? engine.lazyElementIndexAt(node, req.offset) : null };
      }
      case 'nodeById': {
        if (!result) return { id, type: 'located', path: null, lazyIndex: null };
        return { id, type: 'located', path: isCount(req.nodeId) ? pathTo(result, req.nodeId) : null, lazyIndex: null };
      }
      case 'ranges': {
        if (!result) return { id, type: 'ranges', segments: [] };
        if (!isCount(req.start) || !isCount(req.end) || req.end < req.start || req.end - req.start > MAX_RANGE_WINDOW) {
          return { id, type: 'error', message: 'invalid byte window' };
        }
        return { id, type: 'ranges', segments: collectRanges(result.root, req.start, req.end) };
      }
      default:
        return { id: (req as { id?: number }).id ?? -1, type: 'error', message: 'unknown request' };
    }
  }

  return {
    /** Handle one request; posts at most one response (none when superseded). Never throws. */
    async handle(req: EngineRequest): Promise<void> {
      const gen = generation;
      try {
        const res = await dispatch(req);
        if (res) deps.post(res);
      } catch (e) {
        // A request that was overtaken by a newer open/parse stays silent even when it failed.
        if (gen !== generation && req.type !== 'open' && req.type !== 'parse') return;
        deps.post({ id: req.id, type: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    },
  };
}
