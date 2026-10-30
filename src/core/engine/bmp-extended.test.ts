import { describe, expect, it } from 'vitest';
import bmpJson from '../../formats/bmp.json';
import { MemoryByteSource } from '../byte-source';
import type { ParseResult } from './interpret';
import { parse } from './interpret';
import { find, le16, le32 } from './test-helpers';
import { formatIssues, validateSpec } from './validate';

const v = validateSpec(bmpJson);
if (!v.ok) throw new Error(formatIssues(v.errors));
const bmp = v.spec;
const run = (bytes: Uint8Array | number[]) => parse(bmp, new MemoryByteSource(Uint8Array.from(bytes)));
const warnings = (r: ParseResult) => r.errors.filter((e) => e.severity === 'warning').map((e) => e.message);
const hard = (r: ParseResult) => r.errors.filter((e) => e.severity === 'error');

interface Opts {
  headerSize?: number;
  width?: number; // raw 32-bit pattern is written, so 0x80000000 style values are fine
  height?: number;
  bpp?: number;
  compression?: number;
  sizeImage?: number;
  clrUsed?: number;
  masks?: number[]; // written after a 40-byte header
  palette?: number[][];
  offBits?: number;
  pixels?: number[];
  csType?: number;
  profileData?: number;
  profileSize?: number;
  tail?: number[];
}

function build(o: Opts = {}): Uint8Array {
  const { width = 2, height = 2, bpp = 24, compression = 0, sizeImage = 0, clrUsed = 0 } = o;
  const headerSize = o.headerSize ?? 40;
  const dib = [...le32(headerSize), ...le32(width), ...le32(height), ...le16(1), ...le16(bpp), ...le32(compression), ...le32(sizeImage), ...le32(2835), ...le32(2835), ...le32(clrUsed), ...le32(0)];
  while (dib.length < headerSize) dib.push(0);
  if (headerSize >= 108) dib.splice(56, 4, ...le32(o.csType ?? 0));
  if (headerSize >= 124) {
    dib.splice(112, 4, ...le32(o.profileData ?? 0));
    dib.splice(116, 4, ...le32(o.profileSize ?? 0));
  }
  const masks = (o.masks ?? []).flatMap((m) => le32(m));
  const pal = (o.palette ?? []).flat();
  const stride = Math.floor((bpp * Math.max(width, 0) + 31) / 32) * 4;
  const pixels = o.pixels ?? new Array(Math.min(stride * Math.abs(height), 64)).fill(0xab);
  const offBits = o.offBits ?? 14 + dib.length + masks.length + pal.length;
  const total = 14 + dib.length + masks.length + pal.length + pixels.length + (o.tail?.length ?? 0);
  return Uint8Array.from([0x42, 0x4d, ...le32(total), 0, 0, 0, 0, ...le32(offBits), ...dib, ...masks, ...pal, ...pixels, ...(o.tail ?? [])]);
}

describe('BMP golden fixture (hard-coded bytes, independent of the builder)', () => {
  const hex = `
    42 4D 46 00 00 00 00 00 00 00 36 00 00 00
    28 00 00 00 02 00 00 00 02 00 00 00 01 00 18 00 00 00 00 00 10 00 00 00 13 0B 00 00 13 0B 00 00 00 00 00 00 00 00 00 00
    00 00 FF FF FF FF 00 00 FF 00 00 00 FF 00 00 00`;
  const bytes = Uint8Array.from(hex.trim().split(/\s+/).map((h) => parseInt(h, 16)));

  it('has every value as written', async () => {
    expect(bytes.length).toBe(70);
    const r = await run(bytes);
    expect(r.errors).toEqual([]);
    const fh = find(r.root, 'file_header');
    expect([find(fh, 'magic').value, find(fh, 'file_size').value, find(fh, 'reserved1').value, find(fh, 'reserved2').value, find(fh, 'off_bits').value]).toEqual(['BM', 70, 0, 0, 54]);
    const b = find(r.root, 'dib.body');
    expect(find(r.root, 'dib.size').value).toBe(40);
    const val = (n: string) => find(b, n).value;
    expect([val('width'), val('height'), val('planes'), val('bpp'), val('compression'), val('size_image')]).toEqual([2, 2, 1, 24, 0, 16]);
    expect([val('x_pels_per_meter'), val('y_pels_per_meter'), val('clr_used'), val('clr_important')]).toEqual([2835, 2835, 0, 0]);
    expect(find(b, 'compression').enumLabel).toBe('BI_RGB');
    const px = find(r.root, 'pixels');
    expect([px.offset, px.size]).toEqual([54, 16]);
    expect(Array.from(px.value as Uint8Array)).toEqual([0, 0, 0xff, 0xff, 0xff, 0xff, 0, 0, 0xff, 0, 0, 0, 0xff, 0, 0, 0]);
    expect(find(r.root, 'palette').children).toEqual([]);
    expect(r.root.children!.map((c) => c.name)).toEqual(['file_header', 'dib', 'palette', 'pixels']);
  });
});

