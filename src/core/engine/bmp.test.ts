import { describe, expect, it } from 'vitest';
import bmpJson from '../../formats/bmp.json';
import { MemoryByteSource } from '../byte-source';
import { detect } from './detect';
import { findNodeAt, parse } from './interpret';
import { find, le16, le32 } from './test-helpers';
import { formatIssues, validateSpec } from './validate';

const v = validateSpec(bmpJson);
if (!v.ok) throw new Error(formatIssues(v.errors));
const bmp = v.spec;

interface BmpOpts {
  width?: number;
  height?: number;
  bpp?: number;
  headerSize?: number;
  clrUsed?: number;
  compression?: number;
  palette?: number[][]; // [b,g,r,0]
  offBits?: number;
  pixels?: number[];
  csType?: number;
  core?: boolean;
}

/** Build a BMP in code. */
function makeBmp(o: BmpOpts = {}): Uint8Array {
  const { width = 2, height = 2, bpp = 24, clrUsed = 0, compression = 0, palette = [], csType = 0 } = o;
  const headerSize = o.headerSize ?? (o.core ? 12 : 40);
  let dib: number[];
  if (headerSize === 12) dib = [...le32(12), ...le16(width), ...le16(height), ...le16(1), ...le16(bpp)];
  else {
    dib = [...le32(headerSize), ...le32(width), ...le32(height), ...le16(1), ...le16(bpp), ...le32(compression), ...le32(0), ...le32(2835), ...le32(2835), ...le32(clrUsed), ...le32(0)];
    while (dib.length < headerSize) dib.push(0);
    if (headerSize >= 108) {
      // cs_type sits after the 40 info bytes + 16 mask bytes
      const at = 40 + 16;
      dib.splice(at, 4, ...le32(csType));
    }
  }
  const pal = palette.flat();
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  const rows = Math.abs(height);
  const pixels = o.pixels ?? new Array(stride * rows).fill(0xab);
  const offBits = o.offBits ?? 14 + dib.length + pal.length;
  const total = 14 + dib.length + pal.length + pixels.length;
  return Uint8Array.from([0x42, 0x4d, ...le32(total), ...le16(0), ...le16(0), ...le32(offBits), ...dib, ...pal, ...pixels]);
}

const run = (bytes: Uint8Array) => parse(bmp, new MemoryByteSource(bytes));

