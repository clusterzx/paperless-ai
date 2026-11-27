import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ctcDecode, parseCharacterDict } from '../../src/server/ocr/ctc.js';
import { convexHull, dbPostprocess, minAreaRect, orderQuad } from '../../src/server/ocr/detPost.js';
import { createImage, cropQuad, fromPixels, resize, rotate90, toTensor, IMAGENET, type Point, type Quad, type RawImage } from '../../src/server/ocr/image.js';
import { linesToText, skewAngle, type OcrLine } from '../../src/server/ocr/layout.js';
import { candidateProviders } from '../../src/server/ocr/pipeline.js';
import { assessText } from '../../src/server/ocr/quality.js';
import { isPdf } from '../../src/server/ocr/render.js';
import { DETECTION_MODELS, parseDbOptions, V6_MODELS } from '../../src/server/ocr/models.js';
import { effectiveOcrModel, OCR_LANGUAGES, OCR_V6_LANGUAGES } from '../../src/shared/ocr.js';

function rect(x: number, y: number, w: number, h: number): Quad {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

const line = (text: string, quad: Quad): OcrLine => ({ text, score: 0.99, quad });

describe('character dictionary and CTC decoding', () => {
  it('reads the block list of an inference.yml, including quoted entries', () => {
    const yml = ['PostProcess:', '  name: CTCLabelDecode', '  character_dict:', "  - '0'", '  - a', "  - ''''", '  - "\\u00e4"', '  - ß', 'Other: 1'].join('\n');
    expect(parseCharacterDict(yml)).toEqual(['0', 'a', "'", 'ä', 'ß']);
    expect(() => parseCharacterDict('Global: {}')).toThrow(/character_dict/);
  });

  it('collapses repeats, drops blanks and averages the confidence', () => {
    const chars = ['a', 'b', ' '];
    // steps: a a blank a b b space
    const seq = [1, 1, 0, 1, 2, 2, 3];
    const classes = 4;
    const probs = new Float32Array(seq.length * classes);
    seq.forEach((c, t) => (probs[t * classes + c] = 0.9));
    const [r] = ctcDecode(probs, 1, seq.length, classes, chars);
    expect(r.text).toBe('aab ');
    expect(r.score).toBeCloseTo(0.9);
  });
});

describe('DB post-processing', () => {
  it('finds the minimum-area rectangle of a rotated box', () => {
    const angle = Math.PI / 12;
    const pts: Point[] = [];
    for (let x = 0; x <= 40; x++) for (const y of [0, 10]) pts.push([x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)]);
    const r = minAreaRect(convexHull(pts));
    expect(Math.max(r.w, r.h)).toBeCloseTo(40, 0);
    expect(Math.min(r.w, r.h)).toBeCloseTo(10, 0);
  });

  it('orders corners top-left, top-right, bottom-right, bottom-left', () => {
    expect(orderQuad([[10, 5], [0, 0], [0, 5], [10, 0]])).toEqual([[0, 0], [10, 0], [10, 5], [0, 5]]);
  });

  it('turns text regions of the probability map into grown boxes in source coordinates', () => {
    const w = 64;
    const h = 32;
    const prob = new Float32Array(w * h);
    const fill = (x0: number, y0: number, x1: number, y1: number, p: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) prob[y * w + x] = p;
    };
    fill(4, 4, 44, 10, 0.95); // a text line
    fill(4, 20, 6, 22, 0.95); // a speck – too small
    fill(50, 20, 60, 28, 0.4); // weak region – below box threshold
    const boxes = dbPostprocess(prob, w, h, w * 2, h * 2);
    expect(boxes).toHaveLength(1);
    const [tl, tr, br, bl] = boxes[0].quad;
    // Grown around the kernel (x 4..43, y 4..9) and scaled ×2.
    expect(tl[0]).toBeLessThan(8);
    expect(tr[0]).toBeGreaterThan(86);
    expect(bl[1] - tl[1]).toBeGreaterThan(12);
    expect(br[1]).toBeLessThanOrEqual(h * 2);
    expect(boxes[0].score).toBeGreaterThan(0.6);
  });
});

