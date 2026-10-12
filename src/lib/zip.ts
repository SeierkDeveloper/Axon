// A small reader for ZIP archives, which is what a Word, Excel or PowerPoint file is. It reads the directory at the
// end of the archive and unpacks one named part at a time, with a ceiling on how much it will unpack, so a file
// built to blow up when opened is turned away instead. Stored and deflated parts only: that is all Office writes.
// The writer underneath packs parts into an archive: for the tests, and for handing somebody the files of a page an
// agent built for them (./siteZip).

import zlib from "node:zlib";

export interface ZipEntry { name: string; method: number; packed: number; size: number; at: number }

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
/** The most parts an archive may list before it is refused. */
export const MAX_ENTRIES = 5_000;

/** True when these bytes begin as a ZIP archive does. */
export const looksZip = (b: Buffer): boolean => b.length > 30 && b.readUInt32LE(0) === LOCAL;

/** The parts an archive lists, or null when it is not an archive this reader takes (damaged, too many parts, ZIP64). */
export function zipEntries(b: Buffer): ZipEntry[] | null {
  if (!looksZip(b)) return null;
  // the directory's end record sits within the last 64 KB (its own 22 bytes and at most a 65,535 byte comment)
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (b.readUInt32LE(i) === EOCD) { end = i; break; }
  }
  if (end < 0) return null;
  const count = b.readUInt16LE(end + 10), dirSize = b.readUInt32LE(end + 12), dirAt = b.readUInt32LE(end + 16);
  if (count > MAX_ENTRIES || dirAt === 0xffffffff || dirAt + dirSize > b.length) return null;
  const out: ZipEntry[] = [];
  let p = dirAt;
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== CENTRAL) return null;
    const method = b.readUInt16LE(p + 10), packed = b.readUInt32LE(p + 20), size = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28), extraLen = b.readUInt16LE(p + 30), commentLen = b.readUInt16LE(p + 32), at = b.readUInt32LE(p + 42);
    if (packed === 0xffffffff || size === 0xffffffff || at === 0xffffffff) return null;
    out.push({ name: b.toString("utf8", p + 46, p + 46 + nameLen), method, packed, size, at });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** One part of an archive, unpacked, or null when it is not there, is larger than `max`, or cannot be unpacked. */
export function zipRead(b: Buffer, entries: ZipEntry[], name: string, max: number): Buffer | null {
  const e = entries.find((x) => x.name === name);
  if (!e || e.size > max) return null;
  if (e.at + 30 > b.length || b.readUInt32LE(e.at) !== LOCAL) return null;
  const start = e.at + 30 + b.readUInt16LE(e.at + 26) + b.readUInt16LE(e.at + 28);
  if (start + e.packed > b.length) return null;
  const data = b.subarray(start, start + e.packed);
  try {
    if (e.method === 0) return data.length <= max ? Buffer.from(data) : null;
    // the size an archive claims is not trusted: unpacking stops at the ceiling whatever the directory says
    if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: max });
  } catch {
    return null;
  }
  return null;
}

let table: Uint32Array | null = null;
function crc32(b: Buffer): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** An archive of these parts, stored as they are (or deflated with `deflate`). `at` is the date its files carry. */
export function zipWrite(parts: { name: string; data: Buffer | string }[], o: { deflate?: boolean; at?: Date } = {}): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  // the date and time as an archive keeps them: two seconds at a time, and no year before 1980
  const d = o.at && o.at.getUTCFullYear() >= 1980 ? o.at : null;
  const time = d ? (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1) : 0;
  const date = d ? ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() : 0x21;
  let at = 0;
  for (const part of parts) {
    const raw = typeof part.data === "string" ? Buffer.from(part.data, "utf8") : part.data;
    const body = o.deflate ? zlib.deflateRawSync(raw) : raw, name = Buffer.from(part.name, "utf8"), crc = crc32(raw);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(LOCAL, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(o.deflate ? 8 : 0, 8); head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(name.length, 26);
    local.push(head, name, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(CENTRAL, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(o.deflate ? 8 : 0, 10); dir.writeUInt16LE(time, 12); dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(raw.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(at, 42);
    central.push(dir, name);
    at += 30 + name.length + body.length;
  }
  const dirBytes = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0); end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10); end.writeUInt32LE(dirBytes.length, 12); end.writeUInt32LE(at, 16);
  return Buffer.concat([...local, dirBytes, end]);
}
