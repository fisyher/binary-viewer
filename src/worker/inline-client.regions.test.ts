import { describe, expect, it } from 'vitest';
import { le16, le32 } from '../core/engine/test-helpers';
import { createInlineClient } from './inline-client';

/** 1x1 24-bit BMP: 14-byte file header, 40-byte DIB header, 4 pixel bytes. */
function makeBmp(): Uint8Array<ArrayBuffer> {
  const dib = [...le32(40), ...le32(1), ...le32(1), ...le16(1), ...le16(24), ...le32(0), ...le32(4), ...le32(2835), ...le32(2835), ...le32(0), ...le32(0)];
  return Uint8Array.from([0x42, 0x4d, ...le32(14 + 40 + 4), ...le16(0), ...le16(0), ...le32(54), ...dib, 0xab, 0xcd, 0xef, 0]);
}

describe('overview regions through the client', () => {
  it('keep their names on the way from the worker handler to the caller', async () => {
    const client = createInlineClient();
    await client.open(new Blob([makeBmp()]), 'pic.bmp');
    await client.parse('bmp');
    const ov = await client.overview(16);
    expect(ov.regions.map((r) => r.name)).toEqual(['file_header', 'dib', 'pixels']);
    client.dispose();
  });
});
