/**
 * File handling of the intake: type detection by magic bytes, page count and text layer of PDFs
 * (PDFium), thumbnails (PDFium + sharp). The native/WASM libraries are optional dependencies; without
 * them documents are still stored, only without text layer and thumbnail.
 */
import { setImmediate as yieldTick } from 'node:timers/promises';
import { logger } from '../logger.js';

const log = logger.child({ module: 'archive' });

/** File types the archive accepts (the OCR pipeline reads them). */
export const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff', 'image/webp', 'image/gif', 'image/bmp'] as const;

const MAX_TEXT_PAGES = 1000;
const THUMB_WIDTH = 480;

/** The real type of a file from its first bytes (the name and the declared type are not trusted). */
export function sniffType(bytes: Uint8Array): string | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024));
  const head = b.toString('latin1');
  if (head.includes('%PDF-')) return 'application/pdf';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.startsWith('II*\0') || head.startsWith('MM\0*')) return 'image/tiff';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('BM')) return 'image/bmp';
  return null;
}

export function extensionFor(mime: string): string {
  return (
    { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/tiff': 'tif', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' }[mime] ??
    'bin'
  );
}

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
        const { originalWidth } = page.getOriginalSize();
        const r = await page.render({ scale: Math.min(3, THUMB_WIDTH / Math.max(originalWidth, 1)), render: 'bitmap' } as Parameters<typeof page.render>[0]);
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
    return null;
  }
}

/** Neutral placeholder thumbnail (our own markup, safe to serve). */
export const PLACEHOLDER_THUMB = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400"><rect width="300" height="400" fill="#f3f4f6"/><path d="M110 140h80v120h-80z" fill="none" stroke="#c4c7cf" stroke-width="8"/></svg>',
);
