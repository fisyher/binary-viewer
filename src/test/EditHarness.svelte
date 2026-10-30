<script lang="ts">
  // Test-only wrapper wiring an editable HexView + StatusBar the way App does.
  import type { Selection } from '../core/caret';
  import type { EditBuffer } from '../core/edit-buffer';
  import HexView from '../ui/HexView.svelte';
  import StatusBar from '../ui/StatusBar.svelte';

  let { editor, locked = false }: { editor: EditBuffer; locked?: boolean } = $props();
  let selection = $state<Selection | null>(null);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let insertMode = $state(false);
  let version = $state(0);
  $effect(() => {
    version = editor.version;
    return editor.onChange(() => (version = editor.version));
  });
</script>

<HexView
  source={editor}
  {editor}
  editVersion={version}
  {locked}
  bind:selection
  bind:error
  bind:insertMode
  onNotice={(m) => (notice = m)}
/>
<StatusBar {selection} {error} {notice} {insertMode} />
