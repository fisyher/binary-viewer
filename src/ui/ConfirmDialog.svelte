<script lang="ts">
  let {
    message,
    confirmLabel = 'Discard changes',
    onConfirm,
    onCancel,
  }: { message: string; confirmLabel?: string; onConfirm: () => void; onCancel: () => void } = $props();

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') onCancel();
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="backdrop">
  <div class="dialog" role="alertdialog" aria-modal="true" aria-label="Confirm" aria-describedby="confirm-msg">
    <p id="confirm-msg">{message}</p>
    <div class="buttons">
      <button type="button" onclick={onCancel}>Cancel</button>
      <button type="button" class="danger" onclick={onConfirm}>{confirmLabel}</button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10;
  }
  .dialog {
    background: var(--chrome);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    padding: 16px 20px;
    max-width: 420px;
    box-shadow: 0 8px 28px var(--dialog-shadow);
  }
  p {
    margin: 0 0 16px;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .danger {
    border-color: var(--error);
  }
</style>
