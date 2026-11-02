<script lang="ts">
  import { collapseLeading, crumbTitle, type Crumb } from './breadcrumb';

  let {
    crumbs,
    hasStructure,
    onSelect,
  }: {
    /** The path to the located node, root first; empty is nothing to show. */
    crumbs: readonly Crumb[];
    /** A parse result is open (else "No structure" is shown). */
    hasStructure: boolean;
    /** A segment was chosen: select that node in the structure tree. */
    onSelect: (crumb: Crumb) => void;
  } = $props();

  // About how many characters of the 12px face fit: when the path is longer, the leading segments become "…".
  const CHAR_PX = 7;
  let width = $state(0);
  const hidden = $derived(collapseLeading(crumbs.map((c) => c.label), width > 0 ? Math.floor(width / CHAR_PX) : 0));
  const shown = $derived(crumbs.slice(hidden));
  const hiddenNames = $derived(crumbs.slice(0, hidden).map((c) => c.label).join(' › '));
</script>

<nav class="crumbs" aria-label="Structure path" bind:clientWidth={width}>
  {#if !hasStructure || crumbs.length === 0}
    <span class="none">No structure</span>
  {:else}
    <ol>
      {#if hidden > 0}
        <li>
          <button type="button" class="more" title={hiddenNames} aria-label="Show parent: {hiddenNames}" onclick={() => onSelect(crumbs[hidden - 1]!)}>…</button>
          <span class="sep" aria-hidden="true">›</span>
        </li>
      {/if}
      {#each shown as c, i (hidden + i)}
        {@const last = hidden + i === crumbs.length - 1}
        <li>
          <button type="button" class:last title={crumbTitle(c)} aria-current={last ? 'location' : undefined} onclick={() => onSelect(c)}>{c.label}</button>
          {#if !last}<span class="sep" aria-hidden="true">›</span>{/if}
        </li>
      {/each}
    </ol>
  {/if}
</nav>

<style>
  .crumbs {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: var(--fs-sm);
    white-space: nowrap;
  }
  ol {
    display: flex;
    align-items: center;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    flex: none;
  }
  li:last-child {
    flex: 0 1 auto;
    min-width: 0;
  }
  button {
    min-height: 24px;
    min-width: 24px;
    padding: 0 4px;
    border-color: transparent;
    color: var(--ink-quiet);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  button:hover:not(:disabled) {
    color: var(--ink);
  }
  button.last {
    color: var(--ink);
    font-weight: 600;
  }
  .sep {
    color: var(--ink-quiet);
    padding: 0 1px;
  }
  .none {
    display: inline-block;
    line-height: 24px;
    padding: 0 4px;
    color: var(--ink-quiet);
  }
</style>
