import { untrack } from 'svelte';
import { starterSpec } from '../../core/builder';
import { downloadBlob } from '../../core/download';
import type { FormatSpec } from '../../core/engine';
import type { SpecEntry, SpecLibrary, LibrarySnapshot } from '../../core/spec-library';
import { sanitizeText } from '../../core/tree-model';

type Confirm = { message: string; label: string; run: () => void };
type NewForm = { id: string; name: string; endian: 'le' | 'be'; magic: string; ext: string };

/**
 * The state behind the format library UI, shared by the list (side bar) and the detail (spec editor tab): which spec is
 * open, its unsaved draft, the new-spec form, and every action on the library. Create it once in a component's
 * initialisation and call `connect()` from an `$effect`.
 */
export class FormatsState {
  private held: SpecEntry | undefined = undefined; // the selected entry while a save that renames it is in flight
  private readonly lastValid = new Map<string, FormatSpec>();
  readonly t = (s: string, max = 120) => sanitizeText(s, max);

  snap = $state.raw<LibrarySnapshot>(undefined as never);
  selectedId = $state<string | null>(null);
  // The editors stay mounted across tab switches and renames (they are keyed by this, which only changes when the
  // user opens another spec), so unsaved text is never discarded by the UI.
  editorKey = $state(0);
  saving = $state(false);
  tab = $state<'builder' | 'json' | 'docs'>('json');
  // The draft text is shared by the JSON editor, the builder and the preview. null = untouched: follow the saved text.
  draft = $state<string | null>(null);
  saveStatus = $state<{ ok: boolean; text: string } | null>(null);
  jsonEditor = $state<{ save(): Promise<void> | void; revert(): void } | undefined>();
  newForm = $state<NewForm | null>(null);
  newError = $state<string | null>(null);
  editorDirty = $state(false);
  confirm = $state<Confirm | null>(null);
  error = $state<string | null>(null);
  /** Called when a spec was opened (or re-selected) by the user: the app shows its tab. */
  onOpened: () => void = () => {};
  /** Called when the open spec went away (closed, deleted): the app leaves the spec tab. */
  onClosed: () => void = () => {};

  constructor(readonly library: SpecLibrary) {
    this.snap = library.snapshot();
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
    const e = this.snap.entries.find((x) => x.id === this.selectedId);
    if (e) this.held = e;
    for (const x of this.snap.entries) if (x.spec) this.lastValid.set(x.id, x.spec);
    if (this.selectedId !== null && !e && !this.saving) {
      // The open spec disappeared (removed from the synced folder, deleted elsewhere): drop its tab and draft state.
      this.selectedId = null;
      this.editorDirty = false;
      this.draft = null;
      this.error = null;
      this.editorKey++;
      this.onClosed();
    }
  }

  readonly selected: SpecEntry | undefined = $derived(
    this.snap.entries.find((e) => e.id === this.selectedId) ?? (this.saving ? this.held : undefined),
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

  /** Run `action` now, or after the user agrees to drop unsaved edits of the open spec. */
  guard(action: () => void) {
    if (this.editorDirty) {
      this.confirm = {
        message: `"${this.selected ? this.t(this.selected.name) : 'This format'}" has unsaved changes. Discard them?`,
        label: 'Discard changes',
        run: action,
      };
    } else action();
  }

  private open(id: string, tab?: 'builder' | 'json') {
    this.editorDirty = false;
    this.error = null;
    this.selectedId = id;
    this.editorKey++;
    this.draft = null;
    if (tab) this.tab = tab;
    this.refresh();
    this.onOpened();
  }

  /** Open a spec in the (single) spec tab; asks first if the spec that would be replaced has unsaved changes. */
  select(id: string) {
    if (id === this.selectedId) {
      this.onOpened();
      return;
    }
    this.guard(() => this.open(id));
  }

  /** Close the spec tab (asks first if there are unsaved changes). */
  close() {
    this.guard(() => {
      this.editorDirty = false;
      this.error = null;
      this.selectedId = null;
      this.editorKey++;
      this.draft = null;
      this.onClosed();
    });
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
    this.guard(async () => {
      const r = await this.library.create(id, name);
      if (!r.ok) {
        this.newError = r.error;
        return; // the dirty flag stays: nothing was replaced
      }
      this.editorDirty = false;
      const sv = await this.library.save(r.id, st.text);
      this.newForm = null;
      this.newError = null;
      this.open(r.id, 'builder');
      this.error = sv.ok ? null : sv.error;
    });
  }

  async duplicate() {
    const id = this.selectedId;
    if (!id) return;
    const r = await this.library.duplicate(id);
    if (r.ok) this.guard(() => this.open(r.id, 'json'));
    else this.error = r.error;
  }

  askDelete() {
    const e = this.selected;
    if (!e || e.source !== 'user') return;
    this.confirm = {
      message: `Delete the format "${this.t(e.name)}" (${this.t(e.id, 64)})? ${this.folder.state === 'connected' ? 'Its file in the synced folder is removed too. ' : ''}This cannot be undone.`,
      label: 'Delete',
      run: () => {
        void this.library.delete(e.id).then((r) => {
          if (r.ok) this.gone();
          else this.error = r.error;
        });
      },
    };
  }

  /** The open spec no longer exists (deleted): drop the tab without asking. */
  private gone() {
    this.editorDirty = false;
    this.selectedId = null;
    this.error = null;
    this.onClosed();
  }

  async save(text: string) {
    const id = this.selectedId;
    if (!id) return { ok: false as const, error: 'No format selected.' };
    this.saving = true;
    try {
      const r = await this.library.save(id, text);
      if (r.ok && r.id !== id) {
        this.selectedId = r.id; // the id inside the JSON changed; the editor stays mounted
        this.refresh();
      }
      return r;
    } finally {
      this.saving = false;
    }
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
          if (r.ok) this.gone();
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
