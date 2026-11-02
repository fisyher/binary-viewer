import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { buildZip } from '../src/test/zip-builder';
import { expect, expectParsed, expectSelection, gotoApp, hex, hexByte, hexView, makeBmp, minimap, openBytes, openLargeFile, revealRow, statusBar, test, treeRow, viewTop } from './fixtures';

test.describe('viewer', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test('start screen shows the title, tagline, built-in formats and opens the Formats side bar', async ({ page }) => {
    await expect(page).toHaveTitle('Binary Viewer');
    await expect(page.getByText('Hex editor and binary format inspector')).toBeVisible();
    const welcome = page.getByRole('tabpanel', { name: 'Welcome' });
    await expect(welcome.getByRole('heading', { name: 'Built-in formats' })).toBeVisible();
    await expect(welcome.getByText('Windows Bitmap')).toBeVisible();
    await expect(welcome.getByText(/^ZIP/)).toBeVisible();
    const activity = page.getByRole('navigation', { name: 'Activity bar' });
    await expect(activity.getByRole('button', { name: 'Structure' })).toHaveAttribute('aria-pressed', 'true');
    await expect(activity.getByRole('button', { name: 'Formats' })).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Browse formats' }).click();
    await expect(activity.getByRole('button', { name: 'Formats' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: 'Format library' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Windows Bitmap' })).toBeVisible();
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
    await expect(statusBar(page).getByRole('button', { name: /^Format: ZIP Archive/ })).toBeVisible();

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

  for (const clip of ['top', 'bottom'] as const) {
    test(`structure tree: double-clicking a row that is half clipped at the ${clip} toggles that row only`, async ({ page }) => {
      const { bytes } = buildZip(Array.from({ length: 60 }, (_, i) => ({ name: `f${i}.txt`, data: `data ${i}` })));
      await openBytes(page, 'many.zip', bytes);
      await expectParsed(page);
      await revealRow(page, 'entries');
      await page.keyboard.press('ArrowRight'); // expand entries: many expandable entries[i] rows
      const tree = page.getByRole('tree', { name: 'Structure' });
      await tree.evaluate((el) => (el.scrollTop += 15 * 24)); // bring the entries[i] rows into the window (rows are 24px)
      await expect(treeRow(page, 'entries[3]')).toBeVisible();

      // Scroll so that the entry is cut by 12 px (half a row) at the ${clip} edge of the tree; row positions come from the layout.
      const key = await tree.evaluate((el, edge) => {
        const rows = [...el.querySelectorAll<HTMLElement>('[role="treeitem"][aria-expanded="false"]')];
        const box = el.getBoundingClientRect();
        const pick = rows.filter((r) => (r.querySelector('.nm')?.textContent ?? '').startsWith('entries[')).find((r) => {
          const b = r.getBoundingClientRect();
          return edge === 'top' ? b.top > box.top + 72 && b.bottom < box.bottom - 72 : b.top > box.top + 72 && b.bottom < box.bottom - 24;
        });
        if (!pick) throw new Error('no suitable entries[i] row in the window');
        const b = pick.getBoundingClientRect();
        // content offset of the row's top edge, then shift so that 12 px of it are outside the viewport
        const contentTop = b.top - box.top + el.scrollTop;
        el.scrollTop = edge === 'top' ? contentTop + 12 : contentTop + 12 - el.clientHeight;
        return pick.getAttribute('data-key')!;
      }, clip);
      const target = page.locator(`[role="treeitem"][data-key="${key}"]`);
      await expect(target).toHaveAttribute('aria-expanded', 'false');
      const scrolled = await tree.evaluate((el) => el.scrollTop);
      const before = await tree.evaluate((el) => [...el.querySelectorAll('[role="treeitem"]')].map((r) => [r.getAttribute('data-key'), r.getAttribute('aria-expanded')]));

      const pt = await tree.evaluate((el, [k, edge]) => {
        const b = el.querySelector(`[data-key="${k}"]`)!.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const clipped = edge === 'top' ? box.top - b.top : b.bottom - box.bottom;
        return { x: b.left + 95, y: edge === 'top' ? b.bottom - 4 : b.top + 4, clipped }; // in the name column, right of the 24px twisty
      }, [key, clip] as const);
      expect(Math.round(pt.clipped)).toBe(12);
      await page.mouse.dblclick(pt.x, pt.y);

      await expect(target).toHaveAttribute('aria-expanded', 'true');
      await expect(target).toHaveAttribute('aria-selected', 'true');
      expect(await tree.evaluate((el) => el.scrollTop), 'a pointer click must not scroll the tree').toBe(scrolled);
      const after = await tree.evaluate((el) => Object.fromEntries([...el.querySelectorAll('[role="treeitem"]')].map((r) => [r.getAttribute('data-key'), r.getAttribute('aria-expanded')])));
      for (const [k, v] of before) if (k && k !== key && k in after) expect(after[k], `row ${k}`).toBe(v);
    });
  }

  test('structure tree: a double-click on an "open" row acts on that row, not on the row that moves under the pointer', async ({ page }) => {
    const { bytes } = buildZip([{ name: 'first.txt', data: 'hello' }, { name: 'second.txt', data: 'world' }]);
    await openBytes(page, 'a.zip', bytes);
    await expectParsed(page);
    await revealRow(page, 'entries');
    await page.keyboard.press('ArrowRight');
    await revealRow(page, 'entries[0]');
    await page.keyboard.press('ArrowRight');
    const header = await revealRow(page, 'local_header');
    await page.keyboard.press('ArrowRight'); // expand the reference: its child is the "open ..." row
    const open = page.locator('[role="treeitem"][data-ref]');
    await expect(open).toHaveCount(1);
    await open.scrollIntoViewIfNeeded();
    const box = (await open.boundingBox())!;
    const x = box.x + 60;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down({ clickCount: 1 });
    await page.mouse.up({ clickCount: 1 });
    await expect(open).toHaveCount(0); // opened: the target now sits where the row was, expanded
    const underPointer = () => page.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.closest('[role="treeitem"]')?.getAttribute('aria-expanded'), [x, y]);
    await expect.poll(underPointer).toBe('true');
    // The second click of the double-click lands on the row that replaced the "open" row; it must not collapse it.
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.up({ clickCount: 2 });
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(await underPointer()).toBe('true');
  });

  test('structure tree: keyboard focus stays in the tree while the active row scrolls out of the window', async ({ page }) => {
    const { bytes } = buildZip(Array.from({ length: 60 }, (_, i) => ({ name: `f${i}.txt`, data: `data ${i}` })));
    await openBytes(page, 'many.zip', bytes);
    await expectParsed(page);
    const tree = page.getByRole('tree', { name: 'Structure' });
    await revealRow(page, 'entries');
    await treeRow(page, 'entries').click(); // a clicked row must not keep the focus: it unmounts when it scrolls out of the window
    await expect(tree).toBeFocused();
    await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press(i % 3 === 0 ? 'ArrowRight' : 'ArrowDown');
      await expect(tree).toBeFocused();
    }
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

test.describe('structure minimap', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  const bandCount = async (page: Page) => Number(await minimap(page).getAttribute('data-structured-bands'));

  test('BMP: the strip shows the header and pixel regions; a click near the bottom scrolls the hex view there', async ({ page }) => {
    const pixels = 20_000;
    await openBytes(page, 'pic.bmp', makeBmp(pixels));
    await expectParsed(page);
    const strip = minimap(page);
    await expect(strip).toBeVisible();
    await expect(strip).toHaveAttribute('aria-controls', 'hex-grid');
    await expect(strip).toHaveAttribute('aria-orientation', 'vertical');
    await expect.poll(() => bandCount(page)).toBeGreaterThanOrEqual(2);
    await expect(strip).toHaveAttribute('data-groups', /^(1,)?2,4$/); // the 14-byte file header may be a sliver of the first bucket
    // The 14-byte file header and the 40-byte DIB header are far under a pixel tall here, yet drawn as 2px marks.
    await expect(strip).toHaveAttribute('data-region-marks', /^[2-9]$/);
    expect(await viewTop(page)).toBe(0);

    const box = (await strip.boundingBox())!;
    // The very bottom edge, with the Problems panel (and its resizer's wider hit area) open right below the strip.
    await strip.click({ position: { x: box.width / 2, y: box.height - 1 } });
    const size = 54 + pixels;
    await expect.poll(() => viewTop(page)).toBeGreaterThan(size * 0.5);
    await expect(hexByte(page, size - 1)).toBeVisible(); // the very bottom of the strip is the last byte
    await strip.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await expect(hexByte(page, Math.floor(size / 2))).toBeVisible();
    await expect(hexByte(page, 0)).toHaveCount(0);
  });

  test('a pointer click focuses the strip without a keyboard focus ring, and the keys then work', async ({ page }) => {
    await openBytes(page, 'pic.bmp', makeBmp(20_000));
    await expectParsed(page);
    const strip = minimap(page);
    const box = (await strip.boundingBox())!;
    await strip.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await expect(strip).toBeFocused();
    expect(await strip.evaluate((el) => el.matches(':focus-visible'))).toBe(false);
    await page.keyboard.press('Home');
    await expect.poll(() => viewTop(page)).toBe(0);
    await page.keyboard.press('Tab'); // leave, then come back with the keyboard: the ring shows
    await page.keyboard.press('Shift+Tab');
    await expect(strip).toBeFocused();
    expect(await strip.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
  });

  test('ZIP with many entries: structure bands for the entries and the central directory; keyboard scrolls', async ({ page }) => {
    const { bytes } = buildZip(Array.from({ length: 60 }, (_, i) => ({ name: `f${i}.txt`, data: `data ${i}` })));
    await openBytes(page, 'many.zip', bytes);
    await expectParsed(page);
    const strip = minimap(page);
    await expect.poll(() => bandCount(page)).toBeGreaterThanOrEqual(2);
    await strip.focus();
    await page.keyboard.press('End');
    await expect(hexByte(page, bytes.length - 1)).toBeVisible();
    expect(await viewTop(page)).toBeGreaterThan(0);
    await page.keyboard.press('Home');
    await expect.poll(() => viewTop(page)).toBe(0);
    await page.keyboard.press('PageDown');
    await expect.poll(() => viewTop(page)).toBeGreaterThan(0);
    await expect(hexByte(page, 0)).toHaveCount(0);
  });

  test('a file with no parsed format still shows the strip, without structure bands', async ({ page }) => {
    await openBytes(page, 'blob.bin', Uint8Array.from({ length: 4000 }, (_, i) => i & 0xff));
    await expect(minimap(page)).toBeVisible();
    await expect.poll(() => bandCount(page)).toBe(0);
    const box = (await minimap(page).boundingBox())!;
    await minimap(page).click({ position: { x: box.width / 2, y: box.height - 1 } });
    await expect(hexByte(page, 3999)).toBeVisible();
  });

  test('the strip is hidden on a narrow viewport', async ({ page }) => {
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expect(minimap(page)).toBeVisible();
    await page.setViewportSize({ width: 560, height: 800 });
    await expect(minimap(page)).toBeHidden();
  });

  test('large file: a 64 MiB file gets a strip and a click near the bottom shows the end of the file', async ({ page }) => {
    test.setTimeout(90_000);
    const size = 64 * 1024 * 1024;
    await openLargeFile(page, 'big.bin', new Uint8Array(size));
    const strip = minimap(page);
    await expect(strip).toBeVisible();
    const box = (await strip.boundingBox())!;
    await strip.click({ position: { x: box.width / 2, y: box.height - 1 } });
    await expect.poll(() => viewTop(page)).toBeGreaterThan(size * 0.9);
    const top = await viewTop(page);
    expect(top).toBeGreaterThan(size * 0.97);
    await expect(hexByte(page, top + 16 * 5)).toBeVisible(); // the rows the strip reports are the rows the grid shows
    await expect(hexByte(page, 0)).toHaveCount(0);
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

const editorTabs = (page: Page) => page.getByRole('tablist', { name: 'Editors' }).getByRole('tab');

test.describe('shell', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test('opening a spec from the Formats side bar opens a spec tab; closing it returns to the file', async ({ page }) => {
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expectParsed(page);
    const fileTab = page.getByRole('tab', { name: 'pic.bmp' });
    await expect(fileTab).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('button', { name: 'Formats', exact: true }).click();
    await page.getByRole('button', { name: /^Windows Bitmap/ }).click();
    const specTab = page.getByRole('tab', { name: 'Windows Bitmap' });
    await expect(specTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Windows Bitmap' })).toBeVisible();
    await expect(page.getByLabel('Spec JSON')).toBeVisible();
    await expect(hexView(page)).toBeHidden(); // the file tab is not the active editor

    await page.getByRole('button', { name: 'Close Windows Bitmap' }).click();
    await expect(specTab).toHaveCount(0);
    await expect(fileTab).toHaveAttribute('aria-selected', 'true');
    await expect(hexView(page)).toBeVisible();
    await expect(hexByte(page, 0)).toHaveText('42');
  });

  test('several spec tabs: edits stay per tab, a modified dot shows, closing a modified tab asks first', async ({ page }) => {
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expectParsed(page);
    await page.getByRole('button', { name: 'Formats', exact: true }).click();
    await page.getByRole('button', { name: /^Windows Bitmap/ }).click();
    await page.getByRole('button', { name: 'Duplicate', exact: true }).click(); // an editable copy opens in its own tab
    const copyTab = page.getByRole('tab', { name: /^Windows Bitmap \(copy\)/ });
    await expect(copyTab).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: /^ZIP Archive/ }).click();
    const zipTab = page.getByRole('tab', { name: 'ZIP Archive', exact: true });
    await expect(zipTab).toHaveAttribute('aria-selected', 'true');
    // original, copy, zip: three spec tabs next to the file tab
    await expect(editorTabs(page)).toHaveCount(4);

    await copyTab.click();
    const area = page.getByLabel('Spec JSON');
    const original = await area.inputValue();
    await area.fill(original.replace('(copy)', '(copy) edited'));
    await expect(copyTab.getByLabel('Modified')).toBeVisible();
    await expect(zipTab.getByLabel('Modified')).toHaveCount(0);

    await zipTab.click();
    await expect(page.getByLabel('Spec JSON')).not.toHaveValue(/\(copy\) edited/);
    await copyTab.click();
    await expect(page.getByLabel('Spec JSON')).toHaveValue(original.replace('(copy)', '(copy) edited')); // the text survived the switch
    await expect(copyTab.getByLabel('Modified')).toBeVisible();

    await page.getByRole('button', { name: /^Close Windows Bitmap \(copy\)/ }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('has unsaved changes. Discard them?');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(copyTab).toBeVisible();
    await page.getByRole('button', { name: /^Close Windows Bitmap \(copy\)/ }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click();
    await expect(copyTab).toHaveCount(0);
    await expect(editorTabs(page)).toHaveCount(3);
    await expect(zipTab).toHaveAttribute('aria-selected', 'true'); // the right neighbour took over
  });

  test('the Structure side bar tree stays usable while a spec tab with a running preview is active', async ({ page }) => {
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expectParsed(page);
    await page.getByRole('button', { name: 'Formats', exact: true }).click();
    await page.getByRole('button', { name: /^Windows Bitmap/ }).click();
    const preview = page.locator('section.preview');
    await expect(preview.getByRole('status').filter({ hasText: /^Parsed: \d+ nodes/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Windows Bitmap', exact: true })).toHaveAttribute('aria-selected', 'true');

    // The viewer's own tree (side bar) is live: no "paused" note, rows can be selected and the hex selection follows.
    await page.getByRole('button', { name: 'Structure', exact: true }).click();
    await expect(page.getByText('Paused while a format preview is running')).toHaveCount(0);
    const viewerRow = page.locator('.tree-wrap').getByRole('treeitem').filter({ has: page.locator('.nm', { hasText: /^file_header$/ }) });
    await viewerRow.click();
    await expectSelection(page, 0, 14);
    await expect(statusBar(page)).toContainText('End: 0xD (13)');
    // Still on the spec tab, and its preview is still there.
    await expect(page.getByRole('tab', { name: 'Windows Bitmap', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(preview.getByRole('status').filter({ hasText: /^Parsed: \d+ nodes/ })).toBeVisible();
    await page.getByRole('tab', { name: 'pic.bmp' }).click();
    await expect(hexByte(page, 0)).toBeVisible();
    await expect(page.locator('.hex .b.sel[data-o="13"]')).toBeVisible();
  });

  test('the theme button cycles System, Light and Dark, sets data-theme and is remembered', async ({ page }) => {
    const html = page.locator('html');
    const theme = page.getByRole('button', { name: /^Theme:/ });
    const ground = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await expect(theme).toHaveAccessibleName('Theme: System');
    await expect(html).not.toHaveAttribute('data-theme', /.*/);

    await theme.click();
    await expect(theme).toHaveAccessibleName('Theme: Light');
    await expect(html).toHaveAttribute('data-theme', 'light');
    expect(await ground()).toBe('rgb(251, 251, 252)');

    await theme.click();
    await expect(theme).toHaveAccessibleName('Theme: Dark');
    await expect(html).toHaveAttribute('data-theme', 'dark');
    expect(await ground()).toBe('rgb(26, 30, 38)');

    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark'); // applied before the app mounts
    await expect(page.getByRole('button', { name: 'Theme: Dark' })).toBeVisible();

    await page.getByRole('button', { name: 'Theme: Dark' }).click();
    await expect(page.getByRole('button', { name: 'Theme: System' })).toBeVisible();
    await expect(html).not.toHaveAttribute('data-theme', /.*/);
  });

  test('panels collapse and come back, and the layout is remembered', async ({ page }) => {
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expectParsed(page);
    const inspector = page.getByRole('complementary', { name: 'Data inspector' });
    const tree = page.getByRole('tree', { name: 'Structure' });
    const problems = page.getByRole('region', { name: 'Problems' });
    await expect(inspector).toBeVisible();
    await expect(tree).toBeVisible();
    await expect(problems).toBeVisible();

    await page.getByRole('button', { name: 'Hide data inspector' }).click();
    await expect(inspector).toBeHidden();
    await page.getByRole('button', { name: 'Show data inspector' }).click();
    await expect(inspector).toBeVisible();

    const activityStructure = page.getByRole('navigation', { name: 'Activity bar' }).getByRole('button', { name: 'Structure' });
    await activityStructure.click(); // the active item collapses the side bar
    await expect(tree).toBeHidden();
    await expect(activityStructure).toHaveAttribute('aria-pressed', 'false');
    await activityStructure.click();
    await expect(tree).toBeVisible();

    await page.getByRole('button', { name: 'Hide problems panel' }).click();
    await expect(problems).toBeHidden();
    await page.getByRole('button', { name: 'Show problems panel' }).click();
    await expect(problems).toBeVisible();

    // resize with the keyboard, then collapse the inspector and reload: both are remembered
    const sep = page.getByRole('separator', { name: 'Resize side bar' });
    await sep.focus();
    await expect(sep).toHaveAttribute('aria-valuenow', '300');
    await page.keyboard.press('ArrowRight');
    await expect(sep).toHaveAttribute('aria-valuenow', '316');
    await page.getByRole('button', { name: 'Hide data inspector' }).click();
    await page.reload();
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expect(page.getByRole('separator', { name: 'Resize side bar' })).toHaveAttribute('aria-valuenow', '316');
    await expect(page.getByRole('complementary', { name: 'Data inspector' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Show data inspector' })).toBeVisible();
  });
});
test.describe('narrow screens', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the side bar is a drawer with a scrim; the scrim and Escape close it; the page does not scroll sideways', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expectParsed(page);
    const tree = page.getByRole('tree', { name: 'Structure' });
    const structure = page.getByRole('navigation', { name: 'Activity bar' }).getByRole('button', { name: 'Structure' });
    await expect(tree).toBeHidden(); // starts collapsed

    await structure.click();
    await expect(tree).toBeVisible();
    const scrim = page.getByRole('button', { name: 'Close panel' });
    await expect(scrim).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await scrim.click({ position: { x: 320, y: 400 } }); // right of the drawer
    await expect(tree).toBeHidden();
    await expect(scrim).toHaveCount(0);

    await structure.click();
    await expect(tree).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tree).toBeHidden();

    // the inspector is a drawer too
    await page.getByRole('button', { name: 'Show data inspector' }).click();
    await expect(page.getByRole('complementary', { name: 'Data inspector' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('complementary', { name: 'Data inspector' })).toBeHidden();
  });
});

test.describe('command palette', () => {
  // The dialog is named after its mode ("Command palette", "Go to offset", ...), so find it by its input.
  const box = (page: Page) => page.getByRole('dialog').getByRole('combobox');
  const dialog = (page: Page) => page.getByRole('dialog').filter({ has: page.getByRole('combobox') });

  /** Records, for every later key press, whether the page called preventDefault. This listener is added after the app's own, so it runs after it. */
  async function watchKeys(page: Page): Promise<() => Promise<Array<{ key: string; prevented: boolean }>>> {
    await page.evaluate(() => {
      const seen: Array<{ key: string; prevented: boolean }> = [];
      (window as unknown as { __seen: typeof seen }).__seen = seen;
      window.addEventListener('keydown', (e) => seen.push({ key: e.key, prevented: e.defaultPrevented }));
    });
    return () => page.evaluate(() => (window as unknown as { __seen: Array<{ key: string; prevented: boolean }> }).__seen);
  }

  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test('Ctrl+K and F1 reach the page, are prevented (no browser UI) and open the palette', async ({ page }) => {
    const seen = await watchKeys(page);
    for (const key of ['Control+k', 'F1']) {
      await page.keyboard.press(key);
      await expect(dialog(page)).toBeVisible();
      await expect(box(page)).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toBeHidden();
    }
    const keys = (await seen()).filter((k) => k.key === 'k' || k.key === 'F1');
    expect(keys).toEqual([
      { key: 'k', prevented: true },
      { key: 'F1', prevented: true },
    ]);
  });

  test('Ctrl+K also works from inside the hex grid and Ctrl+S does not leave the page to the browser', async ({ page }) => {
    await openBytes(page, 'a.bin', Uint8Array.from({ length: 64 }, (_, i) => i));
    const seen = await watchKeys(page);
    await hexByte(page, 3).click();
    await page.keyboard.press('Control+k');
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(hexView(page)).toBeFocused();
    await expect(statusBar(page)).toContainText('Start: 0x3 (3)'); // the keys did not edit or move anything
    expect((await seen()).find((k) => k.key === 'k')).toEqual({ key: 'k', prevented: true });
  });

  test('Ctrl+S without a file is claimed by the page (no Save page dialog)', async ({ page }) => {
    const seen = await watchKeys(page);
    await page.keyboard.press('Control+s');
    expect((await seen()).find((k) => k.key === 's')).toEqual({ key: 's', prevented: true });
    await expect(dialog(page)).toBeHidden();
  });

  test('the Search commands field opens it', async ({ page }) => {
    await page.getByRole('button', { name: 'Search commands (Ctrl+K)' }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole('option').first()).toBeVisible();
  });

  test('typing "minimap" and Enter hides the minimap, and again shows it', async ({ page }) => {
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expectParsed(page);
    await expect(minimap(page)).toBeVisible();
    await page.keyboard.press('Control+k');
    await box(page).fill('minimap');
    await expect(dialog(page).getByRole('option')).toHaveText([/Hide minimap/]);
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeHidden();
    await expect(minimap(page)).toHaveCount(0);

    await page.keyboard.press('F1');
    await box(page).fill('minimap');
    await expect(dialog(page).getByRole('option')).toHaveText([/Show minimap/]);
    await page.keyboard.press('Enter');
    await expect(minimap(page)).toBeVisible();
  });

  test('Go to offset: "go", Enter, 1F4, Enter selects that byte', async ({ page }) => {
    await openBytes(page, 'big.bin', Uint8Array.from({ length: 2048 }, (_, i) => i & 0xff));
    await page.keyboard.press('Control+k');
    await box(page).fill('go');
    await expect(dialog(page).getByRole('option').first()).toContainText('Go to offset');
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toHaveAccessibleName('Go to offset');
    await expect(box(page)).toBeFocused();
    await box(page).fill('99999');
    await page.keyboard.press('Enter');
    await expect(dialog(page).getByRole('alert')).toContainText('Out of range');
    await box(page).fill('1F4');
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeHidden();
    await expect(statusBar(page)).toContainText('Start: 0x1F4 (500)');
    await expect(hexByte(page, 500)).toBeVisible();
    await expect(hexView(page)).toBeFocused();
  });

  test('Escape closes it and focus returns to the element that had it', async ({ page }) => {
    await openBytes(page, 'a.bin', new Uint8Array(32));
    const activity = page.getByRole('navigation', { name: 'Activity bar' }).getByRole('button', { name: 'Formats' });
    await activity.focus();
    await page.keyboard.press('Control+k');
    await expect(box(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(activity).toBeFocused();
  });

  test('the background is inert while it is open, and a click outside closes it', async ({ page }) => {
    await page.keyboard.press('Control+k');
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator('.app')).toHaveAttribute('inert', '');
    await page.mouse.click(5, 400);
    await expect(dialog(page)).toBeHidden();
    await expect(page.locator('.app')).not.toHaveAttribute('inert', '');
  });

  test('About Binary Viewer from the palette', async ({ page }) => {
    await page.keyboard.press('F1');
    await box(page).fill('about');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: /^Binary Viewer$/ })).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('Choose format switches the parse', async ({ page }) => {
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expectParsed(page);
    await page.keyboard.press('Control+k');
    await box(page).fill('choose format');
    await page.keyboard.press('Enter');
    await expect(dialog(page).getByRole('option', { name: /None \(raw\)/ })).toBeVisible();
    await dialog(page).getByRole('option', { name: /None \(raw\)/ }).click();
    await expect(statusBar(page).getByRole('button', { name: 'Format: No format. Choose format' })).toBeVisible();
  });
});

test.describe('command palette: held keys', () => {
  test('holding F1 or Ctrl+K opens it once and does not flicker it shut', async ({ page }) => {
    await gotoApp(page);
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('combobox') });
    await page.keyboard.down('F1');
    await page.keyboard.down('F1'); // auto-repeat
    await page.keyboard.down('F1');
    await page.keyboard.up('F1');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.keyboard.down('Control');
    await page.keyboard.down('k');
    await page.keyboard.down('k');
    await page.keyboard.down('k');
    await page.keyboard.up('k');
    await page.keyboard.up('Control');
    await expect(dialog).toBeVisible();
  });
});

test.describe('UX refinement', () => {
  const box = async (locator: import('@playwright/test').Locator) => {
    await expect(locator).toBeVisible();
    const b = await locator.boundingBox();
    expect(b, 'bounding box').not.toBeNull();
    return b!;
  };

  test('the tree twisty and the jump button are at least 24 x 24 CSS px, and the rows are as tall', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expectParsed(page);
    const twisty = treeRow(page, 'file_header').locator('[data-twisty]');
    const t = await box(twisty);
    expect(t.width).toBeGreaterThanOrEqual(23.99); // fractional layout (Firefox) may land a hair under
    expect(t.height).toBeGreaterThanOrEqual(23.99);
    const jump = treeRow(page, 'off_bits').getByRole('button', { name: /Go to pixel data/ });
    const j = await box(jump);
    expect(j.width).toBeGreaterThanOrEqual(23.99);
    expect(j.height).toBeGreaterThanOrEqual(23.99);
    // the hit area of the twisty does not reach into the neighbouring row's
    const rows = await page.getByRole('treeitem').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).slice(0, 4));
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.top).toBeGreaterThanOrEqual(rows[i - 1]!.bottom - 0.5);
    expect(rows[0]!.height).toBeGreaterThanOrEqual(24);
  });

  test('buttons in the panels, the title bar and the status bar are at least 24px each way', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expectParsed(page);
    const buttons = [
      page.getByRole('button', { name: /^Byte order: / }), // the inspector
      page.getByRole('button', { name: 'Hide data inspector' }),
      page.getByRole('button', { name: 'Hide side bar' }),
      page.getByRole('button', { name: 'Hide problems panel' }),
      page.getByRole('button', { name: 'Problems', exact: true }),
      page.getByRole('button', { name: 'New', exact: true }),
      page.getByRole('button', { name: 'Open…' }),
      page.getByRole('button', { name: 'Search commands (Ctrl+K)' }),
      page.getByRole('button', { name: 'About', exact: true }),
    ];
    for (const b of buttons) {
      const r = await box(b);
      expect(r.width, String(b)).toBeGreaterThanOrEqual(23.99);
      expect(r.height, String(b)).toBeGreaterThanOrEqual(23.99);
    }
    // every button in the status bar fills the bar and is at least 24px wide
    const bar = statusBar(page);
    const barBox = await box(bar);
    const heights = await bar.locator('button').evaluateAll((els) => els.filter((e) => (e as HTMLButtonElement).offsetParent !== null).map((e) => e.getBoundingClientRect()));
    expect(heights.length).toBeGreaterThanOrEqual(5);
    for (const r of heights) {
      expect(r.width).toBeGreaterThanOrEqual(23.99);
      expect(r.height).toBeGreaterThanOrEqual(22);
      expect(r.height).toBeGreaterThanOrEqual(barBox.height - 2);
    }
  });

  test('the resizer has a 17px hit area around its 1px line', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(40));
    const sep = page.getByRole('separator', { name: 'Resize side bar' });
    const line = await box(sep);
    expect(line.width).toBeLessThanOrEqual(1.5);
    const hit = await sep.evaluate((el) => {
      const r = getComputedStyle(el, '::after');
      return { left: parseFloat(r.left), width: parseFloat(r.width) };
    });
    expect(hit.width).toBeGreaterThanOrEqual(16.5);
    // a press 7px from the line still grabs it
    const before = await page.getByRole('separator', { name: 'Resize side bar' }).getAttribute('aria-valuenow');
    await page.mouse.move(line.x + 0.5 + 7, line.y + 100);
    await page.mouse.down();
    await page.mouse.move(line.x + 0.5 + 47, line.y + 100);
    await page.mouse.up();
    expect(Number(await sep.getAttribute('aria-valuenow'))).toBeGreaterThan(Number(before));
  });

  test('F6 and Shift+F6 move through the regions in visual order', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expectParsed(page);
    const region = () => page.evaluate(() => document.activeElement?.closest('[data-region]')?.getAttribute('data-region') ?? null);
    await hexView(page).focus();
    const seen: Array<string | null> = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('F6');
      seen.push(await region());
    }
    expect(seen).toEqual(['bottom', 'inspector', 'status', 'activity', 'side', 'editor']);
    await page.keyboard.press('Shift+F6');
    expect(await region()).toBe('side');
    await page.keyboard.press('Shift+F6');
    expect(await region()).toBe('activity');
    // collapsed regions are skipped
    await page.getByRole('button', { name: 'Hide data inspector' }).click();
    await hexView(page).focus();
    await page.keyboard.press('F6');
    expect(await region()).toBe('bottom');
    await page.keyboard.press('F6');
    expect(await region()).toBe('status');
  });

  test('the breadcrumb follows hex clicks and keyboard moves, and a segment selects its node', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expectParsed(page);
    const nav = page.getByRole('navigation', { name: 'Structure path' });
    await expect(nav.getByRole('button')).toHaveText(['file']);
    await hexByte(page, 10).click(); // off_bits
    await expect(nav.getByRole('button')).toHaveText(['file', 'file_header', 'off_bits']);
    await expect(nav.getByRole('button', { name: 'off_bits' })).toHaveAttribute('aria-current', 'location');
    await expect(nav.getByRole('button', { name: 'off_bits' })).toHaveAttribute('title', /^off_bits : .+ @ 0xA \(size 4\)$/);
    await nav.getByRole('button', { name: 'file_header' }).click();
    await expectSelection(page, 0, 14);
    await expect(treeRow(page, 'file_header')).toHaveAttribute('aria-selected', 'true');
    await hexView(page).focus();
    for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowDown'); // 16 bytes each: into the DIB header
    await expect(nav.getByRole('button').nth(1)).toHaveText('dib', { timeout: 3000 });
  });

  test('the status bar holds the format, the parse summary and the actions', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expectParsed(page);
    const bar = statusBar(page);
    await expect(page.getByLabel('Format', { exact: true })).toHaveCount(0); // the old selector is gone
    await expect(bar.getByRole('button', { name: 'Format: Windows Bitmap. Choose format' })).toBeVisible();
    await expect(bar.getByRole('button', { name: /^Show problems: 0 errors/ })).toContainText(/\d+ nodes\s*·\s*0 errors\s*·\s*0 warnings/);
    // the summary opens and focuses Problems
    await page.getByRole('button', { name: 'Hide problems panel' }).click();
    await bar.getByRole('button', { name: /^Show problems/ }).click();
    await expect(page.getByRole('button', { name: 'Problems', exact: true })).toBeFocused();
    // the format button opens Choose format
    await bar.getByRole('button', { name: /^Format: / }).click();
    await expect(page.getByRole('dialog', { name: 'Choose format' })).toBeVisible();
    await page.getByRole('option', { name: /None \(raw\)/ }).click();
    await expect(bar.getByRole('button', { name: 'Format: No format. Choose format' })).toBeVisible();
    // the edit mode and the selection are actions
    await bar.getByRole('button', { name: 'Edit mode: Overwrite. Switch to insert' }).click();
    await expect(bar.getByRole('button', { name: 'Edit mode: Insert. Switch to overwrite' })).toBeVisible();
    await bar.getByRole('button', { name: /No selection/ }).click();
    await expect(page.getByRole('dialog', { name: 'Go to offset' })).toBeVisible();
  });

  test('the activity bar label shows on keyboard focus, and is not clipped by the side bar', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(40));
    const item = page.getByRole('navigation', { name: 'Activity bar' }).getByRole('button', { name: 'Formats' });
    const tip = item.locator('.tip');
    await expect(tip).toBeHidden();
    await page.keyboard.press('Tab'); // some control gets focus; walk to the activity bar with F6
    await page.getByRole('navigation', { name: 'Activity bar' }).getByRole('button', { name: 'Structure' }).focus();
    await page.keyboard.press('Tab');
    await expect(item).toBeFocused();
    await expect(tip).toBeVisible();
    await expect(tip).toHaveText('Formats');
    // it sits to the right of the bar, over the side bar; the bar clips nothing and stacks above the side bar
    const tb = await box(tip);
    const nav = page.getByRole('navigation', { name: 'Activity bar' });
    const nb = await box(nav);
    expect(tb.x).toBeGreaterThanOrEqual(nb.x + nb.width);
    const style = await nav.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { overflow: cs.overflow, z: Number(cs.zIndex), side: Number(getComputedStyle(document.querySelector('.side-slot')!).zIndex) || 0 };
    });
    expect(style.overflow).toBe('visible');
    expect(style.z).toBeGreaterThan(style.side);
  });

  test('the focus ring colour reaches 3:1 on the ground and chrome backgrounds in the light theme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await gotoApp(page);
    const ratio = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      const lum = (hexColor: string) => {
        const n = parseInt(hexColor.trim().slice(1), 16);
        const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
          const v = c / 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        }) as [number, number, number];
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const s = lum(css.getPropertyValue('--signal'));
      return ['--ground', '--chrome', '--chrome-deep'].map((n) => {
        const o = lum(css.getPropertyValue(n));
        return (Math.max(s, o) + 0.05) / (Math.min(s, o) + 0.05);
      });
    });
    for (const r of ratio) expect(r).toBeGreaterThanOrEqual(3);
  });

  test('the minimap tooltip names the region under the pointer', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(4000));
    await expectParsed(page);
    const strip = minimap(page);
    const b = await box(strip);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); // the middle of the file: the pixel data
    await expect(strip.locator('.tip')).toContainText(/^pixels · 0x[0-9A-F]{8}$/);
  });
});

