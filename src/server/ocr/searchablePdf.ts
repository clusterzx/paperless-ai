/**
 * Searchable PDF: the OCR text is laid over each page as invisible text (text render mode 3) in
 * the places PaddleOCR found it – search, select and copy work in every PDF viewer, the page looks
 * exactly as before. Like OCRmyPDF's output, but with the text PaddleOCR read.
 *
 * - PDF: the pages get the text layer; pages that already carry most of their text keep it as it is.
 * - Image (JPEG, PNG, TIFF, …): becomes a PDF with one page per image (JPEG data is kept as is).
 */
import zlib from 'node:zlib';
import { PDFDocument, PDFString, type PDFPage, type PDFRef } from 'pdf-lib';
import { ADVANCE, FONT_NAME, glyphlessFont, UNITS } from './glyphlessFont.js';
import { isPdf } from './render.js';
import type { LayoutLine, PageLayout } from './textLayer.js';

export interface SearchablePdf {
  data: Uint8Array;
  /** Pages that got the OCR text. */
  pages: number;
  /** Pages that kept the text they already had. */
  kept: number;
}

/** A page with fewer characters of its own than this gets the OCR text in any case. */
const MIN_OWN_TEXT = 20;

/**
 * Whether a page keeps its own text instead of getting the OCR text: it has a text layer with a
 * good part of what the OCR read (a digital page, an earlier OCR) – not just a stamp or a footer.
 */
export function keepsOwnText(page: PageLayout): boolean {
  const read = page.lines.reduce((s, l) => s + l.text.replace(/\s+/g, '').length, 0);
  return page.textChars >= MIN_OWN_TEXT && page.textChars >= 0.3 * read;
}

/**
 * The file with the OCR text laid over its pages, or null when no page needs it (no text was read,
 * or every page has its own). `pages[i]` belongs to page i; pages beyond it (maxPages) stay as they are.
 * `always`: a PDF in any case – a PDF without a page to change comes back as it is, an image becomes
 * a PDF without text (remote OCR: Paperless-ngx expects one).
 */
export async function makeSearchablePdf(file: Uint8Array, pages: PageLayout[], opts: { always?: boolean } = {}): Promise<SearchablePdf | null> {
  const pdf = isPdf(file);
  const kept = pages.filter((p) => p.lines.length && keepsOwnText(p)).length;
  const wanted = pages.filter((p) => p.lines.length && !keepsOwnText(p));
  if (!wanted.length) {
    if (!opts.always) return null;
    if (pdf) return { data: file, pages: 0, kept };
  }
  const doc = pdf ? await PDFDocument.load(file, { updateMetadata: false }) : await imagesToPdf(file);
  const pdfPages = doc.getPages();
  const font = embedFont(
    doc,
    wanted.flatMap((p) => p.lines.map((l) => l.text)),
  );
  let written = 0;
  pages.forEach((layout, i) => {
    const page = pdfPages[i];
    if (page && layout.lines.length && !keepsOwnText(layout) && addTextLayer(page, layout, font)) written++;
  });
  if (!written) {
    if (!opts.always) return null;
    if (pdf) return { data: file, pages: 0, kept };
  }
  const data = await doc.save({ useObjectStreams: true });
  return { data, pages: written, kept };
}

// ------------------------------------------------------------------ font

interface EmbeddedFont {
  ref: PDFRef;
  /** The text as character codes for a Tj operator (hex string without brackets) and their count. */
  encode(text: string): { hex: string; count: number };
}

/** First code for characters outside the Basic Multilingual Plane (no BMP character uses the surrogate range). */
const EXTRA_CODES = 0xd800;
const EXTRA_MAX = 0x800;

const hex4 = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');

/**
 * The glyphless font as Type0/CIDFontType2 with Identity-H: a character code is the UTF-16 code
 * unit, every code shows glyph 1 (empty, half an em wide), the ToUnicode map gives the text back.
 */
