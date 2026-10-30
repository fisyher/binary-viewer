/** Starter spec for the "New format" flow. Pure. */
import { parseHexBytes } from '../engine';
import { addDetect, toText, type BuilderModel, type FieldModel } from './model';

export interface StarterOptions {
  id: string;
  name: string;
  endian: 'le' | 'be';
  /** Optional hex bytes (e.g. "89 50 4E 47"); adds a magic field and a detect rule at offset 0. */
  magic?: string;
  /** Optional extension, with or without a leading dot. */
  extension?: string;
}

export type StarterResult = { ok: true; text: string } | { ok: false; error: string };

export function starterSpec(o: StarterOptions): StarterResult {
  const magic = (o.magic ?? '').trim();
  let bytes: Uint8Array | null = null;
  if (magic !== '') {
    bytes = parseHexBytes(magic, 64);
    if (!bytes) return { ok: false, error: 'Magic bytes must be 1 to 64 hex bytes, for example "42 4D".' };
  }
  const ext = (o.extension ?? '').trim().replace(/^\./, '').toLowerCase();
  if (ext !== '' && !/^[a-z0-9_+-]{1,16}$/.test(ext)) return { ok: false, error: 'The extension may use lower-case letters, digits, "_", "+" and "-" (up to 16).' };
  const fields: FieldModel[] = bytes
    ? [{ name: 'magic', type: 'str', size: bytes.length, encoding: 'latin1', expect: String.fromCharCode(...bytes), doc: 'Signature' }]
    : [{ name: 'magic', type: 'u4' }];
  let model: BuilderModel = {
    meta: { schemaVersion: 1, id: o.id, name: o.name, endian: o.endian, extensions: ext ? [ext] : [], root: 'root', extra: {} },
    types: [{ name: 'root', fields, extra: {} }],
  };
  if (bytes) model = addDetect(model, { at: 0, bytes: [...bytes].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') });
  return { ok: true, text: toText(model) };
}
