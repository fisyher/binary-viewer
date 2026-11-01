<script lang="ts">
  import { sanitizeText } from '../core/tree-model';
  import { describeDetection, describeStatus, detectionBasis, type ParseStatus } from '../core/format-status';
  import type { DetectionInfo, SpecInfo } from '../worker/protocol';

  let {
    specs,
    detections,
    selected,
    status,
    errorText = null,
    onSelect,
    onCancel,
  }: {
    specs: SpecInfo[];
    detections: DetectionInfo[];
    /** Chosen spec id, or null for "None (raw)". */
    selected: string | null;
    status: ParseStatus;
    /** Engine/spec failure to show prominently (e.g. a built-in spec failed validation). */
    errorText?: string | null;
    onSelect: (specId: string | null) => void;
    onCancel: () => void;
  } = $props();

  const custom = $derived(new Set(specs.filter((s) => s.custom).map((s) => s.id)));
  const tag = (id: string) => (custom.has(id) ? ' (custom)' : '');
  const others = $derived(specs.filter((s) => !detections.some((d) => d.specId === s.id)));
  const top = $derived(detections[0]);
  const suggestion = $derived(top && selected === top.specId && !top.magicMatched);

  function change(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    onSelect(v === '' ? null : v);
  }
</script>

<div class="formatbar">
  <label>
    Format
    <select value={selected ?? ''} onchange={change} aria-label="Format">
      <option value="">None (raw)</option>
      {#each detections as d (d.specId)}
        <option value={d.specId}>{sanitizeText(describeDetection(d), 120)}{tag(d.specId)}</option>
      {/each}
      {#each others as s (s.id)}
        <option value={s.id}>{sanitizeText(s.name, 120)}{tag(s.id)}</option>
      {/each}
    </select>
  </label>
  {#if suggestion && top}<span class="hint">Suggested from {detectionBasis(top)} only</span>{/if}
  {#if status.state === 'parsing'}
    <span class="status" role="status">{sanitizeText(describeStatus(status), 400)}</span>
    <button type="button" onclick={onCancel}>Cancel</button>
  {:else if status.state !== 'idle'}
    <span class="status" class:warn={status.state === 'truncated' || status.state === 'aborted'} class:err={status.state === 'error'} role="status"
      >{sanitizeText(describeStatus(status), 400)}</span
    >
  {/if}
  {#if errorText}<span class="err" role="alert">{sanitizeText(errorText, 400)}</span>{/if}
</div>

<style>
.formatbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 12px;
    font-size: var(--fs-sm);
    min-height: 26px;
    min-width: 0;
  }
  label {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--ink-quiet);
  }
  select {
    font: inherit;
    color: var(--ink);
    background: var(--ground);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    padding: 2px 6px;
    max-width: 36ch;
  }
  .hint,
  .status {
    color: var(--ink-quiet);
  }
  .warn {
    color: var(--warn);
  }
  .err {
    color: var(--error);
  }
  button {
    padding: 0 8px;
    font-size: var(--fs-sm);
  }
</style>
