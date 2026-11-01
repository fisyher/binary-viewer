<script lang="ts">
  let {
    hasName,
    saving = false,
    unreadable = false,
    loadError = null,
    onNew,
    onOpen,
    onSave,
    onSaveAs,
    onAbout,
    onPalette,
  }: {
    /** A document is open (Save / Save As need one). */
    hasName: boolean;
    /** A save is in progress (editing is blocked). */
    saving?: boolean;
    /** The file could not be re-read after saving: only opening another file makes sense. */
    unreadable?: boolean;
    loadError?: string | null;
    onNew: () => void;
    onOpen: () => void;
    onSave: () => void;
    onSaveAs: () => void;
    /** Opens the About dialog; gets the clicked button so focus can return to it. */
    onAbout: (opener: HTMLElement) => void;
    /** Opens the command palette; gets the clicked button so focus can return to it. */
    onPalette: (opener: HTMLElement) => void;
  } = $props();
</script>

<!-- The single place for app-level actions: the file actions and the entry point of the command palette (Ctrl+K, F1). -->
<header class="titlebar">
  <button type="button" class="brand" aria-label="About Binary Viewer" title="About Binary Viewer" onclick={(e) => onAbout(e.currentTarget)}>
    <svg viewBox="0 0 32 32" width="18" height="18" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="3" fill="currentColor" />
      <g class="mark" fill="none" stroke-width="3" stroke-linecap="round">
        <ellipse cx="10.5" cy="16" rx="4.5" ry="6.5" />
        <path d="M18.5 12l8 8M26.5 12l-8 8" />
      </g>
    </svg>
    <span class="brand-text">Binary Viewer</span>
  </button>
  <div class="actions" role="group" aria-label="File">
    <button type="button" onclick={onNew} disabled={saving}>New</button>
    <button type="button" onclick={onOpen} disabled={saving}>Open…</button>
    <button type="button" onclick={onSave} disabled={!hasName || saving || unreadable}>Save</button>
    <button type="button" onclick={onSaveAs} disabled={!hasName || saving || unreadable}>Save As…</button>
  </div>
  {#if loadError}<span class="error" role="alert">{loadError}</span>{/if}
  <span class="spacer"></span>
  <button type="button" class="palette" aria-label="Commands" title="Commands (Ctrl+K)" aria-keyshortcuts="Control+K F1" onclick={(e) => onPalette(e.currentTarget)}>
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <circle cx="6.5" cy="6.5" r="4.25" fill="none" stroke="currentColor" stroke-width="1.4" />
      <path d="M10 10l4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  </button>
  <button type="button" class="about" aria-label="About" title="About Binary Viewer" onclick={(e) => onAbout(e.currentTarget)}>?</button>
</header>

<style>
  .titlebar {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 36px;
    padding: 0 8px;
    box-sizing: border-box;
    background: var(--chrome-deep);
    border-bottom: 1px solid var(--rule);
    min-width: 0;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    border-color: transparent;
    padding: 2px 6px;
    font-weight: 600;
    font-size: var(--fs-lg);
    color: var(--ink);
  }
  .mark {
    stroke: var(--chrome-deep);
  }
  .actions {
    display: flex;
    gap: 2px;
  }
  .actions button {
    border-color: transparent;
    padding: 2px 10px;
  }
  .actions button:hover:not(:disabled) {
    border-color: var(--rule);
  }
  .palette,
  .about {
    border-color: transparent;
    min-width: 28px;
    font-weight: 600;
    color: var(--ink-quiet);
  }
  .spacer {
    flex: 1;
  }
  .error {
    color: var(--error);
    font-size: var(--fs-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  @media (max-width: 720px) {
    .brand-text {
      display: none;
    }
    .titlebar {
      gap: 4px;
    }
    .actions button {
      padding: 2px 6px;
    }
  }
</style>
