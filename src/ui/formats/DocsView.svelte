<script lang="ts">
  import { buildDocModel, type DocField, type DocModel, type DocPosition } from '../../core/engine';
  import type { FormatSpec } from '../../core/engine';
  import { sanitizeText } from '../../core/tree-model';

  // All spec-derived text is untrusted. It only ever reaches the page through Svelte text bindings (never as HTML),
  // and goes through sanitizeText first so control and bidi characters are shown visibly.
  let { spec, reason = 'Fix the validation errors to see the documentation.' }: { spec: FormatSpec | null; reason?: string } = $props();

  const model: DocModel | null = $derived(spec ? buildDocModel(spec) : null);
  const typeNames = $derived(new Set(model?.types.map((t) => t.name) ?? []));
  let root: HTMLElement | undefined = $state();

  const t = (s: string, max = 400) => sanitizeText(s, max);

  function jump(name: string) {
    const target = [...(root?.querySelectorAll<HTMLElement>('section[data-type]') ?? [])].find((el) => el.dataset.type === name);
    if (!target) return;
    target.scrollIntoView?.({ block: 'start' });
    target.focus();
  }

  function position(p: DocPosition): string {
    if (p.kind === 'find') return `found by searching ${p.direction} from ${p.from} (window ${p.window} bytes) for ${p.bytes}`;
    return p.kind === 'at' ? `at ${p.expr}` : p.kind === 'variable' ? 'variable' : `0x${p.offset.toString(16).toUpperCase().padStart(2, '0')} (${p.offset})`;
  }

  function size(s: DocField['size']): string {
    const b = s.base;
    const base = b.kind === 'eos' ? 'to end of stream' : b.kind === 'expr' ? b.expr : b.kind === 'static' ? `${b.bytes}` : b.kind === 'terminator' ? `until terminator ${b.terminator}` : 'variable';
    if (!s.repeat) return base;
    if (s.repeat.kind === 'eos') return `${base} × until end of stream`;
    return `${base} × ${s.repeat.kind === 'count' ? s.repeat.expr : `until ${s.repeat.expr}`}`;
  }
</script>

