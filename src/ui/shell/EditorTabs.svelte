<script module lang="ts">
  export interface EditorTab {
    /** 'file' for the binary file; any other string is a spec tab (the app chooses it). */
    id: string;
    label: string;
    /** Unsaved changes: shows a marker. */
    modified: boolean;
    /** Accessible name of the marker. */
    modifiedLabel: string;
    closable: boolean;
  }

  /** DOM id of a tab button (spec ids are user text: keep it selector-safe). */
  export const tabDomId = (id: string) => 'editor-tab-' + id.replace(/[^A-Za-z0-9_-]/g, '_');
</script>

<script lang="ts">
  import { tick } from 'svelte';

  let {
    tabs,
    activeId,
    panelId,
    onSelect,
    onClose,
  }: {
    tabs: EditorTab[];
    activeId: EditorTab['id'];
    /** The id of the panel the active tab controls. */
    panelId: (id: EditorTab['id']) => string;
    onSelect: (id: EditorTab['id']) => void;
    onClose: (id: EditorTab['id']) => void;
  } = $props();

  let list: HTMLElement | undefined = $state();
  // The active tab can vanish (no file open yet): fall back to the first one.
  const current = $derived(tabs.some((t) => t.id === activeId) ? activeId : tabs[0]?.id);

  // Many tabs scroll horizontally; the active one is kept in view.
  $effect(() => {
    void current;
    void tabs.length;
    const box = list;
    const el = box?.querySelector<HTMLElement>('.tab.active');
    if (!box || !el) return;
    if (el.offsetLeft < box.scrollLeft) box.scrollLeft = el.offsetLeft;
    else if (el.offsetLeft + el.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = el.offsetLeft + el.offsetWidth - box.clientWidth;
  });

  const tabButtons = () => [...(list?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];

  async function onKeyDown(e: KeyboardEvent) {
    const i = tabs.findIndex((t) => t.id === current);
    if (i < 0) return;
    if (e.key === 'Delete') {
      const tab = tabs[i]!;
      if (!tab.closable) return;
      e.preventDefault();
      onClose(tab.id);
      await tick();
      // The tab is gone: keep the keyboard on the tab bar unless a dialog took the focus.
      if (document.activeElement === document.body || document.activeElement === null) tabButtons().find((b) => b.tabIndex === 0)?.focus();
      return;
    }
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0 || next === i) return;
    e.preventDefault();
    onSelect(tabs[next]!.id);
    tabButtons()[next]?.focus();
  }

  /** The browser's middle-click autoscroll would start on mousedown; the close happens on auxclick. */
  function onMouseDown(e: MouseEvent) {
    if (e.button === 1) e.preventDefault();
  }
  function onAuxClick(e: MouseEvent, tab: EditorTab) {
    if (e.button !== 1 || !tab.closable) return;
    e.preventDefault();
    onClose(tab.id);
  }
</script>

<div class="tabbar">
  {#if tabs.length > 0}
    <div class="tabs" role="tablist" aria-label="Editors" bind:this={list}>
      {#each tabs as tab (tab.id)}
        {@const active = tab.id === current}
        <div class="tab" class:active>
          <button
            type="button"
            role="tab"
            id={tabDomId(tab.id)}
            aria-selected={active}
            aria-controls={active ? panelId(tab.id) : undefined}
            tabindex={active ? 0 : -1}
            title={tab.label}
            onclick={() => onSelect(tab.id)}
            onkeydown={onKeyDown}
            onmousedown={onMouseDown}
            onauxclick={(e) => onAuxClick(e, tab)}
          >
            <span class="label" class:file={tab.id === 'file'}>{tab.label}</span>
            {#if tab.modified}<span class="dirty" aria-label={tab.modifiedLabel} title={tab.modifiedLabel}>●</span>{/if}
          </button>
          {#if tab.closable}
            <button
              type="button"
              class="close"
              tabindex={active ? 0 : -1}
              aria-label="Close {tab.label}"
              title="Close {tab.label}"
              onclick={() => onClose(tab.id)}
              onmousedown={onMouseDown}
              onauxclick={(e) => onAuxClick(e, tab)}
            >
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
    position: relative;
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
