import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatStreamEvent, RagSource } from '../../src/shared/api.js';
import { createHarness, parseSsePayload, waitFor, type Harness } from '../helpers/appHarness.js';
import type { ChatRequestInfo } from '../helpers/mockLlm.js';

const LONG_CONTENT = Array.from(
  { length: 40 },
  (_, i) => `Section ${i + 1} of the rental agreement describes obligations of the tenant regarding paragraph ${i + 1}, including maintenance and notice periods.`,
).join('\n\n');

function seed(h: Harness) {
  const p = h.paperless;
  p.addTag('Energy', 1);
  p.addTag('ai-processed', 2);
  p.addCorrespondent('City Power', 10);
  p.addCorrespondent('Allianz', 11);
  p.addDocumentType('Invoice', 20);
  p.addDocumentType('Contract', 21);
  p.addDocument({
    id: 1,
    title: 'Electricity bill',
    content: 'City Power electricity invoice. Total amount 89.50 EUR for the consumption in March 2024.',
    correspondent: 10,
    document_type: 20,
    created: '2024-03-31',
    tags: [1, 2],
  });
  p.addDocument({
    id: 2,
    title: 'Car insurance policy',
    content: 'Your car insurance with Allianz protects your vehicle against damage. Annual premium 420 EUR.',
    correspondent: 11,
    document_type: 21,
    created: '2023-06-01',
  });
  p.addDocument({ id: 3, title: 'Doctor appointment', content: 'Dr. Smith medical practice confirms your appointment for a checkup.', created: '2024-01-10' });
  p.addDocument({ id: 4, title: 'Rental agreement', content: LONG_CONTENT, document_type: 21, created: '2022-09-01' });
}

/** Chat replies: condensing returns a standalone query, streaming answers cite source 1. */
function chatHandler(req: ChatRequestInfo) {
  if (req.system.includes('Rewrite the follow-up question')) return JSON.stringify({ query: 'electricity bill amount March 2024' });
  return { content: 'The electricity bill was 89.50 EUR [1].', chunkSize: 6, usage: { prompt_tokens: 400, completion_tokens: 12 } };
}

const search = async (h: Harness, body: Record<string, unknown>) => {
  const res = await h.inject({ method: 'POST', url: '/api/rag/search', headers: h.apiKeyHeaders(), payload: body });
  expect(res.statusCode).toBe(200);
  return res.json() as { sources: RagSource[]; mode: string; tookMs: number };
};

