<script lang="ts">
  import { untrack } from 'svelte';
  import type { Diagnostic, LazyArray, Node } from '../../core/engine';
  import { describeStatus, type ParseStatus } from '../../core/format-status';
  import { checkSpecText } from '../../core/spec-text';
  import { nodeByteRange, sanitizeText } from '../../core/tree-model';
  import { SupersededError } from '../../worker/engine-client';
  import type { ParseSnapshot } from '../../worker/protocol';
  import Diagnostics from '../Diagnostics.svelte';
  import StructureTree from '../StructureTree.svelte';
  import { PREVIEW_DEBOUNCE_MS, PreviewUnavailableError } from './preview';

  let {
    text,
    docName,
    active,
    busy,
    epoch,
    parseDraft,
    loadPage,
    loadRef,
    onShowInViewer,
  }: {
    /** The draft spec text. */
    text: string;
    /** Name of the document open in the viewer; null = none (the pane is hidden). */
    docName: string | null;
    /** The Formats view is showing. No parse is requested while it is not. */
    active: boolean;
    /** A save is in progress: no parse is requested. */
    busy: boolean;
    /** Changes whenever the viewer finished an engine operation; the preview then re-parses. */
    epoch: number;
    parseDraft: (text: string) => Promise<ParseSnapshot | null>;
    loadPage: (nodeId: number, start: number, count: number) => Promise<{ nodes: Node[]; lazy: LazyArray | null }>;
    loadRef?: (nodeId: number) => Promise<Node[]>;
    onShowInViewer: (range: { start: number; end: number } | null, offset: number) => void;
  } = $props();

  let enabled = $state(true);
  let collapsed = $state(false);
  let root = $state.raw<Node | null>(null);
  let keep = $state.raw<Node | null>(null);
  let diagnostics = $state.raw<Diagnostic[]>([]);
  let status = $state<ParseStatus>({ state: 'idle' });
  let problems = $state.raw<string[]>([]);
  let sel = $state.raw<{ node: Node | null; range: { start: number; end: number } | null; offset: number } | null>(null);
  let runId = 0;

  function clearResult() {
    runId++; // an in-flight parse must not repopulate it
    root = null;
    keep = null;
    diagnostics = [];
    sel = null;
    status = { state: 'idle' };
  }

  // Unavailable (off, hidden, saving, no document): the tree is no longer backed by the worker, so drop it.
  $effect(() => {
    if (!enabled || !active || busy || docName === null) untrack(clearResult);
  });

  $effect(() => {
    const t = text;
    void epoch;
    if (!enabled || !active || busy || docName === null) return;
    const timer = setTimeout(() => void run(t), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  async function run(t: string) {
    const id = ++runId;
    sel = null; // a node of the previous parse
    const c = checkSpecText(t);
    if (!c.valid) {
      root = null;
      diagnostics = [];
      sel = null;
      status = { state: 'idle' };
      problems = c.syntax ? [`Syntax error at line ${c.syntax.line}, column ${c.syntax.column}: ${c.syntax.message}`] : c.issues.slice(0, 20).map((i) => `${i.path}: ${i.message}`);
      return;
    }
    problems = [];
    status = { state: 'parsing' };
    try {
      const snap = await parseDraft(t);
      if (id !== runId) return;
      if (!snap) {
        status = { state: 'idle' };
        return;
      }
      keep = snap.root;
      root = snap.root;
      diagnostics = snap.errors;
      const errors = snap.errors.filter((d) => d.severity === 'error').length;
      status = { state: snap.stats.aborted ? 'aborted' : snap.stats.truncated ? 'truncated' : 'done', nodes: snap.stats.nodes, errors, warnings: snap.errors.length - errors };
    } catch (e) {
      if (id !== runId) return;
      if (e instanceof SupersededError || e instanceof PreviewUnavailableError) {
        clearResult(); // the next trigger (epoch / busy change) runs it again
        return;
      }
      root = null;
      problems = [e instanceof Error ? e.message : String(e)];
      status = { state: 'idle' };
    }
  }

  const hex = (n: number) => '0x' + n.toString(16).toUpperCase();
  function onSelect(node: Node, range: { start: number; end: number } | null) {
    sel = { node, range, offset: node.offset };
  }
  function onLinkJump(offset: number, size: number) {
    sel = { node: null, range: size > 0 ? { start: offset, end: offset + size - 1 } : null, offset };
  }
  function onJump(d: Diagnostic) {
    if (d.offset !== undefined) sel = { node: null, range: null, offset: d.offset };
  }
</script>

{#if docName !== null}
  <section class="preview" class:collapsed aria-label="Preview on open file">
    <div class="head">
      <button type="button" class="toggle" aria-expanded={!collapsed} onclick={() => (collapsed = !collapsed)}>{collapsed ? '▸' : '▾'} Preview</button>
      <label><input type="checkbox" bind:checked={enabled} /> Preview on open file</label>
      <span class="doc">{sanitizeText(docName, 80)}</span>
      {#if status.state === 'parsing'}<span class="muted" role="status">Parsing…</span>
      {:else if status.state !== 'idle'}<span class="muted" role="status">{sanitizeText(describeStatus(status), 200)}</span>{/if}
    </div>
    {#if !collapsed}
      <div class="body">
        {#if !enabled}
          <p class="muted pad">Preview is off.</p>
        {:else if busy}
          <p class="muted pad">Waiting for the save to finish…</p>
        {:else if problems.length > 0}
          <div class="problems" role="alert" aria-label="Draft problems">
            <p>The draft is not valid, so it cannot be previewed:</p>
            <ul>{#each problems as p, i (i)}<li>{sanitizeText(p, 300)}</li>{/each}</ul>
          </div>
        {:else}
          <div class="tree"><StructureTree {root} {diagnostics} {loadPage} {loadRef} {onSelect} onJump={onLinkJump} preserveFor={keep} /></div>
          <Diagnostics {diagnostics} {onJump} />
        {/if}
        {#if sel}
          <div class="selinfo" role="status">
            {#if sel.node}{sanitizeText(sel.node.name, 80)}: {/if}offset {hex(sel.offset)} ({sel.offset}){#if sel.node}, size {sel.node.size}{/if}
            <button type="button" onclick={() => sel && onShowInViewer(sel.range ?? (sel.node ? nodeByteRange(sel.node) : null), sel.offset)}>Show in viewer</button>
          </div>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
.preview {
    flex: 0 0 42%;
    min-height: 140px;
    border-top: 1px solid var(--rule);
    background: var(--ground);
    display: flex;
    flex-direction: column;
  }
  .preview.collapsed {
    flex: none;
    min-height: 0;
  }
  .head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 2px 12px 2px 6px;
    background: var(--chrome);
    border-bottom: 1px solid var(--rule);
    font-size: var(--fs-sm);
  }
  .head label {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .toggle {
    border-color: transparent;
    font-weight: 600;
  }
  .doc,
  .muted {
    color: var(--ink-quiet);
  }
  .body {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .tree {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .pad {
    padding: 6px 12px;
    margin: 0;
  }
  .problems {
    padding: 6px 12px;
    color: var(--error);
    font-size: var(--fs-sm);
    overflow: auto;
  }
  .selinfo {
    flex: none;
    padding: 4px 12px;
    font-size: var(--fs-sm);
    border-top: 1px solid var(--rule);
    display: flex;
    align-items: center;
    gap: 12px;
  }
</style>
