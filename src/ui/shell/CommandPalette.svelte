<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { fuzzyMatch, rankMatches, splitByRanges, type Match } from '../../core/command-match';
  import type { OffsetMode } from '../../core/parse-offset';
  import { GROUP_ORDER, type Command, type SubMode } from '../commands';
  import { globalKey, isImeKey } from './keys';

  let {
    commands,
    recent,
    onUse,
    onClose,
  }: {
    commands: Command[];
    /** Ids of the most recently used commands, newest first (listed first while the query is empty). */
    recent: readonly string[];
    /** A command was chosen (to remember it). */
    onUse: (id: string) => void;
    /** Close the palette; `then` runs once the background is live again and focus is back where it was. */
    onClose: (then?: () => void) => void;
  } = $props();

  const uid = $props.id();
  const listId = `${uid}-list`;
  const errorId = `${uid}-error`;
  const optId = (i: number) => `${uid}-opt-${i}`;
  const PAGE = 8;
  /** A search or pick list shows at most this many rows (hundreds of library specs must not become hundreds of DOM rows). */
  const MAX_ROWS = 50;

  /** One selectable row of the list: a command or an item of a pick list. */
  interface Row {
    key: string;
    label: string;
    ranges: ReadonlyArray<readonly [number, number]>;
    /** Right-hand dimmed text: why the row is disabled, a hint, or the group while searching. */
    note: string | null;
    shortcut: string | null;
    /** Why the row cannot be chosen; null when it can. */
    disabled: string | null;
    choose: () => void;
  }
  interface Built {
    sections: Section[];
    /** Matches that are not listed because of MAX_ROWS. */
    more: number;
  }
  interface Section {
    name: string | null;
    rows: Row[];
  }

  let query = $state('');
  let mode = $state.raw<SubMode | null>(null);
  /** The command that opened `mode`; it is remembered once the sub-mode finishes. */
  let modeCommand: Command | null = null;
  let base = $state<OffsetMode>('hex');
  let error = $state<string | null>(null);
  let active = $state(0);
  let input: HTMLInputElement | undefined = $state();
  let listEl: HTMLElement | undefined = $state();

  const q = $derived(query.trim());

  function commandRow(c: Command, m: Match | null, withGroup: boolean): Row {
    const disabled = c.disabledReason?.() ?? null;
    return {
      key: c.id,
      label: c.label,
      ranges: m?.ranges ?? [],
      note: disabled ?? c.hint ?? (withGroup ? c.group : null),
      shortcut: c.shortcut ?? null,
      disabled,
      choose: () => chooseCommand(c),
    };
  }

  /** Label matches first; a command found only through its keywords comes after all of those. */
  function searchCommands(text: string): Row[] {
    type Hit = { c: Command; m: Match | null; score: number; i: number };
    const hits = commands.flatMap((c, i): Hit[] => {
      const m = fuzzyMatch(text, c.label);
      if (m) return [{ c, m, score: m.score, i }];
      const k = c.keywords ? fuzzyMatch(text, c.keywords) : null;
      return k ? [{ c, m: null, score: k.score - 1000, i }] : [];
    });
    hits.sort((a, b) => b.score - a.score || a.i - b.i);
    return hits.map((h) => commandRow(h.c, h.m, true));
  }

  const built: Built = $derived.by(() => {
    const m = mode;
    if (m?.kind === 'offset') return { sections: [], more: 0 };
    if (m?.kind === 'pick') {
      const ranked = rankMatches(q, m.items, (it) => it.label);
      const rows = ranked.slice(0, MAX_ROWS).map(
        ({ item, match }): Row => ({
          key: item.id,
          label: item.label,
          ranges: match.ranges,
          note: item.hint ?? null,
          shortcut: item.shortcut ?? null,
          disabled: null,
          choose: () => {
            const pick = m.pick;
            if (!pick) return;
            remember(modeCommand);
            onClose(() => pick(item.id));
          },
        }),
      );
      return { sections: [{ name: null, rows }], more: ranked.length - rows.length };
    }
    if (q !== '') {
      const all = searchCommands(q);
      return { sections: [{ name: null, rows: all.slice(0, MAX_ROWS) }], more: Math.max(0, all.length - MAX_ROWS) };
    }
    const shown = commands.filter((c) => !c.searchOnly);
    const recents = recent.map((id) => shown.find((c) => c.id === id)).filter((c): c is Command => c !== undefined);
    const out: Section[] = [];
    if (recents.length > 0) out.push({ name: 'Recent', rows: recents.map((c) => commandRow(c, null, false)) });
    for (const g of GROUP_ORDER) {
      const rows = shown.filter((c) => c.group === g && !recents.includes(c)).map((c) => commandRow(c, null, false));
      if (rows.length > 0) out.push({ name: g, rows });
    }
    return { sections: out, more: 0 };
  });
  const sections = $derived(built.sections);
  const rows = $derived(sections.flatMap((s) => s.rows));
  const offsetMode = $derived(mode?.kind === 'offset');
  const current = $derived(rows.length === 0 ? -1 : Math.min(active, rows.length - 1));

  /** Flat index of a row, for the option ids. */
  const indexOf = (s: Section, i: number) => {
    let n = 0;
    for (const x of sections) {
      if (x === s) return n + i;
      n += x.rows.length;
    }
    return n + i;
  };

  const modeTitle = $derived(mode ? mode.title : 'Command palette');
  const placeholder = $derived(
    mode?.kind === 'offset'
      ? base === 'hex'
        ? 'Offset in hex, e.g. 1F or 0x1F'
        : 'Offset in decimal'
      : mode?.kind === 'pick'
        ? mode.placeholder
        : 'Type a command',
  );
  const emptyText = $derived(mode?.kind === 'pick' ? (mode.items.length === 0 ? mode.empty : 'No matches') : 'No matching commands');
  const moreText = $derived(built.more > 0 ? `${built.more} more ${built.more === 1 ? 'match' : 'matches'}. Keep typing to narrow them.` : '');
  // One live region for the whole life of the palette, so a change of its text is announced.
  const status = $derived(
    offsetMode ? '' : rows.length === 0 ? emptyText : `${rows.length} ${rows.length === 1 ? 'result' : 'results'}. ${moreText}`.trim(),
  );

  onMount(() => input?.focus());

  $effect(() => {
    // Keep the active option in view (jsdom has no scrollIntoView).
    const i = current;
    if (i < 0 || !listEl) return;
    listEl.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  });

  function onInput() {
    error = null;
    active = 0; // the best match; if it is disabled, Enter does nothing rather than run a worse one
  }

  async function enter(next: SubMode | null) {
    mode = next;
    if (next === null) modeCommand = null;
    query = '';
    error = null;
    active = 0;
    await tick();
    input?.focus();
  }

  /** Remember a command as recent (not the long tail or the tab switches, which may not exist next time). */
  function remember(c: Command | null) {
    if (c && !c.searchOnly && !c.transient) onUse(c.id);
  }

  function chooseCommand(c: Command) {
    if (c.disabledReason?.()) return;
    if (c.sub) {
      const next = c.sub();
      modeCommand = c;
      if (next.kind === 'pick' && !next.pick) remember(c); // a read-only list: opening it is the whole use
      void enter(next);
    } else {
      remember(c);
      onClose(c.run);
    }
  }

  function submitOffset() {
    if (mode?.kind !== 'offset') return;
    const r = mode.submit(query, base);
    if ('error' in r) error = r.error;
    else {
      remember(modeCommand);
      onClose(r.run);
    }
  }

  function chooseCurrent() {
    if (offsetMode) return submitOffset();
    const r = rows[current];
    if (r && r.disabled === null) r.choose();
  }

  function move(to: number) {
    if (rows.length === 0) return;
    active = Math.max(0, Math.min(rows.length - 1, to));
  }

  function trapTab(e: KeyboardEvent) {
    const focusable = [...(input?.closest('.panel')?.querySelectorAll<HTMLElement>('input, button:not([disabled])') ?? [])];
    if (focusable.length === 0) return;
    const at = focusable.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (at <= 0 ? focusable.length - 1 : at - 1) : at < 0 || at === focusable.length - 1 ? 0 : at + 1;
    e.preventDefault();
    focusable[next]!.focus();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.defaultPrevented || isImeKey(e)) return;
    const global = globalKey(e);
    if (global === 'palette') {
      e.preventDefault();
      if (!e.repeat) onClose(); // a held key must not flicker the palette
      return;
    }
    if (global === 'save') {
      e.preventDefault(); // keep the browser's Save page dialog away; the palette does nothing else with it
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+A, Ctrl+Backspace and friends keep working in the input
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
      case 'Enter':
        e.preventDefault();
        chooseCurrent();
        break;
      case 'Tab':
        trapTab(e);
        break;
      case 'Backspace':
        if (mode && query === '' && e.target === input) {
          e.preventDefault();
          void enter(null);
        }
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (!offsetMode && rows.length > 0) move(current + 1 >= rows.length ? 0 : current + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!offsetMode && rows.length > 0) move(current <= 0 ? rows.length - 1 : current - 1);
        break;
      case 'PageDown':
        if (!offsetMode) {
          e.preventDefault();
          move(current + PAGE);
        }
        break;
      case 'PageUp':
        if (!offsetMode) {
          e.preventDefault();
          move(current - PAGE);
        }
        break;
      case 'Home':
        if (!offsetMode && e.target === input) {
          e.preventDefault();
          move(0);
        }
        break;
      case 'End':
        if (!offsetMode && e.target === input) {
          e.preventDefault();
          move(rows.length - 1);
        }
        break;
    }
  }

  function onBackdropMouseDown(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  function onPanelMouseDown(e: MouseEvent) {
    // Clicking a row or empty space must not take focus away from the input.
    if (!(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLButtonElement)) e.preventDefault();
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="backdrop" role="presentation" onmousedown={onBackdropMouseDown}>
  <div class="panel" role="dialog" aria-modal="true" aria-label={modeTitle} tabindex="-1" onmousedown={onPanelMouseDown}>
    {#if mode}
      <div class="crumb">
        <span class="title">{mode.title}</span>
        {#if offsetMode}
          <button
            type="button"
            class="base"
            onclick={() => {
              base = base === 'hex' ? 'dec' : 'hex';
              error = null;
              input?.focus();
            }}
            title="Toggle offset base"
            aria-label="Offset base: {base === 'hex' ? 'hexadecimal' : 'decimal'}">{base === 'hex' ? 'Hex' : 'Dec'}</button
          >
        {/if}
      </div>
    {/if}
    <div class="field">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
        <circle cx="6.5" cy="6.5" r="4.25" fill="none" stroke="currentColor" stroke-width="1.4" />
        <path d="M10 10l4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
      <input
        bind:this={input}
        bind:value={query}
        oninput={onInput}
        type="text"
        role="combobox"
        aria-label={modeTitle}
        aria-autocomplete="list"
        aria-expanded={!offsetMode && rows.length > 0}
        aria-controls={offsetMode ? undefined : listId}
        aria-activedescendant={!offsetMode && current >= 0 ? optId(current) : undefined}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? errorId : undefined}
        {placeholder}
        maxlength="100"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
      />
    </div>
    {#if error}<p class="error" id={errorId} role="alert">{error}</p>{/if}
    {#if !offsetMode}
      <div class="list" id={listId} role="listbox" aria-label={modeTitle} bind:this={listEl} hidden={rows.length === 0}>
        {#each sections as section (section.name ?? '')}
          {@const gid = `${uid}-g-${section.name}`}
          <div role="group" aria-labelledby={section.name ? gid : undefined}>
            {#if section.name}<div class="group" id={gid}>{section.name}</div>{/if}
            {#each section.rows as row, i (row.key)}
              {@const n = indexOf(section, i)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                class="opt"
                id={optId(n)}
                role="option"
                tabindex="-1"
                aria-selected={n === current}
                aria-disabled={row.disabled !== null ? 'true' : undefined}
                class:active={n === current}
                class:disabled={row.disabled !== null}
                onmousemove={() => (active = n)}
                onclick={row.choose}
              >
                <span class="label">{#each splitByRanges(row.label, row.ranges) as seg, k (k)}{#if seg.hit}<span class="hit">{seg.text}</span>{:else}{seg.text}{/if}{/each}</span>
                {#if row.note}<span class="note">{row.note}</span>{/if}
                {#if row.shortcut}<kbd>{row.shortcut}</kbd>{/if}
              </div>
            {/each}
          </div>
        {/each}
      </div>
      {#if rows.length === 0}<p class="none" aria-hidden="true">{emptyText}</p>{:else if moreText}<p class="none" aria-hidden="true">{moreText}</p>{/if}
    {:else}
      <p class="none">{base === 'hex' ? 'Hexadecimal; 0x prefix optional.' : 'Decimal digits.'} Press Enter to go.</p>
    {/if}
    <div class="sr" role="status">{status}</div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--scrim);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: min(14vh, 120px);
    box-sizing: border-box;
    z-index: 20;
  }
  .panel {
    width: min(560px, calc(100vw - 32px));
    max-height: calc(100dvh - min(14vh, 120px) - 16px);
    display: flex;
    flex-direction: column;
    background: var(--chrome);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    box-shadow: 0 8px 28px var(--dialog-shadow);
    overflow: hidden;
  }
  .panel:focus {
    outline: none;
  }
  @media (prefers-reduced-motion: no-preference) {
    .panel {
      animation: fade-in 120ms ease-out;
    }
  }
  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  .crumb {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px 0;
  }
  .title {
    font-weight: 600;
  }
  .base {
    min-width: 4ch;
    font-family: var(--mono);
    font-size: var(--fs-sm);
  }
  .field {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--rule);
    color: var(--ink-quiet);
  }
  .field svg {
    flex: none;
  }
  input {
    flex: 1;
    min-width: 0;
    padding: 4px 0;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--ink);
    font-size: var(--fs-lg);
  }
  input:focus-visible {
    outline: none;
  }
  .field:has(input:focus-visible) {
    box-shadow: inset 0 -2px 0 var(--signal);
  }
  .error {
    margin: 0;
    padding: 6px 12px;
    color: var(--error);
    font-size: var(--fs-sm);
  }
  .list {
    overflow-y: auto;
    padding: 4px 0;
    min-height: 0;
  }
  .group {
    padding: 8px 12px 2px;
    color: var(--ink-quiet);
    font-size: var(--fs-xs);
    font-weight: 500;
  }
  .opt {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 5px 12px 5px 10px;
    border-left: 2px solid transparent;
    cursor: default;
    font-size: var(--fs-base);
  }
  .opt.active {
    background: var(--hover);
    border-left-color: var(--signal);
  }
  .opt.disabled .label {
    color: var(--ink-faint);
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hit {
    font-weight: 600;
    text-decoration: underline;
    text-decoration-color: var(--signal);
    text-decoration-thickness: 2px;
    text-underline-offset: 2px;
  }
  .note {
    flex: none;
    max-width: 55%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-quiet);
    font-size: var(--fs-sm);
  }
  kbd {
    flex: none;
    font-family: var(--mono);
    font-size: var(--fs-xs);
    color: var(--ink-quiet);
  }
  .none {
    margin: 0;
    padding: 10px 12px;
    color: var(--ink-quiet);
    font-size: var(--fs-sm);
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @media (max-width: 480px) {
    .backdrop {
      padding-top: 8px;
    }
    .panel {
      max-height: calc(100dvh - 16px);
    }
    .note {
      max-width: 45%;
    }
  }
</style>
