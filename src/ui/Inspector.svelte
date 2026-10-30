<script lang="ts">
  import type { ByteSource } from '../core/byte-source';
  import { formatOffset, offsetWidth } from '../core/hex-format';
  import { decodeInspector, INSPECTOR_WINDOW, type InspectorRow } from '../core/inspector';

  let {
    source,
    offset,
    littleEndian = $bindable(true),
  }: { source: ByteSource | null; offset: number | null; littleEndian?: boolean } = $props();

  // Bytes tagged with the source/offset they were read for, so stale data can be dimmed.
  let data = $state.raw<{ src: ByteSource; off: number; bytes: Uint8Array } | null>(null);
  let error = $state<string | null>(null);
  let reqId = 0;

  // Fetch a fixed window at the offset; only the latest request may update the panel.
  $effect(() => {
    const src = source;
    const off = offset;
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
    <h2>Data Inspector{#if at} <span class="at">{at}</span>{/if}</h2>
    <button
      type="button"
      class="endian"
      onclick={() => (littleEndian = !littleEndian)}
      title="Toggle byte order"
      aria-label="Byte order: {littleEndian ? 'little-endian' : 'big-endian'}"
    >{littleEndian ? 'LE' : 'BE'}</button>
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
    width: 360px;
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--panel);
    border-left: 1px solid var(--border);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
  }
  h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }
  .endian {
    min-width: 4ch;
    font-family: var(--mono);
    padding: 2px 8px;
  }
  .at {
    font-family: var(--mono);
    font-weight: normal;
    color: var(--muted);
  }
  .body.stale {
    opacity: 0.4;
  }
  .body {
    overflow: auto;
    padding: 4px 0 8px;
  }
  .msg {
    margin: 12px;
    color: var(--muted);
  }
  .msg.error {
    color: var(--error);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  caption {
    text-align: left;
    padding: 8px 12px 2px;
    color: var(--muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  th {
    text-align: left;
    font-weight: normal;
    color: var(--muted);
    padding: 1px 8px 1px 12px;
    white-space: nowrap;
    vertical-align: top;
    width: 1%;
  }
  td {
    font-family: var(--mono);
    padding: 1px 12px 1px 0;
    word-break: break-all;
  }
  td.na {
    color: var(--muted);
    opacity: 0.6;
  }
</style>
