<script lang="ts">
  import { untrack } from 'svelte';
  import {
    canRedo,
    canUndo,
    createHistory,
    isCanonicalText,
    isModelError,
    locateIssues,
    pushState,
    redo,
    toModel,
    toText,
    undo,
    typeIssues,
    type BuilderModel,
    type History,
    type ModelResult,
  } from '../../../core/builder';
  import { checkSpecText, type TextCheck } from '../../../core/spec-text';
  import { sanitizeText } from '../../../core/tree-model';
  import { loadHideRewriteNotice, saveHideRewriteNotice } from '../../prefs';
  import EnumsPanel from './EnumsPanel.svelte';
  import FieldTable from './FieldTable.svelte';
  import MetaForm from './MetaForm.svelte';
  import Palette from './Palette.svelte';
  import TypesPanel from './TypesPanel.svelte';

  let {
    text,
    onText,
    readOnly,
    dirty,
    status = null,
    onSave,
    onRevert,
    onDuplicate,
  }: {
    /** The draft text; the builder is a view of it. */
    text: string;
    onText: (text: string) => void;
    readOnly: boolean;
    dirty: boolean;
    status?: { ok: boolean; text: string } | null;
    onSave: () => void;
    onRevert: () => void;
    onDuplicate: () => void;
  } = $props();

  const DEBOUNCE_MS = 300;
  const initial: ModelResult = untrack(() => toModel(text));
  let model = $state.raw<ModelResult>(initial);
  let hist = $state.raw<History<BuilderModel> | null>(isModelError(initial) ? null : createHistory(initial));
  let lastEmitted: string | null = untrack(() => text);
  let check = $state.raw<TextCheck>(untrack(() => checkSpecText(text)));
  let selType = $state('');
  let selRow = $state<number | null>(null);
  let notice = $state<string | null>(null);
  // Before the builder rewrites a spec whose text is not in canonical form, the user confirms (Apply / Cancel). The
  // edit waits in `pending` meanwhile; once applied the text is canonical, so this only asks again after JSON edits.
  let hideRewrite = loadHideRewriteNotice();
  let pending = $state.raw<BuilderModel | null>(null);
  let pendingBase = ''; // the text the held edit was made against
  const canonCache = { text: '', value: false, valid: false };
  /** `isCanonicalText` for the current text, computed once per text. */
  function textIsCanonical(t: string): boolean {
    if (!canonCache.valid || canonCache.text !== t) {
      canonCache.text = t;
      canonCache.value = isCanonicalText(t);
      canonCache.valid = true;
    }
    return canonCache.value;
  }
  let dontAsk = $state(false);
  let rev = $state(0); // re-renders the panels so inputs drop a cancelled edit

  // JSON edits (or save/revert) reach the builder through the text: anything we did not emit ourselves is re-read.
  $effect(() => {
    const t = text;
    untrack(() => {
      if (t === lastEmitted) return;
      lastEmitted = t;
      const r = toModel(t);
      model = r;
      hist = isModelError(r) ? null : createHistory(r);
      notice = null;
      pending = null; // an edit waiting for confirmation was made against the old text
    });
  });

  $effect(() => {
    const t = text;
    const timer = setTimeout(() => (check = checkSpecText(t)), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  const ok = $derived(isModelError(model) ? null : model);
  const located = $derived(locateIssues(check.issues));

  // Keep the selected type valid; default to the root.
  $effect(() => {
    const m = ok;
    if (!m) return;
    if (!m.types.some((t) => t.name === selType)) {
      selType = (m.meta.root !== undefined && m.types.some((t) => t.name === m.meta.root) ? m.meta.root : m.types[0]?.name) ?? '';
      selRow = null;
    }
  });
  const fieldCount = $derived(ok?.types.find((t) => t.name === selType)?.fields.length ?? 0);
  const insertIndex = $derived(selRow === null || selRow >= fieldCount ? fieldCount : selRow + 1);

  function commit(next: BuilderModel) {
    if (readOnly || !hist) return;
    const h = pushState(hist, next);
    if (h === hist || toText(next) === toText(hist.present)) {
      // nothing changes. If an edit is being held, this one put things back to how they are: the held edit is obsolete.
      if (pending !== null) {
        pending = null;
        rev++;
      }
      return;
    }
    if (!hideRewrite && !textIsCanonical(text)) {
      pending = next; // asks first; a second edit while waiting replaces the held one (last wins)
      pendingBase = text;
      return;
    }
    hist = h;
    apply(h.present);
  }

  function applyPending() {
    const next = pending;
    const base = pendingBase;
    pending = null;
    if (dontAsk) {
      hideRewrite = true;
      saveHideRewriteNotice();
    }
    if (next && base !== text) {
      rev++; // the text changed since the edit was made: it no longer applies
      return;
    }
    if (next && hist) {
      hist = pushState(hist, next);
      apply(next);
    }
  }
  function cancelPending() {
    pending = null;
    rev++;
  }

  function apply(m: BuilderModel) {
    model = m;
    const t = toText(m);
    lastEmitted = t;
    onText(t);
  }

  function doUndo() {
    if (readOnly || !hist || !canUndo(hist)) return;
    hist = undo(hist);
    apply(hist.present);
  }
  function doRedo() {
    if (readOnly || !hist || !canRedo(hist)) return;
    hist = redo(hist);
    apply(hist.present);
  }

  /** Ctrl+Z / Ctrl+Y outside text inputs (inputs keep their native undo). */
  function onKeyDown(e: KeyboardEvent) {
    const el = e.target as HTMLElement | null;
    const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 's') {
      e.preventDefault();
      onSave();
      return;
    }
    if (typing) return;
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      doUndo();
    } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
      e.preventDefault();
      doRedo();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="builder" role="region" aria-label="Format builder" onkeydown={onKeyDown}>
  <div class="bar">
    {#if readOnly}
      <span class="note">Built-in format (read-only)</span>
      <button type="button" onclick={onDuplicate}>Duplicate to edit</button>
    {:else}
      <button type="button" onclick={doUndo} disabled={!hist || !canUndo(hist)}>Undo</button>
      <button type="button" onclick={doRedo} disabled={!hist || !canRedo(hist)}>Redo</button>
      <button type="button" onclick={onSave} disabled={!dirty || check.syntax !== null}>Save spec</button>
      <button type="button" onclick={onRevert} disabled={!dirty}>Revert</button>
      {#if dirty}<span class="dirty" role="status">● Unsaved edits</span>{/if}
    {/if}
    <span class="spacer"></span>
    {#if check.syntax}<span class="bad">Invalid JSON</span>
    {:else if check.valid}<span class="good">Valid</span>
    {:else}<span class="bad">{check.issues.length} validation issue{check.issues.length === 1 ? '' : 's'}</span>{/if}
  </div>
  {#if status}<div class="result" class:fail={!status.ok} role="status">{sanitizeText(status.text, 400)}</div>{/if}
  {#if pending}
    <div class="warn" role="alert" aria-label="Rewrite confirmation">
      Editing here rewrites the JSON in canonical form (layout, key order and number spelling may change; meaning is preserved). Apply your latest edit?
      <label><input type="checkbox" bind:checked={dontAsk} /> Don't show this again</label>
      <button type="button" onclick={applyPending}>Apply</button>
      <button type="button" onclick={cancelPending}>Cancel</button>
    </div>
  {/if}
  {#if notice}<div class="warn" role="status">{sanitizeText(notice, 600)}</div>{/if}

  {#if isModelError(model)}
    <div class="blocked" role="alert">
      {#if model.line !== undefined}
        Fix the JSON syntax error at line {model.line}, col {model.column} to use the builder.
      {:else}
        {#if model.error.includes('fix it in JSON')}{sanitizeText(model.error, 300)}{:else}The builder cannot edit this spec: {sanitizeText(model.error, 300)} Fix it in the JSON tab to use the builder.{/if}
      {/if}
    </div>
  {:else if ok}
    {#if readOnly}<div class="note pad">This is a built-in format; everything below is read-only.</div>{/if}
    {#key rev}
    <div class="body">
      <div class="side">
        <details open>
          <summary>Format</summary>
          <MetaForm model={ok} issues={located} {readOnly} {commit} />
        </details>
        <details open>
          <summary>Types ({ok.types.length})</summary>
          <TypesPanel model={ok} bind:selected={selType} issues={located} {readOnly} {commit} />
        </details>
        <details>
          <summary>Enums ({ok.enums?.length ?? 0})</summary>
          <EnumsPanel model={ok} issues={located} {readOnly} {commit} />
        </details>
      </div>
      <div class="main">
        <h4>
          Fields of "{sanitizeText(selType, 64)}"
          {#if typeIssues(located, selType).length > 0}<span class="bad">({typeIssues(located, selType).length} issue{typeIssues(located, selType).length === 1 ? '' : 's'})</span>{/if}
        </h4>
        <FieldTable model={ok} typeName={selType} bind:selected={selRow} issues={located} {readOnly} {commit} onNotice={(m) => (notice = m)} />
      </div>
      <div class="palette">
        <Palette model={ok} typeName={selType} {insertIndex} {readOnly} {commit} onNotice={(m) => (notice = m)} />
      </div>
    </div>
    {/key}
  {/if}
</div>

<style>
  .builder {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--rule);
    background: var(--chrome);
  }
  .spacer {
    flex: 1;
  }
  .note,
  .pad {
    color: var(--ink-quiet);
  }
  .pad {
    padding: 2px 8px;
    font-size: var(--fs-sm);
  }
  .dirty {
    color: var(--edited);
  }
  .good {
    color: var(--ok);
  }
  .bad {
    color: var(--error);
  }
  .result,
  .warn {
    padding: 2px 8px;
    font-size: var(--fs-sm);
    border-bottom: 1px solid var(--rule);
  }
  .warn {
    color: var(--warn);
  }
  .result.fail {
    color: var(--error);
  }
  .blocked {
    padding: 16px;
    color: var(--error);
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .side {
    flex: none;
    width: 280px;
    overflow: auto;
    border-right: 1px solid var(--rule);
    padding: 4px 8px;
  }
  .main {
    flex: 1;
    min-width: 0;
    overflow: auto;
  }
  .main h4 {
    margin: 6px 8px 0;
  }
  .palette {
    flex: none;
    width: 260px;
    overflow: auto;
    border-left: 1px solid var(--rule);
  }
  summary {
    cursor: pointer;
    font-weight: 600;
  }
</style>
