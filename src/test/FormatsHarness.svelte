<script lang="ts">
  // Test harness: the format library list and the spec detail side by side with one shared FormatsState,
  // the way App wires them (list in the side bar, detail in the spec tab).
  import { untrack } from 'svelte';
  import type { LazyArray, Node } from '../core/engine';
  import type { SpecLibrary } from '../core/spec-library';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import FormatDetail from '../ui/formats/FormatDetail.svelte';
  import FormatList from '../ui/formats/FormatList.svelte';
  import { FormatsState } from '../ui/formats/formats-state.svelte';
  import type { ParseSnapshot } from '../worker/protocol';

  let {
    library,
    onDirtyChange = () => {},
    previewDoc = null,
    previewActive = true,
    previewBusy = false,
    previewEpoch = 0,
    parseDraft = async () => null,
    loadPreviewPage = async () => ({ nodes: [], lazy: null }),
    loadPreviewRef = undefined,
    onShowInViewer = () => {},
  }: {
    library: SpecLibrary;
    onDirtyChange?: (dirty: boolean) => void;
    previewDoc?: string | null;
    previewActive?: boolean;
    previewBusy?: boolean;
    previewEpoch?: number;
    parseDraft?: (text: string) => Promise<ParseSnapshot | null>;
    loadPreviewPage?: (nodeId: number, start: number, count: number) => Promise<{ nodes: Node[]; lazy: LazyArray | null }>;
    loadPreviewRef?: (nodeId: number) => Promise<Node[]>;
    onShowInViewer?: (range: { start: number; end: number } | null, offset: number) => void;
  } = $props();

  const ctl = new FormatsState(untrack(() => library));
  $effect(() => ctl.connect());
  $effect(() => onDirtyChange(ctl.editorDirty));
</script>

<div class="formats">
  <FormatList {ctl} />
  <FormatDetail {ctl} {previewDoc} {previewActive} {previewBusy} {previewEpoch} {parseDraft} {loadPreviewPage} {loadPreviewRef} {onShowInViewer} />
</div>

{#if ctl.confirm}
  {@const pending = ctl.confirm}
  <ConfirmDialog
    message={pending.message}
    confirmLabel={pending.label}
    onCancel={() => (ctl.confirm = null)}
    onConfirm={() => {
      const run = pending.run;
      ctl.confirm = null;
      run();
    }}
  />
{/if}