describe('BMP: valid files', () => {
  it('parses a 2x2 24-bit image; rows are padded to 4 bytes', async () => {
    const bytes = makeBmp({ width: 2, height: 2, bpp: 24 });
    const stride = Math.floor((24 * 2 + 31) / 32) * 4;
    expect(stride).toBe(8); // 6 pixel bytes + 2 padding bytes per row
    expect(bytes.length).toBe(14 + 40 + 2 * stride);
    const r = await run(bytes);
    expect(r.errors).toEqual([]);
    const fh = find(r.root, 'file_header');
    expect(find(fh, 'magic').value).toBe('BM');
    expect(find(fh, 'magic').validation).toBeUndefined();
    expect(find(fh, 'file_size').value).toBe(bytes.length);
    expect(find(fh, 'off_bits').value).toBe(54);
    expect(fh.size).toBe(14);
    const dib = find(r.root, 'dib');
    expect(find(dib, 'size').value).toBe(40);
    expect(find(dib, 'body').typeName).toBe('bitmap_info_body');
    expect(find(dib, 'body').size).toBe(36);
    expect(find(dib, 'body.width').value).toBe(2);
    expect(find(dib, 'body.height').value).toBe(2);
    expect(find(dib, 'body.bpp').value).toBe(24);
    expect(find(dib, 'body.compression').enumLabel).toBe('BI_RGB');
    expect(find(dib, 'body.x_pels_per_meter').value).toBe(2835);
    const pixels = find(r.root, 'pixels');
    expect(pixels.offset).toBe(54);
    expect(pixels.size).toBe(2 * stride);
    expect(find(r.root, 'palette').children).toEqual([]); // 24-bit: no palette
    expect(r.root.children!.some((c) => c.name === 'palette_core')).toBe(false);
  });

  it('parses an 8-bit image with a 256-entry palette (RGBQUAD, blue first)', async () => {
    const palette = Array.from({ length: 256 }, (_, i) => [i, 255 - i, 7, 0]);
    const bytes = makeBmp({ width: 2, height: 2, bpp: 8, palette });
    const r = await run(bytes);
    expect(r.errors).toEqual([]);
    const pal = find(r.root, 'palette');
    expect(pal.children).toHaveLength(256);
    const e1 = find(pal, 'palette[1]');
    expect(['blue', 'green', 'red', 'reserved'].map((n) => find(e1, n).value)).toEqual([1, 254, 7, 0]);
    expect(pal.size).toBe(1024);
    const pixels = find(r.root, 'pixels');
    expect(pixels.offset).toBe(14 + 40 + 1024);
    expect(pixels.size).toBe(2 * 4); // 2 pixels padded to 4 bytes per row
  });

  it('uses clr_used when non-zero', async () => {
    const palette = [[1, 2, 3, 0], [4, 5, 6, 0], [7, 8, 9, 0]];
    const r = await run(makeBmp({ bpp: 8, clrUsed: 3, palette }));
    expect(find(r.root, 'palette').children).toHaveLength(3);
    expect(r.errors).toEqual([]);
  });

  it('a very large clr_used becomes a lazy palette', async () => {
    const palette = Array.from({ length: 3000 }, () => [0, 0, 0, 0]);
    const r = await run(makeBmp({ bpp: 8, clrUsed: 3000, palette }));
    const pal = find(r.root, 'palette');
    expect(pal.lazy).toMatchObject({ count: 3000, elemSize: 4, elemType: 'rgbquad' });
  });

  it('parses an OS/2 core header with an RGBTRIPLE palette', async () => {
    const palette = [[1, 2, 3], [4, 5, 6]]; // bpp 1 -> 2 entries of 3 bytes
    const bytes = makeBmp({ core: true, width: 8, height: 2, bpp: 1, palette: palette as number[][], offBits: 14 + 12 + 6, pixels: [0xff, 0, 0, 0, 0xaa, 0, 0, 0] });
    const r = await run(bytes);
    expect(r.errors).toEqual([]);
    expect(find(r.root, 'dib.body').typeName).toBe('bitmap_core_body');
    expect(find(r.root, 'dib.body').size).toBe(8);
    expect(find(r.root, 'dib.body.width').value).toBe(8);
    const pal = find(r.root, 'palette_core');
    expect(pal.children).toHaveLength(2);
    expect(find(pal, 'palette_core[1].red').value).toBe(6);
    expect(r.root.children!.some((c) => c.name === 'palette')).toBe(false);
  });

  it('parses V4 and V5 headers, including the colour space enum', async () => {
    const v4 = await run(makeBmp({ headerSize: 108, csType: 0x73524742 }));
    expect(v4.errors).toEqual([]);
    expect(find(v4.root, 'dib.body').typeName).toBe('bitmap_v4_body');
    expect(find(v4.root, 'dib.body').size).toBe(104);
    expect(find(v4.root, 'dib.body.cs_type').enumLabel).toBe('LCS_sRGB');
    expect(find(v4.root, 'dib.body.endpoints.green.y').offset).toBe(14 + 4 + 40 - 4 + 16 + 4 + 12 + 4);
    const v5 = await run(makeBmp({ headerSize: 124 }));
    expect(v5.errors).toEqual([]);
    expect(find(v5.root, 'dib.body').typeName).toBe('bitmap_v5_body');
    expect(find(v5.root, 'dib.body').size).toBe(120);
    expect(find(v5.root, 'dib.body.profile_size').offset).toBe(14 + 4 + 120 - 8);
    expect(find(v5.root, 'pixels').offset).toBe(14 + 124);
  });

  it('negative height (top-down) is a signed value', async () => {
    const bytes = makeBmp({ width: 2, height: -2, bpp: 24 });
    const r = await run(bytes);
    expect(r.errors).toEqual([]);
    expect(find(r.root, 'dib.body.height').value).toBe(-2);
    expect(find(r.root, 'pixels').size).toBe(16);
  });

  it('flags a wrong magic and bad planes as validation errors but keeps parsing', async () => {
    const bytes = makeBmp();
    bytes[0] = 0x58;
    bytes[14 + 4 + 8] = 2; // planes
    const r = await run(bytes);
    expect(find(r.root, 'file_header.magic').validation![0]).toMatch(/expected "BM"/);
    expect(find(r.root, 'dib.body.planes').validation![0]).toMatch(/expected 1, found 2/);
    expect(find(r.root, 'pixels').size).toBe(16);
  });

  it('hex click maps to the right structure', async () => {
    const r = await run(makeBmp());
    expect(findNodeAt(r.root, 0)!.name).toBe('magic');
    expect(findNodeAt(r.root, 10)!.name).toBe('off_bits');
    expect(findNodeAt(r.root, 18)!.name).toBe('width');
    expect(findNodeAt(r.root, 60)!.name).toBe('pixels');
  });
});

