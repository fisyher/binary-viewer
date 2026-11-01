import { readFile } from 'node:fs/promises';
import { buildZip } from '../src/test/zip-builder';
import { expect, expectParsed, expectSelection, gotoApp, hex, hexByte, hexView, makeBmp, openBytes, openLargeFile, revealRow, statusBar, test, treeRow } from './fixtures';

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

  for (const clip of ['top', 'bottom'] as const) {
    test(`structure tree: double-clicking a row that is half clipped at the ${clip} toggles that row only`, async ({ page }) => {
      const { bytes } = buildZip(Array.from({ length: 60 }, (_, i) => ({ name: `f${i}.txt`, data: `data ${i}` })));
      await openBytes(page, 'many.zip', bytes);
      await expectParsed(page);
      await revealRow(page, 'entries');
      await page.keyboard.press('ArrowRight'); // expand entries: many expandable entries[i] rows
      const tree = page.getByRole('tree', { name: 'Structure' });
      await tree.evaluate((el) => (el.scrollTop += 330)); // bring the entries[i] rows into the window
      await expect(treeRow(page, 'entries[3]')).toBeVisible();

      // Scroll so that the entry is cut by 11 px (half a row) at the ${clip} edge of the tree; row positions come from the layout.
      const key = await tree.evaluate((el, edge) => {
        const rows = [...el.querySelectorAll<HTMLElement>('[role="treeitem"][aria-expanded="false"]')];
        const box = el.getBoundingClientRect();
        const pick = rows.filter((r) => (r.querySelector('.nm')?.textContent ?? '').startsWith('entries[')).find((r) => {
          const b = r.getBoundingClientRect();
          return edge === 'top' ? b.top > box.top + 66 && b.bottom < box.bottom - 66 : b.top > box.top + 66 && b.bottom < box.bottom - 22;
        });
        if (!pick) throw new Error('no suitable entries[i] row in the window');
        const b = pick.getBoundingClientRect();
        // content offset of the row's top edge, then shift so that 11 px of it are outside the viewport
        const contentTop = b.top - box.top + el.scrollTop;
        el.scrollTop = edge === 'top' ? contentTop + 11 : contentTop + 11 - el.clientHeight;
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
        return { x: b.left + 60, y: edge === 'top' ? b.bottom - 4 : b.top + 4, clipped };
      }, [key, clip] as const);
      expect(Math.round(pt.clipped)).toBe(11);
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
