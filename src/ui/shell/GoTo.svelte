<script lang="ts">
  import type { OffsetMode } from '../../core/parse-offset';

  let {
    disabled = false,
    error = null,
    onGoTo,
  }: {
    disabled?: boolean;
    error?: string | null;
    onGoTo: (text: string, mode: OffsetMode) => void;
  } = $props();

  let text = $state('');
  let mode = $state<OffsetMode>('hex');

  function submit(e: SubmitEvent) {
    e.preventDefault();
    onGoTo(text, mode);
  }
</script>

<form class="goto" onsubmit={submit}>
  <button
    type="button"
    class="base"
    onclick={() => (mode = mode === 'hex' ? 'dec' : 'hex')}
    {disabled}
    title="Toggle offset base"
    aria-label="Offset base: {mode === 'hex' ? 'hexadecimal' : 'decimal'}"
  >{mode === 'hex' ? 'Hex' : 'Dec'}</button>
  <input
    type="text"
    bind:value={text}
    placeholder={mode === 'hex' ? 'Go to offset (hex)' : 'Go to offset (decimal)'}
    aria-label="Go to offset"
    aria-invalid={error ? 'true' : 'false'}
    {disabled}
    spellcheck="false"
    autocomplete="off"
  />
  <button type="submit" {disabled}>Go</button>
  {#if error}<span class="error" role="alert">{error}</span>{/if}
</form>

<style>
  .goto {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .base {
    min-width: 4ch;
    font-family: var(--mono);
    font-size: var(--fs-sm);
  }
  input {
    width: 20ch;
    font-family: var(--mono);
    font-size: var(--fs-sm);
  }
  input[aria-invalid='true'] {
    border-color: var(--error);
  }
  .error {
    color: var(--error);
    font-size: var(--fs-sm);
  }
  @container page (max-width: 720px) {
    input {
      width: 14ch;
    }
  }
</style>