function embedFont(doc: PDFDocument, texts: string[]): EmbeddedFont {
  const ctx = doc.context;
  // Characters beyond U+FFFF get their own codes (a code is two bytes).
  const extra = new Map<number, number>();
  for (const text of texts) {
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (cp > 0xffff && !extra.has(cp) && extra.size < EXTRA_MAX) extra.set(cp, EXTRA_CODES + extra.size);
    }
  }
  const codeOf = (cp: number) => {
    if (cp > 0xffff) return extra.get(cp) ?? 0xfffd;
    return cp >= 0xd800 && cp <= 0xdfff ? 0xfffd : cp;
  };

  const ranges: string[] = [];
  for (let hi = 0; hi < 256; hi++) {
    if (hi >= 0xd8 && hi <= 0xdf) continue;
    const start = hex4(hi << 8);
    ranges.push(`<${start}> <${hex4((hi << 8) | 0xff)}> <${start}>`);
  }
  const chars = [...extra].map(([cp, code]) => {
    const s = String.fromCodePoint(cp);
    return `<${hex4(code)}> <${hex4(s.charCodeAt(0))}${hex4(s.charCodeAt(1))}>`;
  });
  const blocks = (entries: string[], kind: 'bfrange' | 'bfchar') => {
    const out: string[] = [];
    for (let i = 0; i < entries.length; i += 100) {
      const part = entries.slice(i, i + 100);
      out.push(`${part.length} begin${kind}`, ...part, `end${kind}`);
    }
    return out;
  };
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...blocks(ranges, 'bfrange'),
    ...blocks(chars, 'bfchar'),
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');

  const fontFile = glyphlessFont();
  const fontFileRef = ctx.register(compressed(doc, fontFile, { Length1: fontFile.length }));
  const descriptor = ctx.register(
    ctx.obj({
      Type: 'FontDescriptor',
      FontName: FONT_NAME,
      Flags: 4, // symbolic
      FontBBox: [0, 0, ADVANCE, UNITS],
      ItalicAngle: 0,
      Ascent: UNITS,
      Descent: 0,
      CapHeight: UNITS,
      StemV: 80,
      FontFile2: fontFileRef,
    }),
  );
  // Every code (CID) → glyph 1.
  const toGid = Buffer.alloc(0x20000);
  for (let i = 1; i < toGid.length; i += 2) toGid[i] = 1;
  const cidFont = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: FONT_NAME,
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
      FontDescriptor: descriptor,
      DW: ADVANCE,
      CIDToGIDMap: ctx.register(compressed(doc, toGid)),
    }),
  );
  const ref = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: FONT_NAME,
      Encoding: 'Identity-H',
      DescendantFonts: [cidFont],
      ToUnicode: ctx.register(compressed(doc, Buffer.from(cmap, 'latin1'))),
    }),
  );
  return {
    ref,
    encode(text) {
      let hex = '';
      let count = 0;
      for (const ch of text) {
        hex += hex4(codeOf(ch.codePointAt(0)!));
        count++;
      }
      return { hex, count };
    },
  };
}

/** A stream compressed with zlib (faster than the JavaScript deflate of pdf-lib). */
function compressed(doc: PDFDocument, data: Uint8Array, dict: Record<string, unknown> = {}) {
  return doc.context.stream(zlib.deflateSync(data), { ...dict, Filter: 'FlateDecode' } as never);
}

// ------------------------------------------------------------------ text layer

type Point = [number, number];

