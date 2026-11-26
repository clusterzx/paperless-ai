/**
 * A TrueType font without any visible glyph, for the invisible text layer of searchable PDFs (the
 * idea of Tesseract's and OCRmyPDF's "GlyphLessFont"): every character shows the same glyph half
 * an em wide that has no area – a single line from corner to corner of its box – so the text can be
 * found, selected and copied but never shows, even where a reader ignores the invisible text mode.
 * The line gives the glyph its extent: PDFium drops text whose glyphs have none once it is turned.
 * Built here instead of shipping a binary file – the font only has to satisfy PDF readers.
 */

/** Units per em; every glyph is ADVANCE wide and the em box spans 0…UNITS (no descender). */
export const UNITS = 1000;
export const ADVANCE = 500;
export const FONT_NAME = 'GlyphLessFont';

class Writer {
  private readonly parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    return this.u8(v >> 8).u8(v);
  }
  i16(v: number) {
    return this.u16(v < 0 ? v + 0x10000 : v);
  }
  u32(v: number) {
    return this.u16((v >>> 16) & 0xffff).u16(v & 0xffff);
  }
  bytes(b: Iterable<number>) {
    for (const v of b) this.u8(v);
    return this;
  }
  zeros(n: number) {
    for (let i = 0; i < n; i++) this.u8(0);
    return this;
  }
  done(): Buffer {
    return Buffer.from(this.parts);
  }
}