{#snippet typeLink(name: string)}
  {#if typeNames.has(name)}
    <button type="button" class="type-link" onclick={() => jump(name)} title="Jump to {t(name, 80)}">{t(name, 80)}</button>
  {:else}
    <code>{t(name, 80)}</code>
  {/if}
{/snippet}

<div class="docs" bind:this={root}>
  {#if !model}
    <p class="empty">{reason}</p>
  {:else}
    <h2>{t(model.title, 200)}</h2>
    <p class="meta">
      Spec id <code>{t(model.id, 80)}</code> (schema version {model.schemaVersion}). Default byte order: {model.defaultEndian}.
    </p>
    {#if model.doc}<p class="prose">{t(model.doc, 20000)}</p>{/if}
    <p class="note">{model.precedenceNote}</p>

    <h3>Magic and detection</h3>
    <ul>
      {#if model.detect.length === 0}<li>Magic bytes: none</li>{/if}
      {#each model.detect as r, i (i)}
        <li>Magic bytes: <code>{t(r.bytes, 200)}</code> at {r.where}{#if r.mask}, mask <code>{t(r.mask, 200)}</code>{/if}</li>
      {/each}
      <li>
        Extensions:
        {#if model.extensions.length === 0}none{:else}{#each model.extensions as e, i (i)}{#if i > 0}, {/if}<code>{t(e, 40)}</code>{/each}{/if}
      </li>
    </ul>

    <h3>Structures</h3>
    <p>Root type: {@render typeLink(model.rootType)}. Offsets are relative to the start of the containing structure.</p>
    {#each model.types as ty (ty.name)}
      <section data-type={ty.name} tabindex="-1">
        <h4>{t(ty.name, 80)}</h4>
        {#if ty.doc}<p class="prose">{t(ty.doc, 20000)}</p>{/if}
        <table>
          <thead>
            <tr><th>Field</th><th>Type</th><th>Endian</th><th>Offset/Position</th><th>Size</th><th>Description</th></tr>
          </thead>
          <tbody>
            {#each ty.fields as f, i (i)}
              <tr>
                <td><code>{t(f.name, 80)}</code></td>
                <td>
                  {#if f.type.kind === 'simple'}
                    {@render typeLink(f.type.name)}
                  {:else}
                    switch on <code>{t(f.type.on)}</code>:
                    {#each f.type.cases as c, ci (ci)}{#if ci > 0}, {/if}<code>{t(c.key, 80)}</code> → {@render typeLink(c.type)}{/each}
                    {#if f.type.default !== undefined}, default → {@render typeLink(f.type.default)}{/if}
                  {/if}
                </td>
                <td>{f.endian}</td>
                <td>{t(position(f.position))}</td>
                <td>{t(size(f.size))}</td>
                <td>
                  {#if f.doc}<div>{t(f.doc, 2000)}</div>{/if}
                  {#if f.value !== undefined}<div>Computed value (no bytes): <code>{t(f.value)}</code>.</div>{/if}
                  {#if f.ifExpr !== undefined}<div>Present only if <code>{t(f.ifExpr)}</code>.</div>{/if}
                  {#if f.ifMagic}
                    <div>
                      Present only if the bytes <code>{t(f.ifMagic.bytes, 200)}</code>{#if f.ifMagic.mask} (mask <code>{t(f.ifMagic.mask, 200)}</code>){/if} are at <code>{t(f.ifMagic.at)}</code>.
                    </div>
                  {/if}
                  {#if f.findMask !== undefined}<div>Search mask: <code>{t(f.findMask, 200)}</code>.</div>{/if}
                  {#if f.findAccept}
                    <div>
                      Search candidates are tried nearest first and accepted by the first condition that holds:
                      {#each f.findAccept as a, ai (ai)}{#if ai > 0}; {/if}{ai + 1}. <code>{t(a)}</code>{/each}.
                    </div>
                  {/if}
                  {#if f.ref}
                    <div>Reference: can be opened as <code>{t(f.ref.type, 80)}</code> at <code>{t(f.ref.at)}</code>{#if f.ref.doc} — {t(f.ref.doc, 400)}{/if}.</div>
                  {/if}
                  {#if f.enum}
                    <div>
                      Enum <code>{t(f.enum.name, 80)}</code>{#if f.enum.preview} ({f.enum.preview.map((p) => t(p, 80)).join(', ')}{f.enum.more ? ', …' : ''}){/if}.
                    </div>
                  {/if}
                  {#each f.asserts as a, ai (ai)}
                    <div class="assert">Check ({a.level}): <code>{t(a.expr)}</code>{#if a.message} — {t(a.message, 400)}{/if}.</div>
                  {/each}
                  {#if f.expect !== undefined}<div>Expected value: <code>{t(f.expect, 80)}</code>{f.fatal ? ' (a mismatch stops parsing)' : ''}.</div>{/if}
                  {#if f.bits.length > 0}
                    <div>
                      Bits (bit 0 = least significant):
                      {#each f.bits as b, bi (bi)}{#if bi > 0}; {/if}<code>{t(b.name, 80)}</code> [{b.range}]{#if b.doc} {t(b.doc, 400)}{/if}{/each}.
                    </div>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/each}

    {#if model.enums.length > 0}
      <h3>Enums</h3>
      {#each model.enums as e (e.name)}
        <section data-enum={e.name}>
          <h4>{t(e.name, 80)}</h4>
          <table>
            <thead><tr><th>Value</th><th>Name</th></tr></thead>
            <tbody>
              {#each e.entries.slice(0, 500) as en, i (i)}
                <tr><td><code>{t(en.key, 80)}</code></td><td>{t(en.label, 400)}</td></tr>
              {/each}
              {#if e.entries.length > 500}<tr><td colspan="2" class="muted">… and {e.entries.length - 500} more</td></tr>{/if}
            </tbody>
          </table>
        </section>
      {/each}
    {/if}
  {/if}
</div>

<style>
  .docs {
    height: 100%;
    overflow: auto;
    padding: 8px 16px 24px;
    user-select: text;
  }
  h2,
  h3,
  h4 {
    margin: 12px 0 6px;
  }
  .meta,
  .note,
  .muted,
  .empty {
    color: var(--muted);
  }
  .note {
    font-size: 12px;
    border-left: 3px solid var(--border);
    padding-left: 8px;
  }
  .prose {
    white-space: pre-wrap;
  }
  section:focus {
    outline: 1px dashed var(--accent);
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin-bottom: 12px;
    font-size: 12px;
  }
  th,
  td {
    border: 1px solid var(--border);
    padding: 3px 6px;
    text-align: left;
    vertical-align: top;
  }
  th {
    background: var(--panel);
  }
  code {
    font-family: var(--mono);
  }
  .type-link {
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    font-family: var(--mono);
    font-size: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
