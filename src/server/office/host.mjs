/**
 * LibreOffice (WebAssembly build, @matbee/libreoffice-converter) in a process of its own, started by
 * src/server/office/service.ts. It holds ~1.3 GB while loaded; the service ends the process when it
 * has been idle, when a conversion hangs, and at shutdown – the memory is then given back for sure.
 *
 * Messages (IPC, advanced serialization):
 *   → { type: 'init', dir, fontsDir }               ← { type: 'ready', ms, cpuMs, phases, rss } | { type: 'failed', message }
 *   → { type: 'convert', id, data, ext, pdfa }       ← { type: 'done', id, data, rss } | { type: 'failed', id, message, code }
 * This file is plain JavaScript (copied into dist as it is), so it also runs from the sources.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let converter = null;

const FONT = /\.(ttf|otf|ttc)$/i;

/** Extra fonts (e.g. Noto CJK) from <data>/office/fonts. */
function fonts(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => FONT.test(f))
    .map((f) => ({ filename: f, data: new Uint8Array(fs.readFileSync(path.join(dir, f))) }));
}

const send = (msg) => process.send?.(msg);

process.on('disconnect', () => process.exit(0));

process.on('message', async (msg) => {
  try {
    if (msg.type === 'init') {
      const started = Date.now();
      const cpu = process.cpuUsage();
      // What the start spends its time on (logged when it is slow): [ms since start, step].
      const phases = [];
      const mark = (step) => {
        if (phases.length < 40 && phases.at(-1)?.[1] !== step) phases.push([Date.now() - started, step]);
      };
      const require = createRequire(path.join(msg.dir, 'package.json'));
      const wasmLoader = require(path.join(msg.dir, 'wasm', 'loader.cjs'));
      const { createConverter } = await import(pathToFileURL(path.join(msg.dir, 'dist', 'server.js')).href);
      mark('converter code loaded');
      converter = await createConverter({
        wasmPath: path.join(msg.dir, 'wasm'),
        wasmLoader,
        fonts: fonts(msg.fontsDir),
        verbose: false,
        onProgress: (p) => mark(p.message || p.phase),
      });
      mark('ready');
      const used = process.cpuUsage(cpu);
      send({
        type: 'ready',
        ms: Date.now() - started,
        cpuMs: Math.round((used.user + used.system) / 1000),
        phases,
        rss: process.memoryUsage().rss,
      });
    } else if (msg.type === 'convert') {
      if (!converter) throw Object.assign(new Error('LibreOffice is not loaded'), { code: 'NOT_LOADED' });
      const options = { outputFormat: 'pdf', ...(msg.pdfa ? { pdf: { pdfaLevel: 'PDF/A-2b' } } : {}) };
      const result = await converter.convert(msg.data, options, `document.${msg.ext}`);
      send({ type: 'done', id: msg.id, data: result.data, rss: process.memoryUsage().rss });
    }
  } catch (err) {
    send({ type: 'failed', id: msg.id ?? null, message: (err && err.message) || String(err), code: (err && err.code) || null });
  }
});

send({ type: 'started' });