describe('BMP bpp 0 (BI_JPEG / BI_PNG)', () => {
  it('has no palette when clr_used is 0', async () => {
    const r = await run(build({ bpp: 0, compression: 5, sizeImage: 8, pixels: [1, 2, 3, 4, 5, 6, 7, 8] }));
    expect(hard(r)).toEqual([]);
    expect(find(r.root, 'palette').children).toEqual([]);
    expect(find(r.root, 'dib.body.compression').enumLabel).toBe('BI_PNG');
    expect(find(r.root, 'pixels').size).toBe(8);
    expect(warnings(r)).toEqual([]);
  });
  it('core header with bpp 0 also has no palette', async () => {
    const bytes = Uint8Array.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 26, 0, 0, 0, ...le32(12), ...le16(2), ...le16(2), ...le16(1), ...le16(0), 1, 2]);
    const r = await run(bytes);
    expect(find(r.root, 'palette_core').children).toEqual([]);
  });
});

describe('BMP colour masks after a 40-byte header', () => {
  const rgb = [0xff0000, 0x00ff00, 0x0000ff];
  it('BI_BITFIELDS, 32 bpp, off_bits 66', async () => {
    const r = await run(build({ bpp: 32, compression: 3, masks: rgb, pixels: new Array(16).fill(1) }));
    expect(find(r.root, 'file_header.off_bits').value).toBe(66);
    expect(hard(r)).toEqual([]);
    expect(warnings(r)).toEqual([]);
    const m = find(r.root, 'masks');
    expect([m.offset, m.size]).toEqual([54, 12]);
    expect(find(m, 'red').value).toBe(0xff0000);
    expect(find(m, 'blue').value).toBe(0xff);
    expect(m.children!.some((c) => c.name === 'alpha')).toBe(false);
    expect(find(r.root, 'pixels').offset).toBe(66);
    expect(find(r.root, 'palette').children).toEqual([]);
  });

  it('with clr_used = 2 the palette follows the masks', async () => {
    const palette = [[1, 2, 3, 0], [4, 5, 6, 0]];
    const r = await run(build({ bpp: 32, compression: 3, masks: rgb, clrUsed: 2, palette }));
    expect(hard(r)).toEqual([]);
    const pal = find(r.root, 'palette');
    expect(pal.offset).toBe(66);
    expect(pal.children).toHaveLength(2);
    expect(find(pal, 'palette[1].red').value).toBe(6);
    expect(find(r.root, 'file_header.off_bits').value).toBe(74);
    expect(find(r.root, 'pixels').offset).toBe(74);
    expect(warnings(r)).toEqual([]);
  });

  it('BI_ALPHABITFIELDS has a fourth mask, off_bits 70', async () => {
    const r = await run(build({ bpp: 32, compression: 6, masks: [...rgb, 0xff000000] }));
    expect(find(r.root, 'file_header.off_bits').value).toBe(70);
    const m = find(r.root, 'masks');
    expect(m.size).toBe(16);
    expect(find(m, 'alpha').value).toBe(0xff000000);
    expect(find(r.root, 'pixels').offset).toBe(70);
    expect(warnings(r)).toEqual([]);
  });

  it('does not apply to other compressions or header sizes', async () => {
    const r = await run(build({ bpp: 32, compression: 0 }));
    expect(r.root.children!.some((c) => c.name === 'masks')).toBe(false);
    const v4 = await run(build({ headerSize: 108, bpp: 32, compression: 3 }));
    expect(v4.root.children!.some((c) => c.name === 'masks')).toBe(false);
  });
});

