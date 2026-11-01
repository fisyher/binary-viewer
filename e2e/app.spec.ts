import { readFile } from 'node:fs/promises';
import { buildZip } from '../src/test/zip-builder';
import { expect, expectParsed, expectSelection, gotoApp, hex, hexByte, hexView, makeBmp, openBytes, openLargeFile, revealRow, statusBar, test, treeRow } from './fixtures';

test.describe('viewer', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test('start screen shows the title, tagline, built-in formats and switches to Formats', async ({ page }) => {
    await expect(page).toHaveTitle('Binary Viewer');
    await expect(page.getByText('Hex editor and binary format inspector')).toBeVisible();
    await expect(page.getByText(/Built-in formats:.*Windows Bitmap.*ZIP/)).toBeVisible();
    const modes = page.getByRole('group', { name: 'Mode' });
    await expect(modes.getByRole('button', { name: 'Viewer' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Browse formats' }).click();
    await expect(modes.getByRole('button', { name: 'Formats' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Browse formats' })).toBeHidden();
  });

  test('BMP: hex bytes, structure tree, node selection, Data Inspector and the off_bits link', async ({ page }) => {
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expect(page).toHaveTitle('pic.bmp — Binary Viewer');
    await expect(hexByte(page, 0)).toHaveText('42');
    await expect(hexByte(page, 1)).toHaveText('4D');
    await expectParsed(page);
    await expect(page.getByRole('tree', { name: 'Structure' })).toBeVisible();

    await treeRow(page, 'file_header').click();
    await expectSelection(page, 0, 14);
    await expect(statusBar(page)).toContainText('End: 0xD (13)');
    const inspector = page.getByRole('complementary', { name: 'Data inspector' });
    await expect(inspector.getByText('@ 0x00000000')).toBeVisible();

    const offBits = treeRow(page, 'off_bits');
    await expect(offBits).toBeVisible();
    await offBits.getByRole('button', { name: /Go to pixel data/ }).click();
    await expectSelection(page, 54, 40);
    await expect(inspector.getByText('@ 0x00000036')).toBeVisible();
  });

  test('ZIP: data jump selects exactly the stored data; descriptor is unavailable without flag bit 3', async ({ page }) => {
    const { bytes, layout } = buildZip([
      { name: 'first.txt', data: 'hello' },
      { name: 'second.txt', data: 'a longer second payload' },
      { name: 'third.txt', data: 'xyz' },
    ]);
    await openBytes(page, 'a.zip', bytes);
    await expectParsed(page);
    await expect(page.getByLabel('Format', { exact: true })).toHaveValue('zip');

    // The tree is virtualized: walk it with the keyboard so the target rows are selected and therefore rendered.
    await revealRow(page, 'entries');
    await page.keyboard.press('ArrowRight'); // expand entries
    await revealRow(page, 'entries[1]');
    await page.keyboard.press('ArrowRight'); // expand entries[1]
    await expect(treeRow(page, 'entries[1]')).toHaveAttribute('aria-expanded', 'true');
    const header = await revealRow(page, 'local_header');

    const e = layout.entries[1]!;
    const last = e.data + e.dataLen - 1;
    await header.getByRole('button', { name: /Jump to data of/ }).click();
    await expectSelection(page, e.data, e.dataLen);
    await expect(statusBar(page)).toContainText(`End: ${hex(last)} (${last})`);

    await header.getByRole('button', { name: /Jump to descriptor of/ }).click();
    await expect(page.getByRole('alert').filter({ hasText: '"descriptor" is not available' })).toBeVisible();
  });

  test('Go to offset (hex) and Ctrl+Home / Ctrl+End', async ({ page }) => {
    await openBytes(page, 'blob.bin', Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff));
    const goto = page.getByRole('textbox', { name: 'Go to offset' });
    await goto.fill('1F4');
    await goto.press('Enter');
    await expectSelection(page, 0x1f4, 1);
    await expect(hexByte(page, 0x1f4)).toHaveClass(/sel/);

    await hexView(page).focus();
    await page.keyboard.press('Control+End');
    // Ctrl+End lands on the append slot just past the last byte (editing is always on), so the caret is at offset == size.
    await expect(statusBar(page)).toContainText('Start: 0x3E8 (1000)');
    await expect(hexByte(page, 999)).toBeVisible();
    await page.keyboard.press('Control+Home');
    await expect(statusBar(page)).toContainText('Start: 0x0 (0)');
    await expect(hexByte(page, 0)).toBeVisible();
  });

  test('editing: typing marks the document modified, Ctrl+Z undoes, Insert toggles the mode', async ({ page }) => {
    await openBytes(page, 'blob.bin', Uint8Array.from({ length: 64 }, (_, i) => i));
    await expect(page).toHaveTitle('blob.bin — Binary Viewer');
    await expect(statusBar(page)).toContainText('Overwrite');

    await hexByte(page, 4).click();
    await page.keyboard.type('FE');
    await expect(hexByte(page, 4)).toHaveText('FE');
    await expect(page).toHaveTitle('• blob.bin — Binary Viewer');
    await expect(page.getByLabel('Modified')).toBeVisible();

    await page.keyboard.press('Control+z');
    await expect(hexByte(page, 4)).toHaveText('04');
    await expect(page).toHaveTitle('blob.bin — Binary Viewer');

    await page.keyboard.press('Insert');
    await expect(statusBar(page)).toContainText('Insert');
    await page.keyboard.press('Insert');
    await expect(statusBar(page)).toContainText('Overwrite');
  });

  test('large file: 64 MiB opens and Ctrl+End shows the last row', async ({ page }) => {
    test.setTimeout(90_000);
    const size = 64 * 1024 * 1024;
    const big = new Uint8Array(size);
    big[size - 1] = 0xee;
    await openLargeFile(page, 'big.bin', big);
    await expect(page.getByText(`${size.toLocaleString('en-US')} bytes`)).toBeVisible();
    await hexByte(page, 0).click();
    await page.keyboard.press('Control+End');
    await expect(hexByte(page, size - 1)).toHaveText('EE');
    // 64 MiB is a multiple of 16, so the append slot (offset == size) opens one more row after the last data row.
    const offsets = page.locator('.row .off');
    await expect(offsets.last()).toHaveText(size.toString(16).toUpperCase().padStart(8, '0'));
    await expect(offsets.filter({ hasText: (size - 16).toString(16).toUpperCase().padStart(8, '0') })).toBeVisible();
    await expect(hexByte(page, 0)).toHaveCount(0); // scrolled away from the top
    await expect(statusBar(page)).toContainText(`Start: ${hex(size)} (${size})`);
  });
});

test.describe('saving', () => {
  test('without the File System Access API, Save downloads the edited bytes', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      delete w.showSaveFilePicker;
      delete w.showOpenFilePicker;
    });
    await gotoApp(page);
    await openBytes(page, 'blob.bin', Uint8Array.from({ length: 32 }, (_, i) => i));
    await hexByte(page, 2).click();
    await page.keyboard.type('EE');
    await expect(page).toHaveTitle('• blob.bin — Binary Viewer');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const d = await download;
    expect(d.suggestedFilename()).toBe('blob.bin');
    const saved = await readFile((await d.path())!);
    expect(saved.length).toBe(32);
    expect(saved[2]).toBe(0xee);
    expect(saved[3]).toBe(3);
    await expect(page).toHaveTitle('blob.bin — Binary Viewer');
    await expect(page.getByText(/Download started/)).toBeVisible();
  });

  test('Save As through a stubbed File System Access picker writes the edit', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'showSaveFilePicker exists only in Chromium; the picker is stubbed here, so no real file dialog is involved');
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      const written: Blob[] = [];
      w.__written = written;
      w.showSaveFilePicker = async () => ({
        name: 'out.bin',
        getFile: async () => new File(written, 'out.bin'),
        createWritable: async () => {
          written.length = 0;
          return {
            write: async (d: Blob | Uint8Array) => void written.push(d instanceof Blob ? d : new Blob([d as BlobPart])),
            close: async () => {},
          };
        },
      });
    });
    await gotoApp(page);
    await openBytes(page, 'blob.bin', Uint8Array.from({ length: 32 }, (_, i) => i));
    await hexByte(page, 1).click();
    await page.keyboard.type('CD');
    await page.getByRole('button', { name: 'Save As…' }).click();
    await expect(page).toHaveTitle('out.bin — Binary Viewer');
    const bytes = await page.evaluate(async () => {
      const parts = (window as unknown as { __written: Blob[] }).__written;
      return [...new Uint8Array(await new Blob(parts).arrayBuffer())];
    });
    expect(bytes).toHaveLength(32);
    expect(bytes[1]).toBe(0xcd);
    expect(bytes[2]).toBe(2);
  });
});

test.describe('About dialog', () => {
  for (const [label, name] of [
    ['brand button', 'About Binary Viewer'],
    ['? button', 'About'],
  ] as const) {
    test(`opens from the ${label}, shows the version, closes with Escape and restores focus`, async ({ page }) => {
      await gotoApp(page);
      const opener = page.getByRole('button', { name, exact: true });
      await opener.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/Version /)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
    });
  }
});
