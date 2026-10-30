<script lang="ts">
  import { downloadBlob } from '../../core/download';
  import type { FormatSpec } from '../../core/engine';
  import type { SpecEntry, SpecLibrary } from '../../core/spec-library';
  import { sanitizeText } from '../../core/tree-model';
  import { untrack } from 'svelte';
  import ConfirmDialog from '../ConfirmDialog.svelte';
  import DocsView from './DocsView.svelte';
  import SpecJsonEditor from './SpecJsonEditor.svelte';

  let { library, onDirtyChange = () => {} }: { library: SpecLibrary; onDirtyChange?: (dirty: boolean) => void } = $props();

  let snap = $state.raw(untrack(() => library.snapshot()));
  $effect(() => {
    snap = library.snapshot();
    return library.subscribe(() => (snap = library.snapshot()));
  });

  let selectedId = $state<string | null>(null);
  // The editor stays mounted across tab switches and renames (it is keyed by this, which only changes when the
  // user picks another spec), so unsaved text is never discarded by the UI.
  let editorKey = $state(0);
  let saving = $state(false);
  let held: SpecEntry | undefined; // the selected entry while a save that renames it is in flight
  const lastValid = new Map<string, FormatSpec>();
  let tab = $state<'json' | 'docs'>('json');
  let editorDirty = $state(false);
  let confirm = $state<{ message: string; label: string; run: () => void } | null>(null);
  let error = $state<string | null>(null);
  let importInput: HTMLInputElement | undefined = $state();

  $effect(() => onDirtyChange(editorDirty));

  const selected: SpecEntry | undefined = $derived(snap.entries.find((e) => e.id === selectedId) ?? (saving ? held : undefined));
  $effect(() => {
    const e = snap.entries.find((x) => x.id === selectedId);
    if (e) held = e;
    for (const x of snap.entries) if (x.spec) lastValid.set(x.id, x.spec);
  });
  const docsSpec = $derived(selected ? (selected.spec ?? lastValid.get(selected.id) ?? null) : null);
  const docsNote = $derived(
    !selected ? null : !selected.valid && docsSpec ? 'The saved version is invalid; showing the last valid version.' : editorDirty ? 'Showing the last saved version; you have unsaved changes.' : null,
  );
  const builtins = $derived(snap.entries.filter((e) => e.source === 'builtin'));
  const customs = $derived(snap.entries.filter((e) => e.source === 'user'));
  const folder = $derived(snap.folder);

  const t = (s: string, max = 120) => sanitizeText(s, max);

  /** Run `action` now, or after the user agrees to drop unsaved edits of the open spec. */
  function guard(action: () => void) {
    if (editorDirty) {
      confirm = { message: `"${selected ? t(selected.name) : 'This format'}" has unsaved changes. Discard them?`, label: 'Discard changes', run: action };
    } else action();
  }

  function select(id: string | null) {
    if (id === selectedId) return;
    guard(() => {
      editorDirty = false;
      error = null;
      selectedId = id;
      editorKey++;
    });
  }

  async function createNew() {
    guard(async () => {
      editorDirty = false;
      const r = await library.create();
      if (r.ok) {
        error = null;
        selectedId = r.id;
        editorKey++;
        tab = 'json';
      } else error = r.error;
    });
  }

  async function duplicate() {
    const id = selectedId;
    if (!id) return;
    const r = await library.duplicate(id);
    if (r.ok) {
      guard(() => {
        editorDirty = false;
        error = null;
        selectedId = r.id;
        editorKey++;
        tab = 'json';
      });
    } else error = r.error;
  }

  function askDelete() {
    const e = selected;
    if (!e || e.source !== 'user') return;
    confirm = {
      message: `Delete the format "${t(e.name)}" (${t(e.id, 64)})? ${folder.state === 'connected' ? 'Its file in the synced folder is removed too. ' : ''}This cannot be undone.`,
      label: 'Delete',
      run: () => {
        void library.delete(e.id).then((r) => {
          if (r.ok) {
            editorDirty = false;
            selectedId = null;
            error = null;
          } else error = r.error;
        });
      },
    };
  }

  async function save(text: string) {
    const id = selectedId;
    if (!id) return { ok: false as const, error: 'No format selected.' };
    saving = true;
    try {
      const r = await library.save(id, text);
      if (r.ok && r.id !== id) selectedId = r.id; // the id inside the JSON changed; the editor stays mounted
      return r;
    } finally {
      saving = false;
    }
  }

  function keepRemoved() {
    const e = selected;
    if (e) void library.keepRemoved(e.id).then((r) => (error = r.ok ? null : r.error));
  }

  function overwriteFolderFile(allowLoss = false) {
    const e = selected;
    if (!e) return;
    void library.overwriteFolderFile(e.id, allowLoss).then((r) => {
      if (r.ok) error = null;
      else if (r.needsConfirm) {
        confirm = {
          message: r.error + ' Replace it anyway? The old contents will be lost.',
          label: 'Overwrite',
          run: () => overwriteFolderFile(true),
        };
      } else error = r.error;
    });
  }

  function askDeleteRemoved() {
    const e = selected;
    if (!e) return;
    confirm = {
      message: 'Delete "' + t(e.name) + '" (' + t(e.id, 64) + ') from this library? Its file is already gone from the folder.',
      label: 'Delete locally',
      run: () => {
        void library.deleteRemoved(e.id).then((r) => {
          if (r.ok) {
            editorDirty = false;
            selectedId = null;
          } else error = r.error;
        });
      },
    };
  }

  async function onImport(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = input.files ? [...input.files] : [];
    input.value = '';
    if (files.length > 0) await library.importFiles(files);
  }

  function exportJson() {
    if (!selected) return;
    const blob = library.export(selected.id);
    if (blob) downloadBlob(`${selected.id}.json`, blob);
  }

  function exportDoc(kind: 'md' | 'html') {
    if (!selected) return;
    const d = library.exportDoc(selected.id, kind);
    if (d) downloadBlob(d.fileName, d.blob);
    else error = 'Documentation can only be generated for a valid format.';
  }

  const folderLine = $derived(
    !folder.supported
      ? 'Folder: not supported in this browser — use Import/Export'
      : folder.state === 'connected'
        ? `Folder: ${t(folder.name ?? '?', 60)} · synced`
        : folder.state === 'needs-permission'
          ? `Folder: ${t(folder.name ?? '?', 60)} · permission needed`
          : 'Folder: not connected',
  );