describe('RAG with embeddings (hybrid search)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ embedding: 'custom' });
    seed(h);
    h.llm.reply(chatHandler);
    await h.rag.sync();
  });
  afterAll(() => h.close());

  it('indexes and embeds all documents', async () => {
    const status = (await h.inject({ method: 'GET', url: '/api/rag/status', headers: h.apiKeyHeaders() })).json();
    expect(status).toMatchObject({
      enabled: true,
      state: 'idle',
      documents: 4,
      embeddingProvider: 'custom',
      embeddingModel: 'mock-embed',
      lastError: null,
      progress: null,
      vectorSearch: true,
    });
    expect(status.chunks).toBeGreaterThan(5);
    expect(status.embedded).toBe(status.chunks);
    expect(status.lastSyncAt).toBeGreaterThan(0);
    // embeddings were requested with the configured model at the custom endpoint
    const req = h.llm.embeddingRequests()[0];
    expect(req.path).toBe('/v1/embeddings');
    expect(req.body).toMatchObject({ model: 'mock-embed' });
    // passages carry the document metadata; internal tags are not indexed
    const inputs = h.llm.embeddingRequests().flatMap((r) => r.body!.input as string[]);
    expect(inputs.find((t) => t.includes('City Power electricity'))).toBe(
      'Title: Electricity bill | From: City Power | Type: Invoice | Date: 2024-03-31 | Tags: Energy\nCity Power electricity invoice. Total amount 89.50 EUR for the consumption in March 2024.',
    );
  });

  it('finds documents by keyword', async () => {
    const res = await search(h, { query: 'electricity' });
    expect(res.mode).toBe('hybrid');
    expect(res.sources[0]).toMatchObject({
      n: 1,
      documentId: 1,
      title: 'Electricity bill',
      correspondent: 'City Power',
      documentType: 'Invoice',
      created: '2024-03-31',
      tags: ['Energy'],
      url: `${h.paperless.url}/documents/1/details`,
    });
    expect(res.sources[0].snippet).toContain('electricity invoice');
  });

  it('finds documents by meaning (no keyword overlap)', async () => {
    const res = await search(h, { query: 'automobile coverage' });
    expect(res.mode).toBe('hybrid');
    expect(res.sources[0].documentId).toBe(2);
    const doctor = await search(h, { query: 'physician visit' });
    expect(doctor.sources[0].documentId).toBe(3);
  });

  it('applies filters', async () => {
    const byCorrespondent = await search(h, { query: 'insurance electricity', filters: { correspondent: 'allianz' } });
    expect(byCorrespondent.sources.map((s) => s.documentId)).toEqual([2]);
    const byDate = await search(h, { query: 'insurance electricity', filters: { from: '2024-01-01', to: '' } });
    expect(byDate.sources.map((s) => s.documentId).sort()).toEqual([1, 3]);
    const byType = await search(h, { query: 'agreement', filters: { documentType: 'Contract' }, limit: 1 });
    expect(byType.sources).toHaveLength(1);
    expect(byType.sources[0].documentId).toBe(4);
    const filters = (await h.inject({ method: 'GET', url: '/api/rag/filters', headers: h.apiKeyHeaders() })).json();
    expect(filters).toEqual({ correspondents: ['Allianz', 'City Power'], documentTypes: ['Contract', 'Invoice'] });
    const invalid = await h.inject({ method: 'POST', url: '/api/rag/search', headers: h.apiKeyHeaders(), payload: { query: 'x', filters: { from: '01.01.2024' } } });
    expect(invalid.statusCode).toBe(400);
  });

  it('streams a chat answer with sources', async () => {
    h.llm.clearRequests();
    const res = await h.inject({
      method: 'POST',
      url: '/api/rag/chat',
      headers: h.apiKeyHeaders(),
      payload: { question: 'How much was the electricity bill?' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = parseSsePayload(res.payload) as ChatStreamEvent[];
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('status');
    expect(types.indexOf('sources')).toBeLessThan(types.indexOf('delta'));
    expect(types.at(-1)).toBe('done');
    const sources = events.find((e) => e.type === 'sources') as Extract<ChatStreamEvent, { type: 'sources' }>;
    expect(sources.sources[0].documentId).toBe(1);
    const answer = events
      .filter((e): e is Extract<ChatStreamEvent, { type: 'delta' }> => e.type === 'delta')
      .map((e) => e.text)
      .join('');
    expect(answer).toBe('The electricity bill was 89.50 EUR [1].');
    expect(events.at(-1)).toEqual({ type: 'done', usage: { promptTokens: 400, completionTokens: 12, totalTokens: 412 }, model: 'test-model' });

    // the prompt contains the numbered excerpts
    const [chatReq] = h.llm.chatRequests();
    const msgs = (chatReq.body as { messages: { role: string; content: string }[] }).messages;
    expect(msgs[0].content).toContain('Cite the excerpts');
    expect(msgs.at(-1)!.content).toContain('Question: How much was the electricity bill?');
    expect(msgs.at(-1)!.content).toContain('[1] Title: Electricity bill | From: City Power');
    expect(h.ctx.repos.usage.stats().byFeature).toContainEqual({ feature: 'rag', calls: 1, tokens: 412 });
  });

  it('rewrites follow-up questions using the history', async () => {
    h.llm.clearRequests();
    const res = await h.inject({
      method: 'POST',
      url: '/api/rag/chat',
      headers: h.apiKeyHeaders(),
      payload: {
        question: 'And in March?',
        history: [
          { role: 'user', content: 'Tell me about my energy costs' },
          { role: 'assistant', content: 'You have an electricity bill from City Power [1].' },
        ],
      },
    });
    const events = parseSsePayload(res.payload) as ChatStreamEvent[];
    expect(events.filter((e) => e.type === 'status').map((e) => (e as { message: string }).message)).toContain('Understanding the question…');
    const [condense, answer] = h.llm.chatRequests();
    expect(condense.body).toMatchObject({ response_format: { type: 'json_object' }, temperature: 0 });
    const msgs = (answer.body as { messages: { role: string; content: string }[] }).messages;
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    // citations are removed from the history sent to the model
    expect(msgs[2].content).toBe('You have an electricity bill from City Power.');
    expect((events.find((e) => e.type === 'sources') as { sources: RagSource[] }).sources[0].documentId).toBe(1);
  });

  it('answers through the legacy non-streaming endpoint', async () => {
    const res = await h.inject({ method: 'POST', url: '/api/rag/ask', headers: h.apiKeyHeaders(), payload: { question: 'electricity bill amount' } });
    expect(res.json()).toMatchObject({
      answer: 'The electricity bill was 89.50 EUR [1].',
      sources: expect.arrayContaining([expect.objectContaining({ doc_id: 1, title: 'Electricity bill', correspondent: 'City Power', date: '2024-03-31' })]),
    });
  });

  it('re-indexes changed documents only', async () => {
    h.paperless.clearRequests();
    h.llm.clearRequests();
    await h.rag.sync();
    // nothing changed: one listing, no content fetch, no embeddings
    expect(h.paperless.calls('GET', '/api/documents/').filter((r) => r.query.id__in)).toHaveLength(0);
    expect(h.llm.embeddingRequests()).toHaveLength(0);

    h.paperless.editDocument(1, { content: 'City Power statement about the solar panel feed-in tariff.' });
    await h.rag.sync();
    expect(h.paperless.calls('GET', '/api/documents/').filter((r) => r.query.id__in).map((r) => r.query.id__in)).toEqual(['1']);
    const embedded = h.llm.embeddingRequests().flatMap((r) => r.body!.input as string[]);
    expect(embedded).toHaveLength(1);
    expect(embedded[0]).toContain('solar panel');
    expect((await search(h, { query: 'solar' })).sources[0].documentId).toBe(1);
    expect(h.rag.status().embedded).toBe(h.rag.status().chunks);
  });

  it('re-indexes documents whose metadata changed (renamed correspondent)', async () => {
    h.paperless.correspondents.get(11)!.name = 'Allianz Versicherung';
    await h.rag.sync();
    const res = await search(h, { query: 'premium' });
    expect(res.sources[0]).toMatchObject({ documentId: 2, correspondent: 'Allianz Versicherung' });
  });

  it('removes deleted documents', async () => {
    h.paperless.deleteDocument(3);
    await h.rag.sync();
    expect(h.rag.status().documents).toBe(3);
    const res = await search(h, { query: 'doctor appointment checkup' });
    expect(res.sources.map((s) => s.documentId)).not.toContain(3);
  });

  it('re-embeds everything when the embedding model changes', async () => {
    const chunks = h.rag.status().chunks;
    h.ctx.config.update({ rag: { embeddingModel: 'mock-embed-v2' } });
    h.llm.clearRequests();
    await h.rag.sync();
    const inputs = h.llm.embeddingRequests().flatMap((r) => r.body!.input as string[]);
    expect(inputs).toHaveLength(chunks);
    expect(h.llm.embeddingRequests()[0].body).toMatchObject({ model: 'mock-embed-v2' });
    expect(h.rag.status()).toMatchObject({ embeddingModel: 'mock-embed-v2', embedded: chunks, vectorSearch: true });
    expect((await search(h, { query: 'automobile coverage' })).sources[0].documentId).toBe(2);
  });

  it('rebuilds the index from scratch', async () => {
    const cookie = await h.login();
    const res = await h.inject({ method: 'POST', url: '/api/rag/rebuild', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    await waitFor(() => h.rag.status().state === 'idle' && h.rag.status().embedded > 0);
    expect(h.rag.status()).toMatchObject({ documents: 3, lastError: null });
    // API keys may not trigger a rebuild
    expect((await h.inject({ method: 'POST', url: '/api/rag/rebuild', headers: h.apiKeyHeaders() })).statusCode).toBe(403);
  });

  it('keeps working with keyword search when the embedding service fails', async () => {
    h.ctx.config.update({ rag: { embeddingModel: 'broken-model' } });
    h.llm.opts.embeddingErrorStatus = 400;
    await h.rag.sync();
    expect(h.rag.status()).toMatchObject({ state: 'error', embedded: 0, vectorSearch: false });
    expect(h.rag.status().lastError).toMatch(/^Embedding failed – keyword search still works/);
    const res = await search(h, { query: 'premium' });
    expect(res.mode).toBe('keyword');
    expect(res.sources[0].documentId).toBe(2);
    delete h.llm.opts.embeddingErrorStatus;
    await h.rag.sync();
    expect(h.rag.status()).toMatchObject({ state: 'idle', lastError: null, vectorSearch: true });
  });
});

describe('RAG without embeddings (keyword only)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ embedding: 'none' });
    seed(h);
    h.llm.reply(chatHandler);
  });
  afterAll(() => h.close());

  it('answers from an empty index with a hint', async () => {
    const res = await h.inject({ method: 'POST', url: '/api/rag/chat', headers: h.apiKeyHeaders(), payload: { question: 'What is in my archive?' } });
    const events = parseSsePayload(res.payload) as ChatStreamEvent[];
    expect(events[0]).toMatchObject({ type: 'status', message: expect.stringContaining('index is still empty') });
    expect(events.find((e) => e.type === 'sources')).toEqual({ type: 'sources', sources: [] });
    const user = (h.llm.chatRequests().at(-1)!.body as { messages: { content: string }[] }).messages.at(-1)!.content;
    expect(user).toContain('(No matching documents were found in the archive.)');
  });

  it('indexes without embedding requests and searches by keyword', async () => {
    h.llm.clearRequests();
    await h.rag.sync();
    expect(h.llm.embeddingRequests()).toHaveLength(0);
    expect(h.rag.status()).toMatchObject({ documents: 4, embedded: 0, vectorSearch: false, embeddingProvider: 'none', embeddingModel: null, state: 'idle' });
    const res = await search(h, { query: 'insurance' });
    expect(res.mode).toBe('keyword');
    expect(res.sources[0].documentId).toBe(2);
    // German-style prefix search
    expect((await search(h, { query: 'rental agreements' })).sources[0].documentId).toBe(4);
    // purely semantic queries find nothing without embeddings
    expect((await search(h, { query: 'automobile' })).sources).toEqual([]);
  });

  it('boosts documents of a mentioned correspondent and recent documents', async () => {
    const res = await search(h, { query: 'latest document from City Power' });
    expect(res.sources[0].documentId).toBe(1);
  });

  it('chats with keyword retrieval', async () => {
    const res = await h.inject({ method: 'POST', url: '/api/rag/chat', headers: h.apiKeyHeaders(), payload: { question: 'electricity amount' } });
    const events = parseSsePayload(res.payload) as ChatStreamEvent[];
    expect((events.find((e) => e.type === 'sources') as { sources: RagSource[] }).sources[0].documentId).toBe(1);
    expect(events.at(-1)!.type).toBe('done');
  });

  it('reports errors of the model inside the stream', async () => {
    h.llm.reply({ status: 401, error: { error: { message: 'Invalid key' } } });
    const res = await h.inject({ method: 'POST', url: '/api/rag/chat', headers: h.apiKeyHeaders(), payload: { question: 'electricity amount' } });
    const events = parseSsePayload(res.payload) as ChatStreamEvent[];
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('Invalid key') });
    h.llm.reply(chatHandler);
  });

  it('is unavailable when disabled', async () => {
    h.ctx.config.update({ rag: { enabled: false } });
    expect(h.rag.status().state).toBe('disabled');
    for (const url of ['/api/rag/search', '/api/rag/chat', '/api/rag/ask']) {
      const res = await h.inject({ method: 'POST', url, headers: h.apiKeyHeaders(), payload: { query: 'x', question: 'x' } });
      expect(res.statusCode, url).toBe(409);
    }
    expect((await h.inject({ method: 'GET', url: '/api/session' })).json().features).toEqual({ rag: false });
    h.ctx.config.update({ rag: { enabled: true } });
  });
});
