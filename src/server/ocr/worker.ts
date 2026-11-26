/**
 * The OCR worker: a child process running the OCR pipeline. Rendering and inference never block
 * the web server, and ending the process gives all of its memory back – on the GPU including the
 * CUDA context, which stays allocated until the process that created it ends.
 */
import '../env.js';
import { OcrPipeline, type PipelineOptions } from './pipeline.js';
import { renderPages, type RenderOptions } from './render.js';
import { layoutLines, type PageLayout } from './textLayer.js';

export interface OcrRequest {
  id: number;
  bytes: Uint8Array;
  render: RenderOptions;
}

export interface OcrPageSummary {
  text: string;
  lines: number;
  /** Where the lines are on the page (for the text layer of a searchable PDF). */
  layout: PageLayout;
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

function send(msg: OcrWorkerMessage): void {
  try {
    process.send?.(msg);
  } catch {
    // The server is gone – the 'disconnect' handler ends this process.
  }
}

function main(options: PipelineOptions): void {
  // The server crashed or was killed: never stay behind holding the (GPU) memory.
  process.on('disconnect', () => process.exit(0));

  let pipeline: Promise<OcrPipeline> | null = null;
  const getPipeline = (): Promise<OcrPipeline> => {
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
  };

  // One document at a time: the pipeline already uses all configured threads.
  let chain = Promise.resolve();
  process.on('message', (req: OcrRequest) => {
    chain = chain.then(async () => {
      try {
        const p = await getPipeline();
        const pages: OcrPageSummary[] = [];
        let totalPages = 0;
        for await (const page of renderPages(req.bytes, req.render)) {
          totalPages = page.total;
          const shown = req.render.maxPages > 0 ? Math.min(page.total, req.render.maxPages) : page.total;
          send({ type: 'progress', id: req.id, page: page.index + 1, pages: shown });
          const started = performance.now();
          const r = await p.recognize(page.image);
          pages.push({
            text: r.text,
            lines: r.lines.length,
            layout: { lines: layoutLines(r.lines, r.rotation, page.image.width, page.image.height), textChars: page.textChars },
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
}

// Started by the runner with an IPC channel and the pipeline options as argument (the module also
// provides the message types above).
if (process.send && process.argv[2]) main(JSON.parse(process.argv[2]) as PipelineOptions);
