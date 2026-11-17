// Runs the OCR engine with the fake worker in a plain Node process (no test runner keeping the
// event loop alive) and prints one line per release mode.
import { fileURLToPath } from 'node:url';
import { OcrWorkerEngine } from '../../src/server/ocr/runner.js';
import type { OcrRelease } from '../../src/shared/ocr.js';

const entry = fileURLToPath(new URL('./fakeOcrWorker.mjs', import.meta.url));
for (const [device, release] of [
  ['cuda', 'auto'],
  ['cpu', 'document'],
  ['cpu', 'idle'],
] as const) {
  const e = new OcrWorkerEngine(
    {
      cacheDir: '/x',
      language: 'latin',
      detector: 'mobile',
      device,
      threads: 1,
      detMaxSide: 960,
      pageOrientation: false,
      textlineOrientation: false,
      minScore: 0.5,
    },
    { entry, execArgv: [], release: () => release as OcrRelease, idleMs: 100 },
  );
  const r = await e.run(new TextEncoder().encode('slow page'), { dpi: 200, maxPages: 0 });
  console.log(`${device}/${release}: ${r.text.split(' (')[0]}, worker running: ${e.pid !== null}`);
}
