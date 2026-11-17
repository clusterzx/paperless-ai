/**
 * PaddleOCR (PP-OCRv5) ONNX models published by PaddlePaddle on Hugging Face
 * (Apache-2.0). They are downloaded on first use into the data directory and
 * pinned to a revision, so an update of the model repository never changes
 * results silently.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { OcrLanguage } from '../../shared/ocr.js';

export interface ModelFile {
  repo: string;
  revision: string;
  /** Size of inference.onnx in bytes (download check). */
  size: number;
}

export { OCR_LANGUAGES, type OcrLanguage } from '../../shared/ocr.js';
export type OcrDetector = 'mobile' | 'server';

export const DETECTION_MODELS: Record<OcrDetector, ModelFile> = {
  mobile: { repo: 'PaddlePaddle/PP-OCRv5_mobile_det_onnx', revision: 'e6f4fa85f00e168c862bc462aebca69eef9b3d3d', size: 4826518 },
  server: { repo: 'PaddlePaddle/PP-OCRv5_server_det_onnx', revision: 'dcf248c4dcc064c6d030db241255f9e8fbc6733a', size: 88116791 },
};

export const RECOGNITION_MODELS: Record<OcrLanguage, ModelFile> = {
  latin: { repo: 'PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx', revision: '89d3a50e2c27e2e7cceeab0e944c25c807d5db4f', size: 8042023 },
  en: { repo: 'PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx', revision: '3fafbc3b5dcf93dd72add9f48368be8a3a2cd33b', size: 7848423 },
  multi: { repo: 'PaddlePaddle/PP-OCRv5_mobile_rec_onnx', revision: 'ed152b8b495f84de93cda5709d768548a9127622', size: 16534782 },
  cyrillic: { repo: 'PaddlePaddle/cyrillic_PP-OCRv5_mobile_rec_onnx', revision: '2cef88145434beb8afa9dd82d77d799eb1ad7b29', size: 8048799 },
  eslav: { repo: 'PaddlePaddle/eslav_PP-OCRv5_mobile_rec_onnx', revision: '9a32171fc5718746875e1a261818884517975013', size: 7887627 },
  greek: { repo: 'PaddlePaddle/el_PP-OCRv5_mobile_rec_onnx', revision: '8152b89d2ee0e1d4c92decab75fe75e5e3d836b6', size: 7808735 },
  arabic: { repo: 'PaddlePaddle/arabic_PP-OCRv5_mobile_rec_onnx', revision: '14aaedcd75825982689ecf5cd64ab33ee083215a', size: 7998947 },
  devanagari: { repo: 'PaddlePaddle/devanagari_PP-OCRv5_mobile_rec_onnx', revision: '251aec19e36739540d35e2cc943f6aa7503b98e5', size: 7912311 },
  korean: { repo: 'PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx', revision: '5c6f574b8e2230adf4287b33e736d71b9fabd28e', size: 13418787 },
  thai: { repo: 'PaddlePaddle/th_PP-OCRv5_mobile_rec_onnx', revision: '1d4adbbafb1034a2fd6618498575b81ea7b69f69', size: 7891015 },
  tamil: { repo: 'PaddlePaddle/ta_PP-OCRv5_mobile_rec_onnx', revision: '0db89798af0d5218fad9ea7ace0557526e9077f1', size: 7885691 },
  telugu: { repo: 'PaddlePaddle/te_PP-OCRv5_mobile_rec_onnx', revision: 'f1197c83430241c58c64b0952b3a80366d04eeba', size: 7898759 },
};

/** Text line orientation (0° / 180°). */
export const TEXTLINE_ORIENTATION_MODEL: ModelFile = {
  repo: 'PaddlePaddle/PP-LCNet_x0_25_textline_ori_onnx',
  revision: 'aea1f18d97338aaf84b463f90192f2820524a00a',
  size: 1019454,
};

/** Page orientation (0° / 90° / 180° / 270°). */
export const PAGE_ORIENTATION_MODEL: ModelFile = {
  repo: 'PaddlePaddle/PP-LCNet_x1_0_doc_ori_onnx',
  revision: '7330ab7039123e46af2dc03154b9969aa412c61d',
  size: 6788069,
};

export interface LocalModel {
  onnx: string;
  yml: string;
}

const hubUrl = () => (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');

export function modelDir(cacheDir: string, model: ModelFile): string {
  return path.join(cacheDir, 'paddleocr', model.repo.replace('/', '__'), model.revision.slice(0, 12));
}

async function download(url: string, target: string, expectedSize: number | null, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(15 * 60_000), redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download of ${url} failed: HTTP ${res.status}`);
  const tmp = `${target}.${process.pid}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), fs.createWriteStream(tmp));
    const size = fs.statSync(tmp).size;
    if (expectedSize !== null && size !== expectedSize) throw new Error(`Download of ${url} is incomplete (${size} of ${expectedSize} bytes)`);
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Make sure the model files are available locally; downloads them once. */
export async function ensureModel(cacheDir: string, model: ModelFile, onDownload?: (repo: string) => void, signal?: AbortSignal): Promise<LocalModel> {
  const dir = modelDir(cacheDir, model);
  const onnx = path.join(dir, 'inference.onnx');
  const yml = path.join(dir, 'inference.yml');
  const ready = fs.existsSync(onnx) && fs.statSync(onnx).size === model.size && fs.existsSync(yml);
  if (!ready) {
    onDownload?.(model.repo);
    fs.mkdirSync(dir, { recursive: true });
    const base = `${hubUrl()}/${model.repo}/resolve/${model.revision}`;
    await download(`${base}/inference.yml`, yml, null, signal);
    await download(`${base}/inference.onnx`, onnx, model.size, signal);
  }
  return { onnx, yml };
}
