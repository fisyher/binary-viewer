<script lang="ts">
  import type { OffsetMode } from '../core/parse-offset';

  let {
    fileName,
    size,
    hasFile,
    dirty = false,
    saving = false,
    unreadable = false,
    onNew,
    onOpen,
    onSave,
    onSaveAs,
    onGoTo,
    gotoError,
    loadError = null,
    view = 'viewer',
    onView = () => {},
    onAbout = () => {},
  }: {
    fileName: string | null;
    size: number;
    hasFile: boolean;
    /** Unsaved edits: shows a marker next to the file name. */
    dirty?: boolean;
    /** A save is in progress (editing is blocked). */
    saving?: boolean;
    /** The file could not be re-read after saving: only opening another file makes sense. */
    unreadable?: boolean;
    onNew: () => void;
    onOpen: () => void;
    onSave: () => void;
    onSaveAs: () => void;
    onGoTo: (text: string, mode: OffsetMode) => void;
    loadError?: string | null;
    gotoError: string | null;
    /** Top-level view: the hex viewer or the format library. */
    view?: 'viewer' | 'formats';
    onView?: (view: 'viewer' | 'formats') => void;
    /** Opens the About dialog; gets the clicked button so focus can return to it. */
    onAbout?: (opener: HTMLElement) => void;
  } = $props();

  let text = $state('');
  let mode = $state<OffsetMode>('hex');

  function submit(e: SubmitEvent) {
    e.preventDefault();
    onGoTo(text, mode);
  }
</script>

<header class="toolbar">
  <button type="button" class="brand" aria-label="About Binary Viewer" title="About Binary Viewer" onclick={(e) => onAbout(e.currentTarget)}>
    <svg viewBox="0 0 32 32" width="18" height="18" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="6" fill="currentColor" opacity="0.85" />
      <g class="mark" fill="none" stroke-width="3" stroke-linecap="round">
        <ellipse cx="10.5" cy="16" rx="4.5" ry="6.5" />
        <path d="M18.5 12l8 8M26.5 12l-8 8" />
      </g>
    </svg>
    <span class="brand-text">Binary Viewer</span>
  </button>
  <div class="modes" role="group" aria-label="Mode">
    <button type="button" class:active={view === 'viewer'} aria-pressed={view === 'viewer'} onclick={() => onView('viewer')}>Viewer</button>
    <button type="button" class:active={view === 'formats'} aria-pressed={view === 'formats'} onclick={() => onView('formats')}>Formats</button>
  </div>
  <button type="button" onclick={onNew} disabled={saving}>New</button>
  <button type="button" onclick={onOpen} disabled={saving}>Open…</button>
  <button type="button" onclick={onSave} disabled={fileName === null || saving || unreadable}>Save</button>
  <button type="button" onclick={onSaveAs} disabled={fileName === null || saving || unreadable}>Save As…</button>
  {#if fileName !== null}
    <span class="file" title={fileName}>{fileName}</span>
    {#if dirty}<span class="dirty" title="Unsaved changes" aria-label="Modified">●</span>{/if}
    {#if saving}<span class="size">Saving…</span>{/if}
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
  <button type="button" class="about" aria-label="About" title="About Binary Viewer" onclick={(e) => onAbout(e.currentTarget)}>?</button>
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
  .brand {
    display: flex;
    align-items: center;
    gap: 6px;
    border-color: transparent;
    background: transparent;
    color: var(--muted);
    font-weight: 600;
  }
  .mark {
    stroke: var(--panel);
  }
  .brand:hover {
    color: var(--fg);
  }
  @media (max-width: 720px) {
    .brand-text {
      display: none;
    }
  }
  .about {
    min-width: 2.2ch;
    font-weight: 600;
  }
  .modes {
    display: flex;
  }
  .modes button {
    border-radius: 0;
  }
  .modes button:first-child {
    border-radius: 4px 0 0 4px;
  }
  .modes button:last-child {
    border-radius: 0 4px 4px 0;
    margin-left: -1px;
  }
  .modes button.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .file {
    font-weight: 600;
    max-width: 30ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dirty {
    color: var(--edited);
    margin-left: -6px;
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
