/**
 * File formats of the built-in archive: what a file really is (from its content – the name and the
 * declared type are only hints) and what the archive does with it.
 *
 * - PDF and images: stored as they are; text from the PDF text layer or OCR.
 * - Text, Markdown, CSV, HTML and e-mails (.eml): always accepted; their text is read directly.
 * - Office documents (Word, Excel, PowerPoint, OpenDocument, RTF): only with the optional Office
 *   converter (Settings → Archive), which adds a PDF of them (the original is kept).
 */
export { kindOf, type FileKind } from '../../shared/fileTypes.js';

/** Office types and the file extension the converter is told (it picks its import filter by it). */
export const OFFICE_EXTENSIONS: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/rtf': 'rtf',
};

const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/tiff': 'tif',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'text/html': 'html',
  'message/rfc822': 'eml',
  ...OFFICE_EXTENSIONS,
};

export function extensionFor(mime: string): string {
  return EXTENSIONS[mime] ?? 'bin';
}

/** A file the archive recognises but does not take – with the reason (shown in the inbox). */
export class UnsupportedFormat {
  constructor(readonly reason: string) {}
}

const ext = (filename: string) => (/\.([a-z0-9]{1,10})$/i.exec(filename)?.[1] ?? '').toLowerCase();

// ---------------------------------------------------------------- binary formats

/** The type of a file with a binary signature, from its first bytes (null: none of these). */
export function sniffBinary(bytes: Uint8Array): string | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024));
  const head = b.toString('latin1');
  if (head.includes('%PDF-')) return 'application/pdf';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.startsWith('II*\0') || head.startsWith('MM\0*')) return 'image/tiff';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  // BMP: "BM", reserved zero bytes and a known header size (text starting with "BM" has no zero bytes).
  if (
    head.startsWith('BM') &&
    b.length >= 18 &&
    b.readUInt32LE(6) === 0 &&
    [12, 40, 52, 56, 64, 108, 124].includes(b.readUInt32LE(14))
  )
    return 'image/bmp';
  if (head.startsWith('{\\rtf')) return 'application/rtf';
  return null;
}

const ZIP_MAGIC = 0x04034b50;
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** Names of the entries of a ZIP file (central directory; the local headers when it is cut off). */
export function zipEntries(bytes: Uint8Array, limit = 5000): string[] {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names: string[] = [];
  // End of central directory: the last 22 bytes plus a comment of up to 64 KB.
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (b.readUInt32LE(i) !== 0x06054b50) continue;
    let p = b.readUInt32LE(i + 16);
    const count = b.readUInt16LE(i + 10);
    for (let n = 0; n < Math.min(count, limit) && p + 46 <= b.length && b.readUInt32LE(p) === 0x02014b50; n++) {
      const nameLen = b.readUInt16LE(p + 28);
      names.push(b.toString('utf8', p + 46, Math.min(b.length, p + 46 + nameLen)));
      p += 46 + nameLen + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
    }
    if (names.length) return names;
    break;
  }
  // No usable directory: walk the local headers while their sizes are known.
  let p = 0;
  while (names.length < limit && p + 30 <= b.length && b.readUInt32LE(p) === ZIP_MAGIC) {
    const nameLen = b.readUInt16LE(p + 26);
    names.push(b.toString('utf8', p + 30, Math.min(b.length, p + 30 + nameLen)));
    const size = b.readUInt32LE(p + 18);
    if (b.readUInt16LE(p + 6) & 0x08 && size === 0) break;
    p += 30 + nameLen + b.readUInt16LE(p + 28) + size;
  }
  return names;
}

/** The `mimetype` entry an OpenDocument file starts with (stored uncompressed), or null. */
function odfMimetype(b: Buffer): string | null {
  if (b.length < 38 || b.readUInt32LE(0) !== ZIP_MAGIC || b.readUInt16LE(8) !== 0) return null;
  const nameLen = b.readUInt16LE(26);
  if (b.toString('latin1', 30, 30 + nameLen) !== 'mimetype') return null;
  const start = 30 + nameLen + b.readUInt16LE(28);
  return b.toString('latin1', start, Math.min(b.length, start + b.readUInt32LE(18), start + 100)).trim();
}