test.describe('UX refinement 2', () => {
  const box = async (locator: import('@playwright/test').Locator) => {
    await expect(locator).toBeVisible();
    const b = await locator.boundingBox();
    expect(b, 'bounding box').not.toBeNull();
    return b!;
  };
  const palette = (page: Page) => page.getByRole('dialog').filter({ has: page.getByRole('combobox') });
  async function runCommand(page: Page, query: string) {
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').fill(query);
    await page.keyboard.press('Enter');
    await expect(palette(page)).toHaveCount(0);
  }
  /** Seed local storage and reload, so the page starts as a returning user's would. */
  async function startWith(page: Page, prefs: Record<string, string>) {
    await gotoApp(page);
    await page.evaluate((p) => {
      for (const [k, v] of Object.entries(p)) localStorage.setItem(k, v);
    }, prefs);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Binary Viewer', level: 1 })).toBeVisible();
  }

  // A file without a format: a click selects just the clicked byte (in a parsed file the structure takes the selection over).
  const ramp = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);

  // ---- A6: zoom ----
  for (const scale of ['0.9', '1.15', '1.3']) {
    test(`at ${Math.round(Number(scale) * 100)}% a click on a byte selects that byte, in the hex and the ASCII column`, async ({ page }) => {
      await startWith(page, { 'binaryviewer.uiScale': scale });
      await openBytes(page, 'ramp.bin', ramp(400));
      await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe(scale);
      await hexByte(page, 0x40).click();
      await expect(statusBar(page)).toContainText('Start: 0x40 (64)');
      await hexByte(page, 0x7b).click();
      await expect(statusBar(page)).toContainText('Start: 0x7B (123)');
      await page.locator('.ascii .c[data-o="100"]').click();
      await expect(statusBar(page)).toContainText('Start: 0x64 (100)');
      // the status bar says it is not 100%
      await expect(statusBar(page).getByRole('button', { name: /^Zoom: / })).toHaveText(`${Math.round(Number(scale) * 100)}%`);
    });
  }

  test('Ctrl+= zooms the interface (not the browser), Ctrl+0 resets, and a click still lands on the right byte at 115%', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'ramp.bin', ramp(400));
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    await page.keyboard.press('Control+Equal');
    await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('1.15');
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(dpr); // the page, not the browser, zoomed
    await expect(statusBar(page).getByRole('button', { name: 'Zoom: 115%. Reset to 100%' })).toBeVisible();
    await hexByte(page, 0x50).click();
    await expect(statusBar(page)).toContainText('Start: 0x50 (80)');
    await page.keyboard.press('Control+0');
    await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('');
    await expect(statusBar(page).getByRole('button', { name: /^Zoom: / })).toHaveCount(0);
    await hexByte(page, 0x50).click();
    await expect(statusBar(page)).toContainText('Start: 0x50 (80)');
    // Zoom in / out from the palette
    await runCommand(page, 'zoom out');
    await expect(statusBar(page).getByRole('button', { name: 'Zoom: 90%. Reset to 100%' })).toBeVisible();
    await statusBar(page).getByRole('button', { name: /^Zoom: / }).click();
    await expect(statusBar(page).getByRole('button', { name: /^Zoom: / })).toHaveCount(0);
  });

  for (const scale of ['0.9', '1.3']) {
    test(`at ${Math.round(Number(scale) * 100)}% the app still fills the window exactly (no scrollbars, status bar at the bottom)`, async ({ page }) => {
      await startWith(page, { 'binaryviewer.uiScale': scale });
      await openBytes(page, 'pic.bmp', makeBmp(400));
      const vh = page.viewportSize()!.height;
      const bar = await box(statusBar(page));
      expect(bar.y + bar.height).toBeGreaterThan(vh - 2);
      expect(bar.y + bar.height).toBeLessThanOrEqual(vh + 1);
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
    });
  }

  test('at 115% dragging a resizer moves it by the pointer distance (screen px over zoom)', async ({ page }) => {
    await startWith(page, { 'binaryviewer.uiScale': '1.15' });
    await openBytes(page, 'pic.bmp', makeBmp(40));
    const sep = page.getByRole('separator', { name: 'Resize side bar' });
    const before = Number(await sep.getAttribute('aria-valuenow'));
    const line = await box(sep);
    await page.mouse.move(line.x + 0.5, line.y + 100);
    await page.mouse.down();
    await page.mouse.move(line.x + 0.5 + 57.5, line.y + 100, { steps: 5 }); // 57.5 screen px = 50 CSS px at 115%
    await page.mouse.up();
    const after = Number(await sep.getAttribute('aria-valuenow'));
    expect(after - before).toBeGreaterThanOrEqual(48);
    expect(after - before).toBeLessThanOrEqual(52);
    // and the line followed the pointer
    const moved = await box(sep);
    expect(Math.abs(moved.x - (line.x + 57.5))).toBeLessThanOrEqual(3);
  });

  test('at 115% a click on the minimap seeks by the strip ratio, and its canvas has one pixel per screen pixel', async ({ page }) => {
    await startWith(page, { 'binaryviewer.uiScale': '1.15' });
    await openBytes(page, 'pic.bmp', makeBmp(20_000));
    await expectParsed(page);
    const strip = minimap(page);
    const b = await box(strip);
    const size = 54 + 20_000;
    await strip.click({ position: { x: b.width / 2, y: b.height / 2 } });
    await expect(hexByte(page, Math.floor(size / 2))).toBeVisible();
    const px = await strip.locator('canvas').evaluate((c) => ({ w: (c as HTMLCanvasElement).width, h: (c as HTMLCanvasElement).height, rect: c.getBoundingClientRect() }));
    expect(Math.abs(px.w - px.rect.width * (await page.evaluate(() => window.devicePixelRatio)))).toBeLessThanOrEqual(2);
    expect(Math.abs(px.h - px.rect.height * (await page.evaluate(() => window.devicePixelRatio)))).toBeLessThanOrEqual(2);
  });

  test('at 115% the tree still selects the clicked row and scrolls its window (virtualization)', async ({ page }) => {
    await startWith(page, { 'binaryviewer.uiScale': '1.15' });
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expectParsed(page);
    await treeRow(page, 'dib').click();
    await expectSelection(page, 14, 40);
  });

  // ---- B1: tree values and columns ----
  test('the tree column dividers resize Name and Value from the keyboard, are remembered, and double-click resets them', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expectParsed(page);
    const name = page.getByRole('separator', { name: 'Resize Name column' });
    const value = page.getByRole('separator', { name: 'Resize Value column' });
    await expect(name).toBeVisible();
    await name.focus();
    const w0 = Number(await name.getAttribute('aria-valuenow'));
    await page.keyboard.press('ArrowRight');
    await expect(name).toHaveAttribute('aria-valuenow', String(w0 + 16));
    // the rows follow: the Name cell is as wide as the divider says
    const cell = await treeRow(page, 'file_header').locator('.name').evaluate((el) => el.getBoundingClientRect().width);
    expect(Math.abs(cell - (w0 + 16))).toBeLessThanOrEqual(1.5);
    await value.focus();
    for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowLeft'); // far below the minimum
    await expect(value).toHaveAttribute('aria-valuenow', '60');
    await page.keyboard.press('Home');
    await expect(name).toHaveAttribute('aria-valuenow', String(w0 + 16));
    await page.reload();
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expect(page.getByRole('separator', { name: 'Resize Name column' })).toHaveAttribute('aria-valuenow', String(w0 + 16));
    await expect(page.getByRole('separator', { name: 'Resize Value column' })).toHaveAttribute('aria-valuenow', '60');
    await page.getByRole('separator', { name: 'Resize Name column' }).dblclick();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('binaryviewer.layout.treeNameWidth'))).toBeNull();
  });

  test('dragging a tree divider with the mouse changes the width and the minimum holds', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expectParsed(page);
    const name = page.getByRole('separator', { name: 'Resize Name column' });
    const b = await box(name);
    const w0 = Number(await name.getAttribute('aria-valuenow'));
    await page.mouse.move(b.x + 0.5, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 0.5 + 40, b.y + b.height / 2, { steps: 4 });
    await page.mouse.up();
    const w1 = Number(await name.getAttribute('aria-valuenow'));
    expect(w1 - w0).toBeGreaterThanOrEqual(38);
    expect(w1 - w0).toBeLessThanOrEqual(42);
    const b2 = await box(name);
    await page.mouse.move(b2.x + 0.5, b2.y + b2.height / 2);
    await page.mouse.down();
    await page.mouse.move(b2.x - 600, b2.y + b2.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect(name).toHaveAttribute('aria-valuenow', '80');
  });

  // ---- B5: motion ----
  test('the motion tokens are 120ms / 80ms, and 0ms with reduced motion', async ({ page }) => {
    await gotoApp(page);
    // the production build's CSS minifier may write 120ms as .12s: compare the durations, not the text
    const ms = (v: string) => (v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000);
    const tokens = () => page.evaluate(() => ['--motion-in', '--motion-out'].map((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim())).then((a) => a.map(ms));
    expect(await tokens()).toEqual([120, 80]);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await tokens()).toEqual([0, 0]);
  });

  test('the palette opens with a 120ms fade and 4px rise, and with none under reduced motion', async ({ page }) => {
    await gotoApp(page);
    const anim = async () => {
      await page.keyboard.press('Control+k');
      const panel = page.getByRole('dialog').filter({ has: page.getByRole('combobox') });
      await expect(panel).toBeVisible();
      const r = await panel.evaluate((el) => {
        const s = getComputedStyle(el);
        return { name: s.animationName, duration: s.animationDuration };
      });
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      return r;
    };
    const normal = await anim();
    expect(normal.name).toMatch(/palette-in/);
    expect(normal.duration).toBe('0.12s');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect((await anim()).duration).toBe('0s');
  });

  test('the hex grid, the minimap and the tree rows are never animated', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(400));
    await expectParsed(page);
    const animated = await page.evaluate(() => {
      const sel = ['[role="grid"]', '[role="grid"] *', '[role="scrollbar"]', '[role="scrollbar"] *', '[role="treeitem"]', '[role="tree"]'];
      return [...document.querySelectorAll(sel.join(','))].filter((el) => {
        const s = getComputedStyle(el);
        return s.animationName !== 'none' || s.transitionProperty.split(',').some((p) => p.trim() !== 'all' && p.trim() !== '') && parseFloat(s.transitionDuration) > 0;
      }).length;
    });
    expect(animated).toBe(0);
  });

  // ---- B6: reset layout ----
  test('Reset layout restores the default sizes and visibility and keeps the theme', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expectParsed(page);
    await page.getByRole('button', { name: /^Theme: / }).click(); // System -> Light
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    const sep = page.getByRole('separator', { name: 'Resize side bar' });
    await sep.focus();
    await page.keyboard.press('ArrowRight');
    await expect(sep).toHaveAttribute('aria-valuenow', '316');
    await page.getByRole('button', { name: 'Hide data inspector' }).click();
    await runCommand(page, 'minimap');
    await expect(minimap(page)).toHaveCount(0);
    await runCommand(page, 'reset layout');
    await expect(page.getByRole('separator', { name: 'Resize side bar' })).toHaveAttribute('aria-valuenow', '300');
    await expect(page.getByRole('complementary', { name: 'Data inspector' })).toBeVisible();
    await expect(minimap(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(theme);
  });

  test('a resizer has a context menu with one item, Reset layout: right-click or Shift+F10, Escape closes it and focus returns', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(40));
    const sep = page.getByRole('separator', { name: 'Resize side bar' });
    await sep.focus();
    await page.keyboard.press('ArrowRight');
    await expect(sep).toHaveAttribute('aria-valuenow', '316');
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveCount(1);
    await expect(menu.getByRole('menuitem', { name: 'Reset layout' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(sep).toBeFocused();
    // right click
    const b = await box(sep);
    await page.mouse.click(b.x + 0.5, b.y + 200, { button: 'right' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(sep).toHaveAttribute('aria-valuenow', '300');
    await expect(sep).toBeFocused();
    // the ContextMenu key too
    await page.keyboard.press('ContextMenu');
    await expect(menu).toBeVisible();
  });

  // ---- B7 / C2 / C3 ----
  test('the inspector says what to do: open a file, then click a byte or use Go to offset', async ({ page }) => {
    await gotoApp(page);
    const inspector = page.getByRole('complementary', { name: 'Data inspector' });
    await expect(inspector).toContainText('Open a file to inspect its bytes.');
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expect(inspector).toContainText('Click a byte, or press Ctrl+K and choose Go to offset.');
    await hexByte(page, 3).click();
    await expect(inspector).not.toContainText('Click a byte');
  });

  test('the title bar search field is about 240px wide and centred, shrinks, and is only an icon under 720px', async ({ page }) => {
    await gotoApp(page);
    const field = page.getByRole('button', { name: 'Search commands (Ctrl+K)' });
    await expect(field).toContainText('Search commands…');
    await expect(field.locator('kbd')).toHaveText('Ctrl K');
    const b = await box(field);
    expect(b.width).toBeGreaterThanOrEqual(235);
    expect(b.width).toBeLessThanOrEqual(241);
    const vw = page.viewportSize()!.width;
    expect(Math.abs(b.x + b.width / 2 - vw / 2)).toBeLessThanOrEqual(4);
    await page.setViewportSize({ width: 800, height: 700 });
    const mid = await box(field);
    expect(mid.width).toBeLessThanOrEqual(241);
    await expect(field.locator('kbd')).toBeVisible();
    await page.setViewportSize({ width: 700, height: 700 });
    await expect(field.locator('kbd')).toBeHidden();
    await expect(field.getByText('Search commands…')).toBeHidden();
    const icon = await box(field);
    expect(icon.width).toBeLessThanOrEqual(40);
    expect(icon.height).toBeGreaterThanOrEqual(24);
    await field.click();
    await expect(palette(page)).toBeVisible();
  });

  test('editor tabs have a type icon: a binary file, a BMP image once parsed, braces for a spec tab', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'x.bin', Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    await expect(page.getByRole('tab', { name: 'x.bin' }).locator('svg.icon')).toHaveAttribute('data-icon', 'file');
    await openBytes(page, 'pic.bmp', makeBmp(40));
    await expectParsed(page);
    await expect(page.getByRole('tab', { name: 'pic.bmp' }).locator('svg.icon')).toHaveAttribute('data-icon', 'bmp');
    await page.getByRole('navigation', { name: 'Activity bar' }).getByRole('button', { name: 'Formats' }).click();
    await runCommand(page, 'open spec windows');
    await expect(page.getByRole('tab').filter({ has: page.locator('svg.icon[data-icon="spec"]') })).toHaveCount(1);
    for (const svg of await page.locator('[role="tab"] svg.icon').all()) {
      await expect(svg).toHaveAttribute('aria-hidden', 'true');
      const s = await svg.boundingBox();
      expect(s!.width).toBeLessThanOrEqual(16);
    }
  });

  // ---- C4: banding ----
  test('hex banding: on by default, the band sits under the tints and the selection, "Toggle hex row banding" turns it off', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(400));
    await expectParsed(page);
    const hexCol = page.locator('.hex').first();
    const bg = () => hexCol.evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(await bg()).toMatch(/linear-gradient/);
    expect(await bg()).toMatch(/rgba?\(/);
    expect(await page.locator('.ascii').first().evaluate((el) => getComputedStyle(el).backgroundImage)).toMatch(/linear-gradient/);
    // a structure tint and the selection still paint their own, stronger background on the cell
    const tinted = await page.locator('.hex .b[data-t]').first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(tinted).toMatch(/rgba\(.*, 0\.\d+\)/);
    await hexByte(page, 0x60).click();
    expect(await hexByte(page, 0x60).evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/rgba\(.*, 0\.\d+\)/);
    // the band is the token, subtle but not absent, in both themes
    const band = (t: 'light' | 'dark') =>
      page.evaluate((theme) => {
        document.documentElement.setAttribute('data-theme', theme);
        const probe = document.createElement('div');
        probe.style.background = 'var(--band)';
        document.body.append(probe);
        const c = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return c;
      }, t);
    expect(await band('light')).toBe('rgba(31, 36, 48, 0.035)');
    expect(await band('dark')).toBe('rgba(214, 219, 228, 0.035)');
    await runCommand(page, 'banding');
    await expect.poll(bg).toBe('none');
    await page.reload();
    await openBytes(page, 'pic.bmp', makeBmp(400));
    expect(await page.locator('.hex').first().evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none'); // remembered
    await runCommand(page, 'banding');
    expect(await page.locator('.hex').first().evaluate((el) => getComputedStyle(el).backgroundImage)).toMatch(/linear-gradient/);
  });

  test('the band covers the second 8-byte group of the row: its edge is between byte 7 and byte 8', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(400));
    const edge = await page.locator('.hex').first().evaluate((el) => {
      const bg = getComputedStyle(el).backgroundImage; // linear-gradient(to right, transparent Xpx, rgba(...) Xpx)
      const m = /rgba[(]0, 0, 0, 0[)] (-?[\d.]+)px/.exec(bg);
      const r = el.getBoundingClientRect();
      const cells = [...el.querySelectorAll('.b')].map((c) => c.getBoundingClientRect());
      return { x: m ? parseFloat(m[1]!) : NaN, left: r.left, end7: cells[7]!.right - r.left, start8: cells[8]!.left - r.left };
    });
    expect(edge.x).toBeGreaterThan(edge.end7 - 0.5);
    expect(edge.x).toBeLessThan(edge.start8 + 0.5);
  });

  test('narrow screens: a drawer slides and fades in (opacity and transform), and not at all with reduced motion', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(40));
    const slot = page.locator('.side-slot');
    const t = () => slot.evaluate((el) => ({ props: getComputedStyle(el).transitionProperty, dur: getComputedStyle(el).transitionDuration }));
    const closed = await t();
    expect(closed.props).toMatch(/opacity/);
    expect(closed.props).toMatch(/transform/);
    expect(closed.props).not.toMatch(/width|left|right/);
    expect(closed.dur).toMatch(/0\.08s/);
    await page.getByRole('navigation', { name: 'Activity bar' }).getByRole('button', { name: 'Structure' }).click();
    await expect(page.getByRole('tree', { name: 'Structure' })).toBeVisible();
    expect((await t()).dur).toMatch(/0\.12s/);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect((await t()).dur).not.toMatch(/0\.12s/);
  });

  test('a collapsed panel on a wide screen does not animate', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(40));
    const dur = await page.locator('.side-slot').evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(dur.split(',').every((d) => parseFloat(d) === 0)).toBe(true);
  });
});

