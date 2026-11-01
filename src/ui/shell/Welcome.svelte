<script lang="ts">
  import { START_SHORTCUTS } from '../shortcuts';

  let { formatNames, onBrowse }: { formatNames: string[]; onBrowse: () => void } = $props();
</script>

<div class="welcome">
  <div class="column">
    <!-- A sample row from a BMP: the same banding the structure tree paints over a real file. Decorative. -->
    <div class="sample" aria-hidden="true">
      <span class="off">00000000</span>
      <span class="cells">
        <span class="cell" data-t="1">42</span><span class="cell" data-t="1">4D</span>
        <span class="cell" data-t="2">8E</span><span class="cell" data-t="2">00</span><span class="cell" data-t="2">00</span><span class="cell" data-t="2">00</span>
        <span class="cell" data-t="3">00</span><span class="cell" data-t="3">00</span><span class="cell" data-t="3">00</span><span class="cell" data-t="3">00</span>
        <span class="cell" data-t="4">36</span><span class="cell" data-t="4">00</span><span class="cell" data-t="4">00</span><span class="cell" data-t="4">00</span>
      </span>
      <span class="ascii">BM........6...</span>
    </div>

    <h1>Binary Viewer</h1>
    <p class="tagline">Hex editor and binary format inspector</p>

    <p class="prompt">Click <strong>Open…</strong> or drop a file anywhere on this window.</p>
    <p class="privacy">Your files never leave this browser.</p>

    <section class="block" aria-labelledby="welcome-formats">
      <h2 id="welcome-formats">Built-in formats</h2>
      <ul class="formats">
        {#each formatNames as name (name)}<li>{name}</li>{/each}
      </ul>
      <button type="button" onclick={onBrowse}>Browse formats</button>
    </section>

    <section class="block" aria-labelledby="welcome-keys">
      <h2 id="welcome-keys">When a file is open</h2>
      <dl class="keys" aria-label="Keyboard shortcuts">
        {#each START_SHORTCUTS as s (s.keys)}
          <dt><kbd>{s.keys}</kbd></dt>
          <dd>{s.action}</dd>
        {/each}
      </dl>
    </section>
  </div>
</div>

<style>
  .welcome {
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--ground);
  }
  .column {
    max-width: 620px;
    padding: 56px 48px 48px;
  }
  .sample {
    display: flex;
    gap: 16px;
    align-items: center;
    font-family: var(--mono);
    font-size: var(--fs-base);
    margin-bottom: 28px;
    white-space: pre;
  }
  .off {
    color: var(--ink-faint);
  }
  .cells {
    display: inline-flex;
  }
  .cell {
    width: 2.4ch;
    text-align: center;
    margin-right: 0.4ch;
    border-radius: 2px;
  }
  .cell[data-t='1'] {
    background: var(--struct-1-tint);
  }
  .cell[data-t='2'] {
    background: var(--struct-2-tint);
  }
  .cell[data-t='3'] {
    background: var(--struct-3-tint);
  }
  .cell[data-t='4'] {
    background: var(--struct-4-tint);
  }
  .ascii {
    color: var(--ink-quiet);
  }
  h1 {
    margin: 0;
    font-size: var(--fs-xl);
    line-height: 1.2;
  }
  .tagline {
    margin: 4px 0 0;
    font-size: var(--fs-lg);
    color: var(--ink-quiet);
  }
  .prompt {
    margin: 28px 0 0;
    font-size: var(--fs-lg);
  }
  .privacy {
    margin: 4px 0 0;
    color: var(--ink-quiet);
  }
  .block {
    margin-top: 32px;
    padding-top: 16px;
    border-top: 1px solid var(--rule);
  }
  h2 {
    margin: 0 0 8px;
    font-size: var(--fs-base);
  }
  .formats {
    list-style: none;
    margin: 0 0 12px;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 2px 20px;
    color: var(--ink-quiet);
  }
  .keys {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 20px;
    margin: 0;
  }
  .keys dt,
  .keys dd {
    margin: 0;
  }
  .keys kbd {
    font-size: var(--fs-sm);
  }
  .keys dd {
    color: var(--ink-quiet);
  }
  @media (max-width: 600px) {
    .column {
      padding: 28px 20px;
    }
    .sample .ascii {
      display: none;
    }
  }
</style>
