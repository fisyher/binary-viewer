import { formatIssues, validateSpec, type FormatSpec } from '../core/engine';
import bmpJson from './bmp.json';
import zipJson from './zip.json';

export interface BuiltinSpecs {
  specs: FormatSpec[];
  /** One readable message per built-in spec that failed validation (those specs are left out). */
  errors: string[];
}

/** Validate the built-in specs. A failure is reported, never thrown. */
export function loadBuiltinSpecs(): BuiltinSpecs {
  const specs: FormatSpec[] = [];
  const errors: string[] = [];
  for (const [name, json] of [
    ['bmp.json', bmpJson],
    ['zip.json', zipJson],
  ] as const) {
    try {
      const r = validateSpec(json);
      if (r.ok) specs.push(r.spec);
      else errors.push(`${name}: ${formatIssues(r.errors)}`);
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { specs, errors };
}