</script>

<div class="formats">
  <aside class="list" aria-label="Format library">
    <div class="actions">
      <button type="button" onclick={() => void createNew()}>New</button>
      <button type="button" onclick={() => void duplicate()} disabled={!selected}>Duplicate</button>
      <button type="button" onclick={askDelete} disabled={!selected || selected.source !== 'user'}>Delete</button>
      <button type="button" onclick={() => importInput?.click()}>Import…</button>
      <input type="file" hidden multiple accept=".json,application/json" bind:this={importInput} onchange={(e) => void onImport(e)} aria-label="Import format files" />
    </div>
    <div class="actions">
      <button type="button" onclick={exportJson} disabled={!selected}>Export JSON</button>
      <button type="button" onclick={() => exportDoc('md')} disabled={!selected?.valid}>Export Markdown</button>
      <button type="button" onclick={() => exportDoc('html')} disabled={!selected?.valid}>Export HTML</button>
    </div>

    <div class="folder">
      <div class="folder-line" aria-live="polite">{folderLine}</div>
      {#if folder.supported}
        <div class="actions">
          {#if folder.state === 'none'}
            <button type="button" onclick={() => void library.connectFolder()}>Connect folder…</button>
          {:else if folder.state === 'needs-permission'}
            <button type="button" onclick={() => void library.reconnectFolder()}>Reconnect folder</button>
          {/if}
          {#if folder.state === 'connected' || folder.state === 'needs-permission'}
            <button type="button" onclick={() => void library.disconnectFolder()}>Disconnect folder</button>
          {/if}
        </div>
      {/if}
    </div>

    {#if snap.notice}<p class="notice" aria-live="polite">{t(snap.notice, 500)}</p>{/if}
    {#if snap.message}<p class="message" aria-live="polite">{t(snap.message, 500)}</p>{/if}
    {#if error}<p class="error" role="alert">{t(error, 500)}</p>{/if}

    <div class="entries">
      {#each [{ title: 'Built-in', items: builtins }, { title: 'Custom', items: customs }] as group (group.title)}
        <h3>{group.title}</h3>
        {#if group.items.length === 0}
          <p class="muted">None yet. Use New, Duplicate or Import.</p>
        {/if}
        <ul>
          {#each group.items as e (e.id)}
            <li>
              <button type="button" class="entry" class:selected={e.id === selectedId} aria-current={e.id === selectedId ? 'true' : undefined} onclick={() => select(e.id)}>
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
  </aside>

  <section class="detail" aria-label="Format details">
    {#if !selected}
      <div class="placeholder"><p>Select a format, or create a new one.</p></div>
    {:else}
      {#if selected.removedFromFolder}
        <div class="removed" role="alert">
          Removed from folder outside the app.
          <button type="button" onclick={keepRemoved}>Keep (re-write to folder)</button>
          <button type="button" onclick={askDeleteRemoved}>Delete locally</button>
        </div>
      {/if}
      {#if selected.folderBlocked}
        <div class="removed" role="alert">
          The folder file {t(selected.folderBlocked, 140)} blocks syncing this format: it is not a valid spec for it (or it now declares another id). Fix or remove it in the folder, or
          <button type="button" onclick={() => overwriteFolderFile()}>Overwrite folder file</button>
          (its current content is kept as a local copy first).
        </div>
      {/if}
      <div class="tabs" role="tablist" aria-label="Format view">
        <button type="button" role="tab" id="tab-json" aria-selected={tab === 'json'} aria-controls="panel-formats" class:active={tab === 'json'} onclick={() => (tab = 'json')}>JSON</button>
        <button type="button" role="tab" id="tab-docs" aria-selected={tab === 'docs'} aria-controls="panel-formats" class:active={tab === 'docs'} onclick={() => (tab = 'docs')}>Docs</button>
        <span class="title">{t(selected.name)} <span class="id">({t(selected.id, 64)})</span></span>
      </div>
      <div class="panel" id="panel-formats" role="tabpanel" aria-labelledby={tab === 'json' ? 'tab-json' : 'tab-docs'}>
        {#key editorKey}
          <div class="editor-wrap" style:display={tab === 'json' ? 'block' : 'none'}>
            <SpecJsonEditor entry={selected} onSave={save} onDuplicate={() => void duplicate()} onDirtyChange={(d) => (editorDirty = d)} />
          </div>
        {/key}
        {#if tab === 'docs'}
          <div class="docs-wrap">
            {#if docsNote}<p class="docs-note" role="note">{docsNote}</p>{/if}
            <DocsView spec={docsSpec} />
          </div>
        {/if}
      </div>
    {/if}
  </section>
</div>

{#if confirm}
  {@const pending = confirm}
  <ConfirmDialog
    message={pending.message}
    confirmLabel={pending.label}
    onCancel={() => (confirm = null)}
    onConfirm={() => {
      const run = pending.run;
      confirm = null;
      run();
    }}
  />
{/if}

<style>
  .formats {
    display: flex;
    height: 100%;
    min-height: 0;
  }
  .list {
    flex: none;
    width: 320px;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    background: var(--bg);
    min-height: 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 8px 0;
  }
  .folder {
    border-top: 1px solid var(--border);
    margin-top: 8px;
    padding-bottom: 6px;
  }
  .folder-line {
    padding: 6px 8px 0;
    font-size: 12px;
    color: var(--muted);
  }
  .notice,
  .message,
  .error {
    margin: 4px 8px;
    font-size: 12px;
  }
  .notice {
    color: #d97706;
  }
  .message {
    color: var(--muted);
  }
  .error {
    color: var(--error);
  }
  .entries {
    flex: 1;
    min-height: 0;
    overflow: auto;
    border-top: 1px solid var(--border);
  }
  h3 {
    margin: 8px 8px 2px;
    font-size: 12px;
    text-transform: uppercase;
    color: var(--muted);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .muted {
    margin: 2px 8px;
    font-size: 12px;
    color: var(--muted);
  }
  .entry {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0 8px;
    width: 100%;
    text-align: left;
    border: none;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    background: none;
    padding: 4px 8px;
  }
  .entry.selected {
    background: var(--sel-bg);
    color: var(--sel-fg);
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
    font-size: 11px;
    color: var(--muted);
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
    font-size: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0 6px;
  }
  .badge.ok {
    border-color: #16a34a;
    color: #16a34a;
  }
  .badge.bad {
    border-color: var(--error);
    color: var(--error);
  }
  .detail {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .placeholder {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 8px 0;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .tabs button {
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    border-bottom: none;
  }
  .tabs button.active {
    background: var(--bg);
    font-weight: 600;
  }
  .title {
    margin-left: 12px;
    font-weight: 600;
  }
  .title .id {
    font-weight: 400;
  }
  .panel {
    flex: 1;
    min-height: 0;
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
    padding: 4px 8px;
    font-size: 12px;
    border-bottom: 1px solid var(--border);
    color: var(--edited);
  }
</style>
