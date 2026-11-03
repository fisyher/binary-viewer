/**
 * Pure message handler for the engine worker. All environment access is injected so it can be unit-tested
 * without a real Worker. The handler owns the current ByteSource and ParseResult.
 */
import { BlobByteSource, MemoryByteSource, type ByteSource } from '../core/byte-source';
import * as realEngine from '../core/engine';
import { groupOfIndex, topGroupNodes } from '../core/groups';
import type { FormatSpec, Node, ParseResult } from '../core/engine';
import { clampBuckets, computeOverview, computeRegions, type OverviewRegion } from './overview';
import type { DetectionInfo, EngineRequest, EngineResponse, RangeSegment, SpecInfo } from './protocol';

export type EngineApi = Pick<typeof realEngine, 'detect' | 'parse' | 'expandLazy' | 'findNodeAt' | 'lazyElementIndexAt'> & Partial<Pick<typeof realEngine, 'expandRef'>>;

export interface HandlerDeps {
  /** Built-in specs (already validated). User specs arrive later through `setSpecs`. */
  specs: readonly FormatSpec[];
  specErrors: readonly string[];
  post(res: EngineResponse): void;
  engine?: EngineApi;
  makeSource?(file: Blob | null): ByteSource;
}

/** Largest byte window a `ranges` request may cover, and the most segments it returns. */
export const MAX_RANGE_WINDOW = 1 << 20;
export const MAX_SEGMENTS = 4096;
/** Most custom specs the worker accepts in one `setSpecs`. */
export const MAX_CUSTOM_SPECS = 500;
/** Hard limits on one `setSpecs` request, checked before anything is validated. */
export const MAX_SETSPECS_ITEMS = 1000;
export const MAX_SETSPECS_BYTES = 64 * 1024 * 1024;
/** Most rejection messages returned (the rest are summarised). */
export const MAX_REJECTED_MESSAGES = 50;

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
  const builtinIds = new Set(deps.specs.map((s) => s.id));
  let custom: FormatSpec[] = [];
  let specs: readonly FormatSpec[] = deps.specs;
  let names = new Map(specs.map((s) => [s.id, s.name] as const));
  const infos = (): SpecInfo[] => specs.map((s) => (builtinIds.has(s.id) ? { id: s.id, name: s.name } : { id: s.id, name: s.name, custom: true }));

  let source: ByteSource | null = null;
  let result: ParseResult | null = null;
  let index: TreeIndex | null = null;
  let extents: Map<Node, { lo: number; hi: number }> | null = null;
  // For the current tree shape. The regions do not depend on the bucket count, so only `buckets` is keyed on it.
  let overviewCache: { size: number; regions: OverviewRegion[]; truncated: boolean; buckets: { n: number; data: Uint8Array } | null } | null = null;
  let errorsSent = 0; // diagnostics of `result` already delivered to the client
  let generation = 0; // bumped by open/parse; responses from older generations are dropped
  let parseCtl: AbortController | null = null;
  let lifeCtl: AbortController | null = null; // aborted when the result it belongs to is superseded

  // The generation each open/parse/parseDraft request created for itself (see handle()).
  const ownGen = new WeakMap<object, number>();
  let current: EngineRequest | null = null;

  function supersede(): number {
    parseCtl?.abort();
    lifeCtl?.abort();
    parseCtl = lifeCtl = null;
    result = null;
    index = null;
    extents = null;
    overviewCache = null;
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
    // The same grouping as the minimap (core/groups), so hex tints and minimap colours agree.
    topGroupNodes(root).forEach((c, g) => visit(c, groupOfIndex(g)));
    // The cap applies in window order, not traversal order.
    return out.sort((a, b) => a.start - b.start).slice(0, MAX_SEGMENTS);
  }

  async function runParse(id: number, gen: number, spec: FormatSpec): Promise<EngineResponse | null> {
    if (!source) return { id, type: 'error', message: 'no file is open' };
    const ctl = (parseCtl = new AbortController());
    lifeCtl = new AbortController();
    const r = await engine.parse(spec, source, { signal: ctl.signal });
    if (gen !== generation) return null;
    result = r;
    errorsSent = r.errors.length; // the snapshot carries them all
    return { id, type: 'parse', snapshot: { specId: spec.id, root: r.root, errors: r.errors, stats: r.stats } };
  }

  async function dispatch(req: EngineRequest): Promise<EngineResponse | null> {
    const id = req.id;
    switch (req.type) {
      case 'open': {
        const gen = supersede();
        if (current) ownGen.set(current, gen);
        const fileName = typeof req.fileName === 'string' ? req.fileName : '';
        source = makeSource(req.file);
        const found = await engine.detect(specs, fileName, source);
        if (gen !== generation) return null;
        const detections: DetectionInfo[] = found.map((d) => ({ ...d, name: names.get(d.specId) ?? d.specId }));
        return {
          id,
          type: 'open',
          size: source.size,
          specs: infos(),
          specErrors: [...deps.specErrors],
          detections,
        };
      }
      case 'parse': {
        const gen = supersede();
        if (current) ownGen.set(current, gen);
        if (req.specId === null) return { id, type: 'parse', snapshot: null };
        const spec = specs.find((s) => s.id === req.specId);
        if (!spec) return { id, type: 'error', message: `unknown format "${String(req.specId)}"` };
        return runParse(id, gen, spec);
      }
      case 'parseDraft': {
        const gen = supersede();
        if (current) ownGen.set(current, gen);
        if (typeof req.specText !== 'string') return { id, type: 'error', message: 'invalid spec text' };
        // The main thread's copy is not trusted: the draft is validated here with the usual limits.
        const v = realEngine.loadSpec(req.specText);
        if (!v.ok) return { id, type: 'error', message: `invalid spec: ${realEngine.formatIssues(v.errors.slice(0, 5))}` };
        return runParse(id, gen, v.spec);
      }
      case 'setSpecs': {
        if (!Array.isArray(req.specTexts)) return { id, type: 'error', message: 'invalid spec list' };
        if (req.specTexts.length > MAX_SETSPECS_ITEMS) return { id, type: 'error', message: `too many specs (${req.specTexts.length} > ${MAX_SETSPECS_ITEMS})` };
        let totalBytes = 0;
        for (const t of req.specTexts as unknown[]) if (typeof t === 'string') totalBytes += t.length;
        if (totalBytes > MAX_SETSPECS_BYTES) return { id, type: 'error', message: 'spec list too large' };
        const accepted: FormatSpec[] = [];
        const rejected: string[] = [];
        const seen = new Set(builtinIds);
        req.specTexts.forEach((text: unknown, i: number) => {
          const label = `custom spec #${i + 1}`;
          if (accepted.length >= MAX_CUSTOM_SPECS) return void rejected.push(`${label}: too many custom specs (max ${MAX_CUSTOM_SPECS})`);
          if (typeof text !== 'string') return void rejected.push(`${label}: not a text`);
          const v = realEngine.loadSpec(text);
          if (!v.ok) return void rejected.push(`${label}: ${realEngine.formatIssues(v.errors.slice(0, 3))}`);
          if (seen.has(v.spec.id)) return void rejected.push(`${label}: id "${v.spec.id}" is already used by another format`);
          seen.add(v.spec.id);
          accepted.push(v.spec);
        });
        custom = accepted;
        specs = [...deps.specs, ...custom];
        names = new Map(specs.map((s) => [s.id, s.name] as const));
        if (rejected.length > MAX_REJECTED_MESSAGES) {
          const more = rejected.length - MAX_REJECTED_MESSAGES;
          rejected.length = MAX_REJECTED_MESSAGES;
          rejected.push(`… and ${more} more`);
        }
        return { id, type: 'setSpecs', specs: infos(), rejected };
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
        const treeChanged = (arr?.children?.length ?? 0) !== childrenBefore;
        if (treeChanged) {
          // Variable-size expansion appended children; fixed-size page loads leave the tree untouched.
          index = null;
          extents = null;
          overviewCache = null;
        }
        // Overlapping expands share one cursor, advanced synchronously after the await, so no error is sent twice.
        const newErrors = r.errors.slice(errorsSent);
        errorsSent = r.errors.length;
        return { id, type: 'expand', nodes, lazy, newErrors, treeChanged };
      }
      case 'expandRef': {
        if (!result) return { id, type: 'error', message: 'no parse result' };
        if (!isCount(req.nodeId)) return { id, type: 'error', message: 'invalid reference node' };
        const gen = generation;
        const r = result;
        const nodes = await (engine.expandRef ?? realEngine.expandRef)(r, req.nodeId, { signal: lifeCtl?.signal });
        if (gen !== generation) return null;
        if (nodes.length > 0) {
          // The target was attached under the ref node: ids, parents and byte extents changed.
          index = null;
          extents = null;
          overviewCache = null;
        }
        const newErrors = r.errors.slice(errorsSent);
        errorsSent = r.errors.length;
        return { id, type: 'expandRef', nodes, newErrors };
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
      case 'overview': {
        if (!isCount(req.buckets)) return { id, type: 'error', message: 'invalid bucket count' };
        // No result (none yet, or a re-parse is running): an error, so the client keeps the last overview it has.
        if (!result) return { id, type: 'error', message: 'no parse result' };
        const size = source?.size ?? 0;
        const n = size > 0 ? Math.min(clampBuckets(req.buckets), size) : clampBuckets(req.buckets); // never empty buckets
        // The reply's buffer is transferred away, so the cache keeps its own copy.
        if (!overviewCache || overviewCache.size !== size) {
          overviewCache = { size, ...computeRegions(result.root, size), buckets: null };
        }
        if (overviewCache.buckets?.n !== n) overviewCache.buckets = { n, data: computeOverview(result.root, size, n) };
        const { buckets, regions, truncated } = overviewCache;
        // Both transports structured-clone the reply, so `regions` need no copy; only the transferred buffer does.
        return { id, type: 'overview', size, buckets: buckets.data.slice(), regions, truncated };
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
        current = req;
        const promise = dispatch(req);
        current = null;
        const res = await promise;
        if (res) deps.post(res);
      } catch (e) {
        // A request that was overtaken by a newer open/parse/parseDraft stays silent even when it failed (the client
        // already rejected it). open/parse/parseDraft bump the generation themselves, so they compare against theirs.
        if ((ownGen.get(req) ?? gen) !== generation) return;
        deps.post({ id: req.id, type: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    },
  };
}
