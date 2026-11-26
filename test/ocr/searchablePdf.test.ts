/**
 * The invisible text layer of searchable PDFs: checked with PDFium (the PDF engine of Chrome) – the
 * text must come out as it was read, and each line must lie where the OCR found it on the page as
 * shown, whatever the page rotation, crop box or skew of the line.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { glyphlessFont } from '../../src/server/ocr/glyphlessFont.js';
import type { Quad } from '../../src/server/ocr/image.js';
import { keepsOwnText, makeSearchablePdf } from '../../src/server/ocr/searchablePdf.js';
import { layoutLines, type LayoutLine, type LineBox } from '../../src/server/ocr/textLayer.js';
import { makeTempDir } from '../helpers/appHarness.js';
import { makePdf } from '../helpers/pdf.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Pdfium = any;

let libPromise: Promise<Pdfium> | null = null;
const pdfium = () => (libPromise ??= import('@hyzyla/pdfium').then((m) => m.PDFiumLibrary.init()));

interface PageProbe {
  text: string;
  /** Character shown at this point of the page (fractions of the page as shown, origin top left). */
  charAt(u: number, v: number): string | null;
  /** Width × height of the page as shown, in points. */
  size: [number, number];
}

/** Open a PDF with PDFium and look at its pages. */
async function probe(pdf: Uint8Array): Promise<PageProbe[]> {
  const lib = await pdfium();
  const doc = await lib.loadDocument(pdf);
  const m = (lib as any).module;
  const out: PageProbe[] = [];
  for (let i = 0; i < doc.getPageCount(); i++) {
    const page = doc.getPage(i);
    const handle = (page as any).pageIdx;
    const { originalWidth: w, originalHeight: h } = page.getOriginalSize();
    const text = page.getText() as string;
    const textPage = m._FPDFText_LoadPage(handle);
    const size = 10_000;
    // The glyphs are empty, so the tight boxes of the characters are too: like PDF viewers do for
    // selecting, look at the "loose" boxes (the em box of the font, here the box of the line).
    const ptr = m.wasmExports.malloc(16);
    const boxes: { ch: string; l: number; t: number; r: number; b: number }[] = [];
    for (let c = 0; c < m._FPDFText_CountChars(textPage); c++) {
      m._FPDFText_GetLooseCharBox(textPage, c, ptr);
      const [l, t, r, b] = [0, 1, 2, 3].map((k) => m.HEAPF32[ptr / 4 + k]);
      boxes.push({ ch: String.fromCodePoint(m._FPDFText_GetUnicode(textPage, c)), l, t, r, b });
    }
    const charAt = (u: number, v: number) => {
      m._FPDF_DeviceToPage(handle, 0, 0, size, size, 0, Math.round(u * size), Math.round(v * size), ptr, ptr + 8);
      const x = m.HEAPF64[ptr / 8];
      const y = m.HEAPF64[ptr / 8 + 1];
      // The box that holds the point with its centre closest to it (boxes of turned text overlap).
      let best: { ch: string; d: number } | null = null;
      for (const bx of boxes) {
        if (x < Math.min(bx.l, bx.r) || x > Math.max(bx.l, bx.r) || y < Math.min(bx.t, bx.b) || y > Math.max(bx.t, bx.b))
          continue;
        const d = Math.hypot(x - (bx.l + bx.r) / 2, y - (bx.t + bx.b) / 2);
        if (!best || d < best.d) best = { ch: bx.ch, d };
      }
      return best?.ch ?? null;
    };
    out.push({ text, charAt, size: [w, h] });
  }
  return out;
}

/** An upright box in fractions of the page. */
const rect = (x0: number, y0: number, x1: number, y1: number): LineBox => [x0, y0, x1, y0, x1, y1, x0, y1];

/** A box `w` long and `h` high from (x, y), turned clockwise by `deg` (on a square page). */
function turned(x: number, y: number, w: number, h: number, deg: number): LineBox {
  const [c, s] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
  return [x, y, x + w * c, y + w * s, x + w * c - h * s, y + w * s + h * c, x - h * s, y + h * c];
}

