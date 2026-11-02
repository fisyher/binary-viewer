<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    open,
    errors,
    warnings,
    onToggle,
    children,
  }: {
    open: boolean;
    errors: number;
    warnings: number;
    onToggle: () => void;
    children: Snippet;
  } = $props();
</script>

<section class="panel" aria-label="Bottom panel" data-region="bottom">
  <header>
    <button type="button" class="title" aria-expanded={open} aria-controls={open ? 'panel-problems' : undefined} onclick={onToggle}>Problems</button>
    <span class="count" class:has-errors={errors > 0}>{errors} errors, {warnings} warnings</span>
    <button
      type="button"
      class="toggle"
      aria-expanded={open}
      aria-label={open ? 'Hide problems panel' : 'Show problems panel'}
      title={open ? 'Hide problems panel' : 'Show problems panel'}
      onclick={onToggle}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"
        ><path d={open ? 'M3 6l5 5 5-5' : 'M3 10l5-5 5 5'} stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg
      >
    </button>
  </header>
  {#if open}
    <div class="body" id="panel-problems" role="region" aria-label="Problems">{@render children()}</div>
  {/if}
</section>

<style>
  .panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--chrome);
  }
  header {
    flex: none;
    display: flex;
    align-items: center;
    gap: 12px;
    height: 28px;
    padding: 0 6px 0 4px;
    box-sizing: border-box;
    font-size: var(--fs-sm);
  }
  .title {
    border: none;
    border-radius: 0;
    border-bottom: 2px solid var(--signal);
    min-height: 24px;
    min-width: 24px;
    padding: 4px 8px 2px;
    font-weight: 600;
    font-size: var(--fs-sm);
  }
  .count {
    color: var(--ink-quiet);
  }
  .count.has-errors {
    color: var(--error);
  }
  .toggle {
    margin-left: auto;
    border-color: transparent;
    min-width: 24px;
    min-height: 24px;
    padding: 3px 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ink-quiet);
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
</style>