test.describe('UX refinement 2: review fixes', () => {
  test('width breakpoints follow the zoomed layout: at 130% in a 760px window the minimap is hidden and the status bar is compact; at 100% they are not', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 700 });
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(400));
    await expectParsed(page);
    await expect(minimap(page)).toBeVisible(); // 760 CSS px: above 599
    await expect(statusBar(page).locator('.size')).toBeVisible(); // above 720
    await page.evaluate(() => localStorage.setItem('binaryviewer.uiScale', '1.3'));
    await page.reload();
    await openBytes(page, 'pic.bmp', makeBmp(400));
    await expectParsed(page);
    await expect(page.locator('html')).toHaveCSS('zoom', '1.3');
    await expect(minimap(page)).toBeHidden(); // 760 / 1.3 = 584 CSS px
    await expect(statusBar(page).locator('.size')).toBeHidden();
    await expect(statusBar(page).locator('.nodes')).toBeHidden();
  });

  test('closing the divider menu with Tab leaves focus on the divider (not <body>)', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(40));
    const sep = page.getByRole('separator', { name: 'Resize problems panel' });
    await sep.focus();
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(menu).toHaveCount(0);
    await expect(sep).toBeFocused();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    await page.keyboard.press('ArrowUp'); // and it is still the working divider
    await expect(sep).toBeFocused();
  });

  test('the divider menu stays inside the window when opened at its bottom right corner', async ({ page }) => {
    await gotoApp(page);
    await openBytes(page, 'pic.bmp', makeBmp(40));
    const sep = page.getByRole('separator', { name: 'Resize inspector' });
    const b = (await sep.boundingBox())!;
    await page.mouse.click(b.x + 0.5, b.y + b.height - 2, { button: 'right' }); // the bottom of the divider, just above the status bar
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    const m = (await menu.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(m.y + m.height).toBeLessThanOrEqual(vp.height + 0.5);
    expect(m.x + m.width).toBeLessThanOrEqual(vp.width + 0.5);
  });

  test('the zoom keys work while the palette is open', async ({ page }) => {
    await gotoApp(page);
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('combobox')).toBeVisible();
    await page.keyboard.press('Control+Equal');
    await expect(page.locator('html')).toHaveCSS('zoom', '1.15');
    await page.keyboard.press('Control+0');
    await expect(page.locator('html')).toHaveCSS('zoom', '1');
  });
});
