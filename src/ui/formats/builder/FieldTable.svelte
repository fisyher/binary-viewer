<script lang="ts">
  import {
    PRIMITIVE_GROUPS,
    addField,
    addSwitchCase,
    removeSwitchCase,
    renameSwitchCase,
    setSwitchCaseType,
    type Op,
    duplicateField,
    editField,
    enumNames,
    exprSuggestions,
    fieldIssues,
    findReferences,
    findType,
    moveField,
    removeField,
    setFieldType,
    typeNames,
    type BuilderModel,
    type FieldModel,
    type LocatedIssue,
  } from '../../../core/builder';
  import { ENCODINGS } from '../../../core/engine';
  import { sanitizeText } from '../../../core/tree-model';
  import ExprInput from './ExprInput.svelte';

  let {
    model,
    typeName,
    selected = $bindable(null),
    issues,
    readOnly,
    commit,
    onNotice,
  }: {
    model: BuilderModel;
    typeName: string;
    selected: number | null;
    issues: LocatedIssue[];
    readOnly: boolean;
    commit: (m: BuilderModel) => void;
    onNotice: (message: string | null) => void;
  } = $props();

  const t = $derived(findType(model, typeName));
  const fields = $derived(t?.fields ?? []);
  const userTypes = $derived(typeNames(model));
  const enums = $derived(enumNames(model));
  let open = $state<ReadonlySet<number>>(new Set());
  let dragFrom: number | null = null;
  let dragOver = $state<number | null>(null);

  const msgs = (i: number, key: string): string | null => {
    const m = fieldIssues(issues, typeName, i, key).map((x) => x.issue.message);
    return m.length > 0 ? m.join('; ') : null;
  };
  const rowBad = (i: number) => fieldIssues(issues, typeName, i).length > 0;
  const patch = (i: number, p: Partial<FieldModel>) => commit(editField(model, typeName, i, p));
  const isSwitch = (f: FieldModel) => typeof f.type === 'object' && f.type !== null;
  const typeValue = (f: FieldModel) => (isSwitch(f) ? '__switch__' : typeof f.type === 'string' ? f.type : '');
  const known = (v: string) => v === 'value' || PRIMITIVE_GROUPS.some((g) => g.types.includes(v)) || userTypes.includes(v);
  const isValue = (f: FieldModel) => f.type === 'value';
  const repKind = (f: FieldModel) => (f.repeat === undefined ? '' : f.repeat === 'eos' ? 'eos' : typeof f.repeat === 'object' && f.repeat && 'until' in f.repeat ? 'until' : 'count');
  const repText = (f: FieldModel) => (typeof f.repeat === 'object' && f.repeat ? ('until' in f.repeat ? f.repeat.until : f.repeat.count) : '');
  const switchOf = (f: FieldModel) => f.type as unknown as { switch?: unknown; cases?: Record<string, string>; default?: string };

  function rename(i: number, name: string) {
    const old = fields[i]?.name ?? '';
    const refs = findReferences(model, old, typeName);
    patch(i, { name });
    onNotice(
      refs.length > 0
        ? `Renamed "${old}" to "${name}". ${refs.length} expression${refs.length === 1 ? ' still mentions' : 's still mention'} the old name (expressions are not rewritten automatically): ${refs
            .slice(0, 5)
            .map((r) => `${r.typeName}.${r.fieldName} ${r.slot}`)
            .join(', ')}.`
        : null,
    );
  }

  function remove(i: number) {
    const f = fields[i];
    if (!f) return;
    const refs = findReferences(model, f.name, typeName);
    commit(removeField(model, typeName, i));
    if (selected !== null && selected >= fields.length - 1) selected = fields.length - 2 >= 0 ? fields.length - 2 : null;
    onNotice(refs.length > 0 ? `Deleted "${f.name}". ${refs.length} expression${refs.length === 1 ? ' still mentions' : 's still mention'} it: ${refs.slice(0, 5).map((r) => `${r.typeName}.${r.fieldName} ${r.slot}`).join(', ')}.` : null);
  }

  function move(i: number, to: number) {
    if (to < 0 || to >= fields.length) return;
    commit(moveField(model, typeName, i, to));
    selected = to;
  }

  function changeType(i: number, v: string) {
    if (v === '__switch__') {
      const first = fields.slice(0, i)[fields.slice(0, i).length - 1]?.name ?? '';
      commit(setFieldType(model, typeName, i, { switch: first, cases: {} }));
    } else commit(setFieldType(model, typeName, i, v));
  }

  function changeRepeat(i: number, kind: string, text?: string) {
    if (kind === '') patch(i, { repeat: undefined });
    else if (kind === 'eos') patch(i, { repeat: 'eos' });
    else if (kind === 'until') patch(i, { repeat: { until: text ?? '' } });
    else patch(i, { repeat: { count: /^\d+$/.test(text ?? '') ? Number(text) : (text ?? 1) === '' ? 1 : (text ?? 1) } });
  }

  function toggle(i: number) {
    const n = new Set(open);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    open = n;
  }

  function addEmpty() {
    commit(addField(model, typeName, { name: 'field', type: 'u1' }, selected === null ? undefined : selected + 1));
  }

  let caseError = $state<string | null>(null);
  function runCase(r: Op) {
    if (r.ok) {
      caseError = null;
      commit(r.model);
    } else caseError = r.error;
  }

  type Bit = { name?: string; offset?: number; width?: number };
  const bitsOf = (f: FieldModel): Bit[] => (Array.isArray(f.bits) ? (f.bits as Bit[]) : []);
  type Asrt = { expr?: string; level?: string; message?: string };
  const assertsOf = (f: FieldModel): Asrt[] => (Array.isArray(f.assert) ? (f.assert as Asrt[]) : []);
  const setBits = (i: number, bits: Bit[]) => patch(i, { bits: bits.length > 0 ? (bits as never) : undefined });
  const setAsserts = (i: number, a: Asrt[]) => patch(i, { assert: a.length > 0 ? (a as never) : undefined });
  const num = (s: string) => (/^\d{1,9}$/.test(s.trim()) ? Number(s) : (s as unknown as number));
