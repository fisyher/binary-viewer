import { rm, writeFile } from 'node:fs/promises';
import { expect, test as base, type Locator, type Page } from '@playwright/test';

/** Guards that fail a test on console/page errors or on requests that leave the origin. Applied to every test. */
export const test = base.extend<{ guard: void }>({
  guard: [
    async ({ page, baseURL }, use) => {
      const problems: string[] = [];
      const foreign: string[] = [];
      const origin = new URL(baseURL ?? 'http://localhost:4173/').origin;
      page.on('console', (m) => {
        if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      // Web Worker console output (the format engine); only some browsers expose it.
      page.on('worker', (w) => {
        const wp = w as unknown as { on?: (ev: string, cb: (m: { type(): string; text(): string }) => void) => void };
        wp.on?.('console', (m) => {
          if (m.type() === 'error') problems.push(`worker console.error: ${m.text()}`);
        });
      });
      page.on('request', (r) => {
        const url = r.url();
        // blob:/data: URLs never leave the machine; everything else must stay on the preview server's origin.
        if (url.startsWith('blob:') || url.startsWith('data:')) return;
        if (new URL(url).origin !== origin) foreign.push(url);
      });
      await use();
      await Promise.all(tempFiles.splice(0).map((f) => rm(f, { force: true })));
      expect(problems, 'console errors / page errors').toEqual([]);
      expect(foreign, 'requests that left the origin').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function gotoApp(page: Page): Promise<void> {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Binary Viewer', level: 1 })).toBeVisible();
}

// The Formats view has a second (multiple) file input for importing specs.
const OPEN_INPUT = 'input[type="file"]:not([multiple])';

const tempFiles: string[] = [];

/** Open a generated file through the (hidden) file input, which is what the fallback path of "Open…" uses. */
export async function openBytes(page: Page, name: string, bytes: Uint8Array, mimeType = 'application/octet-stream'): Promise<void> {
  await page.locator(OPEN_INPUT).setInputFiles({ name, mimeType, buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
  await expect(page.getByRole('grid', { name: 'Hex view' })).toBeVisible();
}

/** Playwright refuses in-memory buffers over 50 MB, so large fixtures go through a file in the test's output folder. */
export async function openLargeFile(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  const path = test.info().outputPath(name);
  await writeFile(path, bytes);
  tempFiles.push(path); // the browser reads the file lazily, so it may only be removed after the test (guard teardown)
  await page.locator(OPEN_INPUT).setInputFiles(path);
  await expect(page.getByRole('grid', { name: 'Hex view' })).toBeVisible();
}

export const statusBar = (page: Page): Locator => page.locator('footer.status');
export const hexByte = (page: Page, offset: number): Locator => page.locator(`.hex .b[data-o="${offset}"]`);
export const hexView = (page: Page): Locator => page.getByRole('grid', { name: 'Hex view' });
export const treeRow = (page: Page, name: string): Locator =>
  page.getByRole('treeitem').filter({ has: page.locator('.nm', { hasText: new RegExp(`^${name.replace(/[[\]]/g, '\\$&')}$`) }) });

/**
 * The structure tree only renders the rows near the viewport. Walk down with ArrowDown from the current selection
 * (or from the first row when nothing is selected) until the named row is selected; selecting scrolls it into view.
 */
export async function revealRow(page: Page, name: string): Promise<Locator> {
  const row = treeRow(page, name);
  const tree = page.getByRole('tree', { name: 'Structure' });
  // The keyboard cursor is the `.active` row; it also stops on non-node rows ("open ...", "more"), which are never selected.
  const selected = page.locator('[role="treeitem"].active');
  if ((await selected.count()) === 0) await page.getByRole('treeitem').first().click();
  const currentKey = async (): Promise<string | null> => ((await selected.count()) === 1 ? selected.getAttribute('data-key', { timeout: 1000 }).catch(() => null) : null);
  for (let i = 0; i < 500; i++) {
    await expect(selected).toHaveCount(1); // the active row is re-rendered after each scroll
    if ((await selected.locator('.nm').first().textContent().catch(() => null)) === name && (await row.count()) === 1) return row;
    const before = await currentKey();
    await tree.focus(); // selecting a node can hand focus to the hex view
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await currentKey()) ?? before).not.toBe(before);
  }
  throw new Error(`Row "${name}" not reached by keyboard navigation`);
}

export const hex = (n: number): string => '0x' + n.toString(16).toUpperCase();

export async function expectSelection(page: Page, start: number, length: number): Promise<void> {
  const bar = statusBar(page);
  await expect(bar).toContainText(`Start: ${hex(start)} (${start})`);
  await expect(bar).toContainText(`Length: ${hex(length)} (${length})`);
}

/** Wait until the format engine finished parsing ("Parsed: N nodes ..."). */
export async function expectParsed(page: Page): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: /^Parsed: \d+ nodes/ })).toBeVisible();
}

const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

/** A BMP: 14-byte file header, BITMAPINFOHEADER (24 bpp, 1x1), `pixelBytes` of pixels starting at `offBits`. */
export function makeBmp(pixelBytes = 40, offBits = 54): Uint8Array {
  const dib = [...le32(40), ...le32(1), ...le32(1), ...le16(1), ...le16(24), ...le32(0), ...le32(pixelBytes), ...le32(2835), ...le32(2835), ...le32(0), ...le32(0)];
  const out = new Uint8Array(offBits + pixelBytes);
  out.set([0x42, 0x4d, ...le32(out.length), ...le16(0), ...le16(0), ...le32(offBits), ...dib]);
  for (let i = offBits; i < out.length; i++) out[i] = 0xa0 + (i % 16);
  return out;
}
