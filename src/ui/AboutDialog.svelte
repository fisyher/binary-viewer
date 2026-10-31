<script lang="ts">
  import { onMount } from 'svelte';
  import { APP_VERSION, BUILD_COMMIT, BUILD_DATE } from '../core/build-info';
  import { loadBuiltinSpecs } from '../formats';
  import { SHORTCUTS } from './shortcuts';

  let { onClose }: { onClose: () => void } = $props();

  const formats = loadBuiltinSpecs().specs.map((s) => s.name);
  let closeBtn: HTMLButtonElement | undefined = $state();

  onMount(() => closeBtn?.focus());

  function onKeyDown(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab') {
      // The Close button is the only control: keep focus inside the dialog.
      e.preventDefault();
      closeBtn?.focus();
    }
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="backdrop">
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
    <h2 id="about-title">Binary Viewer</h2>
    <p class="meta">Version {APP_VERSION} · build {BUILD_COMMIT} · {BUILD_DATE}</p>
    <p>
      View and edit the bytes of any file, decode its structure with built-in and your own JSON format specs, and build
      new specs visually.
    </p>
    <h3>Privacy &amp; storage</h3>
    <ul>
      <li>Runs entirely on your device: your files are never uploaded.</li>
      <li>No network requests of its own and no analytics.</li>
      <li>Format specs are kept in this browser's IndexedDB; a few display preferences are kept in local storage.</li>
      <li>Folder sync, when connected, only reads and writes the folder you pick.</li>
    </ul>
    <h3>Built-in formats</h3>
    <ul>
      {#each formats as name (name)}<li>{name}</li>{/each}
    </ul>
    <h3>Keyboard shortcuts</h3>
    <dl>
      {#each SHORTCUTS as s (s.keys)}
        <dt><kbd>{s.keys}</kbd></dt>
        <dd>{s.action}</dd>
      {/each}
    </dl>
    <p class="license">Released under the MIT License.</p>
    <div class="buttons">
      <button type="button" bind:this={closeBtn} onclick={onClose}>Close</button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10;
  }
  .dialog {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 16px 20px;
    width: min(520px, calc(100vw - 24px));
    max-height: calc(100vh - 24px);
    overflow-y: auto;
    box-sizing: border-box;
  }
  h2 {
    margin: 0;
  }
  h3 {
    margin: 16px 0 4px;
    font-size: 1rem;
  }
  p {
    margin: 8px 0;
  }
  .meta {
    color: var(--muted);
    font-family: var(--mono);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  ul {
    margin: 0;
    padding-left: 20px;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 12px;
    margin: 0;
  }
  dt,
  dd {
    margin: 0;
  }
  @media (max-width: 480px) {
    dl {
      grid-template-columns: 1fr;
    }
    dd {
      margin-bottom: 6px;
    }
  }
  kbd {
    font-family: var(--mono);
    font-size: 12px;
  }
  .license {
    color: var(--muted);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
  }
</style>