</script>

<div class="fields">
  {#if !t}
    <p class="muted">Select a type.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th></th><th>#</th><th>Name</th><th>Type</th><th>Size</th><th>Repeat</th><th>At</th><th>If</th><th>Enum</th><th>Expect</th><th>Doc</th><th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each fields as f, i (i)}
          <tr
            class:sel={selected === i}
            class:bad={rowBad(i)}
            class:over={dragOver === i}
            aria-selected={selected === i}
            onclick={() => (selected = i)}
            ondragover={(e) => {
              if (dragFrom !== null) {
                e.preventDefault();
                dragOver = i;
              }
            }}
            ondrop={(e) => {
              e.preventDefault();
              if (dragFrom !== null) move(dragFrom, i);
              dragFrom = null;
              dragOver = null;
            }}
          >
            <td>
              <span
                class="handle"
                role="presentation"
                title="Drag to reorder"
                draggable={!readOnly}
                ondragstart={(e) => {
                  dragFrom = i;
                  e.dataTransfer?.setData('text/plain', String(i));
                }}
                ondragend={() => {
                  dragFrom = null;
                  dragOver = null;
                }}>⠿</span
              >
            </td>
            <td class="idx">{i + 1}</td>
            <td>
              <input type="text" value={f.name} disabled={readOnly} aria-label="Name of field {i + 1}" aria-invalid={msgs(i, 'name') ? 'true' : 'false'} class:bad={!!msgs(i, 'name')} onchange={(e) => rename(i, (e.currentTarget as HTMLInputElement).value)} />
              {#if msgs(i, 'name')}<div class="fb">{sanitizeText(msgs(i, 'name')!, 300)}</div>{/if}
            </td>
            <td>
              <select disabled={readOnly} aria-label="Type of field {i + 1}" class:bad={!!msgs(i, 'type')} value={typeValue(f)} onchange={(e) => changeType(i, (e.currentTarget as HTMLSelectElement).value)}>
                {#each PRIMITIVE_GROUPS as g (g.label)}
                  <optgroup label={g.label}>{#each g.types as ty (ty)}<option value={ty}>{ty}</option>{/each}</optgroup>
                {/each}
                <optgroup label="Computed"><option value="value">value (no bytes)</option></optgroup>
                {#if userTypes.length > 0}<optgroup label="Types">{#each userTypes as ty (ty)}<option value={ty}>{sanitizeText(ty, 64)}</option>{/each}</optgroup>{/if}
                <option value="__switch__">switch…</option>
                {#if !isSwitch(f) && !known(typeValue(f))}<option value={typeValue(f)}>{sanitizeText(typeValue(f) || '(none)', 64)}</option>{/if}
              </select>
              {#if msgs(i, 'type')}<div class="fb">{sanitizeText(msgs(i, 'type')!, 300)}</div>{/if}
            </td>
            <td>
              {#if isValue(f)}
                <ExprInput value={f.value} label="Value of field {i + 1}" placeholder="expression" disabled={readOnly} suggestions={exprSuggestions(model, typeName, i)} issue={msgs(i, 'value')} onCommit={(v) => patch(i, { value: v as never })} />
              {:else}
                <ExprInput numeric value={f.size} label="Size of field {i + 1}" disabled={readOnly} suggestions={[...exprSuggestions(model, typeName, i), 'eos']} issue={msgs(i, 'size')} onCommit={(v) => patch(i, { size: v as never })} />
              {/if}
            </td>
            <td class="rep">
              <select disabled={readOnly} aria-label="Repeat of field {i + 1}" value={repKind(f)} onchange={(e) => changeRepeat(i, (e.currentTarget as HTMLSelectElement).value, String(repText(f) ?? ''))}>
                <option value="">once</option>
                <option value="count">count</option>
                <option value="until">until</option>
                <option value="eos">to end</option>
              </select>
              {#if repKind(f) === 'count' || repKind(f) === 'until'}
                <ExprInput
                  numeric={repKind(f) === 'count'}
                  value={repText(f)}
                  label="Repeat {repKind(f)} of field {i + 1}"
                  disabled={readOnly}
                  suggestions={exprSuggestions(model, typeName, i, { withValue: repKind(f) === 'until' })}
                  issue={msgs(i, 'repeat')}
                  onCommit={(v) => changeRepeat(i, repKind(f), v === undefined ? '' : String(v))}
                />
              {:else if msgs(i, 'repeat')}<div class="fb">{sanitizeText(msgs(i, 'repeat')!, 300)}</div>{/if}
            </td>
            <td><ExprInput numeric value={f.at} label="At of field {i + 1}" disabled={readOnly} suggestions={exprSuggestions(model, typeName, i)} issue={msgs(i, 'at')} onCommit={(v) => patch(i, { at: v as never })} /></td>
            <td><ExprInput value={f.if} label="If of field {i + 1}" disabled={readOnly} suggestions={exprSuggestions(model, typeName, i)} issue={msgs(i, 'if')} onCommit={(v) => patch(i, { if: v as never })} /></td>
            <td>
              <select disabled={readOnly} aria-label="Enum of field {i + 1}" class:bad={!!msgs(i, 'enum')} value={typeof f.enum === 'string' ? f.enum : ''} onchange={(e) => patch(i, { enum: (e.currentTarget as HTMLSelectElement).value || undefined })}>
                <option value="">none</option>
                {#each enums as en (en)}<option value={en}>{sanitizeText(en, 64)}</option>{/each}
                {#if typeof f.enum === 'string' && !enums.includes(f.enum)}<option value={f.enum}>{sanitizeText(f.enum, 64)}</option>{/if}
              </select>
              {#if msgs(i, 'enum')}<div class="fb">{sanitizeText(msgs(i, 'enum')!, 300)}</div>{/if}
            </td>
            <td>
              <input
                type="text"
                disabled={readOnly}
                aria-label="Expect of field {i + 1}"
                class:bad={!!msgs(i, 'expect')}
                value={f.expect === undefined ? '' : String(f.expect)}
                onchange={(e) => {
                  const s = (e.currentTarget as HTMLInputElement).value;
                  // Digits are a number for numeric types, text for `str`.
                  patch(i, { expect: s === '' ? undefined : f.type !== 'str' && /^-?\d{1,15}$/.test(s) ? Number(s) : s });
                }}
              />
              {#if msgs(i, 'expect')}<div class="fb">{sanitizeText(msgs(i, 'expect')!, 300)}</div>{/if}
            </td>
            <td><input type="text" disabled={readOnly} aria-label="Doc of field {i + 1}" value={typeof f.doc === 'string' ? f.doc : ''} onchange={(e) => patch(i, { doc: (e.currentTarget as HTMLInputElement).value || undefined })} /></td>
            <td class="acts">
              <button type="button" aria-label="Move field {i + 1} up" disabled={readOnly || i === 0} onclick={() => move(i, i - 1)}>↑</button>
              <button type="button" aria-label="Move field {i + 1} down" disabled={readOnly || i === fields.length - 1} onclick={() => move(i, i + 1)}>↓</button>
              <button type="button" aria-label="Duplicate field {i + 1}" disabled={readOnly} onclick={() => commit(duplicateField(model, typeName, i))}>⧉</button>
              <button type="button" aria-label="Delete field {i + 1}" disabled={readOnly} onclick={() => remove(i)}>✕</button>
              <button type="button" aria-label="{open.has(i) ? 'Collapse' : 'Expand'} field {i + 1}" aria-expanded={open.has(i)} onclick={() => toggle(i)}>{open.has(i) ? '▾' : '▸'}</button>
            </td>
          </tr>
          {#if open.has(i)}
            <tr class="detail" class:bad={rowBad(i)}>
              <td colspan="12">
                <div class="grid">
                  <label>
                    Encoding
                    <select disabled={readOnly} aria-label="Encoding of field {i + 1}" value={f.encoding ?? ''} onchange={(e) => patch(i, { encoding: ((e.currentTarget as HTMLSelectElement).value || undefined) as never })}>
                      <option value="">default</option>
                      {#each ENCODINGS as en (en)}<option value={en}>{en}</option>{/each}
                    </select>
                  </label>
                  {#if msgs(i, 'encoding')}<span class="fb">{sanitizeText(msgs(i, 'encoding')!, 300)}</span>{/if}
                  <label>
                    Terminator
                    <input type="text" disabled={readOnly} aria-label="Terminator of field {i + 1}" value={f.terminator === undefined ? '' : String(f.terminator)} onchange={(e) => {
                      const s = (e.currentTarget as HTMLInputElement).value.trim();
                      patch(i, { terminator: s === '' ? undefined : (num(s) as never) });
                    }} />
                  </label>
                  {#if msgs(i, 'terminator')}<span class="fb">{sanitizeText(msgs(i, 'terminator')!, 300)}</span>{/if}
                </div>

                {#if isSwitch(f)}
                  <fieldset>
                    <legend>Switch</legend>
                    <label>
                      On
                      <ExprInput value={switchOf(f).switch} label="Switch on of field {i + 1}" disabled={readOnly} suggestions={exprSuggestions(model, typeName, i)} issue={msgs(i, 'type')} onCommit={(v) => patch(i, { type: { ...switchOf(f), switch: v ?? '' } as never })} />
                    </label>
                    {#each Object.entries(switchOf(f).cases ?? {}) as [k, v], ci (ci)}
                      <div class="row">
                        <input type="text" disabled={readOnly} aria-label="Case {ci + 1} value of field {i + 1}" value={k} onchange={(e) => runCase(renameSwitchCase(model, typeName, i, k, (e.currentTarget as HTMLInputElement).value))} />
                        <select disabled={readOnly} aria-label="Case {ci + 1} type of field {i + 1}" value={v} onchange={(e) => commit(setSwitchCaseType(model, typeName, i, k, (e.currentTarget as HTMLSelectElement).value))}>
                          {#each [...PRIMITIVE_GROUPS.flatMap((g) => g.types), ...userTypes] as ty (ty)}<option value={ty}>{sanitizeText(ty, 64)}</option>{/each}
                          {#if !known(v)}<option value={v}>{sanitizeText(String(v), 64)}</option>{/if}
                        </select>
                        <button type="button" aria-label="Remove case {ci + 1} of field {i + 1}" disabled={readOnly} onclick={() => commit(removeSwitchCase(model, typeName, i, k))}>✕</button>
                      </div>
                    {/each}
                    <button type="button" disabled={readOnly} onclick={() => runCase(addSwitchCase(model, typeName, i))}>Add case</button>
                    {#if caseError}<span class="fb" role="alert">{sanitizeText(caseError, 300)}</span>{/if}
                    <label>
                      Default
                      <select disabled={readOnly} aria-label="Switch default of field {i + 1}" value={switchOf(f).default ?? ''} onchange={(e) => patch(i, { type: { ...switchOf(f), default: (e.currentTarget as HTMLSelectElement).value || undefined } as never })}>
                        <option value="">none</option>
                        {#each [...PRIMITIVE_GROUPS.flatMap((g) => g.types), ...userTypes] as ty (ty)}<option value={ty}>{sanitizeText(ty, 64)}</option>{/each}
                      </select>
                    </label>
                  </fieldset>
                {/if}

                <fieldset>
                  <legend>Bit fields</legend>
                  {#each bitsOf(f) as b, bi (bi)}
                    <div class="row">
                      <input type="text" disabled={readOnly} aria-label="Bit {bi + 1} name of field {i + 1}" value={b.name ?? ''} onchange={(e) => setBits(i, bitsOf(f).map((x, xi) => (xi === bi ? { ...x, name: (e.currentTarget as HTMLInputElement).value } : x)))} />
                      <input type="text" disabled={readOnly} aria-label="Bit {bi + 1} offset of field {i + 1}" value={b.offset ?? ''} onchange={(e) => setBits(i, bitsOf(f).map((x, xi) => (xi === bi ? { ...x, offset: num((e.currentTarget as HTMLInputElement).value) } : x)))} />
                      <input type="text" disabled={readOnly} aria-label="Bit {bi + 1} width of field {i + 1}" value={b.width ?? ''} onchange={(e) => setBits(i, bitsOf(f).map((x, xi) => (xi === bi ? { ...x, width: num((e.currentTarget as HTMLInputElement).value) } : x)))} />
                      <button type="button" aria-label="Remove bit {bi + 1} of field {i + 1}" disabled={readOnly} onclick={() => setBits(i, bitsOf(f).filter((_, xi) => xi !== bi))}>✕</button>
                    </div>
                  {/each}
                  <button type="button" disabled={readOnly} onclick={() => setBits(i, [...bitsOf(f), { name: `bit${bitsOf(f).length}`, offset: bitsOf(f).length, width: 1 }])}>Add bit field</button>
                  {#if msgs(i, 'bits')}<span class="fb">{sanitizeText(msgs(i, 'bits')!, 300)}</span>{/if}
                </fieldset>

                <fieldset>
                  <legend>Asserts</legend>
                  {#each assertsOf(f) as a, ai (ai)}
                    <div class="row">
                      <ExprInput value={a.expr} label="Assert {ai + 1} expression of field {i + 1}" disabled={readOnly} suggestions={exprSuggestions(model, typeName, i, { withValue: true })} onCommit={(v) => setAsserts(i, assertsOf(f).map((x, xi) => (xi === ai ? { ...x, expr: String(v ?? '') } : x)))} />
                      <select disabled={readOnly} aria-label="Assert {ai + 1} level of field {i + 1}" value={a.level ?? 'error'} onchange={(e) => setAsserts(i, assertsOf(f).map((x, xi) => (xi === ai ? { ...x, level: (e.currentTarget as HTMLSelectElement).value } : x)))}>
                        <option value="error">error</option>
                        <option value="warning">warning</option>
                      </select>
                      <input type="text" disabled={readOnly} aria-label="Assert {ai + 1} message of field {i + 1}" placeholder="message" value={a.message ?? ''} onchange={(e) => setAsserts(i, assertsOf(f).map((x, xi) => (xi === ai ? { ...x, message: (e.currentTarget as HTMLInputElement).value || undefined } : x)))} />
                      <button type="button" aria-label="Remove assert {ai + 1} of field {i + 1}" disabled={readOnly} onclick={() => setAsserts(i, assertsOf(f).filter((_, xi) => xi !== ai))}>✕</button>
                    </div>
                  {/each}
                  <button type="button" disabled={readOnly} onclick={() => setAsserts(i, [...assertsOf(f), { expr: '_ != 0' }])}>Add assert</button>
                  {#if msgs(i, 'assert')}<span class="fb">{sanitizeText(msgs(i, 'assert')!, 300)}</span>{/if}
                </fieldset>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
    {#if fields.length === 0}<p class="muted">This type has no fields yet. Use a building block or "Add field".</p>{/if}
    <button type="button" disabled={readOnly} onclick={addEmpty}>Add field</button>
  {/if}
</div>

<style>
  .fields {
    overflow: auto;
    padding: 4px 8px;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 12px;
  }
  th {
    text-align: left;
    color: var(--muted);
    font-weight: 600;
    white-space: nowrap;
  }
  td {
    padding: 2px 3px;
    vertical-align: top;
  }
  tr.sel > td {
    background: var(--panel);
  }
  tr.bad > td:nth-child(3) {
    border-left: 3px solid var(--error);
  }
  tr.over > td {
    border-top: 2px solid var(--accent);
  }
  .handle {
    cursor: grab;
    color: var(--muted);
  }
  .idx {
    color: var(--muted);
  }
  input[type='text'],
  select {
    font: inherit;
    width: 100%;
    min-width: 6ch;
  }
  .bad {
    border-color: var(--error);
  }
  .fb {
    color: var(--error);
    font-size: 11px;
  }
  .acts {
    white-space: nowrap;
  }
  .acts button {
    padding: 0 5px;
  }
  .muted {
    color: var(--muted);
  }
  .grid,
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin: 2px 0;
  }
  .row input,
  .row select {
    width: auto;
  }
  fieldset {
    margin: 4px 0;
    border: 1px solid var(--border);
  }
  .detail > td {
    background: var(--panel);
  }
</style>