describe('BMP pixel data size', () => {
  it('uses size_image when non-zero and leaves trailing data alone', async () => {
    const r = await run(build({ sizeImage: 8, pixels: new Array(16).fill(1) }));
    expect(find(r.root, 'pixels').size).toBe(8);
  });
  it('clamps an oversized size_image to the end of the file without an error', async () => {
    const r = await run(build({ sizeImage: 0xffffff00, pixels: new Array(16).fill(1) }));
    expect(find(r.root, 'pixels').size).toBe(16);
    expect(find(r.root, 'pixels').error).toBeUndefined();
    expect(hard(r)).toEqual([]);
  });
  it('computes the stride with arithmetic: width 0x7FFFFFFF, bpp 32, height 0x80000000 does not wrap and reads little', async () => {
    const r = await run(build({ width: 0x7fffffff, height: 0x80000000, bpp: 32, pixels: new Array(32).fill(2) }));
    expect(hard(r)).toEqual([]);
    expect(find(r.root, 'dib.body.width').value).toBe(0x7fffffff);
    expect(find(r.root, 'dib.body.height').value).toBe(-2147483648);
    expect(find(r.root, 'pixels').size).toBe(32); // clamped to the file, not wrapped to 0 or negative
    expect(r.stats.bytesRead).toBeLessThan(200);
    expect(r.stats.reads).toBeLessThan(40);
  });
  it('negative or zero width still yields a sane pixel size', async () => {
    const r = await run(build({ width: 0xffffffff, height: 2, pixels: new Array(16).fill(1) }));
    expect(find(r.root, 'pixels').size).toBe(0);
    expect(warnings(r).some((w) => /width should be positive/.test(w))).toBe(true);
  });
  it('headers of unknown size run to the end of the file', async () => {
    const bytes = build();
    bytes.set(le32(44), 14);
    const r = await run(bytes);
    expect(find(r.root, 'pixels').size).toBe(bytes.length - 54);
  });
});

