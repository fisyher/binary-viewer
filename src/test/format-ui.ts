/** Test helpers for the format controls, which live in the status bar and the command palette (not in a select). */
import { fireEvent, waitFor } from '@testing-library/svelte';
import { expect } from 'vitest';

/** The status bar's format button. */
export const formatButton = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('footer.status button.format');

/** The format name the status bar shows ("No format" when none is chosen), or null without a format button. */
export const formatShown = (c: HTMLElement): string | null => formatButton(c)?.querySelector('.fname')?.textContent ?? null;

const paletteInput = () => document.querySelector<HTMLInputElement>('input[role="combobox"]');
const optionLabels = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.querySelector('.label')?.textContent ?? '');

/** Open the Choose format list with the status bar's format button; resolves to the labels of its rows. */
export async function openFormatPicker(c: HTMLElement): Promise<string[]> {
  await fireEvent.click(formatButton(c)!);
  await waitFor(() => expect(document.querySelector('[role="dialog"][aria-label="Choose format"]')).not.toBeNull());
  return optionLabels();
}

/** Close the palette without choosing anything. */
export async function closePalette() {
  await fireEvent.keyDown(paletteInput()!, { key: 'Escape' });
  await waitFor(() => expect(paletteInput()).toBeNull());
}

/** Choose a format by the exact text of its row in the Choose format list (e.g. "Windows Bitmap (magic + extension)" or "None (raw)"). */
export async function chooseFormat(c: HTMLElement, label: string) {
  const labels = await openFormatPicker(c);
  const i = labels.indexOf(label);
  expect(i, `no row "${label}" in ${JSON.stringify(labels)}`).toBeGreaterThanOrEqual(0);
  await fireEvent.click(document.querySelectorAll('[role="option"]')[i]!);
  await waitFor(() => expect(paletteInput()).toBeNull());
}

/** The labels of the Choose format list right now (opens it and closes it again without choosing). */
export async function formatOptions(c: HTMLElement): Promise<string[]> {
  const labels = await openFormatPicker(c);
  await closePalette();
  return labels;
}
