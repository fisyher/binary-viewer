import { untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { sameSpecText, starterSpec } from '../../core/builder';
import { downloadBlob } from '../../core/download';
import type { FormatSpec } from '../../core/engine';
import type { SpecEntry, SpecLibrary, LibrarySnapshot } from '../../core/spec-library';
import { sanitizeText } from '../../core/tree-model';

type Confirm = { message: string; label: string; run: () => void };
type NewForm = { id: string; name: string; endian: 'le' | 'be'; magic: string; ext: string };
type SpecView = 'builder' | 'json' | 'docs';
/** What one open spec tab remembers while another tab is showing. The Builder's undo history is not part of it. */
type Session = {
  /** The unsaved text shared by the JSON editor, the builder and the preview. null = untouched: follow the saved text. */
  draft: string | null;
  tab: SpecView;
  saveStatus: { ok: boolean; text: string } | null;
  error: string | null;
};
/** One entry of the editor tab bar. */
export type OpenSpecTab = { id: string; name: string; dirty: boolean };

/**
 * The state behind the format library UI, shared by the list (side bar) and the detail (spec editor tabs): which specs
 * are open (an ordered list of tabs, one active), each tab's unsaved draft and view, the new-spec form, and every action
 * on the library. Only the active tab has mounted editors; the others live on in `sessions`, so switching never loses
 * text (the Builder's undo history is the one thing that does). Create it once in a component's initialisation and
 * call `connect()` from an `$effect`.
 */
export class FormatsState {
  // Saves in flight, by spec id (two tabs can save at once): `held` is the entry as it was before the save, which keeps a
  // spec whose save renames it from looking like it vanished.
  private readonly savers = new SvelteMap<string, { held: SpecEntry | undefined; n: number }>();
  private readonly lastValid = new Map<string, FormatSpec>();
  private readonly savedSeen = new Map<string, string>(); // each open spec's saved text as last seen
  private readonly dirtyMemo = new Map<string, { draft: string; saved: string; dirty: boolean }>();
  private readonly sessions = new SvelteMap<string, Session>();
  readonly t = (s: string, max = 120) => sanitizeText(s, max);

  snap = $state.raw<LibrarySnapshot>(undefined as never);
  /** Ids of the open spec tabs, left to right. */
  tabIds = $state.raw<string[]>([]);
  activeSpecId = $state<string | null>(null);
  // The editors are keyed by this, which changes when another tab becomes active (and not on a rename, which keeps the
  // active tab), so unsaved text of the shown tab is never discarded by the UI.
  editorKey = $state(0);
  /** A save is in flight. */
  get saving(): boolean {
    return this.savers.size > 0;
  }
  jsonEditor = $state<{ save(): Promise<void> | void; revert(): void } | undefined>();
  newForm = $state<NewForm | null>(null);
  newError = $state<string | null>(null);
  confirm = $state<Confirm | null>(null);
  /** Called when a spec tab was opened or re-selected by the user: the app shows the spec tab. */
  onOpened: () => void = () => {};

  constructor(readonly library: SpecLibrary) {
    this.snap = library.snapshot();
  }

  // The view, draft, save outcome and error of the active tab.
  private get cur(): Session | undefined {
    return this.activeSpecId === null ? undefined : this.sessions.get(this.activeSpecId);
  }
  get tab(): SpecView {
    return this.cur?.tab ?? 'json';
  }
  set tab(v: SpecView) {
    const s = this.cur;
    if (s) s.tab = v;
  }
  get draft(): string | null {
    return this.cur?.draft ?? null;
  }
  set draft(v: string | null) {
    const s = this.cur;
    if (s) s.draft = v;
  }
  get saveStatus(): { ok: boolean; text: string } | null {
    return this.cur?.saveStatus ?? null;
  }
  set saveStatus(v: { ok: boolean; text: string } | null) {
    const s = this.cur;
    if (s) s.saveStatus = v;
  }
  get error(): string | null {
    return this.cur?.error ?? null;
  }
  set error(v: string | null) {
    const s = this.cur;
    if (s) s.error = v;
  }

  /**
   * Mirror the library into `snap`; returns the unsubscribe function (use as an `$effect` body). The initial refresh is
   * untracked and the subscription callback is the only writer afterwards, so the effect never re-runs.
   */
  connect(): () => void {
    untrack(() => this.refresh());
    return this.library.subscribe(() => this.refresh());
  }

  private refresh() {
    this.snap = this.library.snapshot();
    for (const x of this.snap.entries) if (x.spec) this.lastValid.set(x.id, x.spec);
    for (const [id, s] of this.savers) {
      const held = this.snap.entries.find((x) => x.id === id);
      if (held) s.held = held;
    }
    for (const id of [...this.tabIds]) {
      const e = this.snap.entries.find((x) => x.id === id);
      if (!e) {
        // The spec disappeared (removed from the synced folder, deleted elsewhere): drop its tab and session. A spec
        // whose save is renaming it is missing for a moment and keeps its tab.
        if (!this.savers.has(id)) this.dropTab(id);
        continue;
      }
      // The saved text changed underneath a draft that matched the old one (folder sync, a save elsewhere): follow it.
      const prev = this.savedSeen.get(id);
      const s = this.sessions.get(id);
      if (prev !== undefined && prev !== e.text && s && s.draft !== null && sameSpecText(s.draft, prev)) s.draft = null;
      this.savedSeen.set(id, e.text);
    }
  }

  readonly selected: SpecEntry | undefined = $derived(
    this.snap.entries.find((e) => e.id === this.activeSpecId) ?? (this.activeSpecId !== null ? this.savers.get(this.activeSpecId)?.held : undefined),
  );
  readonly draftText: string = $derived(this.draft ?? this.selected?.text ?? '');
  readonly docsSpec: FormatSpec | null = $derived(this.selected ? (this.selected.spec ?? this.lastValid.get(this.selected.id) ?? null) : null);
  readonly docsNote: string | null = $derived(
    !this.selected
      ? null
      : !this.selected.valid && this.docsSpec
        ? 'The saved version is invalid; showing the last valid version.'
        : this.editorDirty
          ? 'Showing the last saved version; you have unsaved changes.'
          : null,
  );
  readonly builtins: SpecEntry[] = $derived(this.snap.entries.filter((e) => e.source === 'builtin'));
  readonly customs: SpecEntry[] = $derived(this.snap.entries.filter((e) => e.source === 'user'));
  readonly folder = $derived(this.snap.folder);
  readonly folderLine: string = $derived(
    !this.folder.supported
      ? 'Folder: not supported in this browser — use Import/Export'
      : this.folder.state === 'connected'
        ? `Folder: ${this.t(this.folder.name ?? '?', 60)} (synced)`
        : this.folder.state === 'needs-permission'
          ? `Folder: ${this.t(this.folder.name ?? '?', 60)} (permission needed)`
          : 'Folder: not connected',
  );

  private entryOf(id: string): SpecEntry | undefined {
    return this.snap.entries.find((e) => e.id === id) ?? this.savers.get(id)?.held;
  }

  /**
   * Does the tab have unsaved changes? Derived: the draft counts only if it is a different JSON value than the saved
   * text (layout and an edit that was undone again do not count). Remembered per tab, so typing in one tab does not
   * re-parse the texts of the others.
   */
  isDirty(id: string): boolean {
    const draft = this.sessions.get(id)?.draft ?? null;
    const saved = this.entryOf(id)?.text;
    if (draft === null || saved === undefined) return false;
    const m = this.dirtyMemo.get(id);
    if (m && m.draft === draft && m.saved === saved) return m.dirty;
    const dirty = !sameSpecText(draft, saved);
    this.dirtyMemo.set(id, { draft, saved, dirty });
    return dirty;
  }
  /** The active tab has unsaved changes. */
  get editorDirty(): boolean {
    return this.activeSpecId !== null && this.isDirty(this.activeSpecId);
  }
  /** Any open tab has unsaved changes (the page then asks before it is left). */
  get anyDirty(): boolean {
    return this.tabIds.some((id) => this.isDirty(id));
  }
  isOpen(id: string): boolean {
    return this.tabIds.includes(id);
  }
  /** The open tabs for the tab bar. */
  readonly openTabs: OpenSpecTab[] = $derived(this.tabIds.map((id) => ({ id, name: this.entryOf(id)?.name ?? id, dirty: this.isDirty(id) })));

  /** Open `id` in a tab after the active one (or just show it if it is open already) and make it the active tab. */
  private open(id: string, tab?: SpecView) {
    const entry = this.entryOf(id);
    if (!entry) return;
    if (!this.tabIds.includes(id)) {
      const at = this.activeSpecId === null ? this.tabIds.length : this.tabIds.indexOf(this.activeSpecId) + 1;
      this.tabIds = [...this.tabIds.slice(0, at), id, ...this.tabIds.slice(at)];
      const session = $state<Session>({ draft: null, tab: 'json', saveStatus: null, error: null }); // deep state: fields are reactive
      this.sessions.set(id, session);
      this.savedSeen.set(id, entry.text);
    }
    if (tab) this.sessions.get(id)!.tab = tab;
    if (this.activeSpecId !== id) {
      this.activeSpecId = id;
      this.editorKey++;
    }
    this.onOpened();
  }

  /** The Formats side bar picked a spec: show its tab, opening it next to the active one if needed. */
  select(id: string) {
    this.refresh(); // the library may have changed since the last notification
    this.open(id);
  }

  /** Show the tab of an open spec. */
  activate(id: string) {
    if (this.tabIds.includes(id)) this.open(id);
  }

  /** Remove a tab and its session; removing the active one activates the neighbour (right, else left, else none). */
  private dropTab(id: string) {
    const i = this.tabIds.indexOf(id);
    if (i < 0) return;
    this.tabIds = this.tabIds.filter((x) => x !== id);
    this.sessions.delete(id);
    this.savedSeen.delete(id);
    this.dirtyMemo.delete(id);
    if (this.activeSpecId === id) {
      this.activeSpecId = this.tabIds[i] ?? this.tabIds[i - 1] ?? null;
      this.editorKey++;
    }
  }

  /** Close a tab (default: the active one); asks first if it has unsaved changes. */
  close(id: string | null = this.activeSpecId) {
    if (id === null || !this.tabIds.includes(id)) return;
    if (this.isDirty(id)) {
      this.confirm = {
        message: `"${this.t(this.entryOf(id)?.name ?? id)}" has unsaved changes. Discard them?`,
        label: 'Discard changes',
        run: () => this.dropTab(id),
      };
    } else this.dropTab(id);
  }

  openNew() {
    let id = 'new-format';
    for (let n = 2; this.snap.entries.some((e) => e.id === id); n++) id = `new-format-${n}`;
    this.newForm = { id, name: 'New format', endian: 'le', magic: '', ext: '' };
    this.newError = null;
  }

  async submitNew() {
    const f = this.newForm;
    if (!f) return;
    const id = f.id.trim();
    const name = f.name.trim();
    if (name === '') {
      this.newError = 'Enter a name.';
      return;
    }
    const st = starterSpec({ id, name, endian: f.endian, magic: f.magic, extension: f.ext });
    if (!st.ok) {
      this.newError = st.error;
      return;
    }
    const r = await this.library.create(id, name);
    if (!r.ok) {
      this.newError = r.error;
      return;
    }
    const sv = await this.library.save(r.id, st.text);
    this.newForm = null;
    this.newError = null;
    this.refresh();
    this.open(r.id, 'builder');
    this.error = sv.ok ? null : sv.error;
  }

  async duplicate() {
    const id = this.activeSpecId;
    if (!id) return;
    const r = await this.library.duplicate(id);
    if (r.ok) {
      this.refresh();
      this.open(r.id, 'json');
    } else this.error = r.error;
  }

  askDelete() {
    const e = this.selected;
    if (!e || e.source !== 'user') return;
    this.confirm = {
      message: `Delete the format "${this.t(e.name)}" (${this.t(e.id, 64)})? ${this.folder.state === 'connected' ? 'Its file in the synced folder is removed too. ' : ''}This cannot be undone.`,
      label: 'Delete',
      run: () => {
        void this.library.delete(e.id).then((r) => {
          if (r.ok) this.dropTab(e.id);
          else this.error = r.error;
        });
      },
    };
  }

  /** Save the active tab's spec. A changed id inside the JSON renames it: the tab keeps its place and state. */
  async save(text: string) {
    const id = this.activeSpecId;
    if (!id) return { ok: false as const, error: 'No format selected.' };
    const s = this.savers.get(id) ?? { held: this.entryOf(id), n: 0 };
    s.n++;
    this.savers.set(id, s);
    try {
      const r = await this.library.save(id, text);
      if (r.ok && r.id !== id) this.rename(id, r.id);
      return r;
    } finally {
      if (--s.n <= 0) this.savers.delete(id);
      this.refresh();
    }
  }

  /** The spec `from` is now called `to`: move its tab, session and bookkeeping over. */
  private rename(from: string, to: string) {
    if (this.tabIds.includes(to)) {
      this.dropTab(from); // `to` is open already (should not happen: the library refuses a taken id)
      return;
    }
    this.tabIds = this.tabIds.map((x) => (x === from ? to : x));
    const s = this.sessions.get(from);
    this.sessions.delete(from);
    if (s) this.sessions.set(to, s);
    this.dirtyMemo.delete(from);
    this.savedSeen.delete(from);
    if (this.activeSpecId === from) this.activeSpecId = to; // the editors stay mounted: no editorKey change
    this.refresh();
  }

  keepRemoved() {
    const e = this.selected;
    if (e) void this.library.keepRemoved(e.id).then((r) => (this.error = r.ok ? null : r.error));
  }

  overwriteFolderFile(allowLoss = false) {
    const e = this.selected;
    if (!e) return;
    void this.library.overwriteFolderFile(e.id, allowLoss).then((r) => {
      if (r.ok) this.error = null;
      else if (r.needsConfirm) {
        this.confirm = {
          message: r.error + ' Replace it anyway? The old contents will be lost.',
          label: 'Overwrite',
          run: () => this.overwriteFolderFile(true),
        };
      } else this.error = r.error;
    });
  }

  askDeleteRemoved() {
    const e = this.selected;
    if (!e) return;
    this.confirm = {
      message: 'Delete "' + this.t(e.name) + '" (' + this.t(e.id, 64) + ') from this library? Its file is already gone from the folder.',
      label: 'Delete locally',
      run: () => {
        void this.library.deleteRemoved(e.id).then((r) => {
          if (r.ok) this.dropTab(e.id);
          else this.error = r.error;
        });
      },
    };
  }

  async importFiles(files: File[]) {
    if (files.length > 0) await this.library.importFiles(files);
  }

  exportJson() {
    const s = this.selected;
    if (!s) return;
    const blob = this.library.export(s.id);
    if (blob) downloadBlob(`${s.id}.json`, blob);
  }

  exportDoc(kind: 'md' | 'html') {
    const s = this.selected;
    if (!s) return;
    const d = this.library.exportDoc(s.id, kind);
    if (d) downloadBlob(d.fileName, d.blob);
    else this.error = 'Documentation can only be generated for a valid format.';
  }
}
