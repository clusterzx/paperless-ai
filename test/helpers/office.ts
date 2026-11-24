/**
 * Office-like files for tests: ZIP (OOXML, OpenDocument), OLE2 compound files (old Office formats,
 * Outlook .msg), .tar.gz packages – and a stand-in for the LibreOffice process.
 */
import zlib from 'node:zlib';
import type { OfficeEngine } from '../../src/server/office/service.js';
import { makePdf } from './pdf.js';

/** A ZIP file with uncompressed entries. */
export function makeZip(entries: { name: string; data: Buffer | string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const name = Buffer.from(e.name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A minimal, valid Word document (.docx) with one paragraph per entry. */
export function makeDocx(paragraphs: string[]): Buffer {
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`,
    },
  ]);
}

/** The start of an OpenDocument file: the uncompressed `mimetype` entry first. */
export function makeOdf(mimetype: string): Buffer {
  return makeZip([
    { name: 'mimetype', data: mimetype },
    {
      name: 'content.xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>',
    },
    {
      name: 'META-INF/manifest.xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>',
    },
  ]);
}

/** An OLE2 compound file (512 byte sectors) whose directory holds these streams. */
export function makeOle(streams: string[]): Buffer {
  const END = 0xfffffffe;
  const names = ['Root Entry', ...streams];
  const dirSectors = Math.ceil(names.length / 4);
  const header = Buffer.alloc(512, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x3e, 0x18);
  header.writeUInt16LE(3, 0x1a);
  header.writeUInt16LE(0xfffe, 0x1c);
  header.writeUInt16LE(9, 0x1e);
  header.writeUInt16LE(6, 0x20);
  header.writeUInt32LE(1, 0x2c);
  header.writeUInt32LE(0, 0x30);
  header.writeUInt32LE(4096, 0x38);
  header.writeUInt32LE(END, 0x3c);
  header.writeUInt32LE(END, 0x44);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(0xffffffff, 0x4c + i * 4);
  header.writeUInt32LE(dirSectors, 0x4c); // the FAT follows the directory
  const dir = Buffer.alloc(dirSectors * 512, 0);
  names.forEach((name, i) => {
    const e = i * 128;
    dir.write(name, e, 'utf16le');
    dir.writeUInt16LE((name.length + 1) * 2, e + 0x40);
    dir[e + 0x42] = i === 0 ? 5 : 2;
  });
  const fat = Buffer.alloc(512, 0xff);
  for (let s = 0; s < dirSectors; s++) fat.writeUInt32LE(s === dirSectors - 1 ? END : s + 1, s * 4);
  fat.writeUInt32LE(0xfffffffd, dirSectors * 4);
  return Buffer.concat([header, dir, fat]);
}

/** A .tar.gz file (ustar; names longer than 100 characters get a pax header). */
export function makeTarGz(entries: { name: string; data?: string; type?: '0' | '2' | '5' }[]): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: string) => {
    const h = Buffer.alloc(512, 0);
    h.write(name.slice(0, 100), 0, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(type, 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return h;
  };
  const pad = (data: Buffer) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512, 0)]);
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    if (Buffer.byteLength(e.name) > 100) {
      const recordOf = (len: number) => `${len} path=${e.name}\n`;
      let len = 10;
      while (Buffer.byteLength(recordOf(len)) !== len) len++;
      const record = recordOf(len);
      blocks.push(header('PaxHeader', Buffer.byteLength(record), 'x'), pad(Buffer.from(record)));
    }
    blocks.push(header(e.name, e.type === '5' || e.type === '2' ? 0 : data.length, e.type ?? '0'));
    if (e.type !== '5' && e.type !== '2') blocks.push(pad(data));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

/** Stands in for the LibreOffice process: every conversion gives a PDF with these lines. */
export class FakeOfficeEngine implements OfficeEngine {
  loaded = false;
  rss: number | null = null;
  starts = 0;
  stops = 0;
  calls: { ext: string; text: string }[] = [];
  /** Answer of each call (1-based); default: a PDF of `lines`. */
  behave: (call: number, ext: string) => Uint8Array | Promise<Uint8Array> = () => makePdf([this.lines]);
  lines = ['Mietvertrag für die Wohnung', 'Musterstraße 1, 12345 Musterstadt'];

  async start(): Promise<void> {
    this.starts++;
    this.loaded = true;
  }

  async convert(data: Uint8Array, ext: string): Promise<Uint8Array> {
    this.calls.push({ ext, text: ext === 'html' ? Buffer.from(data).toString('utf8') : '' });
    return this.behave(this.calls.length, ext);
  }

  stop(): void {
    this.stops++;
    this.loaded = false;
  }
}
