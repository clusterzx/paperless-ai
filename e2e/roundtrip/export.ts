/**
 * Round trip built-in archive → Paperless-ngx (nightly CI, .github/workflows/roundtrip.yml):
 * builds a small built-in archive and exports it in the format of Paperless-ngx's
 * document_exporter. CI then imports it with `document_importer` in the official image.
 *
 *   tsx e2e/roundtrip/export.ts <export directory>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppContext } from '../../src/server/context.js';
import { LocalBackend } from '../../src/server/archive/backend.js';
import { exportArchive } from '../../src/server/migration/export.js';
import { SYSTEM_SCOPE } from '../../src/server/access/scope.js';
import { makePdf } from '../../test/helpers/pdf.js';

const out = path.resolve(process.argv[2] ?? 'roundtrip-export');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-roundtrip-'));
const ctx = new AppContext({ dataDir: data, env: { PAPERLESS_AI_ARCHIVE: 'builtin', PAPERLESS_AI_NO_WATCHERS: '1', LOG_LEVEL: 'warn' } });
const b = ctx.archive() as LocalBackend;
const lib = b.ensureDefaultLibrary();
await ctx.metadata(lib).resolveCustomField('Betrag', true, 'monetary', 'EUR');
const docs = [
  { lines: ['Stadtwerke München', 'Stromrechnung März 2024', 'Gesamtbetrag 84,20 EUR'], title: 'Stromrechnung März 2024', created: '2024-03-31', tags: ['Rechnung', 'Strom'], correspondent: 'Stadtwerke München', customFields: { Betrag: 'EUR84.20' } },
  { lines: ['Hausverwaltung Meier', 'Mietvertrag Leopoldstraße 12'], title: 'Mietvertrag', created: '2023-05-01', tags: ['Vertrag'], correspondent: 'Hausverwaltung Meier', customFields: {} },
  { lines: ['Finanzamt', 'Steuerbescheid 2023'], title: 'Steuerbescheid 2023', created: '2024-06-12', tags: ['Steuer'], correspondent: 'Finanzamt', customFields: {} },
];
for (const [i, d] of docs.entries()) {
  const r = await b.ingest(SYSTEM_SCOPE, { data: makePdf([d.lines]), filename: `doc-${i + 1}.pdf` }, 'api', {
    title: d.title,
    created: d.created,
    tags: d.tags,
    correspondent: d.correspondent,
    customFields: d.customFields,
    skipAnalysis: true,
  });
  if (r.status !== 'stored') throw new Error(`Document ${i + 1}: ${r.status} ${r.reason ?? ''}`);
}
fs.rmSync(out, { recursive: true, force: true });
const res = await exportArchive(ctx, b.blobs, { format: 'ngx', directory: out, libraryIds: null });
await b.close();
ctx.close();
fs.rmSync(data, { recursive: true, force: true });
console.log(JSON.stringify(res));
