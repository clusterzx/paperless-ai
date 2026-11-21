/**
 * Worker thread holding the vector index: searches over hundreds of thousands of passages never
 * block the event loop of the server. Messages are processed in order.
 */
import { parentPort } from 'node:worker_threads';
import { VectorIndex } from './vectorIndex.js';

export type VectorWorkerRequest =
  | { type: 'add'; items: { id: number; documentId: number; vector: Float32Array }[] }
  | { type: 'remove'; ids: number[] }
  | { type: 'removeDocument'; documentId: number }
  | { type: 'clear' }
  | { type: 'search'; reqId: number; query: Float32Array; k: number; allowDocs: number[] | null }
  | { type: 'flush'; reqId: number };

const index = new VectorIndex();

parentPort?.on('message', (msg: VectorWorkerRequest) => {
  try {
    switch (msg.type) {
      case 'add':
        index.addMany(msg.items);
        break;
      case 'remove':
        for (const id of msg.ids) index.remove(id);
        break;
      case 'removeDocument':
        index.removeDocument(msg.documentId);
        break;
      case 'clear':
        index.clear();
        break;
      case 'search': {
        const hits = index.search(msg.query, msg.k, msg.allowDocs ? new Set(msg.allowDocs) : null);
        parentPort!.postMessage({ type: 'result', reqId: msg.reqId, hits, count: index.count, memoryBytes: index.memoryBytes });
        return;
      }
      case 'flush':
        parentPort!.postMessage({ type: 'result', reqId: msg.reqId, hits: [], count: index.count, memoryBytes: index.memoryBytes });
        return;
    }
    parentPort!.postMessage({ type: 'state', count: index.count, memoryBytes: index.memoryBytes, dimensions: index.dimensions });
  } catch (err) {
    if ('reqId' in msg) parentPort!.postMessage({ type: 'result', reqId: msg.reqId, error: err instanceof Error ? err.message : String(err) });
    else parentPort!.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
});
