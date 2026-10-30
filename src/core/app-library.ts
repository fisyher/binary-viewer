import { loadBuiltinSpecs } from '../formats';
import { FolderSync, defaultPicker } from './spec-folder';
import { SpecLibrary } from './spec-library';
import { createDefaultStore } from './spec-store';

/** The library the app uses: built-in specs, IndexedDB storage (memory fallback) and optional folder sync. */
export function createAppLibrary(): SpecLibrary {
  const store = createDefaultStore();
  return new SpecLibrary({ store, builtins: loadBuiltinSpecs().specs, folder: new FolderSync({ store, picker: defaultPicker() }) });
}