function zipType(b: Buffer): string | UnsupportedFormat | null {
  const odf = odfMimetype(b);
  if (odf) {
    const base = odf.replace(/-template$/, '');
    if (OFFICE_EXTENSIONS[base]) return base;
    return new UnsupportedFormat(`this OpenDocument type is not supported (${odf})`);
  }
  const names = new Set(zipEntries(b));
  if (names.has('[Content_Types].xml') || [...names].some((n) => /^(word|xl|ppt)\//.test(n))) {
    if ([...names].some((n) => n.startsWith('word/')))
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if ([...names].some((n) => n.startsWith('xl/'))) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if ([...names].some((n) => n.startsWith('ppt/')))
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if ([...names].some((n) => n.startsWith('visio/'))) return new UnsupportedFormat('Visio drawings are not supported');
  }
  return null;
}

/**
 * Names of the streams of an OLE2 compound file (the old Office formats, Outlook .msg): the
 * directory chain, followed through the FAT of the header (enough for files up to ~7 MB with 512
 * byte sectors, and far larger ones with 4 KB sectors).
 */
export function oleStreams(bytes: Uint8Array, limit = 2000): string[] {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 512 || !b.subarray(0, 8).equals(OLE_MAGIC)) return [];
  const shift = b.readUInt16LE(0x1e);
  if (shift !== 9 && shift !== 12) return [];
  const size = 1 << shift;
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const s = b.readUInt32LE(0x4c + i * 4);
    if (s >= 0xfffffffa) break;
    fatSectors.push(s);
  }
  const perSector = size / 4;
  const next = (sector: number): number => {
    const fat = fatSectors[Math.floor(sector / perSector)];
    if (fat === undefined) return 0xfffffffe;
    const at = (fat + 1) * size + (sector % perSector) * 4;
    return at + 4 <= b.length ? b.readUInt32LE(at) : 0xfffffffe;
  };
  const names: string[] = [];
  const seen = new Set<number>();
  for (
    let sector = b.readUInt32LE(0x30);
    sector < 0xfffffffa && !seen.has(sector) && names.length < limit;
    sector = next(sector)
  ) {
    seen.add(sector);
    const start = (sector + 1) * size;
    for (let e = start; e + 128 <= Math.min(b.length, start + size); e += 128) {
      const len = b.readUInt16LE(e + 0x40);
      if (len >= 2 && len <= 64 && b[e + 0x42]) names.push(b.toString('utf16le', e, e + len - 2));
    }
  }
  return names;
}

function oleType(b: Buffer, name: string): string | UnsupportedFormat | null {
  const streams = new Set(oleStreams(b));
  if (streams.has('EncryptedPackage'))
    return new UnsupportedFormat('the Office document is password-protected – save it without a password');
  if (streams.has('WordDocument')) return 'application/msword';
  if (streams.has('Workbook') || streams.has('Book')) return 'application/vnd.ms-excel';
  if (streams.has('PowerPoint Document')) return 'application/vnd.ms-powerpoint';
  if ([...streams].some((s) => s.startsWith('__substg1.0_')) || ext(name) === 'msg')
    return new UnsupportedFormat('Outlook .msg files are not supported – save the e-mail as .eml');
  // The directory could not be read (a damaged or unusual file): the extension decides.
  const byExt: Record<string, string> = {
    doc: 'application/msword',
    dot: 'application/msword',
    xls: 'application/vnd.ms-excel',
    xlt: 'application/vnd.ms-excel',
    ppt: 'application/vnd.ms-powerpoint',
    pps: 'application/vnd.ms-powerpoint',
  };
  return byExt[ext(name)] ?? null;
}

// ---------------------------------------------------------------- text formats

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

/** The encoding of a text file, or null when it is no text (binary data). */
export function textEncoding(bytes: Uint8Array): TextEncoding | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8';
  if (b[0] === 0xff && b[1] === 0xfe) return 'utf-16le';
  if (b[0] === 0xfe && b[1] === 0xff) return 'utf-16be';
  const sample = b.subarray(0, 256 * 1024);
  let control = 0;
  for (const c of sample) {
    if (c === 0) return null;
    // Control characters other than tab, line feed, form feed, carriage return and escape.
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0c && c !== 0x0d && c !== 0x1b) control++;
  }
  if (control > sample.length / 100) return null;
  try {
    // A cut-off last character of the sample is no reason to doubt the encoding.
    new TextDecoder('utf-8', { fatal: true }).decode(sample.length < b.length ? sample.subarray(0, sample.length - 4) : sample);
    return 'utf-8';
  } catch {
    return 'windows-1252';
  }
}