/** A slightly skewed scan: lines climbing by 3°. */
const skewedLines: LayoutLine[] = [
  { text: 'Stadtwerke Musterstadt GmbH', box: turned(0.12, 0.1, 0.6, 0.03, -3) },
  { text: 'Bitte überweisen Sie den Betrag bis zum 15.11.2026.', box: turned(0.1, 0.4, 0.8, 0.025, 3) },
];

/** A point inside character `i` of `n` of a line: along the middle of the box. */
function inside(box: LineBox, i: number, n: number): [number, number] {
  const t = (i + 0.5) / n;
  const [tlx, tly, trx, try_, brx, bry, blx, bly] = box;
  const topX = tlx + (trx - tlx) * t;
  const topY = tly + (try_ - tly) * t;
  const botX = blx + (brx - blx) * t;
  const botY = bly + (bry - bly) * t;
  return [(topX + botX) / 2, (topY + botY) / 2];
}

/** Every character of each line lies at its place. */
function expectPlaced(page: PageProbe, lines: LayoutLine[]) {
  for (const line of lines) {
    const chars = [...line.text];
    chars.forEach((ch, i) => {
      if (ch === ' ') return;
      const [u, v] = inside(line.box, i, chars.length);
      expect(page.charAt(u, v), `"${ch}" of "${line.text}" at ${u.toFixed(3)},${v.toFixed(3)}`).toBe(ch);
    });
  }
}

/** A scanned page: an image, no text. */
async function scanPdf(
  opts: { size?: [number, number]; rotate?: number; cropBox?: [number, number, number, number]; pages?: number } = {},
) {
  const doc = await PDFDocument.create();
  const png = await sharp({ create: { width: 200, height: 280, channels: 3, background: '#f4f4f0' } })
    .png()
    .toBuffer();
  const image = await doc.embedPng(png);
  for (let i = 0; i < (opts.pages ?? 1); i++) {
    const [w, h] = opts.size ?? [595, 842];
    const page = doc.addPage([w, h]);
    page.drawImage(image, { x: 0, y: 0, width: w, height: h });
    page.drawRectangle({ x: 40, y: 40, width: 100, height: 20, color: rgb(0.2, 0.2, 0.2) });
    if (opts.rotate) page.setRotation({ type: 'degrees', angle: opts.rotate } as never);
    if (opts.cropBox) page.setCropBox(...opts.cropBox);
  }
  return doc.save();
}

const lines: LayoutLine[] = [
  { text: 'Rechnung Nr. 4711', box: rect(0.1, 0.1, 0.6, 0.13) },
  { text: 'Müller & Söhne – Musterstraße 1', box: rect(0.1, 0.2, 0.9, 0.24) },
  { text: 'Betrag: 106,72 EUR', box: rect(0.5, 0.8, 0.9, 0.83) },
];

