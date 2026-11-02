<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    onCollapse,
    children,
  }: {
    title: string;
    onCollapse: () => void;
    children: Snippet;
  } = $props();
</script>

<aside class="side" aria-label="{title} side bar">
  <header>
    <h2>{title}</h2>
    <button type="button" class="collapse" onclick={onCollapse} title="Hide side bar" aria-label="Hide side bar">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </button>
  </header>
  <div class="body">{@render children()}</div>
</aside>

<style>
  .side {
    height: 100%;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--chrome);
  }
  header {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 34px;
    padding: 0 6px 0 12px;
    box-sizing: border-box;
    border-bottom: 1px solid var(--rule);
  }
  h2 {
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 600;
  }
  .collapse {
    border-color: transparent;
    min-width: 24px;
    min-height: 24px;
    padding: 4px 6px;
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
