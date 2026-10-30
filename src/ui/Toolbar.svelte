<script lang="ts">
  import type { OffsetMode } from '../core/parse-offset';

  let {
    fileName,
    size,
    hasFile,
    onOpen,
    onGoTo,
    gotoError,
    loadError = null,
  }: {
    fileName: string | null;
    size: number;
    hasFile: boolean;
    onOpen: () => void;
    onGoTo: (text: string, mode: OffsetMode) => void;
    loadError?: string | null;
    gotoError: string | null;
  } = $props();

  let text = $state('');
  let mode = $state<OffsetMode>('hex');

  function submit(e: SubmitEvent) {
    e.preventDefault();
    onGoTo(text, mode);
  }
</script>

<header class="toolbar">
  <button type="button" onclick={onOpen}>Open…</button>
  {#if fileName !== null}
    <span class="file" title={fileName}>{fileName}</span>
    <span class="size">{size.toLocaleString()} bytes (0x{size.toString(16).toUpperCase()})</span>
  {/if}
  {#if loadError}<span class="error" role="alert">{loadError}</span>{/if}
  <span class="spacer"></span>
  <form onsubmit={submit}>
    <button
      type="button"
      class="mode"
      onclick={() => (mode = mode === 'hex' ? 'dec' : 'hex')}
      disabled={!hasFile}
      title="Toggle offset base"
      aria-label="Offset base: {mode === 'hex' ? 'hexadecimal' : 'decimal'}"
    >{mode === 'hex' ? 'Hex' : 'Dec'}</button>
    <input
      type="text"
      bind:value={text}
      placeholder={mode === 'hex' ? 'Go to offset (hex: 1F or 0x1F)' : 'Go to offset (decimal: 31)'}
      aria-label="Go to offset"
      aria-invalid={gotoError ? 'true' : 'false'}
      disabled={!hasFile}
      spellcheck="false"
      autocomplete="off"
    />
    <button type="submit" disabled={!hasFile}>Go</button>
    {#if gotoError}<span class="error" role="alert">{gotoError}</span>{/if}
  </form>
</header>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .file {
    font-weight: 600;
    max-width: 30ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .size {
    color: var(--muted);
    font-family: var(--mono);
    font-size: 12px;
  }
  .spacer {
    flex: 1;
  }
  form {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .mode {
    min-width: 4ch;
    font-family: var(--mono);
  }
  input {
    width: 32ch;
    font-family: var(--mono);
  }
  input[aria-invalid='true'] {
    border-color: var(--error);
  }
  .error {
    color: var(--error);
    font-size: 12px;
  }
</style>
