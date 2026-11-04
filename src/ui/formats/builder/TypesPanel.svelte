<script lang="ts">
  import { addType, duplicateType, removeType, renameType, typeIssues, type BuilderModel, type LocatedIssue } from '../../../core/builder';
  import { sanitizeText } from '../../../core/tree-model';
  import ConfirmDialog from '../../ConfirmDialog.svelte';

  let {
    model,
    selected = $bindable(''),
    issues,
    readOnly,
    commit,
  }: {
    model: BuilderModel;
    selected: string;
    issues: LocatedIssue[];
    readOnly: boolean;
    commit: (m: BuilderModel) => void;
  } = $props();

  let newName = $state('');
  let renameText = $state<string | null>(null);
  let error = $state<string | null>(null);
  let blocked = $state<{ message: string; where: string[] } | null>(null);
  let confirm = $state<string | null>(null);
  const shownRename = $derived(renameText ?? selected);

  function add() {
    const r = addType(model, newName.trim() === '' ? undefined : newName.trim());
    if (!r.ok) {
      error = r.error;
      return;
    }
    error = null;
    newName = '';
    commit(r.model);
    selected = r.name!;
  }

  function rename() {
    const to = shownRename.trim();
    const r = renameType(model, selected, to);
    renameText = null;
    if (!r.ok) {
      error = r.error;
      return;
    }
    error = null;
    commit(r.model);
    selected = r.name!;
  }

  function duplicate() {
    const r = duplicateType(model, selected);
    if (!r.ok) {
      error = r.error;
      return;
    }
    error = null;
    commit(r.model);
    selected = r.name!;
  }

  function askDelete() {
    error = null;
    const r = removeType(model, selected);
    if (!r.ok) {
      blocked = { message: r.error, where: (r.references ?? []).map((x) => x.where) };
      return;
    }
    blocked = null;
    confirm = selected;
  }

  function doDelete() {
    const name = confirm;
    confirm = null;
    if (name === null) return;
    const r = removeType(model, name);
    if (!r.ok) return;
    commit(r.model);
    selected = r.model.types[0]?.name ?? '';
  }
</script>

<div class="types" role="group" aria-label="Types">
  <ul>
    {#each model.types as t (t.name)}
      <li>
        <button type="button" class="tname" class:sel={t.name === selected} class:bad={typeIssues(issues, t.name).length > 0} aria-current={t.name === selected ? 'true' : undefined} onclick={() => ((selected = t.name), (renameText = null), (blocked = null))}>
          {sanitizeText(t.name, 64)}
          {#if model.meta.root === t.name}<span class="badge">root</span>{/if}
          {#if typeIssues(issues, t.name).length > 0}<span class="badge err" title="Validation issues">{typeIssues(issues, t.name).length}</span>{/if}
        </button>
      </li>
    {/each}
  </ul>
  <div class="row">
    <input type="text" placeholder="new type name" aria-label="New type name" bind:value={newName} disabled={readOnly} />
    <button type="button" disabled={readOnly} onclick={add}>Add type</button>
  </div>
  {#if selected}
    <div class="row">
      <input type="text" aria-label="Rename type" value={shownRename} oninput={(e) => (renameText = (e.currentTarget as HTMLInputElement).value)} disabled={readOnly} />
      <button type="button" disabled={readOnly || shownRename === selected} onclick={rename}>Rename</button>
    </div>
    <div class="row">
      <button type="button" disabled={readOnly} onclick={duplicate}>Duplicate type</button>
      <button type="button" disabled={readOnly} onclick={askDelete}>Delete type</button>
    </div>
  {/if}
  {#if error}<p class="err" role="alert">{sanitizeText(error, 300)}</p>{/if}
  {#if blocked}
    <div class="err" role="alert">
      <p>Cannot delete: {sanitizeText(blocked.message, 200)}</p>
      <ul>{#each blocked.where as w (w)}<li>{sanitizeText(w, 200)}</li>{/each}</ul>
    </div>
  {/if}
</div>

{#if confirm !== null}
  <ConfirmDialog message={`Delete the type "${sanitizeText(confirm, 64)}"? It is not used anywhere else.`} confirmLabel="Delete type" onCancel={() => (confirm = null)} onConfirm={doDelete} />
{/if}

<style>
  .types {
    font-size: var(--fs-sm);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .tname {
    width: 100%;
    text-align: left;
    border-radius: 0;
  }
  .tname.sel {
    background: var(--sel-bg);
    color: var(--sel-fg);
  }
  .tname.bad {
    border-left: 3px solid var(--error);
  }
  .badge {
    font-size: var(--fs-xs);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    padding: 0 5px;
    margin-left: 4px;
  }
  .badge.err,
  .err {
    color: var(--error);
  }
  .row {
    display: flex;
    gap: 4px;
    margin: 4px 0;
  }
  .row input {
    flex: 1;
    min-width: 0;
  }
</style>