describe('BMP: hostile and damaged files', () => {
  it('truncated at 13 bytes: partial tree, error node, no throw', async () => {
    const r = await run(makeBmp().slice(0, 13));
    expect(find(r.root, 'file_header.magic').value).toBe('BM');
    expect(find(r.root, 'file_header.off_bits').error).toMatch(/truncated/);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.root.children!.some((c) => c.name === 'dib')).toBe(false);
  });

  it('truncated inside the DIB header', async () => {
    const r = await run(makeBmp().slice(0, 30));
    expect(find(r.root, 'dib.body').error).toMatch(/exceeds/);
    expect(r.errors.some((e) => e.code === 'bounds')).toBe(true);
  });

  it('empty file', async () => {
    const r = await run(new Uint8Array(0));
    expect(find(r.root, 'file_header.magic').error).toMatch(/exceeds/);
    expect(find(r.root, 'file_header.file_size').error).toMatch(/truncated/);
  });

  it('off_bits = 0xFFFFFFFF is an error node, the rest still parses', async () => {
    const r = await run(makeBmp({ offBits: 0xffffffff }));
    expect(find(r.root, 'pixels').error).toMatch(/outside the file/);
    expect(find(r.root, 'dib.body.bpp').value).toBe(24);
    expect(find(r.root, 'file_header.off_bits').value).toBe(0xffffffff);
  });

  it('off_bits pointing exactly at EOF yields an empty pixel node', async () => {
    const bytes = makeBmp();
    const r = await run(makeBmp({ offBits: bytes.length }));
    const px = find(r.root, 'pixels');
    expect(px.error).toBeUndefined();
    expect(px.size).toBe(0);
  });

  it('DIB size 0: negative body size is an error', async () => {
    const bytes = makeBmp();
    bytes.set(le32(0), 14);
    const r = await run(bytes);
    expect(find(r.root, 'dib.body').error).toMatch(/negative/);
    expect(find(r.root, 'dib.size').value).toBe(0);
  });

  it('DIB size 0xFFFFFFFF: clamped to the file, kept as raw bytes', async () => {
    const bytes = makeBmp();
    bytes.set(le32(0xffffffff), 14);
    const r = await run(bytes);
    const body = find(r.root, 'dib.body');
    expect(body.typeName).toBe('bytes');
    expect(body.size).toBe(bytes.length - 18);
    expect(body.error).toMatch(/exceeds/);
    expect(r.stats.bytesRead).toBeLessThan(100);
  });

  it('unknown DIB size is kept as raw bytes without a palette', async () => {
    const bytes = makeBmp();
    bytes.set(le32(44), 14);
    const r = await run(bytes);
    expect(find(r.root, 'dib.body').typeName).toBe('bytes');
    expect(find(r.root, 'dib.body').size).toBe(40);
    expect(r.root.children!.some((c) => c.name.startsWith('palette'))).toBe(false);
  });

  it('palette count larger than the file is clamped with an error', async () => {
    const bytes = makeBmp({ bpp: 8, clrUsed: 0xffffffff, palette: [[1, 2, 3, 0]], pixels: [] });
    const r = await run(bytes);
    const pal = find(r.root, 'palette');
    expect(pal.error).toMatch(/exceeds/);
    expect(pal.children).toHaveLength(1); // only what fits
    expect(r.errors.some((e) => e.code === 'array')).toBe(true);
  });

  it('absurd bpp does not blow up the palette expression', async () => {
    const r = await run(makeBmp({ bpp: 0xffff }));
    expect(r.errors.every((e) => e.code !== 'internal')).toBe(true);
    expect(find(r.root, 'palette').children).toEqual([]);
  });

  it('random garbage never throws and stays within budgets', async () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let t = 0; t < 50; t++) {
      const bytes = makeBmp({ bpp: 8, palette: [[1, 2, 3, 0]] });
      for (let k = 0; k < 6; k++) bytes[rnd() % bytes.length] = rnd() & 0xff;
      const r = await run(bytes.slice(0, rnd() % (bytes.length + 1)));
      expect(r.stats.nodes).toBeLessThan(5000);
    }
  });
});

describe('BMP: detection', () => {
  const files = (name: string, bytes: Uint8Array) => detect([bmp], name, new MemoryByteSource(bytes));

  it('magic + extension scores highest', async () => {
    const [top] = await files('pic.BMP', makeBmp());
    expect(top!.specId).toBe('bmp');
    expect(top!.magicMatched).toBe(true);
    expect(top!.score).toBeGreaterThan(100);
  });

  it('magic alone (wrong extension) still matches', async () => {
    const [top] = await files('pic.dat', makeBmp());
    expect(top!.magicMatched).toBe(true);
  });

  it('a non-BM file named .bmp ranks low', async () => {
    const [top] = await files('pic.bmp', Uint8Array.from([0x4d, 0x5a, 0, 0]));
    expect(top!.magicMatched).toBe(false);
    expect(top!.score).toBeLessThan(30);
    expect(top!.reasons.join(' ')).toMatch(/magic did not match/);
  });

  it('a non-BM file with another extension is not offered at all', async () => {
    expect(await files('pic.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toEqual([]);
  });

  it('files shorter than the magic do not throw', async () => {
    expect(await files('a.bin', Uint8Array.from([0x42]))).toEqual([]);
    expect(await files('a.bin', new Uint8Array(0))).toEqual([]);
  });
});