function checksum(data: Buffer): number {
  const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

function nameTable(): Buffer {
  const names: [number, string][] = [
    [1, FONT_NAME],
    [2, 'Regular'],
    [3, `${FONT_NAME}-1.0`],
    [4, FONT_NAME],
    [5, 'Version 1.0'],
    [6, FONT_NAME],
  ];
  const strings = names.map(([, s]) => Buffer.from(s, 'utf16le').swap16());
  const w = new Writer()
    .u16(0)
    .u16(names.length)
    .u16(6 + names.length * 12);
  let offset = 0;
  names.forEach(([id], i) => {
    w.u16(3).u16(1).u16(0x409).u16(id).u16(strings[i].length).u16(offset);
    offset += strings[i].length;
  });
  for (const s of strings) w.bytes(s);
  return w.done();
}

let cached: Buffer | null = null;

/** The font file (TrueType, two glyphs: an empty .notdef and the one every character uses). */
export function glyphlessFont(): Buffer {
  if (cached) return cached;
  const glyphs = 2;
  // prettier-ignore
  const tables: Record<string, Buffer> = {
    'OS/2': new Writer()
      .u16(4) // version
      .i16(ADVANCE) // xAvgCharWidth
      .u16(400) // usWeightClass
      .u16(5) // usWidthClass
      .u16(0) // fsType: installable
      .i16(650).i16(600).i16(0).i16(75) // subscript size and offset
      .i16(650).i16(600).i16(0).i16(350) // superscript size and offset
      .i16(50).i16(250) // strikeout size and position
      .i16(0) // sFamilyClass
      .zeros(10) // panose
      .u32(0).u32(0).u32(0).u32(0) // ulUnicodeRange1-4
      .bytes(Buffer.from('NONE', 'latin1')) // achVendID
      .u16(0x40) // fsSelection: regular
      .u16(0x20) // usFirstCharIndex
      .u16(0xffff) // usLastCharIndex
      .i16(UNITS).i16(0).i16(0) // sTypoAscender, sTypoDescender, sTypoLineGap
      .u16(UNITS).u16(0) // usWinAscent, usWinDescent
      .u32(1).u32(0) // ulCodePageRange1-2
      .i16(UNITS / 2).i16(UNITS) // sxHeight, sCapHeight
      .u16(0).u16(0x20).u16(1) // usDefaultChar, usBreakChar, usMaxContext
      .done(),
    // Format 4 with only the closing segment: no character maps to a glyph through the font itself
    // (the PDF maps every character code to glyph 1, see searchablePdf.ts).
    cmap: new Writer()
      .u16(0).u16(1) // version, one subtable
      .u16(3).u16(1).u32(12) // Windows, Unicode BMP
      .u16(4).u16(24).u16(0) // format, length, language
      .u16(2).u16(2).u16(0).u16(0) // segCountX2, searchRange, entrySelector, rangeShift
      .u16(0xffff).u16(0) // endCode, reservedPad
      .u16(0xffff).i16(1).u16(0) // startCode, idDelta, idRangeOffset
      .done(),
    // .notdef is empty; glyph 1 is one contour of two points, (0,0) → (ADVANCE,UNITS): no area.
    glyf: new Writer()
      .i16(1) // numberOfContours
      .i16(0).i16(0).i16(ADVANCE).i16(UNITS) // xMin, yMin, xMax, yMax
      .u16(1) // endPtsOfContours
      .u16(0) // instructionLength
      .u8(1).u8(1) // flags: on curve, 16-bit coordinates
      .i16(0).i16(ADVANCE) // x deltas
      .i16(0).i16(UNITS) // y deltas
      .done(),
    head: new Writer()
      .u32(0x00010000) // version
      .u32(0x00010000) // fontRevision
      .u32(0) // checkSumAdjustment, set below
      .u32(0x5f0f3cf5) // magicNumber
      .u16(0x000b) // flags: baseline and lsb at 0, integer scaling
      .u16(UNITS)
      .zeros(16) // created, modified
      .i16(0).i16(0).i16(ADVANCE).i16(UNITS) // xMin, yMin, xMax, yMax
      .u16(0) // macStyle
      .u16(3) // lowestRecPPEM
      .i16(2) // fontDirectionHint
      .i16(0) // indexToLocFormat: short offsets
      .i16(0) // glyphDataFormat
      .done(),
    hhea: new Writer()
      .u32(0x00010000)
      .i16(UNITS).i16(0).i16(0) // ascender, descender, lineGap
      .u16(ADVANCE) // advanceWidthMax
      .i16(0).i16(0).i16(ADVANCE) // minLeftSideBearing, minRightSideBearing, xMaxExtent
      .i16(1).i16(0).i16(0) // caretSlopeRise, caretSlopeRun, caretOffset
      .zeros(8) // reserved
      .i16(0) // metricDataFormat
      .u16(glyphs) // numberOfHMetrics
      .done(),
    hmtx: new Writer().u16(ADVANCE).i16(0).u16(ADVANCE).i16(0).done(),
    loca: new Writer().u16(0).u16(0).u16(12).done(), // offsets / 2
    maxp: new Writer()
      .u32(0x00010000)
      .u16(glyphs)
      .u16(2).u16(1).u16(0).u16(0) // maxPoints, maxContours, maxCompositePoints, maxCompositeContours
      .u16(2) // maxZones
      .zeros(16) // maxTwilightPoints … maxComponentDepth
      .done(),
    name: nameTable(),
    post: new Writer()
      .u32(0x00030000) // version 3: no glyph names
      .u32(0) // italicAngle
      .i16(-100).i16(50) // underlinePosition, underlineThickness
      .u32(0) // isFixedPitch (all glyphs have the same width, but this is no monospace font for a reader)
      .zeros(16) // memory hints
      .done(),
  };

  const tags = Object.keys(tables).sort();
  const count = tags.length;
  const entrySelector = Math.floor(Math.log2(count));
  const searchRange = 2 ** entrySelector * 16;
  const header = new Writer()
    .u32(0x00010000)
    .u16(count)
    .u16(searchRange)
    .u16(entrySelector)
    .u16(count * 16 - searchRange);
  let offset = 12 + count * 16;
  const body: Buffer[] = [];
  for (const tag of tags) {
    const data = tables[tag];
    header
      .bytes(Buffer.from(tag.padEnd(4, ' '), 'latin1'))
      .u32(checksum(data))
      .u32(offset)
      .u32(data.length);
    const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
    body.push(padded);
    offset += padded.length;
  }
  const font = Buffer.concat([header.done(), ...body]);
  // head.checkSumAdjustment makes the checksum of the whole file 0xB1B0AFBA.
  const headOffset =
    12 + count * 16 + tags.slice(0, tags.indexOf('head')).reduce((s, t) => s + Math.ceil(tables[t].length / 4) * 4, 0);
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headOffset + 8);
  cached = font;
  return font;
}