describe('BMP V5 profiles', () => {
  it('embedded profile located after the pixels', async () => {
    const pixels = new Array(16).fill(0x11);
    const profileAt = 14 + 124 + 16;
    const r = await run(build({ headerSize: 124, csType: 0x4d424544, profileData: profileAt - 14, profileSize: 6, pixels, tail: [1, 2, 3, 4, 5, 6] }));
    expect(hard(r)).toEqual([]);
    expect(find(r.root, 'dib.body.cs_type').enumLabel).toBe('PROFILE_EMBEDDED');
    const p = find(r.root, 'profile');
    expect([p.offset, p.size]).toEqual([profileAt, 6]);
    expect(Array.from(p.value as Uint8Array)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(find(r.root, 'pixels').size).toBe(16); // the profile is not swallowed by the pixel data
    expect(r.root.children!.some((c) => c.name === 'profile_link')).toBe(false);
  });

  it('linked profile is a latin1 string', async () => {
    const path = [0x61, 0x2e, 0x69, 0x63, 0x63, 0xe9, 0];
    const r = await run(build({ headerSize: 124, csType: 0x4c494e4b, profileData: 14 + 124 + 16 - 14, profileSize: path.length, tail: path }));
    const p = find(r.root, 'profile_link');
    expect(p.typeName).toBe('str');
    expect(p.value).toBe('a.iccé');
  });

  it('colour-space FourCCs are byte-reversed on disk', async () => {
    const r = await run(build({ headerSize: 108, csType: 0x73524742 }));
    const off = 14 + 4 + 52; // cs_type: 4 size bytes + 36 info + 16 masks
    const file = build({ headerSize: 108, csType: 0x73524742 });
    expect(Array.from(file.subarray(off, off + 4))).toEqual([0x42, 0x47, 0x52, 0x73]); // "BGRs" in file order: sRGB reversed
    expect(find(r.root, 'dib.body.cs_type').enumLabel).toBe('LCS_sRGB');
  });

  it('a profile pointing outside the file is an error node and parsing continues', async () => {
    const r = await run(build({ headerSize: 124, csType: 0x4d424544, profileData: 0xfffffff0, profileSize: 100 }));
    expect(find(r.root, 'profile').error).toMatch(/outside the file/);
    expect(find(r.root, 'pixels').size).toBeGreaterThan(0);
  });

  it('an oversized profile_size is clamped with an error on the node', async () => {
    const r = await run(build({ headerSize: 124, csType: 0x4d424544, profileData: 124, profileSize: 1_000_000, pixels: new Array(16).fill(0) }));
    expect(find(r.root, 'profile').error).toMatch(/exceeds/);
  });
});

describe('BMP V2 / V3 headers', () => {
  it('52-byte V2: flat body, same paths, palette handled', async () => {
    const r = await run(build({ headerSize: 52, bpp: 8, clrUsed: 2, palette: [[1, 2, 3, 0], [4, 5, 6, 0]] }));
    expect(hard(r)).toEqual([]);
    const b = find(r.root, 'dib.body');
    expect([b.typeName, b.size]).toEqual(['bitmap_v2_body', 48]);
    expect(find(b, 'bpp').value).toBe(8);
    expect(find(b, 'blue_mask').offset).toBe(14 + 4 + 36 + 8);
    expect(find(r.root, 'palette').children).toHaveLength(2);
    expect(find(r.root, 'pixels').offset).toBe(14 + 52 + 8);
  });
  it('56-byte V3 adds an alpha mask', async () => {
    const r = await run(build({ headerSize: 56 }));
    const b = find(r.root, 'dib.body');
    expect([b.typeName, b.size]).toEqual(['bitmap_v3_body', 52]);
    expect(find(b, 'alpha_mask').offset).toBe(14 + 4 + 48);
    expect(find(r.root, 'pixels').offset).toBe(14 + 56);
  });
  it('sizes 16 and 64 (including OS/2 2.x) stay raw', async () => {
    for (const size of [16, 44, 64]) {
      const bytes = build({ pixels: new Array(80).fill(0) });
      bytes.set(le32(size), 14);
      const r = await run(bytes);
      expect(find(r.root, 'dib.body').typeName, String(size)).toBe('bytes');
      expect(find(r.root, 'dib.body').size).toBe(size - 4);
      expect(r.root.children!.some((c) => c.name.startsWith('palette'))).toBe(false);
    }
  });
});

describe('BMP DIB header size edge cases', () => {
  it('sizes 1 to 3 give a negative body size error, 4 to 11 stay raw', async () => {
    for (let size = 1; size <= 11; size++) {
      const bytes = build();
      bytes.set(le32(size), 14);
      const r = await run(bytes);
      const body = find(r.root, 'dib.body');
      if (size < 4) expect(body.error, String(size)).toMatch(/negative/);
      else {
        expect(body.typeName, String(size)).toBe('bytes');
        expect(body.size).toBe(size - 4);
        expect(body.error).toBeUndefined();
      }
      expect(find(r.root, 'file_header.off_bits').value).toBe(54);
    }
  });
});

describe('BMP plausibility warnings', () => {
  const warn = (r: ParseResult, re: RegExp) => expect(warnings(r).some((w) => re.test(w)), JSON.stringify(warnings(r))).toBe(true);

  it.each([
    ['0', 0],
    ['13', 13],
    ['14', 14],
    ['inside the DIB header', 30],
    ['just before the end of the DIB header', 53],
  ])('off_bits %s points inside the headers', async (_n, off) => {
    const r = await run(build({ offBits: off }));
    warn(r, /off_bits points inside the headers/);
    expect(hard(r)).toEqual([]);
  });

  it('off_bits inside the palette', async () => {
    const palette = Array.from({ length: 256 }, () => [0, 0, 0, 0]);
    const r = await run(build({ bpp: 8, palette, offBits: 14 + 40 + 100 }));
    warn(r, /off_bits points inside/);
  });

  it('off_bits inside the colour masks', async () => {
    const r = await run(build({ bpp: 32, compression: 3, masks: [1, 2, 3], offBits: 60 }));
    warn(r, /off_bits points inside/);
  });

  it('off_bits exactly after the headers is fine', async () => {
    expect(warnings(await run(build()))).toEqual([]);
  });

  it('clr_used 257 at 8 bpp', async () => {
    const palette = Array.from({ length: 257 }, () => [0, 0, 0, 0]);
    const r = await run(build({ bpp: 8, clrUsed: 257, palette }));
    warn(r, /clr_used is larger than 2\^bpp/);
    expect(find(r.root, 'palette').children).toHaveLength(257);
    expect(warnings(await run(build({ bpp: 8, clrUsed: 256, palette: palette.slice(0, 256) })))).toEqual([]);
  });

  it('width <= 0 and height == 0', async () => {
    warn(await run(build({ width: 0 })), /width should be positive/);
    warn(await run(build({ width: 0xfffffffe })), /width should be positive/);
    warn(await run(build({ height: 0 })), /height should not be zero/);
  });

  it('unusual bits per pixel', async () => {
    for (const bpp of [3, 12, 48]) warn(await run(build({ bpp })), /unusual bits-per-pixel/);
    for (const bpp of [0, 1, 4, 8, 16, 24, 32]) expect(warnings(await run(build({ bpp, clrUsed: 0, palette: [] }))).filter((w) => /bits-per-pixel/.test(w))).toEqual([]);
  });

  it('negative height with a compressed format', async () => {
    const neg = 0xfffffffe;
    warn(await run(build({ height: neg, compression: 1 })), /top-down bitmap/);
    warn(await run(build({ height: neg, compression: 5 })), /top-down bitmap/);
    expect(warnings(await run(build({ height: neg, compression: 0 }))).filter((w) => /top-down/.test(w))).toEqual([]);
    expect(warnings(await run(build({ height: neg, compression: 3, bpp: 32, masks: [1, 2, 3] }))).filter((w) => /top-down/.test(w))).toEqual([]);
  });

  it('core header: unusual bpp warns', async () => {
    const bytes = Uint8Array.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 26, 0, 0, 0, ...le32(12), ...le16(2), ...le16(2), ...le16(1), ...le16(16), 1, 2]);
    warn(await run(bytes), /unusual bits-per-pixel value for a core header/);
  });
});