export function decodeText(bytes: Uint8Array, encoding: TextEncoding | null = textEncoding(bytes)): string {
  const enc = encoding ?? 'utf-8';
  let text: string;
  if (enc === 'utf-16be') {
    const swapped = Buffer.from(bytes);
    swapped.swap16();
    text = new TextDecoder('utf-16le').decode(swapped.subarray(2));
  } else {
    // TextDecoder drops the byte order mark itself.
    text = new TextDecoder(enc).decode(bytes);
  }
  return text.replace(/\r\n?/g, '\n');
}

const MAIL_HEADER =
  /^(from|to|cc|subject|date|message-id|received|return-path|mime-version|delivered-to|reply-to|sender|x-[\w-]+|dkim-signature|authentication-results|content-type|arc-[\w-]+|thread-[\w-]+|in-reply-to|references):/i;

/** Whether a text starts with the header block of an e-mail (RFC 5322). */
export function looksLikeMail(text: string): boolean {
  const lines = text.slice(0, 64 * 1024).split('\n');
  const names = new Set<string>();
  let i = 0;
  // An mbox "From " line may come first.
  if (lines[0]?.startsWith('From ')) i++;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === '' || line === '\r') break;
    if (/^[ \t]/.test(line)) continue;
    const m = /^([!-9;-~]+):/.exec(line);
    if (!m) return false;
    if (MAIL_HEADER.test(line)) names.add(m[1].toLowerCase());
  }
  return names.has('from') && (names.has('subject') || names.has('date') || names.has('message-id') || names.has('received'));
}

function looksLikeHtml(text: string): boolean {
  let head = text
    .slice(0, 4096)
    .replace(/^\uFEFF/, '')
    .trimStart();
  // Comments and an XML declaration may come first.
  for (;;) {
    const close = head.startsWith('<!--') ? '-->' : head.startsWith('<?xml') ? '>' : null;
    if (!close) break;
    const end = head.indexOf(close);
    if (end < 0) return false;
    head = head.slice(end + close.length).trimStart();
  }
  return /^<!doctype\s+html/i.test(head) || /^<html[\s>]/i.test(head);
}

const TEXT_EXTENSIONS: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  tab: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'text/html',
  eml: 'message/rfc822',
  mht: 'message/rfc822',
  mhtml: 'message/rfc822',
};

function textType(bytes: Uint8Array, name: string): string | UnsupportedFormat | null {
  const encoding = textEncoding(bytes);
  if (!encoding) return null;
  const text = decodeText(bytes.subarray(0, 64 * 1024), encoding);
  const e = ext(name);
  if (e === 'eml' || looksLikeMail(text)) return 'message/rfc822';
  if (TEXT_EXTENSIONS[e] === 'text/html' || looksLikeHtml(text)) return 'text/html';
  if (TEXT_EXTENSIONS[e]) return TEXT_EXTENSIONS[e];
  // Text without a (known) extension is plain text; other text formats (JSON, XML, SVG, source
  // code) are no documents.
  if (!e || /^\d+$/.test(e)) return 'text/plain';
  return new UnsupportedFormat(`.${e} files are not supported`);
}

// ---------------------------------------------------------------- detection

/**
 * What a file is, from its complete content (ZIP and OLE files need more than their first bytes):
 * a MIME type, an UnsupportedFormat with the reason, or null for anything unknown.
 */
export function detectType(bytes: Uint8Array, filename: string): string | UnsupportedFormat | null {
  if (!bytes.byteLength) return null;
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const binary = sniffBinary(b);
  if (binary) return binary;
  if (b.length >= 4 && b.readUInt32LE(0) === ZIP_MAGIC) return zipType(b);
  if (b.subarray(0, 8).equals(OLE_MAGIC)) return oleType(b, filename);
  return textType(b, filename);
}
