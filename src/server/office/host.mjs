/**
 * LibreOffice (WebAssembly build, @matbee/libreoffice-converter) in a process of its own, started by
 * src/server/office/service.ts. It holds ~1.3 GB while loaded; the service ends the process when it
 * has been idle, when a conversion hangs, and at shutdown – the memory is then given back for sure.
 *
 * Messages (IPC, advanced serialization):
 *   → { type: 'init', dir, fontsDir }               ← { type: 'ready', ms, loadMs, warmUpMs, rss } | { type: 'failed', message }
 *   → { type: 'convert', id, data, ext, pdfa }       ← { type: 'done', id, data, rss } | { type: 'failed', id, message, code }
 * This file is plain JavaScript (copied into dist as it is), so it also runs from the sources.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let converter = null;

/** A one-line Word document: converted once after loading, so a LibreOffice that hangs on its first file is noticed (and restarted) before real work. */
const WARM_UP = Buffer.from(
  [
    'UEsDBBQAAAAAAAAAAAB5bjPXrQEAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rp',
    'bmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz48VHlwZXMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9y',
    'Zy9wYWNrYWdlLzIwMDYvY29udGVudC10eXBlcyI+PERlZmF1bHQgRXh0ZW5zaW9uPSJyZWxzIiBDb250ZW50VHlwZT0iYXBwbGlj',
    'YXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLXBhY2thZ2UucmVsYXRpb25zaGlwcyt4bWwiLz48RGVmYXVsdCBFeHRlbnNpb249Inht',
    'bCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3dvcmQvZG9jdW1lbnQueG1sIiBD',
    'b250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LndvcmRwcm9jZXNzaW5nbWwu',
    'ZG9jdW1lbnQubWFpbit4bWwiLz48L1R5cGVzPlBLAwQUAAAAAAAAAAAAm/036ikBAAApAQAACwAAAF9yZWxzLy5yZWxzPD94bWwg',
    'dmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/PjxSZWxhdGlvbnNoaXBzIHhtbG5zPSJodHRw',
    'Oi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L3JlbGF0aW9uc2hpcHMiPjxSZWxhdGlvbnNoaXAgSWQ9',
    'InJJZDEiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9u',
    'c2hpcHMvb2ZmaWNlRG9jdW1lbnQiIFRhcmdldD0id29yZC9kb2N1bWVudC54bWwiLz48L1JlbGF0aW9uc2hpcHM+UEsDBBQAAAAA',
    'AAAAAAB6Kkxc6gAAAOoAAAARAAAAd29yZC9kb2N1bWVudC54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIg',
    'c3RhbmRhbG9uZT0ieWVzIj8+PHc6ZG9jdW1lbnQgeG1sbnM6dz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3dv',
    'cmRwcm9jZXNzaW5nbWwvMjAwNi9tYWluIj48dzpib2R5Pjx3OnA+PHc6cj48dzp0IHhtbDpzcGFjZT0icHJlc2VydmUiPlBhcGVy',
    'bGVzcy1BSTwvdzp0PjwvdzpyPjwvdzpwPjwvdzpib2R5Pjwvdzpkb2N1bWVudD5QSwECFAAUAAAAAAAAAAAAeW4z160BAACtAQAA',
    'EwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUABQAAAAAAAAAAACb/TfqKQEAACkBAAALAAAAAAAAAAAA',
    'AAAAAN4BAABfcmVscy8ucmVsc1BLAQIUABQAAAAAAAAAAAB6Kkxc6gAAAOoAAAARAAAAAAAAAAAAAAAAADADAAB3b3JkL2RvY3Vt',
    'ZW50LnhtbFBLBQYAAAAAAwADALkAAABJBAAAAAA=',
  ].join(''),
  'base64',
);

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
      const require = createRequire(path.join(msg.dir, 'package.json'));
      const wasmLoader = require(path.join(msg.dir, 'wasm', 'loader.cjs'));
      const { createConverter } = await import(pathToFileURL(path.join(msg.dir, 'dist', 'server.js')).href);
      converter = await createConverter({
        wasmPath: path.join(msg.dir, 'wasm'),
        wasmLoader,
        fonts: fonts(msg.fontsDir),
        verbose: false,
      });
      const loaded = Date.now();
      await converter.convert(new Uint8Array(WARM_UP), { outputFormat: 'pdf' }, 'warm-up.docx');
      send({
        type: 'ready',
        ms: Date.now() - started,
        loadMs: loaded - started,
        warmUpMs: Date.now() - loaded,
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