describe('BMP OS/2 core header palettes', () => {
  const core = (bpp: number, palBytes: number[], px: number[] = [0, 0, 0, 0]) =>
    Uint8Array.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 26 + palBytes.length, 0, 0, 0, ...le32(12), ...le16(2), ...le16(2), ...le16(1), ...le16(bpp), ...palBytes, ...px]);

  it('bpp 24 has no palette', async () => {
    const r = await run(core(24, []));
    expect(find(r.root, 'palette_core').children).toEqual([]);
    expect(find(r.root, 'pixels').offset).toBe(26);
    expect(warnings(r)).toEqual([]);
  });
  it('bpp 4 has 16 RGBTRIPLE entries', async () => {
    const pal = Array.from({ length: 48 }, (_, i) => i);
    const r = await run(core(4, pal));
    const p = find(r.root, 'palette_core');
    expect(p.children).toHaveLength(16);
    expect(p.size).toBe(48);
    expect(find(p, 'palette_core[15].red').value).toBe(47);
    expect(find(r.root, 'pixels').offset).toBe(26 + 48);
    expect(warnings(r)).toEqual([]);
  });
});

describe('BMP truncation', () => {
  it('mid-palette: clamped with an error, no throw', async () => {
    const palette = Array.from({ length: 256 }, () => [1, 2, 3, 0]);
    const full = build({ bpp: 8, palette });
    const r = await run(full.subarray(0, 14 + 40 + 102));
    const pal = find(r.root, 'palette');
    expect(pal.error).toMatch(/clamped to 25/);
    expect(pal.children).toHaveLength(25);
    expect(find(r.root, 'pixels').error).toMatch(/outside the file/);
  });

  it('mid-V5 header', async () => {
    const full = build({ headerSize: 124 });
    for (const cut of [14 + 8, 14 + 60, 14 + 100, 14 + 123]) {
      const r = await run(full.subarray(0, cut));
      expect(find(r.root, 'dib.body').error, String(cut)).toMatch(/exceeds/);
      expect(r.stats.nodes).toBeLessThan(200);
    }
  });

  it('every prefix of a V5 file parses without throwing', async () => {
    const full = build({ headerSize: 124, csType: 0x4d424544, profileData: 124 + 16, profileSize: 4, tail: [1, 2, 3, 4], pixels: new Array(16).fill(5) });
    for (let n = 0; n <= full.length; n++) {
      const r = await run(full.subarray(0, n));
      expect(r.errors.every((e) => e.code !== 'internal')).toBe(true);
    }
  });
});
