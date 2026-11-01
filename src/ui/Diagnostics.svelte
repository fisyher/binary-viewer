<script lang="ts">
  import type { Diagnostic } from '../core/engine';
  import { sanitizeText } from '../core/tree-model';

  const MAX_SHOWN = 500;

  let {
    diagnostics,
    onJump,
    alwaysOpen = false,
  }: {
    diagnostics: Diagnostic[];
    onJump: (d: Diagnostic) => void;
    /** Show the list without the collapsible header (the bottom Problems panel supplies its own). */
    alwaysOpen?: boolean;
  } = $props();

  let openState = $state(false);
  const open = $derived(alwaysOpen || openState);
  const errors = $derived(diagnostics.filter((d) => d.severity === 'error').length);
  const warnings = $derived(diagnostics.length - errors);
  const shown = $derived(diagnostics.slice(0, MAX_SHOWN));
</script>

<section class="diag" class:always={alwaysOpen}>
  {#if !alwaysOpen}
    <button type="button" class="toggle" aria-expanded={open} onclick={() => (openState = !openState)}>
      <span>{open ? '▾' : '▸'}</span> Problems
      <span class="count" class:has-errors={errors > 0}>{errors} errors, {warnings} warnings</span>
    </button>
  {/if}
  {#if open}
    <ul>
      {#each shown as d, i (i)}
        <li>
          <button type="button" class="item {d.severity}" onclick={() => onJump(d)} title={d.path ? sanitizeText(d.path, 500) : undefined}>
            <span class="sev">{d.severity === 'error' ? '✖' : '⚠'}</span>
            <span class="msg">{sanitizeText(d.message, 300)}</span>
            {#if d.offset !== undefined}<span class="at">@0x{d.offset.toString(16).toUpperCase()}</span>{/if}
          </button>
        </li>
      {:else}
        <li class="none">No problems</li>
      {/each}
      {#if diagnostics.length > MAX_SHOWN}<li class="none">&hellip; {diagnostics.length - MAX_SHOWN} more not shown</li>{/if}
    </ul>
  {/if}
</section>

<style>
  .diag {
    border-top: 1px solid var(--rule);
    background: var(--chrome);
    font-size: var(--fs-sm);
    display: flex;
    flex-direction: column;
    max-height: 40%;
    min-height: 0;
  }
  .diag.always {
    flex: 1;
    max-height: none;
    border-top: none;
    background: var(--ground);
  }
  .toggle {
    border: none;
    border-radius: 0;
    background: none;
    text-align: left;
    padding: 4px 8px;
  }
  .count {
    color: var(--ink-quiet);
    margin-left: 8px;
  }
  .count.has-errors {
    color: var(--error);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow: auto;
  }
  .item {
    display: flex;
    gap: 8px;
    width: 100%;
    text-align: left;
    border: none;
    border-radius: 0;
    background: none;
    padding: 2px 12px;
  }
  .item:hover {
    background: var(--hover);
  }
  .item.error .sev {
    color: var(--error);
  }
  .item.warning .sev {
    color: var(--warn);
  }
  .msg {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .at {
    font-family: var(--mono);
    color: var(--ink-quiet);
  }
  .none {
    color: var(--ink-quiet);
    padding: 4px 12px;
  }
</style>
