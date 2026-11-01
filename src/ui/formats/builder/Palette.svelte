<script lang="ts">
  import { BLOCKS, applyBlock, defaultValues, exprSuggestions, fieldChoices, typeChoices, type BlockDef, type BuilderModel } from '../../../core/builder';
  import { sanitizeText } from '../../../core/tree-model';
  import ExprInput from './ExprInput.svelte';

  let {
    model,
    typeName,
    insertIndex,
    readOnly,
    commit,
    onNotice,
  }: {
    model: BuilderModel;
    typeName: string;
    /** Position at which fields are inserted (after the selected row). */
    insertIndex: number;
    readOnly: boolean;
    commit: (m: BuilderModel) => void;
    onNotice: (message: string | null) => void;
  } = $props();

  let active = $state<BlockDef | null>(null);
  let values = $state<Record<string, string>>({});
  let error = $state<string | null>(null);
  const ctx = $derived({ typeName, index: insertIndex });
  const groups = $derived([...new Set(BLOCKS.map((b) => b.group))]);

  function start(b: BlockDef) {
    if (readOnly) return;
    active = b;
    values = defaultValues(b, model, ctx);
    error = null;
  }

  function insert() {
    if (!active) return;
    const r = applyBlock(active, model, ctx, values);
    if (!r.ok) {
      error = r.error;
      return;
    }
    commit(r.model);
    onNotice(r.note ?? null);
    active = null;
    error = null;
  }
</script>

<div class="palette" role="group" aria-label="Building blocks">
  <h4>Building blocks</h4>
  <p class="muted">Click a block to insert it {insertIndex >= (model.types.find((t) => t.name === typeName)?.fields.length ?? 0) ? 'at the end of' : 'after the selected row in'} "{sanitizeText(typeName, 64)}".</p>
  {#each groups as g (g)}
    <div class="group">
      <div class="gname">{g}</div>
      {#each BLOCKS.filter((b) => b.group === g) as b (b.id)}
        <button type="button" class="block" disabled={readOnly} aria-pressed={active?.id === b.id} title={b.description} onclick={() => start(b)}>
          <span class="bl">{b.label}</span>
          <span class="bd">{b.description}</span>
        </button>
      {/each}
    </div>
  {/each}

  {#if active}
    {@const block = active}
    <form
      class="wizard"
      aria-label="{block.label} parameters"
      onsubmit={(e) => {
        e.preventDefault();
        insert();
      }}
    >
      <h5>{block.label}</h5>
      <p class="muted">{block.description}</p>
      {#each block.params.filter((p) => !p.showIf || p.showIf(values)) as p (p.key)}
        <label class="param">
          <span>{p.label}</span>
          {#if p.kind === 'checkbox'}
            <input type="checkbox" checked={values[p.key] === 'true'} onchange={(e) => (values[p.key] = (e.currentTarget as HTMLInputElement).checked ? 'true' : 'false')} />
          {:else if p.kind === 'select'}
            <select value={values[p.key]} onchange={(e) => (values[p.key] = (e.currentTarget as HTMLSelectElement).value)}>
              {#each p.options ?? [] as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
            </select>
          {:else if p.kind === 'field'}
            <select value={values[p.key]} onchange={(e) => (values[p.key] = (e.currentTarget as HTMLSelectElement).value)}>
              <option value="">(choose a field)</option>
              {#each fieldChoices(model, ctx, p.scope ?? 'earlier') as n (n)}<option value={n}>{sanitizeText(n, 64)}</option>{/each}
            </select>
          {:else if p.kind === 'type'}
            <select value={values[p.key]} onchange={(e) => (values[p.key] = (e.currentTarget as HTMLSelectElement).value)}>
              <option value="">{p.key === 'default' ? 'none' : '(choose a type)'}</option>
              {#each typeChoices(model, !!p.sized) as n (n)}<option value={n}>{sanitizeText(n, 64)}</option>{/each}
            </select>
          {:else if p.kind === 'textarea'}
            <textarea rows="3" value={values[p.key]} oninput={(e) => (values[p.key] = (e.currentTarget as HTMLTextAreaElement).value)}></textarea>
          {:else if p.kind === 'expr'}
            <ExprInput value={values[p.key]} label={p.label} suggestions={exprSuggestions(model, typeName, insertIndex, { withValue: true })} onCommit={(v) => (values[p.key] = v === undefined ? '' : String(v))} />
          {:else}
            <input type="text" value={values[p.key]} oninput={(e) => (values[p.key] = (e.currentTarget as HTMLInputElement).value)} />
          {/if}
          {#if p.help}<small class="muted">{p.help}</small>{/if}
        </label>
      {/each}
      {#if error}<p class="err" role="alert">{sanitizeText(error, 300)}</p>{/if}
      <div class="btns">
        <button type="submit">Insert</button>
        <button type="button" onclick={() => (active = null)}>Cancel</button>
      </div>
    </form>
  {/if}
</div>

<style>
  .palette {
    padding: 4px 8px;
    font-size: var(--fs-sm);
  }
  h4,
  h5 {
    margin: 4px 0;
  }
  .muted {
    color: var(--ink-quiet);
    margin: 2px 0;
  }
  .group {
    margin: 4px 0;
  }
  .gname {
    font-weight: 600;
    font-size: var(--fs-xs);
    color: var(--ink-quiet);
  }
  .block {
    display: block;
    width: 100%;
    text-align: left;
    margin: 2px 0;
  }
  .bl {
    font-weight: 600;
  }
  .bd {
    display: block;
    color: var(--ink-quiet);
    font-size: var(--fs-xs);
  }
  .wizard {
    border: 1px solid var(--rule);
    padding: 6px;
    margin-top: 8px;
  }
  .param {
    display: flex;
    flex-direction: column;
    margin: 4px 0;
  }
  .err {
    color: var(--error);
  }
  .btns {
    display: flex;
    gap: 6px;
  }
  textarea {
    font-family: var(--mono);
  }
</style>
