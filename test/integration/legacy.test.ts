import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analysisJson, createHarness, waitFor, type Harness } from '../helpers/appHarness.js';

let h: Harness;
let auth: Record<string, string>;
let release: (() => void) | null = null;

beforeAll(async () => {
  h = await createHarness();
  auth = h.apiKeyHeaders();
  h.paperless.addDocument({ id: 1, title: 'first.pdf', content: 'First document content for the legacy API' });
  h.paperless.addDocument({ id: 2, title: 'second.pdf', content: 'Second document content for the legacy API' });
});
afterAll(() => h.close());

describe('legacy endpoints of Paperless-AI 3.x', () => {
  it('/api/processing-status before anything was processed', async () => {
    const res = await h.inject({ method: 'GET', url: '/api/processing-status', headers: auth });
    expect(res.json()).toEqual({ currentlyProcessing: null, lastProcessed: null, processedToday: 0, isProcessing: false });
  });

  it('/api/processing-status while a document is being processed', async () => {
    h.llm.reply(
      () =>
        new Promise((resolve) => {
          release = () => resolve(analysisJson({ title: 'Processed via webhook' }));
        }),
    );
    await h.inject({ method: 'POST', url: '/api/webhook/document', headers: auth, payload: { document_id: 1 } });
    await waitFor(() => release !== null);
    const busy = (await h.inject({ method: 'GET', url: '/api/processing-status', headers: auth })).json();
    expect(busy).toMatchObject({
      currentlyProcessing: { documentId: 1, title: 'first.pdf', status: 'processing', startTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
      isProcessing: true,
    });
    const status = (await h.inject({ method: 'GET', url: '/api/processing/status', headers: auth })).json();
    expect(status.current).toEqual([expect.objectContaining({ documentId: 1, source: 'webhook', stage: 'analyzing' })]);
    release!();
    await h.engine.drain();
    const done = (await h.inject({ method: 'GET', url: '/api/processing-status', headers: auth })).json();
    expect(done).toMatchObject({
      currentlyProcessing: null,
      isProcessing: false,
      processedToday: 1,
      lastProcessed: { documentId: 1, title: 'Processed via webhook', processed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
    });
  });

  it('/api/scan/now processes synchronously', async () => {
    h.llm.reply(analysisJson({ title: 'Scanned now' }));
    const res = await h.inject({ method: 'POST', url: '/api/scan/now', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('Task completed');
    expect(h.paperless.docs.get(2)!.title).toBe('Scanned now');
    expect(h.ctx.repos.documents.counts().processed).toBe(2);
  });

  it('/api/reset-documents and /api/reset-all-documents', async () => {
    expect((await h.inject({ method: 'POST', url: '/api/reset-documents', headers: auth, payload: { ids: ['1'] } })).json()).toEqual({ success: true });
    expect(h.ctx.repos.documents.get(1)).toBeUndefined();
    expect(h.ctx.repos.documents.get(2)).toBeDefined();
    expect((await h.inject({ method: 'POST', url: '/api/reset-all-documents', headers: auth })).json()).toEqual({ success: true });
    expect(h.ctx.repos.documents.counts()).toEqual({ processed: 0, failed: 0, skipped: 0 });
  });

  it('/api/key-regenerate returns a new working key', async () => {
    const cookie = await h.login();
    const old = h.ctx.cfg.security.apiKey;
    const res = await h.inject({ method: 'POST', url: '/api/key-regenerate', headers: { cookie } });
    const body = res.json();
    expect(body.success).toBe(body.apiKey);
    expect(body.apiKey).toMatch(/^[0-9a-f]{64}$/);
    expect((await h.inject({ method: 'GET', url: '/api/processing-status', headers: { 'x-api-key': old } })).statusCode).toBe(401);
    expect((await h.inject({ method: 'GET', url: '/api/processing-status', headers: { 'x-api-key': body.apiKey } })).statusCode).toBe(200);
    auth = { 'x-api-key': body.apiKey };
  });

  it('serves the OpenAPI documentation', async () => {
    const res = await h.inject({ method: 'GET', url: '/api-docs/json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.info.title).toBe('Paperless-AI API');
    expect(Object.keys(spec.paths)).toContain('/api/webhook/document');
    // legacy endpoints are hidden from the documentation
    expect(Object.keys(spec.paths)).not.toContain('/api/scan/now');
  });
});