describe('searchable PDF', () => {
  it('lays the text over a scanned PDF where it was read', async () => {
    const result = await makeSearchablePdf(await scanPdf(), [{ lines, textChars: 0 }]);
    expect(result).toMatchObject({ pages: 1, kept: 0 });
    const [page] = await probe(result!.data);
    for (const l of lines) expect(page.text).toContain(l.text);
    expectPlaced(page, lines);
  });

  it.each([
    ['turned by /Rotate 90', { rotate: 90 }],
    ['turned by /Rotate 180', { rotate: 180 }],
    ['turned by /Rotate 270', { rotate: 270 }],
    ['with a crop box', { cropBox: [50, 100, 400, 600] as [number, number, number, number] }],
    [
      'turned and cropped, landscape',
      { size: [842, 595] as [number, number], rotate: 90, cropBox: [20, 30, 800, 560] as [number, number, number, number] },
    ],
  ])('places the text on a page %s', async (_name, opts) => {
    const result = await makeSearchablePdf(await scanPdf(opts), [{ lines, textChars: 0 }]);
    const [page] = await probe(result!.data);
    expectPlaced(page, lines);
  });

  it('follows skewed, vertical and upside-down lines', async () => {
    // A line turned by 12° (more than a skewed scan: a stamp, a label).
    const skewed = turned(0.2, 0.5, 0.5, 0.03, 12);
    // Read from top to bottom (spine of a folder): reading-order corners start at the top right.
    const vertical: LineBox = [0.93, 0.1, 0.93, 0.5, 0.9, 0.5, 0.9, 0.1];
    // Upside down: starts at the bottom right of the region.
    const upsideDown: LineBox = [0.8, 0.95, 0.3, 0.95, 0.3, 0.92, 0.8, 0.92];
    const special: LayoutLine[] = [
      { text: 'Schräg gescannt', box: skewed },
      { text: 'Ordner 2026', box: vertical },
      { text: 'Kopfüber', box: upsideDown },
    ];
    const result = await makeSearchablePdf(await scanPdf({ size: [700, 700] }), [{ lines: special, textChars: 0 }]);
    const [page] = await probe(result!.data);
    expectPlaced(page, special);
  });

  it('writes the lines of a skewed scan word by word, each where it lies', async () => {
    const result = await makeSearchablePdf(await scanPdf({ size: [700, 700], rotate: 90 }), [
      { lines: skewedLines, textChars: 0 },
    ]);
    const [page] = await probe(result!.data);
    for (const l of skewedLines) expect(page.text.replace(/\s+/g, ' ')).toContain(l.text);
    expectPlaced(page, skewedLines);
  });

  it('maps the lines the pipeline read on a turned page back onto the page', () => {
    // The OCR turned a 100×200 page by 90° clockwise (→ 200×100) and read a line at the top left.
    const quad: Quad = [
      [10, 10],
      [110, 10],
      [110, 30],
      [10, 30],
    ];
    const [line] = layoutLines([{ text: 'Seite', score: 1, quad }], 90, 100, 200);
    // On the page as shown that line runs from the bottom left upwards along the left edge.
    expect(line.box.map((v) => Math.round(v * 100) / 100)).toEqual([0.1, 0.95, 0.1, 0.45, 0.3, 0.45, 0.3, 0.95]);
    // Vertical text read turned by 90°: the reading order starts at the top right corner.
    const [tall] = layoutLines(
      [
        {
          text: 'Ordner',
          score: 1,
          quad: [
            [10, 10],
            [30, 10],
            [30, 110],
            [10, 110],
          ],
          turn: 1,
        },
      ],
      0,
      100,
      200,
    );
    expect(tall.box.slice(0, 2)).toEqual([0.3, 0.05]);
  });

  it('turns an image into a PDF page with its text', async () => {
    const png = await sharp({ create: { width: 1240, height: 1754, channels: 3, background: '#ffffff' } })
      .withMetadata({ density: 150 })
      .png()
      .toBuffer();
    const result = await makeSearchablePdf(png, [{ lines, textChars: 0 }]);
    const [page] = await probe(result!.data);
    // 1240 px at 150 dpi = 595 pt: A4.
    expect(page.size.map(Math.round)).toEqual([595, 842]);
    expectPlaced(page, lines);
  });

  it('keeps the JPEG data of a photo and sizes a page without resolution like A4', async () => {
    const jpeg = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#ffffff' } })
      .jpeg()
      .toBuffer();
    const result = await makeSearchablePdf(jpeg, [{ lines, textChars: 0 }]);
    const [page] = await probe(result!.data);
    expect(page.size.map(Math.round)).toEqual([632, 842]);
    expect(Buffer.from(result!.data).includes(jpeg.subarray(0, 64))).toBe(true);
    expectPlaced(page, lines);
  });

  it('follows the EXIF orientation of a photo like the OCR does', async () => {
    // Stored landscape, shown portrait (orientation 6: turn 90° clockwise).
    const jpeg = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#ffffff' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const result = await makeSearchablePdf(jpeg, [{ lines, textChars: 0 }]);
    const [page] = await probe(result!.data);
    expect(page.size[1]).toBeGreaterThan(page.size[0]);
    expectPlaced(page, lines);
  });

  it('gives every page of a multi-page TIFF its own text', async () => {
    const dir = makeTempDir();
    try {
      const pages = await Promise.all(
        [0, 1].map((i) =>
          sharp({ create: { width: 600, height: 800, channels: 3, background: i ? '#eeeeee' : '#ffffff' } })
            .png()
            .toBuffer(),
        ),
      );
      const tiff = path.join(dir, 'scan.tiff');
      await sharp(pages, { join: { animated: true } })
        .tiff()
        .toFile(tiff);
      const second: LayoutLine[] = [{ text: 'Seite zwei', box: rect(0.1, 0.5, 0.5, 0.53) }];
      const result = await makeSearchablePdf(fs.readFileSync(tiff), [
        { lines, textChars: 0 },
        { lines: second, textChars: 0 },
      ]);
      const probed = await probe(result!.data);
      expect(probed).toHaveLength(2);
      expectPlaced(probed[0], lines);
      expectPlaced(probed[1], second);
      expect(probed[1].text).not.toContain('Rechnung');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves pages with their own text as they are – and makes nothing when that is all of them', async () => {
    const digital = makePdf([['Rechnung Nr. 4711 der Stadtwerke Musterstadt über 106,72 EUR']]);
    const page = { lines, textChars: 52 };
    expect(keepsOwnText(page)).toBe(true);
    expect(keepsOwnText({ lines, textChars: 8 })).toBe(false); // a stamp, a page number
    expect(await makeSearchablePdf(digital, [page])).toBeNull();
    expect(await makeSearchablePdf(await scanPdf(), [{ lines: [], textChars: 0 }])).toBeNull();

    const mixed = await makeSearchablePdf(await scanPdf({ pages: 3 }), [
      { lines, textChars: 0 },
      { lines, textChars: 300 },
    ]);
    expect(mixed).toMatchObject({ pages: 1, kept: 1 });
    const probed = await probe(mixed!.data);
    expect(probed).toHaveLength(3); // the third page was not read (maxPages) and stays as it is
    expect(probed[0].text).toContain('Rechnung Nr. 4711');
    expect(probed[1].text).toBe('');
  });

  it('gives back characters beyond the Basic Multilingual Plane', async () => {
    const rare: LayoutLine[] = [{ text: '𠀋 Straße 𝔄', box: rect(0.1, 0.1, 0.5, 0.13) }];
    const result = await makeSearchablePdf(await scanPdf(), [{ lines: rare, textChars: 0 }]);
    const [page] = await probe(result!.data);
    expect(page.text).toContain('𠀋 Straße 𝔄');
  });

  it('refuses a password protected PDF', async () => {
    const encrypted = Buffer.from(
      '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n3 0 obj << /Filter /Standard /V 1 /R 2 /O (x) /U (y) /P -4 >> endobj\ntrailer << /Root 1 0 R /Encrypt 3 0 R >>\n%%EOF\n',
      'latin1',
    );
    await expect(makeSearchablePdf(encrypted, [{ lines, textChars: 0 }])).rejects.toThrow(/encrypt/i);
  });

  it('builds a valid TrueType font', () => {
    const font = glyphlessFont();
    expect(font.readUInt32BE(0)).toBe(0x00010000);
    let sum = 0;
    for (let i = 0; i < font.length; i += 4) sum = (sum + font.readUInt32BE(i)) >>> 0;
    expect(sum).toBe(0xb1b0afba);
  });

  const pdftotext = (() => {
    try {
      execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!pdftotext)('gives Paperless-ngx the text (pdftotext, as its parser uses)', async () => {
    const dir = makeTempDir();
    try {
      const result = await makeSearchablePdf(await scanPdf({ rotate: 90 }), [{ lines, textChars: 0 }]);
      const file = path.join(dir, 'scan.pdf');
      fs.writeFileSync(file, result!.data);
      // As Paperless-ngx reads the text of a PDF: pdftotext -layout, runs of spaces collapsed.
      const text = execFileSync('pdftotext', ['-q', '-layout', '-enc', 'UTF-8', file, '-'], { encoding: 'utf8' }).replace(
        /[^\S\r\n]+/g,
        ' ',
      );
      for (const l of lines) expect(text).toContain(l.text);

      // A skewed scan: no word is cut into pieces (pdftotext starts a new word when the baseline moves).
      const skewed = await makeSearchablePdf(await scanPdf({ size: [700, 700] }), [{ lines: skewedLines, textChars: 0 }]);
      fs.writeFileSync(file, skewed!.data);
      const words = execFileSync('pdftotext', ['-q', '-layout', '-enc', 'UTF-8', file, '-'], { encoding: 'utf8' }).split(/\s+/);
      for (const l of skewedLines) for (const word of l.text.split(' ')) expect(words).toContain(word);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
