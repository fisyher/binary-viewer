<script lang="ts">
  import type { SideView } from '../prefs';

  let {
    view,
    open,
    onSelect,
  }: {
    /** The side bar view that is (or would be) showing. */
    view: SideView;
    /** The side bar is expanded. */
    open: boolean;
    /** Clicking the active item collapses/expands the side bar; clicking the other switches the view. */
    onSelect: (view: SideView) => void;
  } = $props();

  const items: Array<{ id: SideView; label: string }> = [
    { id: 'structure', label: 'Structure' },
    { id: 'formats', label: 'Formats' },
  ];
</script>

<nav class="activity" aria-label="Activity bar">
  {#each items as item (item.id)}
    {@const active = open && view === item.id}
    <button type="button" class="item" class:active aria-pressed={active} aria-label={item.label} title={item.label} onclick={() => onSelect(item.id)}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        {#if item.id === 'structure'}
          <!-- a tree: root, branch, two children -->
          <rect x="3" y="3.5" width="7" height="4" rx="0.5" />
          <rect x="11" y="10" width="7" height="4" rx="0.5" />
          <rect x="11" y="16.5" width="7" height="4" rx="0.5" />
          <path d="M6.5 7.5v10.5h4.5M6.5 12h4.5" />
        {:else}
          <!-- a document with braces: a format spec -->
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v4h4" />
          <path d="M10.5 11c-1 0-1.5.4-1.5 1.2v.6c0 .5-.4.7-.9.7.5 0 .9.2.9.7v.6c0 .8.5 1.2 1.5 1.2M13.5 11c1 0 1.5.4 1.5 1.2v.6c0 .5.4.7.9.7-.5 0-.9.2-.9.7v.6c0 .8-.5 1.2-1.5 1.2" />
        {/if}
      </svg>
    </button>
  {/each}
</nav>

<style>
  .activity {
    width: 44px;
    box-sizing: border-box;
    background: var(--chrome-deep);
    border-right: 1px solid var(--rule);
    display: flex;
    flex-direction: column;
    align-items: stretch;
    padding-top: 4px;
  }
  .item {
    position: relative;
    height: 44px;
    padding: 0;
    border: none;
    border-radius: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ink-quiet);
  }
  .item:hover:not(:disabled) {
    color: var(--ink);
  }
  .item.active {
    color: var(--ink);
  }
  .item.active::before {
    content: '';
    position: absolute;
    left: 0;
    top: 6px;
    bottom: 6px;
    width: 2px;
    background: var(--signal);
  }
</style>