describe('image operations', () => {
  const img = (w: number, h: number, f: (x: number, y: number) => number): RawImage => {
    const out = createImage(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.data.fill(f(x, y), (y * w + x) * 3, (y * w + x) * 3 + 3);
    return out;
  };

  it('rotates by quarter turns', () => {
    const src = img(3, 2, (x, y) => y * 3 + x);
    const r = rotate90(src, 1);
    expect([r.width, r.height]).toEqual([2, 3]);
    // Clockwise: the bottom-left pixel ends up top-left.
    expect(r.data[0]).toBe(3);
    expect(rotate90(rotate90(src, 2), 2).data).toEqual(src.data);
  });

  it('resizes and converts gray/BGRA pixels', () => {
    const r = resize(img(100, 50, () => 200), 40, 20);
    expect([r.width, r.height, r.data[0]]).toEqual([40, 20, 200]);
    expect(Array.from(fromPixels(new Uint8Array([7]), 1, 1, 1).data)).toEqual([7, 7, 7]);
    expect(Array.from(fromPixels(new Uint8Array([1, 2, 3, 255]), 1, 1, 4, true).data)).toEqual([3, 2, 1]);
  });

  it('normalises to CHW in BGR order', () => {
    const t = toTensor(fromPixels(new Uint8Array([255, 0, 0]), 1, 1, 3), IMAGENET);
    // Channel 0 is blue (0), channel 2 red (255).
    expect(t[0]).toBeCloseTo((0 - 0.485) / 0.229, 3);
    expect(t[2]).toBeCloseTo((1 - 0.406) / 0.225, 3);
  });

  it('cuts out a region and turns tall crops upright', () => {
    const src = img(20, 10, (x) => (x < 10 ? 0 : 255));
    const crop = cropQuad(src, rect(10, 0, 10, 10));
    expect(crop.width).toBe(10);
    expect(crop.data[0]).toBe(255);
    expect(cropQuad(src, rect(0, 0, 4, 10)).width).toBe(10); // 4×10 → rotated to 10×4
  });
});

describe('reading order', () => {
  it('joins boxes of one line, keeps columns apart and starts paragraphs on gaps', () => {
    const text = linesToText([
      line('Gesamtbetrag', rect(400, 300, 120, 20)),
      line('Rechnung', rect(10, 10, 100, 20)),
      line('Nr. 4711', rect(120, 11, 80, 20)),
      line('106,72 €', rect(600, 301, 80, 20)),
      line('Datum', rect(10, 34, 60, 20)),
    ]);
    expect(text).toBe('Rechnung Nr. 4711\nDatum\n\nGesamtbetrag   106,72 €');
  });

  it('straightens skewed scans before building lines', () => {
    const tilt = Math.tan((2 * Math.PI) / 180);
    const skewed = (text: string, x: number, y: number): OcrLine => line(text, [[x, y + x * tilt], [x + 200, y + (x + 200) * tilt], [x + 200, y + 18 + (x + 200) * tilt], [x, y + 18 + x * tilt]]);
    const lines = [skewed('left one', 0, 100), skewed('right one', 1200, 100), skewed('left two', 0, 130), skewed('right two', 1200, 130)];
    expect(skewAngle(lines)).toBeCloseTo((2 * Math.PI) / 180, 3);
    expect(linesToText(lines)).toBe('left one   right one\nleft two   right two');
  });
});

describe('text quality', () => {
  it('rates long tokens in linear time (the patterns backtrack on them)', () => {
    for (const token of [`1${'.'.repeat(200_000)}x`, `ab${"'".repeat(200_000)}!`, `a${'-'.repeat(200_000)}b`]) {
      const started = performance.now();
      const q = assessText(`Rechnung über 42,50 EUR ${token} vom 03.11.2026`, 1);
      expect(performance.now() - started).toBeLessThan(500);
      expect(q.score).toBeLessThan(100);
    }
  });

  it('rates missing, garbled and good text', () => {
    expect(assessText('', 2)).toMatchObject({ level: 'missing', score: 0 });
    expect(assessText("Rchng Nr . l2O4 ; ' ~ | ] Mlrmstr Kpp l . ii| ,, Btrg : 4l2 ,8O EUR ~ _ ' | ; ° ¬ l1 I | ' . -- ' ; :").level).toBe('poor');
    expect(assessText('Sehr geehrte Damen und Herren, hiermit kündige ich meinen Vertrag zum 31.12.2026. Mit freundlichen Grüßen').level).toBe('good');
  });

  it('flags too little text for many pages and respects the threshold', () => {
    const q = assessText('Seite 1 Anlage Seite 2 Seite 3 Ende', 8);
    expect(q.reasons.join()).toMatch(/Little text for 8 pages/);
    expect(assessText('Sehr geehrte Damen und Herren, anbei die Rechnung.', 1, 99).level).toBe('poor');
  });
});

describe('devices and files', () => {
  it('tries the GPU first only where it can exist', () => {
    expect(candidateProviders('cpu', 'linux', true)).toEqual(['cpu']);
    expect(candidateProviders('auto', 'linux', false)).toEqual(['cpu']);
    expect(candidateProviders('auto', 'linux', true)).toEqual(['cuda', 'cpu']);
    expect(candidateProviders('auto', 'win32', false)).toEqual(['dml', 'cpu']);
    expect(candidateProviders('cuda', 'darwin', false)).toEqual(['cuda', 'cpu']);
  });

  it('recognises PDFs by their content, not the file name', () => {
    expect(isPdf(new TextEncoder().encode('%PDF-1.7\n...'))).toBe(true);
    expect(isPdf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
  });
});

describe('PP-OCRv6 (#1026)', () => {
  it('uses PP-OCRv6 for its languages and PP-OCRv5 for the others', () => {
    expect(effectiveOcrModel('v5', 'small', 'latin')).toEqual({ version: 'v5', size: null, label: 'PP-OCRv5', note: null });
    expect(effectiveOcrModel('v6', 'small', 'latin')).toEqual({ version: 'v6', size: 'small', label: 'PP-OCRv6 small', note: null });
    expect(effectiveOcrModel('v6', 'medium', 'en').label).toBe('PP-OCRv6 medium');
    expect(effectiveOcrModel('v6', 'small', 'multi').version).toBe('v6');
    // Tiny reads no Japanese; Cyrillic, Arabic … are not read by any size.
    expect(effectiveOcrModel('v6', 'tiny', 'multi')).toMatchObject({ version: 'v5', note: expect.stringContaining('Japanese') });
    for (const language of OCR_LANGUAGES.filter((l) => !OCR_V6_LANGUAGES.includes(l))) {
      expect(effectiveOcrModel('v6', 'medium', language)).toMatchObject({ version: 'v5', size: null, note: expect.stringMatching(/^PP-OCRv6 does not read .+ – PP-OCRv5 is used$/) });
    }
  });

  it('pins the models of every size to a revision', () => {
    for (const [size, m] of Object.entries(V6_MODELS)) {
      expect(m.det.repo).toBe(`PaddlePaddle/PP-OCRv6_${size}_det_onnx`);
      expect(m.rec.repo).toBe(`PaddlePaddle/PP-OCRv6_${size}_rec_onnx`);
      for (const f of [m.det, m.rec]) expect(f.revision).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(V6_MODELS.tiny.rec.size).toBeLessThan(V6_MODELS.small.rec.size);
    expect(V6_MODELS.small.rec.size).toBeLessThan(V6_MODELS.medium.rec.size);
    expect(V6_MODELS.tiny.det.size + V6_MODELS.tiny.rec.size).toBeLessThan(DETECTION_MODELS.mobile.size + 8_100_000);
  });

  it('takes the thresholds of the text detection from the model', () => {
    const v6 = [
      'Global:',
      '  model_name: PP-OCRv6_tiny_det',
      'PostProcess:',
      '  box_thresh: 0.4',
      '  max_candidates: 3000',
      '  name: DBPostProcess',
      '  thresh: 0.2',
      '  unclip_ratio: 1.4',
      'PreProcess:',
      '  transform_ops:',
      '  - thresh: 0.9',
    ].join('\n');
    expect(parseDbOptions(v6)).toEqual({ thresh: 0.2, boxThresh: 0.4, unclipRatio: 1.4, maxCandidates: 3000 });
    // v5 lists them last; nonsense values and other blocks are left out.
    expect(parseDbOptions('PreProcess:\n  x: 1\nPostProcess:\n  name: DBPostProcess\n  thresh: 0.3\n  box_thresh: 7\n  unclip_ratio: abc\n')).toEqual({ thresh: 0.3 });
    expect(parseDbOptions('Global: {}')).toEqual({});
    // Long input is read in linear time.
    const started = Date.now();
    parseDbOptions(`PostProcess:\n${' '.repeat(200_000)}thresh${' '.repeat(200_000)}`);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

// Runs the real PaddleOCR models when they are available locally:
//   PAPERLESS_AI_OCR_MODELS=<data dir>/models PAPERLESS_AI_OCR_SAMPLE=<file> npx vitest run test/ocr
const modelsDir = process.env.PAPERLESS_AI_OCR_MODELS;
const sample = process.env.PAPERLESS_AI_OCR_SAMPLE;
describe.skipIf(!modelsDir || !sample || !fs.existsSync(path.join(modelsDir ?? '', 'paddleocr')))('PaddleOCR with the real models', () => {
  it('reads the sample document', async () => {
    const { OcrPipeline } = await import('../../src/server/ocr/pipeline.js');
    const { renderPages } = await import('../../src/server/ocr/render.js');
    const p = await OcrPipeline.create({
      cacheDir: modelsDir!,
      language: 'latin',
      detector: 'mobile',
      device: 'cpu',
      threads: 0,
      detMaxSide: 1920,
      pageOrientation: true,
      textlineOrientation: true,
      minScore: 0.5,
    });
    try {
      const { value } = await renderPages(new Uint8Array(fs.readFileSync(sample!)), { dpi: 200, maxPages: 1 }).next();
      const r = await p.recognize(value!.image);
      expect(r.lines.length).toBeGreaterThan(5);
      expect(r.text).toMatch(process.env.PAPERLESS_AI_OCR_EXPECT ? new RegExp(process.env.PAPERLESS_AI_OCR_EXPECT) : /\w{4,}/);
    } finally {
      await p.release();
    }
  }, 120_000);
});
