<script lang="ts">
  import type { ByteSource } from '../core/byte-source';
  import { formatOffset, offsetWidth } from '../core/hex-format';
  import { decodeInspector, INSPECTOR_WINDOW, type InspectorRow } from '../core/inspector';

  let {
    source,
    offset,
    version = 0,
    littleEndian = $bindable(true),
    onCollapse,
  }: {
    source: ByteSource | null;
    offset: number | null;
    /** Bump when the source's bytes changed in place (an EditBuffer edit) to re-read them. */
    version?: number;
    littleEndian?: boolean;
    /** Hide the panel (it can be shown again from the rail). */
    onCollapse?: () => void;
  } = $props();

  // Bytes tagged with the source/offset they were read for, so stale data can be dimmed.
  let data = $state.raw<{ src: ByteSource; off: number; bytes: Uint8Array } | null>(null);
  let error = $state<string | null>(null);
  let reqId = 0;

  // Fetch a fixed window at the offset; only the latest request may update the panel.
  $effect(() => {
    const src = source;
    const off = offset;
    void version;
    const id = ++reqId;
    if (!src || off === null) {
      data = null;
      error = null;
      return;
    }
    src
      .read(off, INSPECTOR_WINDOW)
      .then((b) => {
        if (id !== reqId) return;
        data = { src, off, bytes: b };
        error = null;
      })
      .catch((e: unknown) => {
        if (id !== reqId) return;
        data = null;
        error = `Read failed: ${e instanceof Error ? e.message : String(e)}`;
      });
  });

  const stale = $derived(data !== null && (data.src !== source || data.off !== offset));
  const bytes = $derived(data?.bytes ?? null);
  const at = $derived(
    source && offset !== null ? '@ 0x' + formatOffset(offset, offsetWidth(source.size)) : null,
  );
  const rows = $derived(bytes ? decodeInspector(bytes, littleEndian) : []);
  const groups = $derived(
    rows.reduce<Array<{ name: string; rows: InspectorRow[] }>>((acc, r) => {
      const last = acc[acc.length - 1];
      if (last && last.name === r.group) last.rows.push(r);
      else acc.push({ name: r.group, rows: [r] });
      return acc;
    }, []),
  );
</script>

<aside class="inspector" aria-label="Data inspector">
  <header>
    <h2>Data inspector{#if at} <span class="at">{at}</span>{/if}</h2>
    <div class="tools">
      <button
        type="button"
        class="endian"
        onclick={() => (littleEndian = !littleEndian)}
        title="Toggle byte order"
        aria-label="Byte order: {littleEndian ? 'little-endian' : 'big-endian'}"
      >{littleEndian ? 'LE' : 'BE'}</button>
      {#if onCollapse}
        <button type="button" class="collapse" onclick={onCollapse} title="Hide data inspector" aria-label="Hide data inspector">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
      {/if}
    </div>
  </header>
  {#if error}
    <p class="msg error" role="alert">{error}</p>
  {:else if !bytes}
    <p class="msg">Select a byte to inspect.</p>
  {:else}
    <div class="body" class:stale aria-busy={stale}>
      {#each groups as g (g.name)}
        <table>
          <caption>{g.name}</caption>
          <tbody>
            {#each g.rows as r (r.id)}
              <tr data-id={r.id} title={r.hint}>
                <th scope="row">{r.label}</th>
                <td class:na={r.value === 'n/a'}>{r.value}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/each}
    </div>
  {/if}
</aside>

<style>
.inspector {
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--chrome);
  }
  header {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: 34px;
    padding: 0 6px 0 12px;
    box-sizing: border-box;
    border-bottom: 1px solid var(--rule);
  }
  h2 {
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }
  .endian {
    min-width: max(4ch, 24px);
    min-height: 24px;
    font-family: var(--mono);
    font-size: var(--fs-xs);
    padding: 1px 6px;
  }
  .collapse {
    border-color: transparent;
    min-width: 24px;
    min-height: 24px;
    padding: 4px 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ink-quiet);
  }
  .at {
    font-family: var(--mono);
    font-weight: 400;
    font-size: var(--fs-sm);
    color: var(--ink-quiet);
    margin-left: 6px;
  }
  .body.stale {
    opacity: 0.4;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 4px 0 8px;
  }
  .msg {
    margin: 12px;
    color: var(--ink-quiet);
  }
  .msg.error {
    color: var(--error);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fs-sm);
  }
  caption {
    text-align: left;
    padding: 10px 12px 2px;
    color: var(--ink-quiet);
    font-size: var(--fs-sm);
    font-weight: 600;
  }
  th {
    text-align: left;
    font-weight: 400;
    color: var(--ink-quiet);
    padding: 1px 8px 1px 12px;
    white-space: nowrap;
    vertical-align: top;
    width: 1%;
  }
  td {
    font-family: var(--mono);
    font-size: var(--fs-sm);
    padding: 1px 12px 1px 0;
    word-break: break-all;
  }
  td.na {
    color: var(--ink-faint);
  }
</style>
