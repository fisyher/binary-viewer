<script lang="ts">
  import { BlobByteSource, probeReadable, type ByteSource } from './core/byte-source';
  import { selectionRange, type Selection } from './core/caret';
  import { parseOffset, type OffsetMode } from './core/parse-offset';
  import HexView from './ui/HexView.svelte';
  import Inspector from './ui/Inspector.svelte';
  import { loadLittleEndian, saveLittleEndian } from './ui/prefs';
  import StatusBar from './ui/StatusBar.svelte';
  import Toolbar from './ui/Toolbar.svelte';

  let source = $state<ByteSource | null>(null);
  let fileName = $state<string | null>(null);
  let selection = $state<Selection | null>(null);
  let gotoError = $state<string | null>(null);
  let littleEndian = $state(loadLittleEndian());
  const inspectOffset = $derived(selection ? selectionRange(selection).start : null);
  let readError = $state<string | null>(null);
  let loadError = $state<string | null>(null);
  let dragDepth = $state(0);
  let hexView: ReturnType<typeof HexView> | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();

  $effect(() => saveLittleEndian(littleEndian));

  let loadToken = 0;

  async function load(file: File) {
    const token = ++loadToken; // a later load supersedes this one
    // Folders and unreadable entries show up as odd empty/4096-byte "files"; refuse them.
    try {
      await probeReadable(file);
    } catch {
      if (token !== loadToken) return;
      loadError = `Cannot open "${file.name}" (folder or unreadable file)`;
      return;
    }
    if (token !== loadToken) return;
    loadError = null;
    source = new BlobByteSource(file);
    fileName = file.name;
    selection = null;
    gotoError = null;
    readError = null;
  }

  type PickerWindow = Window & {
    showOpenFilePicker?: (opts?: object) => Promise<Array<{ getFile(): Promise<File> }>>;
  };

  async function openFile() {
    const w = window as PickerWindow;
    if (w.showOpenFilePicker) {
      try {
        const [handle] = await w.showOpenFilePicker({ multiple: false });
        if (handle) await load(await handle.getFile());
      } catch (e) {
        if (!(e instanceof DOMException && e.name === 'AbortError')) console.error(e);
      }
    } else {
      fileInput?.click();
    }
  }

  function onInputChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void load(file);
    input.value = ''; // allow re-opening the same file
  }

  function goTo(text: string, mode: OffsetMode) {
    if (!source) return;
    const r = parseOffset(text, source.size, mode);
    if (!r.ok) {
      gotoError = r.error;
      return;
    }
    gotoError = null;
    hexView?.goTo(r.offset);
  }

  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;

  // enter/leave fire for every child element, so count them to avoid overlay flicker.
  function onDragEnter(e: DragEvent) {
    if (hasFiles(e)) dragDepth++;
  }

  function onDragLeave(e: DragEvent) {
    if (hasFiles(e)) dragDepth = Math.max(0, dragDepth - 1);
  }

  function onDragOver(e: DragEvent) {
    if (hasFiles(e)) e.preventDefault();
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragDepth = 0;
    const item = e.dataTransfer?.items[0];
    const entry = item?.webkitGetAsEntry?.();
    const file = e.dataTransfer?.files[0];
    if (entry?.isDirectory) {
      loadError = `Cannot open "${entry.name}": folders are not supported`;
    } else if (file) {
      void load(file);
    }
  }
</script>

<svelte:window ondragenter={onDragEnter} ondragleave={onDragLeave} ondragover={onDragOver} ondrop={onDrop} />

<input type="file" hidden bind:this={fileInput} onchange={onInputChange} />

<div class="app" class:drag-over={dragDepth > 0}>
  <Toolbar
    {fileName}
    size={source?.size ?? 0}
    hasFile={source !== null && source.size > 0}
    onOpen={openFile}
    onGoTo={goTo}
    {gotoError}
    {loadError}
  />
  <div class="main">
    {#if source && source.size === 0}
      <div class="empty"><p>Empty file (0 bytes)</p></div>
    {:else if source}
      <HexView bind:this={hexView} {source} bind:selection bind:error={readError} />
    {:else}
      <div class="empty">
        <p>No file open</p>
        <p class="hint">Click <strong>Open…</strong> or drop a file anywhere on this window.</p>
      </div>
    {/if}
    <Inspector source={source && source.size > 0 ? source : null} offset={inspectOffset} bind:littleEndian />
  </div>
  <StatusBar {selection} error={readError} onRetry={() => hexView?.retry()} />
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .app.drag-over {
    outline: 2px dashed var(--accent);
    outline-offset: -4px;
  }
  .main {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--muted);
  }
  .empty p {
    margin: 4px;
  }
  .empty :first-child {
    font-size: 1.4rem;
  }
  .hint {
    font-size: 0.9rem;
  }
</style>
