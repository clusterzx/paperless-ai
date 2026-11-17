/**
 * Worker thread running the OCR pipeline, so rendering and inference never
 * block the web server.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { OcrPipeline, type PipelineOptions } from './pipeline.js';
import { renderPages, type RenderOptions } from './render.js';

export interface OcrRequest {
  id: number;
  bytes: ArrayBuffer;
  render: RenderOptions;
}

export interface OcrPageSummary {
  text: string;
  lines: number;
  meanScore: number;
  rotation: number;
  width: number;
  height: number;
  ms: number;
}

export type OcrWorkerMessage =
  | { type: 'log'; message: string }
  | { type: 'ready'; provider: string }
  | { type: 'progress'; id: number; page: number; pages: number }
  | { type: 'result'; id: number; pages: OcrPageSummary[]; totalPages: number; provider: string }
  | { type: 'error'; id: number; error: string };

const port = parentPort!;
const options = workerData as PipelineOptions;
const send = (msg: OcrWorkerMessage) => port.postMessage(msg);

let pipeline: Promise<OcrPipeline> | null = null;
function getPipeline(): Promise<OcrPipeline> {
  pipeline ??= OcrPipeline.create(options, (message) => send({ type: 'log', message })).then(
    (p) => {
      send({ type: 'ready', provider: p.provider });
      return p;
    },
    (err: unknown) => {
      pipeline = null;
      throw err;
    },
  );
  return pipeline;
}

// One document at a time: the pipeline already uses all configured threads.
let chain = Promise.resolve();
port.on('message', (req: OcrRequest) => {
  chain = chain.then(async () => {
    try {
      const p = await getPipeline();
      const pages: OcrPageSummary[] = [];
      let totalPages = 0;
      for await (const page of renderPages(new Uint8Array(req.bytes), req.render)) {
        totalPages = page.total;
        const shown = req.render.maxPages > 0 ? Math.min(page.total, req.render.maxPages) : page.total;
        send({ type: 'progress', id: req.id, page: page.index + 1, pages: shown });
        const started = performance.now();
        const r = await p.recognize(page.image);
        pages.push({
          text: r.text,
          lines: r.lines.length,
          meanScore: r.lines.length ? r.lines.reduce((s, l) => s + l.score, 0) / r.lines.length : 0,
          rotation: r.rotation,
          width: r.width,
          height: r.height,
          ms: Math.round(performance.now() - started),
        });
      }
      send({ type: 'result', id: req.id, pages, totalPages, provider: p.provider });
    } catch (err) {
      send({ type: 'error', id: req.id, error: err instanceof Error ? err.message : String(err) });
    }
  });
});