/** Fractions of the page as shown (origin top left, y down) → PDF user space of the page. */
function displayToUser(page: PDFPage): (u: number, v: number) => Point {
  const rect = (r: { x: number; y: number; width: number; height: number }) => ({
    x0: Math.min(r.x, r.x + r.width),
    y0: Math.min(r.y, r.y + r.height),
    x1: Math.max(r.x, r.x + r.width),
    y1: Math.max(r.y, r.y + r.height),
  });
  let media = { x0: 0, y0: 0, x1: 612, y1: 792 };
  try {
    const m = rect(page.getMediaBox());
    if (m.x1 > m.x0 && m.y1 > m.y0) media = m;
  } catch {
    // No MediaBox: Letter, as PDF readers assume.
  }
  // What is shown: the CropBox within the MediaBox (as PDFium renders it for the OCR).
  let box = media;
  if (page.node.CropBox()) {
    const c = rect(page.getCropBox());
    const cut = {
      x0: Math.max(c.x0, media.x0),
      y0: Math.max(c.y0, media.y0),
      x1: Math.min(c.x1, media.x1),
      y1: Math.min(c.y1, media.y1),
    };
    if (cut.x1 > cut.x0 && cut.y1 > cut.y0) box = cut;
  }
  const { x0, y0, x1, y1 } = box;
  const w = x1 - x0;
  const h = y1 - y0;
  // /Rotate turns the page clockwise for display.
  const rotate = ((Math.round(page.getRotation().angle / 90) % 4) + 4) % 4;
  if (rotate === 1) return (u, v) => [x0 + v * w, y0 + u * h];
  if (rotate === 2) return (u, v) => [x1 - u * w, y0 + v * h];
  if (rotate === 3) return (u, v) => [x1 - v * w, y1 - u * h];
  return (u, v) => [x0 + u * w, y1 - v * h];
}

