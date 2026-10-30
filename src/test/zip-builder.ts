/**
 * A small ZIP writer for tests: builds archives byte by byte (nothing is compressed, "data" is stored as given) and
 * reports where everything landed so tests can patch fields or compare offsets. No binary fixtures.
 */
import { le16, le32 } from '../core/engine/test-helpers';

export const le64 = (n: bigint | number): number[] => {
  let v = BigInt.asUintN(64, BigInt(n));
  const out: number[] = [];
  for (let i = 0; i < 8; i++, v >>= 8n) out.push(Number(v & 0xffn));
  return out;
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Standard CRC-32 (IEEE) of some bytes. */
export function crc32(data: ArrayLike<number>): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const utf8 = (s: string): number[] => [...new TextEncoder().encode(s)];

/** One extra-field TLV block. */
export const extraBlock = (id: number, body: ArrayLike<number> = []): number[] => [...le16(id), ...le16(body.length), ...Array.from(body)];

export const put16 = (b: Uint8Array, at: number, v: number): void => void b.set(le16(v), at);
export const put32 = (b: Uint8Array, at: number, v: number): void => void b.set(le32(v), at);
export const put64 = (b: Uint8Array, at: number, v: bigint | number): void => void b.set(le64(v), at);

export interface ZipEntry {
  /** A string is encoded as UTF-8; pass bytes for anything else (code page 437, invalid UTF-8, ...). */
  name?: string | number[];
  data?: string | number[];
  method?: number;
  /** General purpose flags; bit 3 is added by `descriptor`, bit 11 by `utf8`. */
  flags?: number;
  utf8?: boolean;
  /** Flag bit 3: the local header holds zeros and a data descriptor follows the data. */
  descriptor?: 'sig' | 'nosig' | 'zip64';
  /** `true`: sentinels for both sizes and the local header offset in the central directory (and both sizes in the local header). `sizes`: sizes only. */
  zip64?: boolean | 'sizes';
  /** Extra bytes appended after any generated ZIP64 block. */
  localExtra?: number[];
  cdExtra?: number[];
  comment?: string | number[];
  diskStart?: number;
  externalAttr?: number;
  /** [spec version * 10, host]. */
  madeBy?: [number, number];
  dosTime?: number;
  dosDate?: number;
  /** Force (true) or suppress (false) the ZIP64 block and sentinels in the local header; default: present for `zip64` entries and ZIP64 descriptors. */
  localZip64?: boolean;
}

export interface ZipOptions {
  comment?: string | number[];
  /** Bytes in front of the archive (a self-extractor stub). */
  prefix?: number[];
  /** Store offsets relative to the start of the FILE (true) instead of the start of the archive (false, the default). */
  adjust?: boolean;
  /** Write a ZIP64 EOCD record + locator and sentinels in the EOCD. `extensible` adds extensible data (then the record is not found by adjacency to the locator only if you move it). */
  zip64Eocd?: boolean | { extensible?: number[] };
  /** Replace EOCD fields after the layout is known (16/32-bit values). */
  eocd?: Partial<{ disk: number; cdDisk: number; entriesDisk: number; entriesTotal: number; cdSize: number; cdOffset: number }>;
  /** Digital signature record bytes (including the signature) placed after the central directory. */
  signature?: number[];
}

export interface ZipLayout {
  entries: Array<{ lfh: number; data: number; dataLen: number; descriptor: number | null; cdh: number; name: number[] }>;
  cd: number;
  cdSize: number;
  signature: number | null;
  z64eocd: number | null;
  locator: number | null;
  eocd: number;
  total: number;
}

export interface BuiltZip {
  bytes: Uint8Array<ArrayBuffer>;
  layout: ZipLayout;
}

const toBytes = (v: string | number[] | undefined): number[] => (v === undefined ? [] : typeof v === 'string' ? utf8(v) : v);

/** Build an archive. Offsets in `layout` are absolute (prefix included). */
export function buildZip(entries: ZipEntry[], opts: ZipOptions = {}): BuiltZip {
  const prefix = opts.prefix ?? [];
  const stored = (abs: number): number => (opts.adjust ? abs : abs - prefix.length);
  const body: number[] = [...prefix];
  const layout: ZipLayout = { entries: [], cd: 0, cdSize: 0, signature: null, z64eocd: null, locator: null, eocd: 0, total: 0 };
  const cdRecords: Array<{ e: ZipEntry; name: number[]; data: number[]; lfhAt: number; flags: number; crc: number }> = [];

  for (const e of entries) {
    const name = toBytes(e.name ?? 'a.txt');
    const data = toBytes(e.data ?? 'hi');
    const flags = (e.flags ?? 0) | (e.utf8 ? 0x800 : 0) | (e.descriptor ? 8 : 0);
    const crc = crc32(data);
    const lfhZip64 = e.localZip64 ?? (e.zip64 !== undefined && e.zip64 !== false ? true : e.descriptor === 'zip64');
    const sizes = e.descriptor ? [0, 0] : [data.length, data.length];
    const localSizes = lfhZip64 ? [0xffffffff, 0xffffffff] : sizes;
    const zip64Local = lfhZip64 ? extraBlock(1, [...le64(e.descriptor ? 0 : data.length), ...le64(e.descriptor ? 0 : data.length)]) : [];
    const localExtra = [...zip64Local, ...(e.localExtra ?? [])];
    const lfhAt = body.length;
    body.push(
      ...le32(0x04034b50), ...le16(lfhZip64 ? 45 : 20), ...le16(flags), ...le16(e.method ?? 0), ...le16(e.dosTime ?? 0x6000), ...le16(e.dosDate ?? 0x5a21),
      ...le32(e.descriptor ? 0 : crc), ...le32(localSizes[0]!), ...le32(localSizes[1]!), ...le16(name.length), ...le16(localExtra.length), ...name, ...localExtra,
    );
    const dataAt = body.length;
    body.push(...data);
    let descriptor: number | null = null;
    if (e.descriptor) {
      descriptor = body.length;
      if (e.descriptor === 'sig') body.push(...le32(0x08074b50));
      body.push(...le32(crc));
      if (e.descriptor === 'zip64') body.push(...le64(data.length), ...le64(data.length));
      else body.push(...le32(data.length), ...le32(data.length));
    }
    layout.entries.push({ lfh: lfhAt, data: dataAt, dataLen: data.length, descriptor, cdh: 0, name });
    cdRecords.push({ e, name, data, lfhAt, flags, crc });
  }

  layout.cd = body.length;
  cdRecords.forEach((r, i) => {
    const { e, name, data, lfhAt, flags, crc } = r;
    const z = e.zip64 === true ? 'all' : e.zip64 === 'sizes' ? 'sizes' : null;
    const comment = toBytes(e.comment);
    const zbody: number[] = z ? [...le64(data.length), ...le64(data.length), ...(z === 'all' ? le64(stored(lfhAt)) : [])] : [];
    const cdExtra = [...(z ? extraBlock(1, zbody) : []), ...(e.cdExtra ?? [])];
    layout.entries[i]!.cdh = body.length;
    body.push(
      ...le32(0x02014b50), ...(e.madeBy ?? [63, 0]), ...le16(z ? 45 : 20), ...le16(flags), ...le16(e.method ?? 0), ...le16(e.dosTime ?? 0x6000), ...le16(e.dosDate ?? 0x5a21),
      ...le32(crc), ...le32(z ? 0xffffffff : data.length), ...le32(z ? 0xffffffff : data.length), ...le16(name.length), ...le16(cdExtra.length), ...le16(comment.length),
      ...le16(e.diskStart ?? 0), ...le16(0), ...le32(e.externalAttr ?? 0), ...le32(z === 'all' ? 0xffffffff : stored(lfhAt)), ...name, ...cdExtra, ...comment,
    );
  });
  layout.cdSize = body.length - layout.cd;

  if (opts.signature) {
    layout.signature = body.length;
    body.push(...opts.signature);
  }

  const z64 = opts.zip64Eocd;
  if (z64) {
    const ext = typeof z64 === 'object' ? (z64.extensible ?? []) : [];
    layout.z64eocd = body.length;
    body.push(
      ...le32(0x06064b50), ...le64(44 + ext.length), ...le16(45), ...le16(45), ...le32(0), ...le32(0), ...le64(entries.length), ...le64(entries.length),
      ...le64(layout.cdSize), ...le64(stored(layout.cd)), ...ext,
    );
    layout.locator = body.length;
    body.push(...le32(0x07064b50), ...le32(0), ...le64(stored(layout.z64eocd)), ...le32(1));
  }

  const comment = toBytes(opts.comment);
  layout.eocd = body.length;
  const ov = opts.eocd ?? {};
  body.push(
    ...le32(0x06054b50), ...le16(ov.disk ?? 0), ...le16(ov.cdDisk ?? 0), ...le16(ov.entriesDisk ?? (z64 ? 0xffff : entries.length)), ...le16(ov.entriesTotal ?? (z64 ? 0xffff : entries.length)),
    ...le32(ov.cdSize ?? (z64 ? 0xffffffff : layout.cdSize)), ...le32(ov.cdOffset ?? (z64 ? 0xffffffff : stored(layout.cd))), ...le16(comment.length), ...comment,
  );
  layout.total = body.length;
  return { bytes: Uint8Array.from(body), layout };
}
