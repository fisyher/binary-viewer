<script module lang="ts">
  let counter = 0;
</script>

<script lang="ts">
  import { exprFeedback, exprToText, textToExpr } from '../../../core/builder';
  import { sanitizeText } from '../../../core/tree-model';

  let {
    value,
    onCommit,
    suggestions = [],
    label,
    disabled = false,
    numeric = false,
    placeholder = '',
    issue = null,
  }: {
    value: unknown;
    /** Called when editing ends (change/blur/enter). `undefined` = the key should be removed. */
    onCommit: (v: number | string | undefined) => void;
    suggestions?: string[];
    label: string;
    disabled?: boolean;
    /** Plain digits are stored as a number. */
    numeric?: boolean;
    placeholder?: string;
    /** A validation message for this key, shown next to the input. */
    issue?: string | null;
  } = $props();

  const listId = `expr-names-${++counter}`;
  let local = $state<string | null>(null);
  const shown = $derived(local ?? exprToText(value));
  const feedback = $derived(numeric && /^\s*\d+\s*$/.test(shown) ? { ok: true as const } : exprFeedback(shown));

  function commit() {
    const text = local;
    local = null;
    if (text === null || text === exprToText(value)) return;
    onCommit(numeric ? textToExpr(text) : text.trim() === '' ? undefined : text.trim());
  }
</script>

<span class="expr">
  <input
    type="text"
    list={listId}
    value={shown}
    {placeholder}
    {disabled}
    aria-label={label}
    aria-invalid={!feedback.ok || issue ? 'true' : 'false'}
    class:bad={!feedback.ok || !!issue}
    spellcheck="false"
    autocomplete="off"
    oninput={(e) => (local = (e.currentTarget as HTMLInputElement).value)}
    onchange={commit}
    onkeydown={(e) => e.key === 'Enter' && commit()}
  />
  <datalist id={listId}>
    {#each suggestions as s (s)}<option value={sanitizeText(s, 80)}></option>{/each}
  </datalist>
  {#if !feedback.ok}<span class="fb" role="status">Expression error: {sanitizeText(feedback.error, 200)}</span>{/if}
  {#if issue}<span class="fb" role="alert">{sanitizeText(issue, 300)}</span>{/if}
</span>

<style>
  .expr {
    display: inline-flex;
    flex-direction: column;
    min-width: 0;
  }
  input {
    min-width: 6ch;
    width: 100%;
    font-family: var(--mono);
    font-size: var(--fs-sm);
  }
  .bad {
    border-color: var(--error);
  }
  .fb {
    color: var(--error);
    font-size: var(--fs-xs);
  }
</style>
