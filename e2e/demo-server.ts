/**
 * Demo / end-to-end test server: starts a fake Paperless-ngx with sample
 * documents, a fake OpenAI-compatible LLM and the real Paperless-AI app.
 *
 *   npm run demo                 → configured instance (login admin / demo1234)
 *   DEMO_FRESH=1 npm run demo    → unconfigured instance (setup wizard)
 *
 * GET /__demo/info returns the URLs of the fake services (used by the e2e tests).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockPaperless } from '../test/helpers/mockPaperless.js';
import { startMockLlm, type ChatRequestInfo } from '../test/helpers/mockLlm.js';
import { AppContext } from '../src/server/context.js';
import { buildApp } from '../src/server/http/app.js';
import { ProcessingEngine } from '../src/server/processing/engine.js';
import { RagService } from '../src/server/rag/service.js';
import { hashPassword } from '../src/server/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.DEMO_PORT ?? 3456);
const fresh = process.env.DEMO_FRESH === '1';

const paperless = await startMockPaperless({ maxVersion: 10, minVersion: 9, serverVersion: '3.2.1', token: 'demo-token' });
const llm = await startMockLlm();

// ------------------------------------------------------------------ sample archive
const t = (name: string) => paperless.addTag(name).id;
const c = (name: string) => paperless.addCorrespondent(name).id;
const dt = (name: string) => paperless.addDocumentType(name).id;
const tInsurance = t('Versicherung');
const tHome = t('Wohnung');
t('Steuer');
t('pre-process');
const cStadtwerke = c('Stadtwerke München');
const cAllianz = c('Allianz');
c('Telekom');
const dInvoice = dt('Rechnung');
dt('Vertrag');
paperless.addCustomField('Betrag', 'monetary', { default_currency: 'EUR' });
paperless.addCustomField('Rechnungsnummer', 'string');

const samples = [
  {
    title: 'scan_2024_03_14.pdf',
    created: '2024-03-14',
    content:
      'Stadtwerke München GmbH\nStromrechnung Nr. SR-2024-0315\nAbrechnungszeitraum 01.02.2024 – 29.02.2024\nVerbrauch: 284 kWh\nGesamtbetrag: 84,20 EUR\nDer Betrag wird am 28.03.2024 von Ihrem Konto abgebucht.',
  },
  {
    title: 'Stromrechnung April',
    created: '2024-04-12',
    correspondent: cStadtwerke,
    document_type: dInvoice,
    content: 'Stadtwerke München GmbH\nStromrechnung Nr. SR-2024-0412\nAbrechnungszeitraum März 2024\nVerbrauch: 251 kWh\nGesamtbetrag: 76,90 EUR\nZahlbar bis 30.04.2024.',
  },
  {
    title: 'Mietvertrag',
    created: '2021-03-01',
    tags: [tHome],
    content:
      'Mietvertrag über Wohnraum\nzwischen Hausverwaltung Schmidt & Partner (Vermieter) und Max Mustermann (Mieter)\nMietobjekt: Leopoldstraße 12, 80802 München, 3 Zimmer\nMietbeginn: 01.04.2021\nKaltmiete: 1.250,00 EUR, Nebenkosten-Vorauszahlung: 220,00 EUR\nKaution: 3.750,00 EUR\nUnterzeichnet am 01.03.2021 in München.',
  },
  {
    title: 'Krankenversicherung Beitragsanpassung',
    created: '2024-11-20',
    tags: [tInsurance],
    correspondent: cAllianz,
    content:
      'Allianz Private Krankenversicherungs-AG\nIhre Beitragsanpassung zum 01.01.2025\nVersicherungsnummer KV-778812\nNeuer Monatsbeitrag: 512,40 EUR (bisher 489,10 EUR).\nDie Anpassung erfolgt aufgrund gestiegener Leistungsausgaben im Gesundheitswesen.',
  },
  {
    title: 'Kfz-Versicherung 2025',
    created: '2024-12-02',
    tags: [tInsurance],
    content:
      'HUK-COBURG\nVersicherungsschein Kfz-Haftpflicht und Teilkasko\nFahrzeug: VW Golf, Kennzeichen M-AB 1234\nJahresbeitrag 2025: 438,00 EUR\nSchadenfreiheitsklasse SF 12.',
  },
  {
    title: 'Telekom Rechnung Oktober',
    created: '2024-10-05',
    content: 'Telekom Deutschland GmbH\nIhre Rechnung für Oktober 2024\nRechnungsnummer 4711-0815\nMagentaZuhause L: 54,95 EUR\nGesamtbetrag 54,95 EUR, Abbuchung am 15.10.2024.',
  },
  {
    title: 'Lohnsteuerbescheinigung 2023',
    created: '2024-02-10',
    content: 'Ausdruck der elektronischen Lohnsteuerbescheinigung für 2023\nArbeitgeber: Muster AG\nBruttoarbeitslohn: 58.400,00 EUR\nEinbehaltene Lohnsteuer: 11.230,00 EUR',
  },
  { title: 'Leerer Scan', created: '2024-05-01', content: '' },
];
const baseAdded = Date.UTC(2024, 0, 1);
samples.forEach((s, i) =>
  paperless.addDocument({
    id: i + 1,
    title: s.title,
    created: s.created,
    content: s.content,
    tags: s.tags ?? [],
    correspondent: s.correspondent ?? null,
    document_type: s.document_type ?? null,
    added: new Date(baseAdded + i * 86_400_000).toISOString(),
  }),
);

// ------------------------------------------------------------------ fake AI
function analyze(content: string): Record<string, unknown> {
  const lower = content.toLowerCase();
  const date = /(\d{2})\.(\d{2})\.(\d{4})/.exec(content);
  const amount = /(?:Gesamtbetrag|Kaltmiete|Monatsbeitrag|Jahresbeitrag)[^\d]*([\d.]+,\d{2})/.exec(content)?.[1];
  const number = /(?:Nr\.|Rechnungsnummer|Versicherungsnummer)\s*([\w-]+)/.exec(content)?.[1];
  const firstLine = content.split('\n')[0].replace(/ GmbH| AG|-AG|Private Krankenversicherungs/g, '').trim();
  let type = 'Dokument';
  let tags = ['Archiv'];
  if (lower.includes('rechnung')) {
    type = 'Rechnung';
    tags = ['Rechnung'];
  }
  if (lower.includes('strom')) tags.push('Strom');
  if (lower.includes('versicherung')) {
    type = lower.includes('versicherungsschein') ? 'Vertrag' : 'Schreiben';
    tags.push('Versicherung');
  }
  if (lower.includes('mietvertrag')) {
    type = 'Vertrag';
    tags = ['Wohnung', 'Vertrag'];
  }
  if (lower.includes('lohnsteuer')) {
    type = 'Bescheinigung';
    tags = ['Steuer'];
  }
  const title = lower.includes('mietvertrag')
    ? 'Mietvertrag Leopoldstraße 12'
    : `${type} ${firstLine}${number ? ` ${number}` : ''}`.slice(0, 120);
  return {
    title,
    correspondent: lower.includes('mietvertrag') ? 'Hausverwaltung Schmidt & Partner' : firstLine,
    tags,
    document_type: type,
    document_date: date ? `${date[3]}-${date[2]}-${date[1]}` : '',
    language: 'de',
    custom_fields: [
      ...(amount ? [{ field_name: 'Betrag', value: amount }] : []),
      ...(number ? [{ field_name: 'Rechnungsnummer', value: number }] : []),
    ],
  };
}

llm.reply((req: ChatRequestInfo) => {
  if (req.system.includes('Return the result EXCLUSIVELY as one JSON object')) {
    const content = /Document content:\n"""\n([\s\S]*)\n"""/.exec(req.user)?.[1] ?? req.user;
    return { content: JSON.stringify(analyze(content)), usage: { prompt_tokens: 900 + content.length / 4, completion_tokens: 80 } };
  }
  if (req.system.includes('standalone question')) return JSON.stringify({ query: req.user.split('Follow-up question:').at(-1)?.trim() ?? req.user });
  if (req.system.startsWith('You are Paperless-AI')) {
    const first = /\[1\] Title: ([^|\n]+)/.exec(req.user)?.[1]?.trim();
    const second = /\[2\] Title: ([^|\n]+)/.exec(req.user)?.[1]?.trim();
    if (!first) return 'Dazu habe ich in Ihren Dokumenten leider nichts gefunden.';
    return {
      content: `Laut **${first}** finden sich die gesuchten Angaben direkt im Dokument [1].${second ? `\n\nErgänzend dazu ist auch *${second}* relevant [2].` : ''}\n\n- Quelle geprüft und zusammengefasst\n- Beträge und Daten stammen aus den Dokumenten`,
      chunkSize: 6,
    };
  }
  if (req.system.includes('questions about one document')) {
    const title = /Title: (.+)/.exec(req.system)?.[1] ?? 'dieses Dokument';
    return { content: `**${title}** – kurze Zusammenfassung:\n\n1. Absender und Datum sind im Kopf des Dokuments angegeben.\n2. Die wichtigsten Beträge stehen am Ende.`, chunkSize: 5 };
  }
  return 'OK';
});

// ------------------------------------------------------------------ app
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperless-ai-demo-'));
// In setup-wizard mode the embeddings are pinned to the fake LLM so tests never download a model.
const ctx = new AppContext({ dataDir, env: fresh ? { RAG_EMBEDDING_PROVIDER: 'custom', RAG_EMBEDDING_MODEL: 'mock-embed' } : {} });
if (!fresh) {
  ctx.config.update({
    setupCompleted: true,
    paperless: { url: paperless.url, token: paperless.token },
    ai: { provider: 'custom', custom: { baseUrl: llm.openaiUrl, apiKey: 'demo', model: 'mock-gpt' } },
    processing: {
      automatic: false,
      customFields: [
        { name: 'Betrag', type: 'monetary', currency: 'EUR', description: 'Gesamtbetrag' },
        { name: 'Rechnungsnummer', type: 'string', description: '' },
      ],
    },
    rag: { enabled: true, embeddingProvider: 'custom', embeddingModel: 'mock-embed' },
  });
  ctx.repos.users.create('admin', await hashPassword('demo1234'));
}
const engine = new ProcessingEngine(ctx);
const rag = new RagService(ctx);
engine.on('idle', () => rag.requestSync());
const staticDir = path.resolve(here, '..', 'dist', 'public');
const app = await buildApp({ ctx, engine, rag }, { staticDir });
app.get('/__demo/info', { config: { auth: 'public' } }, async () => ({ paperlessUrl: paperless.url, paperlessToken: paperless.token, llmUrl: llm.openaiUrl }));
await app.listen({ port, host: '127.0.0.1' });
engine.start(false);
rag.start();
if (!fresh) void rag.sync();
console.log(`Demo running on http://127.0.0.1:${port} (${fresh ? 'setup wizard' : 'login admin / demo1234'})`);
console.log(`Fake Paperless: ${paperless.url} (token ${paperless.token}) · Fake LLM: ${llm.openaiUrl}`);

const shutdown = async () => {
  await app.close();
  await Promise.all([engine.stop(), rag.stop(), paperless.close(), llm.close()]);
  ctx.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
