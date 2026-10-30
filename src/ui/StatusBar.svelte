<script lang="ts">
  import { selectionRange, type Selection } from '../core/caret';

  let {
    selection,
    error = null,
    onRetry,
  }: { selection: Selection | null; error?: string | null; onRetry?: () => void } = $props();

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
  .retry {
    padding: 0 8px;
    font-size: 12px;
  }
  .muted {
    color: var(--muted);
  }
</style>
