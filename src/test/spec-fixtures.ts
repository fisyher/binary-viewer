import { loadBuiltinSpecs } from '../formats';

/** A small valid spec as JSON text. */
export function specText(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    { schemaVersion: 1, id, name: `Fmt ${id}`, endian: 'le', extensions: ['xyz'], root: 'root', types: { root: { fields: [{ name: 'magic', type: 'u4' }] } }, ...extra },
    null,
    2,
  );
}

export const builtins = () => loadBuiltinSpecs().specs;
