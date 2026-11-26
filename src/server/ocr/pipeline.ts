/**
 * PaddleOCR (PP-OCRv5 / PP-OCRv6) inference with ONNX Runtime:
 * page orientation → text detection → text line orientation → recognition.
 * Runs in the OCR worker thread; all heavy work is synchronous or native.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type * as OrtTypes from 'onnxruntime-node';
import { ctcDecode, parseCharacterDict } from './ctc.js';
import { dbPostprocess, type DbOptions } from './detPost.js';
import { cropQuad, HALF, IMAGENET, isTall, resize, rotate90, toTensor, writeTensor, type RawImage } from './image.js';
import { linesToText, type OcrLine } from './layout.js';
import {
  DETECTION_MODELS,
  ensureModel,
  PAGE_ORIENTATION_MODEL,
  parseDbOptions,
  RECOGNITION_MODELS,
  TEXTLINE_ORIENTATION_MODEL,
  V6_MODELS,
  type OcrDetector,
  type OcrLanguage,
} from './models.js';

export type { OcrDevice } from '../../shared/ocr.js';
import type { OcrDevice, OcrModelSize } from '../../shared/ocr.js';

export interface PipelineOptions {
  cacheDir: string;
  language: OcrLanguage;
  detector: OcrDetector;
  device: OcrDevice;
  /** CPU threads for ONNX Runtime; 0 = automatic. */
  threads: number;
  /** Longest side of the image handed to the detector (larger = finds smaller text, slower). */
  detMaxSide: number;
  /** Detect and correct pages rotated by 90°/180°/270°. */
  pageOrientation: boolean;
  /** Detect and correct upside-down text lines. */
  textlineOrientation: boolean;
  /** Drop recognised lines below this confidence (0…1). */
  minScore: number;
  /** PP-OCRv6 in this size (one model for its languages) instead of PP-OCRv5 by language and detector. */
  v6?: OcrModelSize;
  /** Thresholds of the text detection; default: those of the model's inference.yml. */
  db?: Partial<DbOptions>;
}

export interface PageResult {
  text: string;
  lines: OcrLine[];
  /** Clockwise rotation applied to the page before recognition. */
  rotation: number;
  width: number;
  height: number;
  /** Milliseconds per stage. */
  timings: { orientation: number; detection: number; recognition: number };
}

type Ort = typeof OrtTypes;
type Session = OrtTypes.InferenceSession;

const REC_HEIGHT = 48;
const REC_BATCH = 8;
const REC_MAX_WIDTH = 3200;
const CLS_BATCH = 16;

/** Execution providers to try for a device setting, best first. */
export function candidateProviders(device: OcrDevice, platform = process.platform, cudaAvailable = cudaProviderInstalled()): string[] {
  if (device === 'cpu') return ['cpu'];
  if (device === 'cuda') return ['cuda', 'cpu'];
  if (platform === 'linux' && cudaAvailable) return ['cuda', 'cpu'];
  if (platform === 'win32') return ['dml', 'cpu'];
  return ['cpu'];
}

/** Whether the CUDA provider of ONNX Runtime was installed (ONNXRUNTIME_NODE_INSTALL=cuda12). */
export function cudaProviderInstalled(): boolean {
  try {
    const require = createRequire(import.meta.url);
    const root = path.dirname(require.resolve('onnxruntime-node/package.json'));
    const bin = path.join(root, 'bin');
    for (const napi of fs.readdirSync(bin)) {
      if (fs.existsSync(path.join(bin, napi, 'linux', process.arch, 'libonnxruntime_providers_cuda.so'))) return true;
    }
  } catch {
    /* not installed */
  }
  return false;
}

export class OcrPipeline {
  private constructor(
    private readonly ort: Ort,
    private readonly det: Session,
    private readonly rec: Session,
    private readonly chars: string[],
    private readonly textlineCls: Session | null,
    private readonly pageCls: Session | null,
    private readonly opts: PipelineOptions,
    /** Execution provider that is actually used. */
    readonly provider: string,
  ) {}

