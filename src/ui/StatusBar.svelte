<script lang="ts">
  import { selectionRange, type Selection } from '../core/caret';

  let {
    selection,
    error = null,
    notice = null,
    info = null,
    insertMode = null,
    onRetry,
  }: {
    selection: Selection | null;
    error?: string | null;
    /** Edit/copy/paste/save problem. */
    notice?: string | null;
    /** Non-error status text. */
    info?: string | null;
    /** null hides the indicator (nothing editable open). */
    insertMode?: boolean | null;
    onRetry?: () => void;
  } = $props();

  const r = $derived(selection ? selectionRange(selection) : null);

  const hex = (n: number) => '0x' + n.toString(16).toUpperCase();
</script>

<footer class="status">
  {#if r}
    <span>Start: {hex(r.start)} ({r.start})</span>
    <span>End: {hex(r.end)} ({r.end})</span>
    <span>Length: {hex(r.length)} ({r.length})</span>
  {:else}
    <span class="muted">No selection</span>
  {/if}
  {#if insertMode !== null}
    <span class="mode" title="Press Insert to toggle">{insertMode ? 'Insert' : 'Overwrite'}</span>
  {/if}
  {#if info}<span class="info" role="status">{info}</span>{/if}
  {#if notice}<span class="error" role="alert">{notice}</span>{/if}
  {#if error}
    <span class="error" role="alert">{error}</span>
    {#if onRetry}<button type="button" class="retry" onclick={onRetry}>Retry</button>{/if}
  {/if}
</footer>

<style>
  .status {
    display: flex;
    gap: 24px;
    padding: 4px 12px;
    background: var(--panel);
    border-top: 1px solid var(--border);
    font-family: var(--mono);
    font-size: 12px;
  }
  .error {
    color: var(--error);
    margin-left: auto;
  }
  .error ~ .error {
    margin-left: 0;
  }
  .retry {
    padding: 0 8px;
    font-size: 12px;
  }
  .info {
    margin-left: auto;
  }
  .muted {
    color: var(--muted);
  }
  .mode {
    font-weight: 600;
  }
</style>
