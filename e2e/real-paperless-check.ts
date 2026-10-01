/**
 * Compatibility check against a REAL Paperless-ngx instance (2.x or 3.x),
 * using a fake LLM. ⚠ It modifies documents – only use a disposable test instance!
 *
 *   PAPERLESS_URL=http://localhost:8000 PAPERLESS_TOKEN=… npx tsx e2e/real-paperless-check.ts
 *
 * Runs: version negotiation, metadata loading, automatic processing of all
 * documents (tags/correspondent/type/date/custom fields), undo, RAG indexing,
 * keyword + vector search and a streamed RAG answer.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockLlm } from '../test/helpers/mockLlm.js';
import { AppContext } from '../src/server/context.js';
import { ProcessingEngine } from '../src/server/processing/engine.js';
import { RagService } from '../src/server/rag/service.js';
import { revertDocument } from '../src/server/processing/applier.js';
import { testPaperlessConnection } from '../src/server/routes/connectionTests.js';

const url = process.env.PAPERLESS_URL;
const token = process.env.PAPERLESS_TOKEN;
if (!url || !token) {
  console.error('Set PAPERLESS_URL and PAPERLESS_TOKEN');
  process.exit(2);
}

const step = (msg: string) => console.log(`\n▶ ${msg}`);
const llm = await startMockLlm();
llm.reply((req) => {
  if (req.system.includes('Return the result EXCLUSIVELY as one JSON object')) {
    const content = req.user.toLowerCase();
    const strom = content.includes('strom');
    return JSON.stringify({
      title: strom ? 'Stromrechnung Stadtwerke SR-2024-0315' : content.includes('miet') ? 'Mietvertrag Wohnung' : 'Beitragsanpassung Krankenversicherung',
      correspondent: strom ? 'Stadtwerke München' : content.includes('miet') ? 'Hausverwaltung Schmidt' : 'Allianz',
      tags: strom ? ['Strom', 'Rechnung'] : ['Versicherung'],
      document_type: strom ? 'Rechnung' : 'Schreiben',
      document_date: strom ? '2024-03-14' : '2024-11-20',
      language: 'de',
      custom_fields: strom ? [{ field_name: 'Betrag', value: '84,20' }, { field_name: 'Rechnungsnummer', value: 'SR-2024-0315' }] : [],
    });
  }
  if (req.system.startsWith('You are Paperless-AI')) return 'Die letzte Stromrechnung beträgt 84,20 EUR [1].';
  return 'OK';
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-real-'));
const ctx = new AppContext({ dataDir, env: {} });
try {
  step('Connection test');
  const conn = await testPaperlessConnection(url, token);
  console.log(conn.message);
  assert.ok(conn.ok, conn.message);

  ctx.config.update({
    setupCompleted: true,
    paperless: { url, token },
    ai: { provider: 'custom', custom: { baseUrl: llm.openaiUrl, model: 'mock' } },
    processing: {
      automatic: false,
      addProcessedTag: true,
      customFields: [
        { name: 'Betrag', type: 'monetary', currency: 'EUR', description: '' },
        { name: 'Rechnungsnummer', type: 'string', description: '' },
      ],
    },
    rag: { enabled: true, embeddingProvider: 'custom', embeddingModel: 'mock-embed' },
  });
  const client = ctx.paperless();
  const info = await client.connect();
  console.log(`API version ${info.apiVersion}, server ${info.serverVersion}, user ${info.user.username}`);

  step('Processing all documents');
  const engine = new ProcessingEngine(ctx);
  const queued = await engine.scan();
  await engine.drain(120_000);
  const counts = ctx.repos.documents.counts();
  console.log(`queued ${queued}, states`, counts);
  assert.ok(counts.processed > 0, 'no document processed');
  assert.equal(counts.failed, 0, 'documents failed – see logs');

  const meta = await ctx.metadata().snapshot(true);
  const docs = await client.listDocuments({ fields: ['id', 'title', 'tags', 'correspondent', 'document_type', 'created', 'custom_fields'] });
  for (const d of docs) {
    console.log(
      `#${d.id} "${d.title}" | ${ctx.metadata().correspondentName(d.correspondent)} | ${ctx.metadata().documentTypeName(d.document_type)} | ${d.created} | tags: ${d.tags.map((t) => ctx.metadata().tagName(t)).join(', ')} | custom: ${JSON.stringify(d.custom_fields)}`,
    );
  }
  const strom = docs.find((d) => d.title.startsWith('Stromrechnung'));
  assert.ok(strom, 'electricity bill not renamed');
  assert.equal(strom!.created?.slice(0, 10), '2024-03-14');
  const betrag = meta.customFields.find((f) => f.name === 'Betrag');
  assert.ok(betrag, 'custom field Betrag not created');
  assert.ok(strom!.custom_fields?.some((f) => f.field === betrag!.id && String(f.value) === 'EUR84.20'), 'monetary value not stored');
  assert.ok(meta.tags.some((t) => t.name === 'ai-processed'), 'processed tag missing');

  step('Undo');
  const reverted = await revertDocument(ctx, strom!.id);
  console.log(`reverted → "${reverted.title}", created ${reverted.created}`);
  assert.ok(!reverted.title.startsWith('Stromrechnung Stadtwerke'), 'title not restored');

  step('RAG index + search + chat');
  const rag = new RagService(ctx);
  await rag.sync();
  const status = rag.status();
  console.log(`index: ${status.documents} documents, ${status.chunks} passages, ${status.embedded} embedded, error: ${status.lastError}`);
  assert.equal(status.documents, docs.length);
  const result = await rag.search('Stromrechnung Betrag');
  console.log('search →', result.documents.map((d) => `#${d.documentId} ${d.chunks[0].title}`).join(' | '), `(${result.mode})`);
  assert.ok(result.documents.length > 0);
  let answer = '';
  for await (const e of rag.chat('Wie hoch war die letzte Stromrechnung?', [])) if (e.type === 'delta') answer += e.text;
  console.log('answer →', answer);
  await rag.stop();
  await engine.stop();
  console.log('\n✅ All checks passed');
} finally {
  ctx.close();
  await llm.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
