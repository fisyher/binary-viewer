<script lang="ts">
  import { selectionRange, type Selection } from '../core/caret';
  import { describeStatus, statusParts, type ParseStatus } from '../core/format-status';
  import { sanitizeText } from '../core/tree-model';
  import type { ThemePref } from './prefs';

  let {
    selection,
    error = null,
    engineError = null,
    notice = null,
    info = null,
    insertMode = null,
    onToggleInsert = () => {},
    onRetry,
    formatName = null,
    formatHint = null,
    onChooseFormat = () => {},
    parse = { state: 'idle' },
    onCancelParse = () => {},
    onShowProblems = () => {},
    littleEndian = true,
    onToggleEndian = () => {},
    canGoTo = false,
    onGoTo = () => {},
    size = null,
    saving = false,
    theme = 'system',
    onCycleTheme = () => {},
  }: {
    selection: Selection | null;
    error?: string | null;
    /** The format engine or the format library failed (shown like the other errors). */
    engineError?: string | null;
    /** Edit/copy/paste/save problem. */
    notice?: string | null;
    /** Non-error status text. */
    info?: string | null;
    /** null hides the indicator (nothing editable open). */
    insertMode?: boolean | null;
    /** Switch between insert and overwrite (the Insert key). */
    onToggleInsert?: () => void;
    onRetry?: () => void;
    /** Name of the format the open file is parsed with; null = none (raw bytes) or no file. */
    formatName?: string | null;
    /** Why the format is only a suggestion ("Suggested from extension only"); null when it is not. */
    formatHint?: string | null;
    /** Open the format picker; gets the clicked button so focus can return to it. */
    onChooseFormat?: (opener: HTMLElement) => void;
    /** State of the parse of the open file; idle shows nothing. */
    parse?: ParseStatus;
    onCancelParse?: () => void;
    /** Open and focus the Problems panel. */
    onShowProblems?: () => void;
    littleEndian?: boolean;
    onToggleEndian?: () => void;
    /** The selection item opens Go to offset (needs a non-empty file); gets the clicked button so focus can return to it. */
    canGoTo?: boolean;
    onGoTo?: (opener: HTMLElement) => void;
    /** Size of the open document; null = no document. */
    size?: number | null;
    saving?: boolean;
    theme?: ThemePref;
    onCycleTheme?: () => void;
  } = $props();

  const r = $derived(selection ? selectionRange(selection) : null);
  const parts = $derived(statusParts(parse));
  const fullStatus = $derived(sanitizeText(describeStatus(parse), 400));

  const hex = (n: number) => '0x' + n.toString(16).toUpperCase();
  const themeLabel = $derived(theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark');
  const shownFormat = $derived(formatName ?? 'No format');
</script>

<footer class="status" data-region="status">
  <div class="left">
    {#if size !== null}
      <button
        type="button"
        class="seg format"
        onclick={(e) => onChooseFormat(e.currentTarget)}
        title={(formatHint ? `${formatHint}. ` : 'Format used to parse the file. ') + 'Choose format'}
        aria-label="Format: {shownFormat}{formatHint ? ` (${formatHint})` : ''}. Choose format"
      >
        <span class="fname">{shownFormat}</span>{#if formatHint}<span class="tag">(extension only)</span>{/if}
      </button>
    {/if}
    <button
      type="button"
      class="seg endian"
      onclick={onToggleEndian}
      title="Toggle byte order"
      aria-label="Value byte order: {littleEndian ? 'little-endian' : 'big-endian'}"
    >{littleEndian ? 'LE' : 'BE'}</button>
    <button type="button" class="seg selection" onclick={(e) => onGoTo(e.currentTarget)} disabled={!canGoTo} title="Go to offset">
      {#if r}
        <span class="mono">Start: {hex(r.start)} ({r.start})</span>
        <span class="mono">End: {hex(r.end)} ({r.end})</span>
        <span class="mono">Length: {hex(r.length)} ({r.length})</span>
      {:else}
        <span class="muted">No selection</span>
      {/if}
    </button>
    {#if insertMode !== null}
      <button
        type="button"
        class="seg mode"
        onclick={onToggleInsert}
        title="Press Insert to toggle"
        aria-label="Edit mode: {insertMode ? 'Insert' : 'Overwrite'}. Switch to {insertMode ? 'overwrite' : 'insert'}"
      >{insertMode ? 'Insert' : 'Overwrite'}</button>
    {/if}
    {#if size !== null && parse.state !== 'idle'}
      <span class="seg parse" class:err={parse.state === 'error'}>
        <!-- The status element always carries the full sentence ("Parsed: 22 nodes, 0 errors, 0 warnings"); once there is a summary it is read, not shown. -->
        <span role="status" class:sr-only={parts !== null} class:text={parse.state === 'error'} title={parse.state === 'error' ? fullStatus : undefined}>{fullStatus}</span>
        {#if parse.state === 'parsing'}
          <button type="button" class="cancel" onclick={onCancelParse}>Cancel</button>
        {:else if parts}
          <button type="button" class="summary" class:partial={parts.lead !== null} onclick={onShowProblems} title="{fullStatus}. Show problems" aria-label="Show problems: {parts.errors}, {parts.warnings}">
            {#if parts.lead}<span class="lead">{parts.lead}</span><span class="dot" aria-hidden="true">&nbsp;·&nbsp;</span>{/if}<span class="nodes">{parts.nodes}<span class="dot" aria-hidden="true">&nbsp;·&nbsp;</span></span><span class:bad={parts.errors !== '0 errors'}>{parts.errors}</span><span class="dot" aria-hidden="true">&nbsp;·&nbsp;</span><span>{parts.warnings}</span>
          </button>
        {/if}
      </span>
    {/if}
    {#if engineError}<span class="seg error text" role="alert" title={engineError}>{engineError}</span>{/if}
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
  /* 25px: the 1px rule above leaves every button in the bar 24px tall. */
  .status {
    display: flex;
    align-items: stretch;
    justify-content: space-between;
    gap: 8px;
    height: 25px;
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
    min-width: 24px;
    flex: none;
  }
  /* Long messages shrink and end in an ellipsis (the full text is the title); Retry stays outside the clipped part. */
  .seg.text {
    flex: 0 1 auto;
    min-width: 0;
    display: block;
    line-height: 24px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mono {
    font-family: var(--mono);
    font-size: var(--fs-xs);
  }
  button.seg,
  .retry,
  .cancel,
  .summary {
    border: none;
    border-radius: 0;
  }
  button.seg {
    font-size: inherit;
  }
  .format {
    font-weight: 600;
    max-width: 30ch;
  }
  .fname {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tag {
    flex: none;
    font-weight: 400;
    color: var(--ink-quiet);
  }
  .error {
    color: var(--error);
  }
  .retry,
  .cancel {
    flex: none;
    padding: 0 10px;
    min-width: 24px;
    font-size: var(--fs-sm);
  }
  .muted {
    color: var(--ink-quiet);
  }
  .selection {
    gap: 12px;
  }
  .selection:disabled {
    opacity: 1; /* "No selection" is the normal look without a file; a quiet colour already says it is not an action */
    cursor: default;
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
  /* The parse summary: status text (read by screen readers) plus the compact button that opens Problems. */
  .parse {
    position: relative;
    align-items: stretch; /* its buttons fill the bar */
    gap: 0;
    padding: 0;
    color: var(--ink-quiet);
  }
  .parse > [role='status']:not(.sr-only) {
    padding: 0 10px;
    display: flex;
    align-items: center;
  }
  .parse > [role='status'].text {
    display: block;
    line-height: 24px;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 50ch;
  }
  .parse.err {
    color: var(--error);
  }
  .summary {
    display: flex;
    align-items: center;
    gap: 0;
    padding: 0 10px;
    min-width: 24px;
    font-size: inherit;
    color: var(--ink-quiet);
  }
  .summary.partial .lead {
    color: var(--warn);
    font-weight: 600;
  }
  .summary .nodes {
    display: flex;
  }
  .summary .bad {
    color: var(--error);
    font-weight: 600;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  @media (max-width: 720px) {
    .size,
    .nodes {
      display: none;
    }
    .format {
      max-width: 14ch;
    }
  }
</style>
