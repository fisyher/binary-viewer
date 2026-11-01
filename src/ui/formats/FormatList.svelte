<script lang="ts">
  import type { FormatsState } from './formats-state.svelte';

  let { ctl }: { ctl: FormatsState } = $props();

  let importInput: HTMLInputElement | undefined = $state();
  const t = (s: string, max = 120) => ctl.t(s, max);

  async function onImport(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = input.files ? [...input.files] : [];
    input.value = '';
    await ctl.importFiles(files);
  }
</script>

<section class="list" aria-label="Format library">
  <div class="actions">
    <button type="button" onclick={() => ctl.openNew()}>New</button>
    <button type="button" onclick={() => importInput?.click()}>Import…</button>
    <input type="file" hidden multiple accept=".json,application/json" bind:this={importInput} onchange={(e) => void onImport(e)} aria-label="Import format files" />
  </div>
  {#if ctl.newForm}
    <form
      class="newform"
      aria-label="New format"
      onsubmit={(e) => {
        e.preventDefault();
        void ctl.submitNew();
      }}
    >
      <label>Format id <input type="text" aria-label="New format id" bind:value={ctl.newForm.id} /></label>
      <label>Name <input type="text" aria-label="New format name" bind:value={ctl.newForm.name} /></label>
      <label>
        Byte order
        <select aria-label="New format endian" bind:value={ctl.newForm.endian}>
          <option value="le">Little-endian (le)</option>
          <option value="be">Big-endian (be)</option>
        </select>
      </label>
      <label>Magic bytes (hex, optional) <input type="text" aria-label="New format magic" placeholder="42 4D" bind:value={ctl.newForm.magic} /></label>
      <label>Extension (optional) <input type="text" aria-label="New format extension" placeholder="bmp" bind:value={ctl.newForm.ext} /></label>
      {#if ctl.newError}<p class="error" role="alert">{t(ctl.newError, 300)}</p>{/if}
      <div class="row-actions">
        <button type="submit">Create</button>
        <button type="button" onclick={() => (ctl.newForm = null)}>Cancel</button>
      </div>
    </form>
  {/if}

  <div class="folder">
    <div class="folder-line" aria-live="polite">{ctl.folderLine}</div>
    {#if ctl.folder.supported}
      <div class="actions">
        {#if ctl.folder.state === 'none'}
          <button type="button" onclick={() => void ctl.library.connectFolder()}>Connect folder…</button>
        {:else if ctl.folder.state === 'needs-permission'}
          <button type="button" onclick={() => void ctl.library.reconnectFolder()}>Reconnect folder</button>
        {/if}
        {#if ctl.folder.state === 'connected' || ctl.folder.state === 'needs-permission'}
          <button type="button" onclick={() => void ctl.library.disconnectFolder()}>Disconnect folder</button>
        {/if}
      </div>
    {/if}
  </div>

  {#if ctl.snap.notice}<p class="notice" aria-live="polite">{t(ctl.snap.notice, 500)}</p>{/if}
  {#if ctl.snap.message}<p class="message" aria-live="polite">{t(ctl.snap.message, 500)}</p>{/if}
  {#if ctl.error}<p class="error" role="alert">{t(ctl.error, 500)}</p>{/if}

  <div class="entries">
    {#each [{ title: 'Built-in', items: ctl.builtins }, { title: 'Custom', items: ctl.customs }] as group (group.title)}
      <h3>{group.title}</h3>
      {#if group.items.length === 0}
        <p class="muted">None yet. Use New, Duplicate or Import.</p>
      {/if}
      <ul>
        {#each group.items as e (e.id)}
          <li>
            <button
              type="button"
              class="entry"
              class:selected={e.id === ctl.selectedId}
              aria-current={e.id === ctl.selectedId ? 'true' : undefined}
              onclick={() => ctl.select(e.id)}
            >
              <span class="name">{t(e.name)}</span>
              <span class="id">{t(e.id, 64)}</span>
              {#if e.extensions.length > 0}<span class="exts">{e.extensions.slice(0, 6).map((x) => '.' + t(x, 16)).join(' ')}</span>{/if}
              <span class="badges">
                {#if e.source === 'user'}
                  <span class="badge" class:ok={e.valid} class:bad={!e.valid} title={e.valid ? 'Valid' : 'Invalid draft: not used for detection'}>{e.valid ? 'valid' : 'invalid'}</span>
                  {#if e.inFolder}<span class="badge">in folder</span>{/if}
                  {#if e.removedFromFolder}<span class="badge bad" title="The file is gone from the folder">removed from folder</span>{/if}
                {:else}
                  <span class="badge ok">built-in</span>
                {/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/each}
  </div>
</section>

<style>
  .list {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    font-size: var(--fs-sm);
  }
  .actions,
  .row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 12px 0;
  }
  .row-actions {
    padding: 4px 0 0;
  }
  .newform {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px 10px;
    margin-top: 8px;
    border-top: 1px solid var(--rule);
  }
  .newform label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: var(--ink-quiet);
  }
  .folder {
    margin-top: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--rule);
  }
  .folder-line {
    padding: 4px 12px 0;
    color: var(--ink-quiet);
  }
  .notice,
  .message,
  .error {
    margin: 6px 12px 0;
  }
  .notice {
    color: var(--warn);
  }
  .message {
    color: var(--ink-quiet);
  }
  .error {
    color: var(--error);
  }
  .entries {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  h3 {
    margin: 12px 12px 4px;
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--ink-quiet);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .muted {
    margin: 2px 12px;
    color: var(--ink-quiet);
  }
  .entry {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0 8px;
    width: 100%;
    text-align: left;
    border: none;
    border-left: 2px solid transparent;
    border-radius: 0;
    padding: 5px 12px 5px 10px;
  }
  .entry.selected {
    background: var(--sel-bg);
    color: var(--sel-fg);
    border-left-color: var(--signal);
  }
  .name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .id,
  .exts {
    font-family: var(--mono);
    font-size: var(--fs-xs);
    color: var(--ink-quiet);
  }
  .entry.selected .id,
  .entry.selected .exts {
    color: inherit;
  }
  .badges {
    grid-row: 1;
    grid-column: 2;
    display: flex;
    gap: 4px;
  }
  .badge {
    font-size: var(--fs-xs);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    padding: 0 5px;
  }
  .badge.ok {
    border-color: var(--ok);
    color: var(--ok);
  }
  .badge.bad {
    border-color: var(--error);
    color: var(--error);
  }
</style>
