/**
 * Turn a document file (PDF or image) into page images for OCR.
 * PDFs are rendered with PDFium (WebAssembly, no native dependencies),
 * images are decoded with sharp (EXIF orientation, multi-page TIFF).
 */
import { fromPixels, type RawImage } from './image.js';

export interface RenderOptions {
  /** Resolution for PDF pages. */
  dpi: number;
  /** Stop after this many pages (0 = all). */
  maxPages: number;
  /** Images larger than this (longest side, px) are scaled down. */
  maxSide?: number;
}

export interface RenderedPage {
  index: number;
  /** Number of pages in the document (before maxPages). */
  total: number;
  image: RawImage;
  /** Characters (without white space) of the text the page already has (PDF text layer; 0 for images). */
  textChars: number;
}

const MAX_SIDE = 7000;

export function isPdf(bytes: Uint8Array): boolean {
  // "%PDF" may be preceded by a few bytes of garbage.
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

type PdfiumModule = typeof import('@hyzyla/pdfium');
let pdfium: Promise<InstanceType<PdfiumModule['PDFiumLibrary']>> | null = null;

async function pdfiumLibrary() {
  pdfium ??= import('@hyzyla/pdfium').then((m) => m.PDFiumLibrary.init());
  return pdfium;
}

async function* renderPdf(bytes: Uint8Array, opts: RenderOptions): AsyncGenerator<RenderedPage> {
  const lib = await pdfiumLibrary();
  let doc;
  try {
    doc = await lib.loadDocument(bytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(/password/i.test(msg) ? 'The PDF is password protected' : `The PDF cannot be opened: ${msg}`, { cause: err });
  }
  try {
    const total = doc.getPageCount();
    const count = opts.maxPages > 0 ? Math.min(total, opts.maxPages) : total;
    const maxSide = opts.maxSide ?? MAX_SIDE;
    for (let i = 0; i < count; i++) {
      const page = doc.getPage(i);
      const { originalWidth: width, originalHeight: height } = page.getOriginalSize();
      const scale = Math.min(opts.dpi / 72, maxSide / Math.max(width, height, 1));
      const r = await page.render({ scale, render: 'bitmap', colorSpace: 'Gray' } as Parameters<typeof page.render>[0]);
      let textChars = 0;
      try {
        textChars = page.getText().replace(/\s+/g, '').length;
      } catch {
        // No text page – nothing there.
      }
      yield { index: i, total, image: fromPixels(r.data, r.width, r.height, 1), textChars };
    }
  } finally {
    doc.destroy();
  }
}

async function* renderImage(bytes: Uint8Array, opts: RenderOptions): AsyncGenerator<RenderedPage> {
  const sharp = (await import('sharp')).default;
  const meta = await sharp(bytes).metadata();
  const total = meta.pages ?? 1;
  const count = opts.maxPages > 0 ? Math.min(total, opts.maxPages) : total;
  const maxSide = opts.maxSide ?? MAX_SIDE;
  for (let i = 0; i < count; i++) {
    const { data, info } = await sharp(bytes, { page: i, limitInputPixels: 30_000 * 30_000 })
      .rotate() // EXIF orientation of photos
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    yield {
      index: i,
      total,
      image: fromPixels(new Uint8Array(data.buffer, data.byteOffset, data.length), info.width, info.height, info.channels as 1 | 3 | 4),
      textChars: 0,
    };
  }
}

/** Page images of a PDF or image file, one at a time (keeps memory low for long documents). */
export function renderPages(bytes: Uint8Array, opts: RenderOptions): AsyncGenerator<RenderedPage> {
  return isPdf(bytes) ? renderPdf(bytes, opts) : renderImage(bytes, opts);
}