/** Numbers for a content stream: no exponents, at most 3 decimals. */
function num(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

/**
 * Lines turned by less than this from the axes of the page (a skewed scan) are written word by word
 * along the axis. pdftotext, which Paperless-ngx reads PDFs with, starts a new word whenever the
 * baseline moves by more than half a point – a line that climbs by 3° would come out cut into pieces.
 */
const STRAIGHTEN_BELOW = (10 * Math.PI) / 180;

/** One run of text: `count` characters from `origin` along `dir`, `width` long and `height` high. */
interface Run {
  hex: string;
  count: number;
  origin: Point;
  dir: Point;
  width: number;
  height: number;
}

function runOperators(run: Run): string {
  const [ux, uy] = run.dir;
  // "Up" is a quarter turn counter-clockwise from the direction of the text.
  const [vx, vy] = [-uy, ux];
  // The em box (no descender) fills the height of the line, its width is stretched to the run's.
  const scale = (100 * run.width) / (run.count * (ADVANCE / UNITS) * run.height);
  return `/FONT ${num(run.height)} Tf ${num(ux)} ${num(uy)} ${num(vx)} ${num(vy)} ${num(run.origin[0])} ${num(run.origin[1])} Tm ${num(scale)} Tz <${run.hex}> Tj`;
}

/** The runs of one line: the line as it lies, or its words along the page axis when it is only slightly skewed. */
function lineRuns(line: LayoutLine, toUser: (u: number, v: number) => Point, font: EmbeddedFont): Run[] {
  const b = line.box;
  const [tl, tr, br, bl] = [0, 2, 4, 6].map((i) => toUser(b[i], b[i + 1]));
  // Direction and length of the line: the mean of its top and bottom edge (a skewed or perspective
  // scan has edges of slightly different length).
  const dx = (br[0] - bl[0] + tr[0] - tl[0]) / 2;
  const dy = (br[1] - bl[1] + tr[1] - tl[1]) / 2;
  const length = Math.hypot(dx, dy);
  if (length < 0.5) return [];
  const u: Point = [dx / length, dy / length];
  const height = ((tl[0] - bl[0] + tr[0] - br[0]) / 2) * -u[1] + ((tl[1] - bl[1] + tr[1] - br[1]) / 2) * u[0];
  if (height < 0.5) return [];

  const angle = Math.atan2(u[1], u[0]);
  const axisAngle = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
  const skew = angle - axisAngle;
  if (Math.abs(skew) < 1e-3 || Math.abs(skew) >= STRAIGHTEN_BELOW) {
    const { hex, count } = font.encode(line.text);
    return count ? [{ hex, count, origin: bl, dir: u, width: length, height }] : [];
  }
  // Word by word (each with the spaces after it): along the axis, centred on its piece of the line.
  const axis: Point = [Math.round(Math.cos(axisAngle)), Math.round(Math.sin(axisAngle))];
  const chars = [...line.text];
  const step = length / chars.length;
  const runs: Run[] = [];
  for (let i = 0; i < chars.length;) {
    let j = i;
    while (j < chars.length && chars[j] !== ' ') j++;
    while (j < chars.length && chars[j] === ' ') j++;
    const { hex, count } = font.encode(chars.slice(i, j).join(''));
    const mid = ((i + j) / 2) * step;
    const width = (j - i) * step * Math.cos(skew);
    const centre: Point = [bl[0] + u[0] * mid, bl[1] + u[1] * mid];
    runs.push({
      hex,
      count,
      origin: [centre[0] - (axis[0] * width) / 2, centre[1] - (axis[1] * width) / 2],
      dir: axis,
      width,
      height,
    });
    i = j;
  }
  return runs;
}

/** Lay the lines of a page over it as invisible text; false when none could be placed. */
function addTextLayer(page: PDFPage, layout: PageLayout, font: EmbeddedFont): boolean {
  const toUser = displayToUser(page);
  const runs = layout.lines.flatMap((line) => lineRuns(line, toUser, font));
  if (!runs.length) return false;
  const key = page.node.newFontDictionary('OcrText', font.ref).asString();
  const content = ['BT', '3 Tr', ...runs.map((r) => runOperators(r).replace('/FONT', key)), 'ET', ''].join('\n');
  page.node.addContentStream(page.doc.context.register(compressed(page.doc, Buffer.from(content, 'latin1'))));
  return true;
}

// ------------------------------------------------------------------ images

/** Pages of a PDF made of an image file, one per image (multi-page TIFF). */
async function imagesToPdf(file: Uint8Array): Promise<PDFDocument> {
  const sharp = (await import('sharp')).default;
  const meta = await sharp(file).metadata();
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setProducer('Paperless-AI');
  const ctx = doc.context;
  const total = meta.pages ?? 1;
  // Without a usable resolution the longer side becomes as long as the one of an A4 page (72 dpi is
  // what cameras and image tools write when they know none).
  const dpi = meta.density && meta.density > 72 && meta.density <= 2400 ? meta.density : null;
  for (let i = 0; i < total; i++) {
    let image: { ref: PDFRef; width: number; height: number };
    const plainJpeg =
      meta.format === 'jpeg' && total === 1 && (meta.orientation ?? 1) === 1 && (meta.channels === 1 || meta.channels === 3);
    if (plainJpeg && meta.width && meta.height) {
      // The JPEG data as it is: no quality loss, no growth.
      const stream = ctx.stream(file, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: meta.width,
        Height: meta.height,
        ColorSpace: meta.channels === 1 ? 'DeviceGray' : 'DeviceRGB',
        BitsPerComponent: 8,
        Filter: 'DCTDecode',
      });
      image = { ref: ctx.register(stream), width: meta.width, height: meta.height };
    } else {
      const gray = (meta.channels ?? 3) <= 2 || meta.space === 'b-w';
      const { data, info } = await sharp(file, { page: i, limitInputPixels: 30_000 * 30_000 })
        .rotate() // EXIF orientation, as the OCR saw it
        .flatten({ background: '#ffffff' })
        .toColourspace(gray ? 'b-w' : 'srgb')
        .raw()
        .toBuffer({ resolveWithObject: true });
      const stream = compressed(doc, data, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: info.width,
        Height: info.height,
        ColorSpace: info.channels === 1 ? 'DeviceGray' : 'DeviceRGB',
        BitsPerComponent: 8,
      });
      image = { ref: ctx.register(stream), width: info.width, height: info.height };
    }
    const scale = dpi ? 72 / dpi : 842 / Math.max(image.width, image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    const page = doc.addPage([width, height]);
    const name = page.node.newXObject('Image', image.ref).asString();
    const content = `q ${num(width)} 0 0 ${num(height)} 0 0 cm ${name} Do Q\n`;
    page.node.addContentStream(ctx.register(ctx.stream(content)));
  }
  return doc;
}
