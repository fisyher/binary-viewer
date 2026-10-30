<script lang="ts">
  import { addDetect, detectIssues, editDetect, metaIssues, removeDetect, setMeta, type BuilderModel, type LocatedIssue } from '../../../core/builder';
  import { sanitizeText } from '../../../core/tree-model';

  let { model, issues, readOnly, commit }: { model: BuilderModel; issues: LocatedIssue[]; readOnly: boolean; commit: (m: BuilderModel) => void } = $props();

  const m = $derived(model.meta);
  let extText = $state('');
  const msg = (key: string) => metaIssues(issues, key).map((x) => x.issue.message).join('; ');

  function addExt() {
    const e = extText.trim().replace(/^\./, '').toLowerCase();
    if (e === '') return;
    extText = '';
    if (!(m.extensions ?? []).includes(e)) commit(setMeta(model, { extensions: [...(m.extensions ?? []), e] }));
  }
  function removeExt(i: number) {
    const next = (m.extensions ?? []).filter((_, xi) => xi !== i);
    commit(setMeta(model, { extensions: next.length > 0 ? next : [] }));
  }
  const parseAt = (s: string): number => (/^-?\d{1,15}$/.test(s.trim()) ? Number(s) : (s as unknown as number));
</script>

<div class="meta" role="group" aria-label="Format info">
  <label>
    Id
    <input type="text" aria-label="Format id" value={m.id ?? ''} disabled={readOnly} class:bad={!!msg('id')} onchange={(e) => commit(setMeta(model, { id: (e.currentTarget as HTMLInputElement).value }))} />
    {#if msg('id')}<small class="fb">{sanitizeText(msg('id'), 300)}</small>{/if}
  </label>
  <label>
    Name
    <input type="text" aria-label="Format name" value={m.name ?? ''} disabled={readOnly} class:bad={!!msg('name')} onchange={(e) => commit(setMeta(model, { name: (e.currentTarget as HTMLInputElement).value }))} />
    {#if msg('name')}<small class="fb">{sanitizeText(msg('name'), 300)}</small>{/if}
  </label>
  <label>
    Byte order
    <select aria-label="Default endian" disabled={readOnly} class:bad={!!msg('endian')} value={m.endian ?? ''} onchange={(e) => commit(setMeta(model, { endian: ((e.currentTarget as HTMLSelectElement).value || undefined) as never }))}>
      {#if m.endian !== 'le' && m.endian !== 'be'}<option value="">(choose le or be)</option>{/if}
      <option value="le">Little-endian (le)</option>
      <option value="be">Big-endian (be)</option>
    </select>
    {#if m.endian === undefined}<small class="fb">Choose le or be (required for u2/u4/u8/f4/f8 without a suffix).</small>{/if}
    {#if msg('endian')}<small class="fb">{sanitizeText(msg('endian'), 300)}</small>{/if}
  </label>
  <label>
    Root type
    <select aria-label="Root type" disabled={readOnly} class:bad={!!msg('root')} value={m.root ?? ''} onchange={(e) => commit(setMeta(model, { root: (e.currentTarget as HTMLSelectElement).value }))}>
      {#if !model.types.some((t) => t.name === m.root)}<option value={m.root ?? ''}>{sanitizeText(m.root ?? '(none)', 64)}</option>{/if}
      {#each model.types as t (t.name)}<option value={t.name}>{sanitizeText(t.name, 64)}</option>{/each}
    </select>
    {#if msg('root')}<small class="fb">{sanitizeText(msg('root'), 300)}</small>{/if}
  </label>
  <div class="ext">
    <span>Extensions</span>
    {#each m.extensions ?? [] as e, i (i)}
      <span class="chip">.{sanitizeText(e, 16)}<button type="button" disabled={readOnly} aria-label="Remove extension {sanitizeText(e, 16)}" onclick={() => removeExt(i)}>×</button></span>
    {/each}
    <input
      type="text"
      aria-label="Add extension"
      placeholder="bmp"
      bind:value={extText}
      disabled={readOnly}
      onkeydown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addExt();
        }
      }}
    />
    <button type="button" disabled={readOnly} onclick={addExt}>Add</button>
    {#if msg('extensions')}<small class="fb">{sanitizeText(msg('extensions'), 300)}</small>{/if}
  </div>
  <div class="detect">
    <span>Detect rules <small class="muted">(offset may be negative = from end; hex bytes; optional mask)</small></span>
    {#each m.detect ?? [] as r, i (i)}
      <div class="row" class:bad={detectIssues(issues, i).length > 0}>
        <input type="text" aria-label="Detect {i + 1} offset" value={String(r.at ?? '')} disabled={readOnly} onchange={(e) => commit(editDetect(model, i, { at: parseAt((e.currentTarget as HTMLInputElement).value) }))} />
        <input type="text" aria-label="Detect {i + 1} bytes" placeholder="42 4D" value={typeof r.bytes === 'string' ? r.bytes : ''} disabled={readOnly} onchange={(e) => commit(editDetect(model, i, { bytes: (e.currentTarget as HTMLInputElement).value }))} />
        <input type="text" aria-label="Detect {i + 1} mask" placeholder="mask (optional)" value={typeof r.mask === 'string' ? r.mask : ''} disabled={readOnly} onchange={(e) => commit(editDetect(model, i, { mask: (e.currentTarget as HTMLInputElement).value.trim() || undefined }))} />
        <button type="button" disabled={readOnly} aria-label="Remove detect rule {i + 1}" onclick={() => commit(removeDetect(model, i))}>✕</button>
        {#each detectIssues(issues, i) as x, xi (xi)}<small class="fb">{sanitizeText(x.issue.message, 200)}</small>{/each}
      </div>
    {/each}
    <button type="button" disabled={readOnly} onclick={() => commit(addDetect(model))}>Add detect rule</button>
  </div>
  <label class="doc">
    Doc
    <textarea aria-label="Format doc" rows="2" value={m.doc ?? ''} disabled={readOnly} onchange={(e) => commit(setMeta(model, { doc: (e.currentTarget as HTMLTextAreaElement).value || undefined }))}></textarea>
    {#if msg('doc')}<small class="fb">{sanitizeText(msg('doc'), 300)}</small>{/if}
  </label>
</div>

<style>
  .meta {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
  }
  label {
    display: flex;
    flex-direction: column;
  }
  .ext,
  .row {
    display: flex;
    gap: 4px;
    align-items: center;
    flex-wrap: wrap;
  }
  .detect {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .chip {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0 6px;
  }
  .chip button {
    border: none;
    background: none;
    padding: 0 2px;
  }
  .bad {
    border-color: var(--error);
  }
  .fb {
    color: var(--error);
  }
  .muted {
    color: var(--muted);
  }
  textarea {
    font: inherit;
  }
</style>
