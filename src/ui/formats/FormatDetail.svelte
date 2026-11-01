<script lang="ts">
  import type { LazyArray, Node } from '../../core/engine';
  import type { ParseSnapshot } from '../../worker/protocol';
  import BuilderView from './builder/BuilderView.svelte';
  import DocsView from './DocsView.svelte';
  import type { FormatsState } from './formats-state.svelte';
  import PreviewPane from './PreviewPane.svelte';
  import SpecJsonEditor from './SpecJsonEditor.svelte';

  let {
    ctl,
    previewDoc = null,
    previewActive = true,
    previewBusy = false,
    previewEpoch = 0,
    parseDraft = async () => null,
    loadPreviewPage = async () => ({ nodes: [], lazy: null }),
    loadPreviewRef = undefined,
    onShowInViewer = () => {},
  }: {
    ctl: FormatsState;
    /** Name of the document open in the viewer (null = none: no preview). */
    previewDoc?: string | null;
    /** This spec tab is the active editor tab. */
    previewActive?: boolean;
    /** A save of the document is in progress. */
    previewBusy?: boolean;
    /** Changes when the viewer finished an engine operation. */
    previewEpoch?: number;
    parseDraft?: (text: string) => Promise<ParseSnapshot | null>;
    loadPreviewPage?: (nodeId: number, start: number, count: number) => Promise<{ nodes: Node[]; lazy: LazyArray | null }>;
    loadPreviewRef?: (nodeId: number) => Promise<Node[]>;
    onShowInViewer?: (range: { start: number; end: number } | null, offset: number) => void;
  } = $props();

  const selected = $derived(ctl.selected);
  const t = (s: string, max = 120) => ctl.t(s, max);
</script>

<section class="detail" aria-label="Format details">
  {#if selected}
    {#if selected.removedFromFolder}
      <div class="removed" role="alert">
        Removed from folder outside the app.
        <button type="button" onclick={() => ctl.keepRemoved()}>Keep (re-write to folder)</button>
        <button type="button" onclick={() => ctl.askDeleteRemoved()}>Delete locally</button>
      </div>
    {/if}
    {#if selected.folderBlocked}
      <div class="removed" role="alert">
        The folder file {t(selected.folderBlocked, 140)} blocks syncing this format: it is not a valid spec for it (or it now declares another id). Fix or remove it in the folder, or
        <button type="button" onclick={() => ctl.overwriteFolderFile()}>Overwrite folder file</button>
        (its current content is kept as a local copy first).
      </div>
    {/if}
    <div class="head">
      <div class="tabs" role="tablist" aria-label="Format view">
        <button type="button" role="tab" id="tab-builder" aria-selected={ctl.tab === 'builder'} aria-controls="panel-formats" class:active={ctl.tab === 'builder'} onclick={() => (ctl.tab = 'builder')}>Builder</button>
        <button type="button" role="tab" id="tab-json" aria-selected={ctl.tab === 'json'} aria-controls="panel-formats" class:active={ctl.tab === 'json'} onclick={() => (ctl.tab = 'json')}>JSON</button>
        <button type="button" role="tab" id="tab-docs" aria-selected={ctl.tab === 'docs'} aria-controls="panel-formats" class:active={ctl.tab === 'docs'} onclick={() => (ctl.tab = 'docs')}>Docs</button>
      </div>
      <span class="title">{t(selected.name)} <span class="id">{t(selected.id, 64)}</span></span>
      <div class="spec-actions">
        <button type="button" onclick={() => void ctl.duplicate()}>Duplicate</button>
        <button type="button" onclick={() => ctl.askDelete()} disabled={selected.source !== 'user'}>Delete</button>
        <button type="button" onclick={() => ctl.exportJson()}>Export JSON</button>
        <button type="button" onclick={() => ctl.exportDoc('md')} disabled={!selected.valid}>Export Markdown</button>
        <button type="button" onclick={() => ctl.exportDoc('html')} disabled={!selected.valid}>Export HTML</button>
      </div>
    </div>
    <div class="panel" id="panel-formats" role="tabpanel" aria-labelledby={ctl.tab === 'builder' ? 'tab-builder' : ctl.tab === 'json' ? 'tab-json' : 'tab-docs'}>
      {#key ctl.editorKey}
        <div class="editor-wrap" style:display={ctl.tab === 'json' ? 'block' : 'none'}>
          <SpecJsonEditor
            bind:this={ctl.jsonEditor}
            entry={selected}
            text={ctl.draftText}
            onText={(v) => (ctl.draft = v)}
            onResult={(r) => (ctl.saveStatus = r)}
            onSave={(text) => ctl.save(text)}
            onDuplicate={() => void ctl.duplicate()}
            onDirtyChange={(d) => (ctl.editorDirty = d)}
          />
        </div>
        <div class="editor-wrap" style:display={ctl.tab === 'builder' ? 'block' : 'none'}>
          <BuilderView
            text={ctl.draftText}
            onText={(v) => (ctl.draft = v)}
            readOnly={selected.source === 'builtin'}
            dirty={ctl.editorDirty}
            status={ctl.tab === 'builder' ? ctl.saveStatus : null}
            onSave={() => void ctl.jsonEditor?.save()}
            onRevert={() => ctl.jsonEditor?.revert()}
            onDuplicate={() => void ctl.duplicate()}
          />
        </div>
      {/key}
      {#if ctl.tab === 'docs'}
        <div class="docs-wrap">
          {#if ctl.docsNote}<p class="docs-note" role="note">{ctl.docsNote}</p>{/if}
          <DocsView spec={ctl.docsSpec} />
        </div>
      {/if}
    </div>
    <PreviewPane
      text={ctl.draftText}
      docName={previewDoc}
      active={previewActive}
      busy={previewBusy}
      epoch={previewEpoch}
      {parseDraft}
      loadPage={loadPreviewPage}
      loadRef={loadPreviewRef}
      {onShowInViewer}
    />
  {:else}
    <div class="placeholder"><p>Select a format, or create a new one.</p></div>
  {/if}
</section>

<style>
  .detail {
    height: 100%;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--ground);
  }
  .head {
    flex: none;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 16px;
    padding: 0 12px;
    background: var(--chrome);
    border-bottom: 1px solid var(--rule);
  }
  .tabs {
    display: flex;
    gap: 2px;
  }
  .tabs button {
    border: none;
    border-radius: 0;
    border-bottom: 2px solid transparent;
    padding: 6px 10px 4px;
    color: var(--ink-quiet);
  }
  .tabs button.active {
    color: var(--ink);
    font-weight: 600;
    border-bottom-color: var(--signal);
  }
  .title {
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title .id {
    font-weight: 400;
    font-family: var(--mono);
    font-size: var(--fs-sm);
    color: var(--ink-quiet);
    margin-left: 6px;
  }
  .spec-actions {
    margin-left: auto;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 4px 0;
  }
  .spec-actions button {
    font-size: var(--fs-sm);
    padding: 1px 8px;
  }
  .placeholder {
    flex: 1;
    padding: 24px 16px;
    color: var(--ink-quiet);
  }
  .placeholder p {
    margin: 0;
  }
  .panel {
    flex: 1;
    min-height: 120px;
  }
  .editor-wrap,
  .docs-wrap {
    height: 100%;
  }
  .docs-wrap {
    display: flex;
    flex-direction: column;
  }
  .docs-note,
  .removed {
    margin: 0;
    padding: 4px 12px;
    font-size: var(--fs-sm);
    border-bottom: 1px solid var(--rule);
    color: var(--edited);
  }
</style>
