/**
 * Worker thread running a local ONNX embedding model via transformers.js.
 * Keeps the main event loop responsive while documents are embedded.
 */
import { parentPort, workerData } from 'node:worker_threads';

interface WorkerInit {
  model: string;
  cacheDir: string;
  threads: number;
}
interface EmbedRequest {
  id: number;
  texts: string[];
}

type Extractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

const init = workerData as WorkerInit;
let extractorPromise: Promise<Extractor> | null = null;

async function load(): Promise<Extractor> {
  const tf = await import('@huggingface/transformers');
  tf.env.cacheDir = init.cacheDir;
  tf.env.allowRemoteModels = true;
  // Keep CPU usage moderate so Paperless and other containers stay responsive.
  const onnx = tf.env.backends?.onnx as { numThreads?: number; wasm?: { numThreads?: number } } | undefined;
  if (onnx) onnx.numThreads = init.threads;
  const extractor = await tf.pipeline('feature-extraction', init.model, {
    dtype: 'q8',
    session_options: { intraOpNumThreads: init.threads, interOpNumThreads: 1 },
  } as Parameters<typeof tf.pipeline>[2]);
  return extractor as unknown as Extractor;
}

parentPort!.on('message', async (msg: EmbedRequest) => {
  try {
    extractorPromise ??= load();
    const extractor = await extractorPromise;
    const out = await extractor(msg.texts, { pooling: 'mean', normalize: true });
    const dims = out.dims[out.dims.length - 1];
    const vectors: Float32Array[] = [];
    for (let i = 0; i < msg.texts.length; i++) vectors.push(out.data.slice(i * dims, (i + 1) * dims));
    parentPort!.postMessage({ id: msg.id, vectors }, vectors.map((v) => v.buffer as ArrayBuffer));
  } catch (err) {
    extractorPromise = null;
    parentPort!.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
});