  static async create(opts: PipelineOptions, log: (msg: string) => void = () => undefined): Promise<OcrPipeline> {
    const ort = (await import('onnxruntime-node')) as Ort;
    const onDownload = (repo: string) => log(`Downloading OCR model ${repo} (first use)…`);
    const v6 = opts.v6 ? V6_MODELS[opts.v6] : null;
    const detFiles = await ensureModel(opts.cacheDir, v6 ? v6.det : DETECTION_MODELS[opts.detector], onDownload);
    const recFiles = await ensureModel(opts.cacheDir, v6 ? v6.rec : RECOGNITION_MODELS[opts.language], onDownload);
    log(v6 ? `OCR models: PP-OCRv6 ${opts.v6}` : `OCR models: PP-OCRv5 (${opts.detector} detection, ${opts.language} recognition)`);
    const textlineFiles = opts.textlineOrientation ? await ensureModel(opts.cacheDir, TEXTLINE_ORIENTATION_MODEL, onDownload) : null;
    const pageFiles = opts.pageOrientation ? await ensureModel(opts.cacheDir, PAGE_ORIENTATION_MODEL, onDownload) : null;

    const threads = opts.threads > 0 ? opts.threads : Math.max(1, Math.min(os.availableParallelism(), 8));
    const base: OrtTypes.InferenceSession.SessionOptions = {
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
      logSeverityLevel: 3,
    };

    // Pick the first provider that can load the detector, then use it for all models.
    let provider = 'cpu';
    let det: Session | null = null;
    const errors: string[] = [];
    for (const ep of candidateProviders(opts.device)) {
      try {
        det = await ort.InferenceSession.create(detFiles.onnx, { ...base, executionProviders: [ep] });
        provider = ep;
        break;
      } catch (err) {
        errors.push(`${ep}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      }
    }
    if (!det) throw new Error(`Could not load the OCR detection model (${errors.join('; ')})`);
    if (errors.length) log(`OCR runs on ${provider.toUpperCase()} – ${errors.join('; ')}`);
    const session = (file: string) => ort.InferenceSession.create(file, { ...base, executionProviders: [provider] });

    const chars = parseCharacterDict(fs.readFileSync(recFiles.yml, 'utf8'));
    chars.push(' ');
    const [rec, textlineCls, pageCls] = await Promise.all([
      session(recFiles.onnx),
      textlineFiles ? session(textlineFiles.onnx) : Promise.resolve(null),
      pageFiles ? session(pageFiles.onnx) : Promise.resolve(null),
    ]);
    // The detection thresholds of the model (PP-OCRv6 uses other ones than v5), unless given.
    const db = { ...parseDbOptions(fs.readFileSync(detFiles.yml, 'utf8')), ...opts.db };
    return new OcrPipeline(ort, det, rec, chars, textlineCls, pageCls, { ...opts, db }, provider);
  }

  async release(): Promise<void> {
    await Promise.all([this.det, this.rec, this.textlineCls, this.pageCls].map((s) => s?.release()));
  }

  private async run(session: Session, data: Float32Array, dims: number[]): Promise<OrtTypes.Tensor> {
    const input = new this.ort.Tensor('float32', data, dims);
    const out = await session.run({ [session.inputNames[0]]: input });
    return out[session.outputNames[0]];
  }

  /** Classify the page orientation; returns the clockwise rotation that makes the text upright. */
  async pageRotation(img: RawImage): Promise<number> {
    if (!this.pageCls) return 0;
    // resize_short 256 → center crop 224
    const scale = 256 / Math.min(img.width, img.height);
    const small = resize(img, img.width * scale, img.height * scale);
    const x0 = Math.floor((small.width - 224) / 2);
    const y0 = Math.floor((small.height - 224) / 2);
    const crop = { width: 224, height: 224, data: new Uint8Array(224 * 224 * 3) };
    for (let y = 0; y < 224; y++) {
      const src = ((y + y0) * small.width + x0) * 3;
      crop.data.set(small.data.subarray(src, src + 224 * 3), y * 224 * 3);
    }
    const out = await this.run(this.pageCls, toTensor(crop, { ...IMAGENET, bgr: false }), [1, 3, 224, 224]);
    const p = out.data as Float32Array;
    let best = 0;
    for (let i = 1; i < 4; i++) if (p[i] > p[best]) best = i;
    // Only turn pages when the model is sure: a wrong turn ruins the whole page.
    if (best === 0 || p[best] < 0.85) return 0;
    // Class k: the page was turned k×90° clockwise → turn it back by the rest of the full circle.
    return [0, 270, 180, 90][best];
  }

  async detect(img: RawImage) {
    const longest = Math.max(img.width, img.height);
    let scale = Math.min(1, this.opts.detMaxSide / longest);
    if (Math.min(img.width, img.height) * scale < 64) scale = 64 / Math.min(img.width, img.height);
    const w = Math.max(32, Math.round((img.width * scale) / 32) * 32);
    const h = Math.max(32, Math.round((img.height * scale) / 32) * 32);
    const input = resize(img, w, h);
    const out = await this.run(this.det, toTensor(input, IMAGENET), [1, 3, h, w]);
    const [, , oh, ow] = out.dims;
    return dbPostprocess(out.data as Float32Array, ow, oh, img.width, img.height, this.opts.db);
  }

  /** Upside-down text lines (0°/180° classifier); `flipped` tells which crops were turned. */
  private async fixUpsideDown(crops: RawImage[]): Promise<{ crops: RawImage[]; flipped: boolean[] }> {
    const flipped = crops.map(() => false);
    if (!this.textlineCls || !crops.length) return { crops, flipped };
    const out = crops.slice();
    for (let i = 0; i < crops.length; i += CLS_BATCH) {
      const batch = crops.slice(i, i + CLS_BATCH);
      const data = new Float32Array(batch.length * 3 * 80 * 160);
      batch.forEach((c, j) => writeTensor(resize(c, 160, 80), { ...IMAGENET, bgr: false }, data, j * 3 * 80 * 160));
      const res = await this.run(this.textlineCls, data, [batch.length, 3, 80, 160]);
      const p = res.data as Float32Array;
      batch.forEach((c, j) => {
        if (p[j * 2 + 1] > 0.9) {
          out[i + j] = rotate90(c, 2);
          flipped[i + j] = true;
        }
      });
    }
    return { crops: out, flipped };
  }

  async recognizeCrops(crops: RawImage[]): Promise<{ text: string; score: number }[]> {
    const results: { text: string; score: number }[] = new Array(crops.length);
    const order = crops.map((c, i) => ({ i, ratio: c.width / c.height })).sort((a, b) => a.ratio - b.ratio);
    for (let b = 0; b < order.length; b += REC_BATCH) {
      const batch = order.slice(b, b + REC_BATCH);
      const maxRatio = Math.max(320 / REC_HEIGHT, ...batch.map((x) => x.ratio));
      const width = Math.min(REC_MAX_WIDTH, Math.ceil(REC_HEIGHT * maxRatio));
      const data = new Float32Array(batch.length * 3 * REC_HEIGHT * width);
      batch.forEach((x, j) => {
        const w = Math.max(1, Math.min(width, Math.ceil(REC_HEIGHT * x.ratio)));
        writeTensor(resize(crops[x.i], w, REC_HEIGHT), HALF, data, j * 3 * REC_HEIGHT * width, width);
      });
      const out = await this.run(this.rec, data, [batch.length, 3, REC_HEIGHT, width]);
      const [n, steps, classes] = out.dims;
      if (classes !== this.chars.length + 1) {
        throw new Error(`OCR model and dictionary do not match (${classes} classes, ${this.chars.length + 1} expected)`);
      }
      ctcDecode(out.data as Float32Array, n, steps, classes, this.chars).forEach((r, j) => (results[batch[j].i] = r));
    }
    return results;
  }

  /** Read one page. */
  async recognize(page: RawImage): Promise<PageResult> {
    let t = performance.now();
    const lap = () => {
      const now = performance.now();
      const ms = Math.round(now - t);
      t = now;
      return ms;
    };
    const rotation = this.opts.pageOrientation ? await this.pageRotation(page) : 0;
    const img = rotation ? rotate90(page, rotation / 90) : page;
    const orientation = lap();
    const boxes = await this.detect(img);
    const detection = lap();
    const { crops, flipped } = await this.fixUpsideDown(boxes.map((b) => cropQuad(img, b.quad)));
    const recognized = await this.recognizeCrops(crops);
    const recognition = lap();
    const lines: OcrLine[] = [];
    recognized.forEach((r, i) => {
      if (!r.text.trim() || r.score < this.opts.minScore) return;
      const turn = (isTall(boxes[i].quad) ? 1 : 0) + (flipped[i] ? 2 : 0);
      lines.push({ text: r.text, score: r.score, quad: boxes[i].quad, ...(turn ? { turn } : {}) });
    });
    return { text: linesToText(lines), lines, rotation, width: img.width, height: img.height, timings: { orientation, detection, recognition } };
  }
}
