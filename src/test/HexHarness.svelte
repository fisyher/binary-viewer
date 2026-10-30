<script lang="ts">
  // Test-only wrapper wiring HexView + StatusBar the way App does.
  import type { ByteSource } from '../core/byte-source';
  import type { Selection } from '../core/caret';
  import HexView from '../ui/HexView.svelte';
  import StatusBar from '../ui/StatusBar.svelte';

  let { source }: { source: ByteSource } = $props();
  let selection = $state<Selection | null>(null);
  let error = $state<string | null>(null);
  let view: ReturnType<typeof HexView> | undefined = $state();

  export function goTo(offset: number) {
    view?.goTo(offset);
  }
</script>

<HexView bind:this={view} {source} bind:selection bind:error />
<StatusBar {selection} {error} onRetry={() => view?.retry()} />
