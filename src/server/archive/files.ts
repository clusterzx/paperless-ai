/**
 * File handling of the intake: page count and text layer of PDFs (PDFium), thumbnails (PDFium +
 * sharp). The native/WASM libraries are optional dependencies; without them documents are still
 * stored, only without text layer and thumbnail. The file types: formats.ts.
 */
import { setImmediate as yieldTick } from 'node:timers/promises';
import { logger } from '../logger.js';

const log = logger.child({ module: 'archive' });

export { sniffBinary as sniffType, extensionFor } from './formats.js';

const MAX_TEXT_PAGES = 1000;
const THUMB_WIDTH = 480;
/** A thumbnail is never higher than this (a page can be 300,000 points high – memory for gigabytes). */
const THUMB_MAX_HEIGHT = 1600;

type PdfiumLibrary = InstanceType<(typeof import('@hyzyla/pdfium'))['PDFiumLibrary']>;
let pdfium: Promise<PdfiumLibrary | null> | null = null;

function pdfiumLibrary(): Promise<PdfiumLibrary | null> {
  pdfium ??= import('@hyzyla/pdfium')
    .then((m) => m.PDFiumLibrary.init())
    .catch((err: unknown) => {
      log.warn(`PDFium is not available – no text layer and no thumbnails for PDFs: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
  return pdfium;
}

/**
 * PDFium aborted (a crafted PDF): this instance is unusable – every later PDF would come back
 * without pages and text until a restart. The next PDF gets a new one.
 */
function afterPdfiumError(err: unknown): void {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (/abort|RuntimeError|memory access out of bounds|unreachable/i.test(msg)) {
    log.warn(`PDFium failed on a PDF (${msg.slice(0, 200)}) – it is loaded again for the next one`);
    pdfium = null;
  }
}

type Sharp = (typeof import('sharp'))['default'];
let sharpModule: Promise<Sharp | null> | null = null;

function sharp(): Promise<Sharp | null> {
  sharpModule ??= import('sharp')
    .then((m) => m.default)
    .catch(() => {
      log.warn('sharp is not available – no thumbnails for images');
      return null;
    });
  return sharpModule;
}

/** Width and height of an image, read from its header; null without sharp or for unreadable data. */
export async function imageSize(data: Buffer): Promise<{ width: number; height: number } | null> {
  const s = await sharp();
  if (!s) return null;
  try {
    const m = await s(data).metadata();
    return m.width && m.height ? { width: m.width, height: m.height } : null;
  } catch {
    return null;
  }
}

export interface FileInfo {
  pages: number | null;
  /** Text layer of a digital PDF ('' for scans and images). */
  text: string;
}

/** Page count and text layer. Never throws: a damaged file is still stored. */
export async function inspectFile(bytes: Uint8Array, mime: string): Promise<FileInfo> {
  try {
    if (mime === 'application/pdf') {
      const lib = await pdfiumLibrary();
      if (!lib) return { pages: null, text: '' };
      const doc = await lib.loadDocument(bytes);
      try {
        const pages = doc.getPageCount();
        const parts: string[] = [];
        for (let i = 0; i < Math.min(pages, MAX_TEXT_PAGES); i++) {
          const page = doc.getPage(i);
          try {
            parts.push(page.getText().replace(/\r\n?/g, '\n').trim());
          } finally {
            page.close?.();
          }
          // Long PDFs: let other requests through between pages.
          if (i % 10 === 9) await yieldTick();
        }
        return { pages, text: parts.filter(Boolean).join('\n\n') };
      } finally {
        doc.destroy();
      }
    }
    const s = await sharp();
    if (!s) return { pages: 1, text: '' };
    const meta = await s(bytes).metadata();
    return { pages: meta.pages ?? 1, text: '' };
  } catch (err) {
    log.warn(`Could not read the file (${mime}): ${err instanceof Error ? err.message : String(err)}`);
    if (mime === 'application/pdf') afterPdfiumError(err);
    return { pages: null, text: '' };
  }
}

/** A WebP thumbnail of the first page, or null when it cannot be made. */
export async function renderThumbnail(bytes: Uint8Array, mime: string): Promise<Buffer | null> {
  const s = await sharp();
  if (!s) return null;
  try {
    if (mime === 'application/pdf') {
      const lib = await pdfiumLibrary();
      if (!lib) return null;
      const doc = await lib.loadDocument(bytes);
      try {
        if (!doc.getPageCount()) return null;
        const page = doc.getPage(0);
        const { originalWidth, originalHeight } = page.getOriginalSize();
        const scale = Math.min(3, THUMB_WIDTH / Math.max(originalWidth, 1), THUMB_MAX_HEIGHT / Math.max(originalHeight, 1));
        const r = await page.render({ scale, render: 'bitmap' } as Parameters<typeof page.render>[0]);
        const channels = r.data.length / (r.width * r.height);
        return await s(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength), { raw: { width: r.width, height: r.height, channels: channels as 1 | 3 | 4 } })
          .flatten({ background: '#ffffff' })
          .webp({ quality: 78 })
          .toBuffer();
      } finally {
        doc.destroy();
      }
    }
    return await s(bytes, { page: 0, limitInputPixels: 30_000 * 30_000 })
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .webp({ quality: 78 })
      .toBuffer();
  } catch (err) {
    log.debug(`No thumbnail: ${err instanceof Error ? err.message : String(err)}`);
    if (mime === 'application/pdf') afterPdfiumError(err);
    return null;
  }
}

/**
 * Thumbnail of a text (plain text, HTML, e-mail without a PDF): the outline of its first lines as
 * bars – no fonts needed (the image has none). E-mails get an envelope.
 */
export async function textThumbnail(text: string, kind: 'text' | 'html' | 'mail'): Promise<Buffer | null> {
  const s = await sharp();
  if (!s) return null;
  const width = 300;
  const height = 400;
  const margin = 26;
  const perRow = 58;
  const rowHeight = 10;
  const top = kind === 'mail' ? 74 : margin;
  const rows: { len: number; strong: boolean }[] = [];
  let header = kind === 'mail';
  for (const line of text.split('\n')) {
    if (rows.length * rowHeight > height - top - margin) break;
    if (header && !line.trim()) header = false;
    const clean = line.replace(/\s+/g, ' ').trim();
    if (!clean) {
      rows.push({ len: 0, strong: false });
      continue;
    }
    for (let i = 0; i < clean.length && rows.length * rowHeight <= height - top - margin; i += perRow) rows.push({ len: Math.min(perRow, clean.length - i), strong: header });
  }
  const bar = (r: { len: number; strong: boolean }, i: number) =>
    `<rect x="${margin}" y="${top + i * rowHeight}" width="${Math.max(6, ((width - 2 * margin) * r.len) / perRow).toFixed(1)}" height="4" rx="2" fill="${r.strong ? '#8b90a0' : '#c3c7d1'}"/>`;
  const bars = rows.map((r, i) => (r.len ? bar(r, i) : '')).join('');
  const envelope = kind === 'mail' ? `<g fill="none" stroke="#6b7080" stroke-width="3" stroke-linejoin="round"><rect x="${margin}" y="24" width="44" height="30" rx="3"/><path d="M${margin} 27l22 15 22-15"/></g>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#ffffff"/>${envelope}${bars}</svg>`;
  try {
    return await s(Buffer.from(svg), { density: (72 * THUMB_WIDTH) / width })
      .resize({ width: THUMB_WIDTH })
      .webp({ quality: 78 })
      .toBuffer();
  } catch (err) {
    log.debug(`No thumbnail: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Neutral placeholder thumbnail (our own markup, safe to serve). */
export const PLACEHOLDER_THUMB = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400"><rect width="300" height="400" fill="#f3f4f6"/><path d="M110 140h80v120h-80z" fill="none" stroke="#c4c7cf" stroke-width="8"/></svg>',
);
