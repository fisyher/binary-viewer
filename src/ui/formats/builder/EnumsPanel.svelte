<script lang="ts">
  import {
    addEnum,
    addEnumEntry,
    editEnumEntry,
    enumIssues,
    removeEnum,
    removeEnumEntry,
    renameEnum,
    type BuilderModel,
    type LocatedIssue,
  } from '../../../core/builder';
  import { sanitizeText } from '../../../core/tree-model';

  let { model, issues, readOnly, commit }: { model: BuilderModel; issues: LocatedIssue[]; readOnly: boolean; commit: (m: BuilderModel) => void } = $props();

  let error = $state<string | null>(null);
  const enums = $derived(model.enums ?? []);

  function run(r: ReturnType<typeof addEnum>) {
    if (!r.ok) error = r.error + (r.references ? ' ' + r.references.map((x) => x.where).join(', ') : '');
    else {
      error = null;
      commit(r.model);
    }
  }
  const entryMsg = (name: string, key: string) =>
    enumIssues(issues, name)
      .filter((x) => x.loc.kind === 'enum' && x.loc.entry === key)
      .map((x) => x.issue.message)
      .join('; ');
</script>

<div class="enums" role="group" aria-label="Enums">
  {#each enums as e (e.name)}
    <fieldset class:bad={enumIssues(issues, e.name).length > 0}>
      <legend>
        <input type="text" aria-label="Name of enum {sanitizeText(e.name, 40)}" value={e.name} disabled={readOnly} onchange={(ev) => run(renameEnum(model, e.name, (ev.currentTarget as HTMLInputElement).value.trim()))} />
        <button type="button" disabled={readOnly} aria-label="Delete enum {sanitizeText(e.name, 40)}" onclick={() => run(removeEnum(model, e.name))}>✕</button>
      </legend>
      {#each e.entries as en, i (i)}
        <div class="row">
          <input type="text" aria-label="Value {i + 1} of enum {sanitizeText(e.name, 40)}" value={en.key} disabled={readOnly} onchange={(ev) => run(editEnumEntry(model, e.name, i, { key: (ev.currentTarget as HTMLInputElement).value.trim() }))} />
          <input type="text" aria-label="Label {i + 1} of enum {sanitizeText(e.name, 40)}" value={en.label} disabled={readOnly} onchange={(ev) => run(editEnumEntry(model, e.name, i, { label: (ev.currentTarget as HTMLInputElement).value }))} />
          <button type="button" disabled={readOnly} aria-label="Remove value {i + 1} of enum {sanitizeText(e.name, 40)}" onclick={() => commit(removeEnumEntry(model, e.name, i))}>✕</button>
          {#if entryMsg(e.name, en.key)}<span class="fb">{sanitizeText(entryMsg(e.name, en.key), 200)}</span>{/if}
        </div>
      {/each}
      <button type="button" disabled={readOnly} aria-label="Add value to enum {sanitizeText(e.name, 40)}" onclick={() => run(addEnumEntry(model, e.name))}>Add value</button>
    </fieldset>
  {/each}
  <button type="button" disabled={readOnly} onclick={() => run(addEnum(model))}>Add enum</button>
  {#if enums.length === 0}<span class="muted">No enums.</span>{/if}
  {#if error}<p class="fb" role="alert">{sanitizeText(error, 300)}</p>{/if}
</div>

<style>
  .enums {
    font-size: var(--fs-sm);
  }
  fieldset {
    margin: 4px 0;
    border: 1px solid var(--rule);
  }
  fieldset.bad {
    border-color: var(--error);
  }
  .row {
    display: flex;
    gap: 4px;
    margin: 2px 0;
    flex-wrap: wrap;
  }
  .row input {
    flex: 1;
    min-width: 6ch;
  }
  .fb {
    color: var(--error);
  }
  .muted {
    color: var(--ink-quiet);
  }
</style>
