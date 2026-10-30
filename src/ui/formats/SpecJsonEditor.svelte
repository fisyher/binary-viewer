<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { SaveResult, SpecEntry } from '../../core/spec-library';
  import { parseJsonValue, sameAsParsed } from '../../core/builder';
  import { checkSpecText, type TextCheck } from '../../core/spec-text';
  import { MAX_SPEC_FILE_BYTES, exceedsBytes } from '../../core/spec-folder';
  import { sanitizeText } from '../../core/tree-model';

  let {
    entry,
    onSave,
    onDuplicate,
    onDirtyChange = () => {},
    text: textProp,
    onText,
    onResult,
  }: {
    entry: SpecEntry;
    onSave: (text: string) => Promise<SaveResult>;
    onDuplicate: () => void;
    onDirtyChange?: (dirty: boolean) => void;
    /** Controlled draft text (owned by the parent, shared with the builder). Omit to let the editor own it. */
    text?: string;
    onText?: (text: string) => void;
    /** The latest save outcome (or null), for views that show it elsewhere. */
    onResult?: (r: { ok: boolean; text: string } | null) => void;
  } = $props();

  const MAX_GUTTER_LINES = 100_000;
  const DEBOUNCE_MS = 300;

  const readOnly = $derived(entry.source === 'builtin');
  let local = $state(untrack(() => entry.text));
  const text = $derived(textProp ?? local);
  function setText(v: string) {
    local = v;
    onText?.(v);
  }
  let base = $state(untrack(() => entry.text)); // the library's text as last seen
  let check = $state.raw<TextCheck>(untrack(() => checkSpecText(entry.text)));
  let saving = $state(false);
  let result = $state<{ ok: boolean; text: string } | null>(null);
  let area: HTMLTextAreaElement | undefined = $state();
  let gutter: HTMLPreElement | undefined = $state();

  // Semantic: a draft that parses to the same JSON as the saved text is not a change (e.g. after a builder undo).
  // The saved text is parsed once per change of `base`, not on every keystroke.
  const baseParsed = $derived(parseJsonValue(base));
  const dirty = $derived(text !== base && !sameAsParsed(text, baseParsed));

  // The library changed the text underneath us (folder sync, a save elsewhere): follow it unless the user has edits.
  $effect(() => {
    const t = entry.text;
    untrack(() => {
      if (t === base) return;
      if (!dirty) setText(t);
      base = t;
    });
  });

  // Debounced validation.
  $effect(() => {
    const t = text;
    const timer = setTimeout(() => (check = checkSpecText(t)), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  $effect(() => onDirtyChange(dirty));
  onDestroy(() => onDirtyChange(false));

  const lineCount = $derived.by(() => {
    let n = 1;
    for (let i = text.indexOf('\n'); i !== -1 && n < MAX_GUTTER_LINES; i = text.indexOf('\n', i + 1)) n++;
    return n;
  });
  const lineNumbers = $derived.by(() => {
    const n = Math.min(lineCount, MAX_GUTTER_LINES);
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = i + 1;
    return out.join('\n');
  });

  /** Typing and pasting go through here so oversized input is refused with a clear message instead of freezing the page. */
  function onInput(e: Event) {
    const area = e.currentTarget as HTMLTextAreaElement;
    if (exceedsBytes(area.value)) {
      area.value = text; // keep the previous text
      result = { ok: false, text: 'Input too large: specs are limited to ' + MAX_SPEC_FILE_BYTES + ' bytes. The change was not applied.' };
      return;
    }
    setText(area.value);
  }

  function syncScroll() {
    if (area && gutter) gutter.scrollTop = area.scrollTop;
  }

  $effect(() => onResult?.(result));

  export async function save() {
    const c = checkSpecText(text); // never trust the debounced result for the decision to save
    check = c;
    if (c.syntax || readOnly || saving) return;
    saving = true;
    const attempt = text;
    try {
      const r = await onSave(attempt);
      if (!r.ok) result = { ok: false, text: r.error };
      else if (r.valid) result = { ok: true, text: 'Saved.' };
      else result = { ok: true, text: `Saved as an invalid draft (${r.issues.length} issue${r.issues.length === 1 ? '' : 's'}). It is not used for detection until it validates.` };
    } catch (e) {
      result = { ok: false, text: `Save failed: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      saving = false;
    }
  }

  export function revert() {
    setText(base);
    check = checkSpecText(base);
    result = null;
  }

  /** Offset of 1-based line/column in `t`. */
  function offsetOf(t: string, line: number, column: number): number {
    let off = 0;
    for (let l = 1; l < line; l++) {
      const nl = t.indexOf('\n', off);
      if (nl === -1) return t.length;
      off = nl + 1;
    }
    return Math.min(off + column - 1, t.length);
  }

  function jumpToSyntaxError() {
    const s = check.syntax;
    if (!s || !area) return;
    const off = offsetOf(text, s.line, s.column);
    area.focus();
    area.setSelectionRange(off, off);
  }

  function onKeyDown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
    }
  }
</script>

<div class="editor">
  <div class="bar">
    {#if readOnly}
      <span class="note">Built-in format (read-only)</span>
      <button type="button" onclick={onDuplicate}>Duplicate to edit</button>
    {:else}
      <button type="button" onclick={() => void save()} disabled={check.syntax !== null || saving || !dirty}>Save</button>
      <button type="button" onclick={revert} disabled={!dirty}>Revert</button>
      {#if dirty}<span class="dirty" title="Unsaved changes" role="status">● Unsaved changes</span>{/if}
    {/if}
    <span class="spacer"></span>
    {#if check.syntax}
      <span class="bad">Invalid JSON</span>
    {:else if check.valid}
      <span class="good">Valid</span>
    {:else}
      <span class="bad">{check.issues.length} validation issue{check.issues.length === 1 ? '' : 's'}</span>
    {/if}
  </div>
  {#if result}
    <div class="result" class:fail={!result.ok} role="status">{sanitizeText(result.text, 400)}</div>
  {/if}
  <div class="pane">
    <pre class="gutter" bind:this={gutter} aria-hidden="true">{lineNumbers}</pre>
    <textarea
      bind:this={area}
      value={text}
      oninput={onInput}
      readonly={readOnly}
      wrap="off"
      spellcheck="false"
      autocomplete="off"
      aria-label="Spec JSON"
      aria-invalid={check.syntax || check.issues.length > 0 ? 'true' : 'false'}
      onscroll={syncScroll}
      onkeydown={onKeyDown}
    ></textarea>
  </div>
  <div class="problems" aria-label="Problems" role="region">
    {#if check.syntax}
      <ul>
        <li class="err">
          <button type="button" class="link" onclick={jumpToSyntaxError}>Syntax error at line {check.syntax.line}, column {check.syntax.column}</button>:
          {sanitizeText(check.syntax.message, 300)}
        </li>
      </ul>
    {:else if check.issues.length > 0}
      <ul>
        {#each check.issues.slice(0, 200) as issue, i (i)}
          <li class="err"><code>{sanitizeText(issue.path, 200)}</code> {sanitizeText(issue.message, 300)}</li>
        {/each}
        {#if check.issues.length > 200}<li class="muted">… and {check.issues.length - 200} more</li>{/if}
      </ul>
    {:else}
      <p class="muted">No problems found.</p>
    {/if}
  </div>
</div>

<style>
  .editor {
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
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }
  .spacer {
    flex: 1;
  }
  .note,
  .muted {
    color: var(--muted);
  }
  .dirty {
    color: var(--edited);
  }
  .good {
    color: #16a34a;
  }
  .bad,
  .err {
    color: var(--error);
  }
  .result {
    padding: 2px 8px;
    font-size: 12px;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
  }
  .result.fail {
    color: var(--error);
  }
  .pane {
    flex: 1;
    min-height: 0;
    display: flex;
    background: var(--bg);
  }
  .gutter,
  textarea {
    margin: 0;
    padding: 6px 8px;
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.45;
    tab-size: 2;
  }
  .gutter {
    flex: none;
    min-width: 4ch;
    padding-bottom: 24px; /* room for the textarea's horizontal scrollbar so the last lines stay aligned */
    text-align: right;
    color: var(--muted);
    background: var(--panel);
    border-right: 1px solid var(--border);
    overflow: hidden;
    user-select: none;
  }
  textarea {
    flex: 1;
    min-width: 0;
    resize: none;
    border: none;
    outline: none;
    color: var(--fg);
    background: var(--bg);
    white-space: pre;
    overflow: auto;
  }
  textarea:read-only {
    background: var(--panel);
  }
  .problems {
    flex: none;
    max-height: 30%;
    overflow: auto;
    border-top: 1px solid var(--border);
    background: var(--bg);
    font-size: 12px;
    padding: 4px 8px;
  }
  .problems ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .problems p {
    margin: 0;
  }
  .link {
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }
  code {
    font-family: var(--mono);
  }
</style>
