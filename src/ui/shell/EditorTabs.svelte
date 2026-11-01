<script module lang="ts">
  export interface EditorTab {
    id: 'file' | 'spec';
    label: string;
    /** Unsaved changes: shows a marker. */
    modified: boolean;
    /** Accessible name of the marker. */
    modifiedLabel: string;
    closable: boolean;
  }
</script>

<script lang="ts">
  let {
    tabs,
    activeId,
    onSelect,
    onClose,
  }: {
    tabs: EditorTab[];
    activeId: EditorTab['id'];
    onSelect: (id: EditorTab['id']) => void;
    onClose: (id: EditorTab['id']) => void;
  } = $props();

  let list: HTMLElement | undefined = $state();
  // The active tab can vanish (the spec tab closed): fall back to the first one.
  const current = $derived(tabs.some((t) => t.id === activeId) ? activeId : tabs[0]?.id);

  function onKeyDown(e: KeyboardEvent) {
    const i = tabs.findIndex((t) => t.id === current);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0 || next === i) return;
    e.preventDefault();
    const id = tabs[next]!.id;
    onSelect(id);
    list?.querySelector<HTMLElement>(`#editor-tab-${id}`)?.focus();
  }
</script>

<!-- Phase 1b adds more spec tabs here; each tab is a role=tab button with its own close button beside it. -->
<div class="tabbar">
  {#if tabs.length > 0}
    <div class="tabs" role="tablist" aria-label="Editors" bind:this={list}>
      {#each tabs as tab (tab.id)}
        {@const active = tab.id === current}
        <div class="tab" class:active>
          <button
            type="button"
            role="tab"
            id="editor-tab-{tab.id}"
            aria-selected={active}
            aria-controls="editor-panel-{tab.id}"
            tabindex={active ? 0 : -1}
            title={tab.label}
            onclick={() => onSelect(tab.id)}
            onkeydown={onKeyDown}
          >
            <span class="label" class:file={tab.id === 'file'}>{tab.label}</span>
            {#if tab.modified}<span class="dirty" aria-label={tab.modifiedLabel} title={tab.modifiedLabel}>●</span>{/if}
          </button>
          {#if tab.closable}
            <button type="button" class="close" aria-label="Close {tab.label}" title="Close {tab.label}" onclick={() => onClose(tab.id)}>
              <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" /></svg>
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .tabbar {
    flex: none;
    height: 34px;
    background: var(--chrome);
    border-bottom: 1px solid var(--rule);
    display: flex;
    min-width: 0;
  }
  .tabs {
    display: flex;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
  }
  .tab {
    position: relative;
    flex: none;
    display: flex;
    align-items: stretch;
    max-width: 260px;
    background: var(--chrome-deep);
    border-right: 1px solid var(--rule);
    color: var(--ink-quiet);
  }
  .tab.active {
    background: var(--ground);
    color: var(--ink);
    margin-bottom: -1px;
  }
  .tab.active::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 2px;
    background: var(--signal);
  }
  [role='tab'] {
    border: none;
    border-radius: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 6px 0 14px;
    min-width: 0;
    font-weight: 500;
  }
  .tab.active [role='tab'] {
    font-weight: 600;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dirty {
    flex: none;
    color: var(--edited);
    font-size: var(--fs-xs);
  }
  .close {
    border: none;
    border-radius: 0;
    padding: 0 10px 0 4px;
    display: flex;
    align-items: center;
    color: var(--ink-quiet);
  }
  .close:hover:not(:disabled) {
    color: var(--ink);
  }
  .tab:not(:has(.close)) [role='tab'] {
    padding-right: 14px;
  }
</style>
