<script lang="ts">
  import { selectionRange, type Selection } from '../core/caret';
  import type { ThemePref } from './prefs';

  let {
    selection,
    error = null,
    notice = null,
    info = null,
    insertMode = null,
    onRetry,
    formatName = null,
    littleEndian = true,
    onToggleEndian = () => {},
    size = null,
    saving = false,
    theme = 'system',
    onCycleTheme = () => {},
  }: {
    selection: Selection | null;
    error?: string | null;
    /** Edit/copy/paste/save problem. */
    notice?: string | null;
    /** Non-error status text. */
    info?: string | null;
    /** null hides the indicator (nothing editable open). */
    insertMode?: boolean | null;
    onRetry?: () => void;
    /** Name of the format the open file is parsed with; null = none (raw bytes) or no file. */
    formatName?: string | null;
    littleEndian?: boolean;
    onToggleEndian?: () => void;
    /** Size of the open document; null = no document. */
    size?: number | null;
    saving?: boolean;
    theme?: ThemePref;
    onCycleTheme?: () => void;
  } = $props();

  const r = $derived(selection ? selectionRange(selection) : null);

  const hex = (n: number) => '0x' + n.toString(16).toUpperCase();
  const themeLabel = $derived(theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark');
</script>

<footer class="status">
  <div class="left">
    {#if size !== null}
      <span class="seg format" title="Format used to parse the file">{formatName ?? 'No format'}</span>
    {/if}
    <button
      type="button"
      class="seg endian"
      onclick={onToggleEndian}
      title="Toggle byte order"
      aria-label="Value byte order: {littleEndian ? 'little-endian' : 'big-endian'}"
    >{littleEndian ? 'LE' : 'BE'}</button>
    {#if r}
      <span class="seg mono">Start: {hex(r.start)} ({r.start})</span>
      <span class="seg mono">End: {hex(r.end)} ({r.end})</span>
      <span class="seg mono">Length: {hex(r.length)} ({r.length})</span>
    {:else}
      <span class="seg muted">No selection</span>
    {/if}
    {#if insertMode !== null}
      <span class="seg mode" title="Press Insert to toggle">{insertMode ? 'Insert' : 'Overwrite'}</span>
    {/if}
    {#if saving}<span class="seg" role="status">Saving…</span>{/if}
    {#if info}<span class="seg info text" role="status" title={info}>{info}</span>{/if}
    {#if notice}<span class="seg error text" role="alert" title={notice}>{notice}</span>{/if}
    {#if error}
      <span class="seg error text" role="alert" title={error}>{error}</span>
      {#if onRetry}<button type="button" class="retry" onclick={onRetry}>Retry</button>{/if}
    {/if}
  </div>
  <div class="right">
    {#if size !== null}
      <span class="seg mono size">{size.toLocaleString()} bytes (0x{size.toString(16).toUpperCase()})</span>
    {/if}
    <button type="button" class="seg theme" onclick={onCycleTheme} aria-label="Theme: {themeLabel}" title="Theme: {themeLabel}. Click to change.">
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
        {#if theme === 'light'}
          <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        {:else if theme === 'dark'}
          <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
        {:else}
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
        {/if}
      </svg>
      {themeLabel}
    </button>
  </div>
</footer>

<style>
  .status {
    display: flex;
    align-items: stretch;
    justify-content: space-between;
    gap: 8px;
    height: 24px;
    box-sizing: border-box;
    background: var(--chrome);
    border-top: 1px solid var(--rule);
    font-size: var(--fs-sm);
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  .left,
  .right {
    display: flex;
    align-items: stretch;
    min-width: 0;
  }
  .left {
    flex: 1;
    overflow: hidden;
  }
  .right {
    flex: none;
  }
  .seg {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 10px;
    flex: none;
  }
  /* Long messages shrink and end in an ellipsis (the full text is the title); Retry stays outside the clipped part. */
  .seg.text {
    flex: 0 1 auto;
    min-width: 0;
    display: block;
    line-height: 22px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mono {
    font-family: var(--mono);
    font-size: var(--fs-xs);
  }
  button.seg,
  .retry {
    border: none;
    border-radius: 0;
  }
  .format {
    font-weight: 600;
  }
  .error {
    color: var(--error);
  }
  .retry {
    flex: none;
    padding: 0 10px;
    font-size: var(--fs-sm);
  }
  .muted {
    color: var(--ink-quiet);
  }
  .mode {
    font-weight: 600;
  }
  .endian {
    font-family: var(--mono);
    font-size: var(--fs-xs);
  }
  .size {
    color: var(--ink-quiet);
  }
  @media (max-width: 720px) {
    .size,
    .format {
      display: none;
    }
  }
</style>
