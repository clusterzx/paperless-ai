import { afterEach, describe, expect, it, vi } from 'vitest';
import { analysisJson, createHarness, type Harness, type HarnessOptions } from '../helpers/appHarness.js';
import type { ChatRequestInfo } from '../helpers/mockLlm.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  h = await createHarness(opts);
  return h;
}

/** Trigger a scan through the API and wait until the queue is empty. */
async function scan(hh: Harness): Promise<number> {
  const res = await hh.inject({ method: 'POST', url: '/api/processing/scan', headers: hh.apiKeyHeaders() });
  expect(res.statusCode).toBe(200);
  await hh.engine.drain(10_000);
  return res.json().queued as number;
}

const ELECTRICITY = 'City Power GmbH\nInvoice no. 2024-03-77\nElectricity consumption March 2024\nTotal amount: 1.234,56 EUR\nDue 01.04.2024';
const LETTER = 'ACME Corporation\nDear customer, your contract will be renewed automatically on 2024-02-02.';

function analysisFor(req: ChatRequestInfo): string {
  if (req.user.includes('City Power')) {
    return analysisJson({
      title: 'Electricity invoice March 2024',
      correspondent: 'City Power',
      tags: ['invoice', 'Electricity'],
      document_type: 'INVOICE',
      document_date: '15.03.2024',
      custom_fields: [
        { field_name: 'Amount', value: '1.234,56 €' },
        { field_name: 'Due date', value: '01.04.2024' },
        { field_name: 'Not configured', value: 'ignored' },
      ],
    });
  }
  if (req.user.includes('ACME')) {
    return analysisJson({ title: 'Contract renewal', correspondent: 'ACME Corporation', tags: ['Contract'], document_type: 'Letter', document_date: '2024-02-02' });
  }
  return analysisJson({ title: 'Something else', tags: ['Misc'] });
}

function seedBasic(hh: Harness) {
  const p = hh.paperless;
  p.addTag('Invoice', 1);
  p.addTag('Old', 3);
  p.addCorrespondent('ACME', 10);
  p.addDocumentType('Invoice', 20);
  p.addDocument({ id: 101, title: 'scan_0001.pdf', content: ELECTRICITY, tags: [3], created: '2024-01-01' });
  p.addDocument({ id: 102, title: 'scan_0002.pdf', content: LETTER, correspondent: 10, created: '2024-01-05' });
  p.addDocument({ id: 103, title: 'empty.pdf', content: '   ' });
  p.addDocument({ id: 104, title: 'locked.pdf', content: 'Some content that is long enough', user_can_change: false });
}

describe('automatic processing', () => {
  it('analyses documents and applies the suggestions to Paperless', async () => {
    const hh = await harness({
      config: {
        processing: {
          customFields: [
            { name: 'Amount', type: 'monetary', currency: 'EUR', description: '' },
            { name: 'Due date', type: 'date', description: '' },
          ],
        },
      },
    });
    seedBasic(hh);
    hh.llm.reply(analysisFor);

    expect(await scan(hh)).toBe(4);

    // ---- document 101: everything new
    const electricityTag = hh.paperless.tagByName('Electricity')!;
    const cityPower = hh.paperless.correspondentByName('City Power')!;
    const amount = hh.paperless.customFieldByName('Amount')!;
    const due = hh.paperless.customFieldByName('Due date')!;
    expect(electricityTag).toBeDefined();
    expect(cityPower).toBeDefined();
    expect(amount).toMatchObject({ data_type: 'monetary', extra_data: { default_currency: 'EUR' } });
    expect(due.data_type).toBe('date');
    expect(hh.paperless.customFieldByName('Not configured')).toBeUndefined();
    // existing objects are matched case-insensitively (no duplicates)
    expect(hh.paperless.calls('POST', '/api/document_types/')).toHaveLength(1); // only "Letter" for document 102
    expect([...hh.paperless.tags.values()].filter((t) => t.name.toLowerCase() === 'invoice')).toHaveLength(1);

    const [patch101] = hh.paperless.patches(101);
    expect(patch101.body).toEqual({
      tags: [3, 1, electricityTag.id],
      title: 'Electricity invoice March 2024',
      created: '2024-03-15',
      document_type: 20,
      correspondent: cityPower.id,
      custom_fields: [
        { field: amount.id, value: 'EUR1234.56' },
        { field: due.id, value: '2024-04-01' },
      ],
    });
    expect(hh.paperless.docs.get(101)).toMatchObject({ title: 'Electricity invoice March 2024', correspondent: cityPower.id, created: '2024-03-15' });

    // ---- document 102: existing correspondent is kept
    const [patch102] = hh.paperless.patches(102);
    const letter = hh.paperless.documentTypeByName('Letter')!;
    expect(patch102.body).toEqual({
      tags: [hh.paperless.tagByName('Contract')!.id],
      title: 'Contract renewal',
      created: '2024-02-02',
      document_type: letter.id,
    });
    expect(hh.paperless.correspondentByName('ACME Corporation')).toBeUndefined();

    // ---- skipped documents
    expect(hh.paperless.patches(103)).toHaveLength(0);
    expect(hh.paperless.patches(104)).toHaveLength(0);
    const docs = hh.ctx.repos.documents;
    expect(docs.get(101)).toMatchObject({ status: 'processed', title: 'Electricity invoice March 2024', modified: hh.paperless.docs.get(101)!.modified });
    expect(docs.get(102)!.status).toBe('processed');
    expect(docs.get(103)).toMatchObject({ status: 'skipped', reason: expect.stringContaining('No text content') });
    expect(docs.get(104)).toMatchObject({ status: 'skipped', reason: expect.stringContaining('no permission') });

    // ---- the AI request
    const [req] = hh.llm.chatRequests();
    const body = req.body as { messages: { role: string; content: string }[]; response_format: { json_schema: { schema: { properties: Record<string, unknown> } } } };
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].content).toContain('Original file name: 101.pdf');
    expect(Object.keys(body.response_format.json_schema.schema.properties)).toContain('custom_fields');

    // ---- history & usage
    const history = await hh.inject({ method: 'GET', url: '/api/history?sort=documentId&order=asc', headers: hh.apiKeyHeaders() });
    const items = history.json().items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      documentId: 101,
      source: 'scan',
      provider: 'custom',
      model: 'test-model',
      title: 'Electricity invoice March 2024',
      correspondent: 'City Power',
      documentType: 'Invoice',
      tagNames: ['Old', 'Invoice', 'Electricity'],
      totalTokens: 120,
      canRevert: true,
      before: { title: 'scan_0001.pdf', tags: [3], correspondent: null, document_type: null, created: '2024-01-01', custom_fields: [] },
    });
    expect(items[1]).toMatchObject({ documentId: 102, correspondent: 'ACME', documentType: 'Letter' });
    const usage = hh.ctx.repos.usage.stats();
    expect(usage).toMatchObject({ calls: 2, analyses: 2, totalTokens: 240 });
    expect(usage.byFeature).toEqual([{ feature: 'process', calls: 2, tokens: 240 }]);

    const status = await hh.inject({ method: 'GET', url: '/api/processing/status', headers: hh.apiKeyHeaders() });
    expect(status.json()).toMatchObject({ running: false, queued: 0, counts: { processed: 2, failed: 0, skipped: 2 }, processedToday: 2 });

    // ---- nothing to do on the next scan
    hh.llm.clearRequests();
    expect(await scan(hh)).toBe(0);
    expect(hh.llm.chatRequests()).toHaveLength(0);

    // a skipped document is retried once it changed (e.g. OCR finished)
    hh.paperless.editDocument(103, { content: 'OCR finished: a short note from ACME' });
    expect(await scan(hh)).toBe(1);
    expect(docs.get(103)!.status).toBe('processed');
  });

  it('overwrites existing correspondents when enabled and shares created objects', async () => {
    const hh = await harness({ config: { processing: { overwriteCorrespondent: true } } });
    seedBasic(hh);
    hh.llm.reply(analysisFor);
    await scan(hh);
    const acmeCorp = hh.paperless.correspondentByName('ACME Corporation')!;
    expect(hh.paperless.docs.get(102)!.correspondent).toBe(acmeCorp.id);
    // created without owner → visible to every Paperless user
    expect(acmeCorp.owner).toBeNull();
    expect(hh.paperless.tagByName('Contract')!.owner).toBeNull();
    expect(hh.paperless.calls('POST', '/api/correspondents/').map((c) => c.body)).toContainEqual({ name: 'ACME Corporation', matching_algorithm: 0, owner: null });
  });

  it('can leave created objects to the API user', async () => {
    const hh = await harness({ config: { processing: { shareCreatedObjects: false } } });
    seedBasic(hh);
    hh.llm.reply(analysisFor);
    await scan(hh);
    expect(hh.paperless.tagByName('Contract')!.owner).toBe(3);
    // the existing correspondent is kept by default
    expect(hh.paperless.docs.get(102)!.correspondent).toBe(10);
  });

  it('ignores document dates in the future and tells the model today\'s date', async () => {
    const hh = await harness();
    hh.paperless.addDocument({ id: 5, content: 'Invoice, payable until 2099-12-31', created: '2024-05-01' });
    hh.llm.reply(analysisJson({ title: 'Invoice', document_date: '2099-12-31' }));
    await scan(hh);
    expect(hh.paperless.docs.get(5)).toMatchObject({ title: 'Invoice', created: '2024-05-01' });
    expect(hh.llm.chatRequests()[0].body!.messages).toContainEqual(expect.objectContaining({ content: expect.stringMatching(/^Today's date: \d{4}-\d{2}-\d{2}\n/) }));
  });

  it('saves the other changes when Paperless rejects a custom field value', async () => {
    const hh = await harness({ config: { processing: { customFields: [{ name: 'Reference', type: 'string', description: '' }, { name: 'Amount', type: 'monetary', currency: 'EUR', description: '' }] } } });
    const ref = hh.paperless.addCustomField('Reference', 'string');
    const amount = hh.paperless.addCustomField('Amount', 'monetary');
    hh.paperless.addDocument({ id: 6, content: 'Invoice R-1 over 12.50 EUR' });
    hh.llm.reply(analysisJson({ title: 'Invoice R-1', custom_fields: [{ field_name: 'Reference', value: 'R-1' }, { field_name: 'Amount', value: '12.50' }] }));
    let rejected = false;
    hh.paperless.intercept = (req) => {
      if (req.method !== 'PATCH' || rejected) return undefined;
      rejected = true;
      // e.g. a select option or value format this Paperless version does not accept
      return { status: 400, body: { custom_fields: [{}, { non_field_errors: ['Value not allowed'] }] } };
    };
    await scan(hh);
    const patches = hh.paperless.patches(6).map((p) => p.body as Record<string, unknown>);
    expect(patches).toHaveLength(2);
    expect(patches[1]).toEqual({ title: 'Invoice R-1', custom_fields: [{ field: ref.id, value: 'R-1' }] });
    expect(hh.paperless.docs.get(6)).toMatchObject({ title: 'Invoice R-1', custom_fields: [{ field: ref.id, value: 'R-1' }] });
    expect(hh.ctx.repos.documents.get(6)!.status).toBe('processed');
    expect(amount.id).toBeGreaterThan(0);
  });

  it('does not change anything when the suggestion matches the document', async () => {
    const hh = await harness();
    hh.paperless.addTag('Invoice', 1);
    hh.paperless.addDocument({ id: 1, title: 'Same title', content: 'Unremarkable document content here', tags: [1], created: '2024-05-05' });
    hh.llm.reply(analysisJson({ title: 'Same title', tags: ['invoice'], document_date: '2024-05-05' }));
    await scan(hh);
    expect(hh.paperless.patches()).toHaveLength(0);
    expect(hh.ctx.repos.documents.get(1)!.status).toBe('processed');
    expect(hh.ctx.repos.history.list({}).total).toBe(0);
  });

  it('never changes a document twice when saving the history fails after the update', async () => {
    const hh = await harness();
    hh.paperless.addDocument({ id: 1, title: 'scan.pdf', content: 'Unremarkable document content here', created: '2024-05-05' });
    hh.llm.reply(analysisJson({ title: 'New title' }));
    const spy = vi.spyOn(hh.ctx.repos.history, 'add').mockImplementation(() => {
      throw new Error('disk full');
    });
    try {
      await scan(hh);
    } finally {
      spy.mockRestore();
    }
    expect(hh.paperless.patches()).toHaveLength(1);
    expect(hh.ctx.repos.documents.get(1)!.status).toBe('processed');
    expect(await scan(hh)).toBe(0);
    expect(hh.paperless.patches()).toHaveLength(1);
  });

  it('marks failures, retries them on later scans up to maxAttempts and again after a change', async () => {
    const hh = await harness({ config: { processing: { maxAttempts: 2 } } });
    hh.paperless.addDocument({ id: 7, title: 'Big', content: 'A document that the model cannot handle' });
    hh.llm.reply({ status: 400, error: { error: { message: 'This model maximum context length is exceeded' } } });

    expect(await scan(hh)).toBe(1);
    expect(hh.ctx.repos.documents.get(7)).toMatchObject({ status: 'failed', attempts: 1, reason: expect.stringContaining('context length') });
    expect(hh.engine.status().lastError).toContain('Document 7');
    expect(await scan(hh)).toBe(1);
    expect(hh.ctx.repos.documents.get(7)).toMatchObject({ status: 'failed', attempts: 2 });
    expect(await scan(hh)).toBe(0);
    expect(hh.llm.chatRequests()).toHaveLength(2);

    const problems = await hh.inject({ method: 'GET', url: '/api/processing/problems', headers: hh.apiKeyHeaders() });
    expect(problems.json()).toEqual([
      expect.objectContaining({ documentId: 7, status: 'failed', attempts: 2, url: `${hh.paperless.url}/documents/7/details` }),
    ]);

    // the document is edited in Paperless → it is tried again
    hh.llm.reply(analysisJson({ title: 'Now it works' }));
    hh.paperless.editDocument(7, { content: 'A shorter version of the document' });
    expect(await scan(hh)).toBe(1);
    expect(hh.ctx.repos.documents.get(7)!.status).toBe('processed');
    expect(hh.paperless.docs.get(7)!.title).toBe('Now it works');
  });

  it('pauses on rate limits without counting an attempt and continues automatically', async () => {
    const hh = await harness({ config: { processing: { maxAttempts: 1 } } });
    hh.paperless.addDocument({ id: 9, content: 'Rate limited document content' });
    let calls = 0;
    hh.llm.reply(() =>
      ++calls <= 3
        ? { status: 429, error: { error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }, headers: { 'Retry-After': '0' } }
        : analysisJson({ title: 'After the pause' }),
    );
    const res = await hh.inject({ method: 'POST', url: '/api/processing/scan', headers: hh.apiKeyHeaders() });
    expect(res.json().queued).toBe(1);
    await vi.waitFor(() => expect(hh.engine.status().rateLimitedUntil).toBeGreaterThan(Date.now()));
    expect(hh.engine.status()).toMatchObject({ queued: 1, current: [], lastError: null });
    expect(hh.ctx.repos.documents.get(9)).toBeUndefined();

    await hh.engine.drain(10_000);
    expect(hh.paperless.docs.get(9)!.title).toBe('After the pause');
    expect(hh.ctx.repos.documents.get(9)!.status).toBe('processed');
    expect(hh.engine.status().rateLimitedUntil).toBeNull();
  });

  it('retries a failed document manually', async () => {
    const hh = await harness({ config: { processing: { maxAttempts: 1 } } });
    hh.paperless.addDocument({ id: 8, content: 'Some document content for retrying' });
    hh.llm.reply({ status: 400, error: { error: { message: 'boom' } } });
    await scan(hh);
    expect(await scan(hh)).toBe(0);
    hh.llm.reply(analysisJson({ title: 'Retried' }));
    const res = await hh.inject({ method: 'POST', url: '/api/processing/retry', headers: hh.apiKeyHeaders(), payload: {} });
    expect(res.json()).toEqual({ queued: 1 });
    await hh.engine.drain();
    expect(hh.paperless.docs.get(8)!.title).toBe('Retried');
  });

  it('asks the model again when the answer is not valid JSON', async () => {
    const hh = await harness();
    hh.paperless.addDocument({ id: 9, content: 'Document with enough content to analyse' });
    let calls = 0;
    hh.llm.reply(() => (++calls === 1 ? 'Sure! The title should be "x".' : '```json\n{"title": "Second try", "tags": [],}\n```'));
    await scan(hh);
    expect(hh.paperless.docs.get(9)!.title).toBe('Second try');
    const [, second] = hh.llm.chatRequests();
    const msgs = (second.body as { messages: { role: string; content: string }[] }).messages;
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(msgs[3].content).toContain('not valid JSON');
    // usage of both calls is recorded together
    expect(hh.ctx.repos.usage.stats()).toMatchObject({ calls: 1, totalTokens: 240 });
  });

  it('falls back to json_object when the provider rejects json_schema', async () => {
    const hh = await harness({ llm: { rejectJsonSchema: true } });
    hh.paperless.addDocument({ id: 10, content: 'Document with enough content to analyse' });
    hh.llm.reply(analysisJson({ title: 'Fallback works' }));
    await scan(hh);
    expect(hh.paperless.docs.get(10)!.title).toBe('Fallback works');
    expect(hh.llm.chatRequests().map((r) => (r.body!.response_format as { type: string }).type)).toEqual(['json_schema', 'json_object']);
  });

  it('respects restrictions to existing tags, correspondents and document types', async () => {
    const hh = await harness({
      config: { processing: { restrict: { tags: true, correspondents: true, documentTypes: true }, addProcessedTag: true } },
    });
    hh.paperless.addTag('Invoice', 1);
    hh.paperless.addTag('ai-processed', 2);
    hh.paperless.addCorrespondent('ACME', 10);
    hh.paperless.addDocumentType('Invoice', 20);
    hh.paperless.addDocument({ id: 1, content: 'Invoice from Nobody Inc about something' });
    hh.llm.reply(analysisJson({ title: 'T', tags: ['Invoice', 'Brand new tag'], correspondent: 'Nobody Inc', document_type: 'Receipt' }));
    await scan(hh);

    for (const c of ['tags', 'correspondents', 'document_types']) expect(hh.paperless.calls('POST', `/api/${c}/`)).toHaveLength(0);
    expect(hh.paperless.patches(1)[0].body).toEqual({ tags: [1, 2], title: 'T' });

    // the JSON schema restricts the model to the existing names (the processed tag is never offered)
    const schema = (hh.llm.chatRequests()[0].body!.response_format as { json_schema: { schema: { properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }> } } })
      .json_schema.schema;
    expect(schema.properties.tags.items!.enum).toEqual(['Invoice']);
    expect(schema.properties.correspondent.enum).toEqual(['ACME', '']);
    expect(schema.properties.document_type.enum).toEqual(['Invoice', '']);
  });

  it('only processes tagged documents, removes the trigger tag and re-processes when it is added again', async () => {
    const hh = await harness({
      config: {
        processing: { onlyTagged: true, tags: ['ai-todo'], removeTriggerTags: true, addProcessedTag: true, processedTagName: 'ai-done', useExistingData: true },
      },
    });
    hh.paperless.addTag('ai-todo', 50);
    hh.paperless.addTag('Finance', 51);
    hh.paperless.addDocument({ id: 301, title: 'tagged', content: 'Please process this document', tags: [50, 51] });
    hh.paperless.addDocument({ id: 302, title: 'untagged', content: 'Do not touch this document' });
    hh.llm.reply(analysisJson({ title: 'Processed', tags: ['Finance', 'ai-todo'] }));

    expect(await scan(hh)).toBe(1);
    const done = hh.paperless.tagByName('ai-done')!;
    expect(hh.paperless.patches(301)[0].body).toEqual({ tags: [51, done.id], title: 'Processed' });
    expect(hh.paperless.patches(302)).toHaveLength(0);
    expect(hh.paperless.calls('GET', '/api/documents/').at(-1)!.query.tags__id__in).toBe('50');
    // internal tags are not offered to the model
    const system = (hh.llm.chatRequests()[0].body as { messages: { content: string }[] }).messages[0].content;
    expect(system).toContain('Existing tags (prefer these): Finance');
    expect(system).not.toMatch(/Existing tags[^\n]*ai-todo/);

    // nothing to do while the trigger tag is absent
    expect(await scan(hh)).toBe(0);

    // the user adds the trigger tag again → processed again
    hh.paperless.editDocument(301, { tags: [...hh.paperless.docs.get(301)!.tags, 50], title: 'Edited by user' });
    expect(await scan(hh)).toBe(1);
    expect(hh.paperless.patches(301)).toHaveLength(2);
    expect(hh.paperless.docs.get(301)!.tags).not.toContain(50);
    expect(hh.paperless.docs.get(301)!.title).toBe('Processed');
  });

  it('skips scanning when none of the trigger tags exist', async () => {
    const hh = await harness({ config: { processing: { onlyTagged: true, tags: ['missing-tag'] } } });
    hh.paperless.addDocument({ id: 1, content: 'Some content to process here' });
    expect(await scan(hh)).toBe(0);
    expect(hh.paperless.calls('GET', '/api/documents/')).toHaveLength(0);
  });

  it('uses prompt tags', async () => {
    const hh = await harness({ config: { processing: { usePromptTags: true, promptTags: ['Red', 'Blue'] } } });
    hh.paperless.addDocument({ id: 1, content: 'Some colourful content to process' });
    hh.llm.reply(analysisJson({ title: 'Colours', tags: ['red', 'Green'] }));
    await scan(hh);
    const red = hh.paperless.tagByName('Red')!;
    expect(hh.paperless.tagByName('Green')).toBeUndefined();
    expect(hh.paperless.patches(1)[0].body).toMatchObject({ tags: [red.id] });
  });

  it('honours disabled functions', async () => {
    const hh = await harness({ config: { processing: { functions: { title: false, tags: false, correspondent: false, documentType: false, documentDate: false } } } });
    hh.paperless.addDocument({ id: 1, title: 'Keep me', content: 'Some content to process here' });
    hh.llm.reply(analysisJson({ title: 'Changed', tags: ['X'], correspondent: 'Y', document_type: 'Z', document_date: '2020-01-01' }));
    await scan(hh);
    expect(hh.paperless.patches()).toHaveLength(0);
    expect(hh.paperless.docs.get(1)!.title).toBe('Keep me');
    const schema = (hh.llm.chatRequests()[0].body!.response_format as { json_schema: { schema: { properties: object } } }).json_schema.schema;
    expect(Object.keys(schema.properties)).toEqual(['language']);
  });

  it('processes documents queued through the API with a custom prompt', async () => {
    const hh = await harness();
    hh.paperless.addDocument({ id: 1, content: 'Some content to process here' });
    hh.llm.reply(analysisJson({ title: 'First' }));
    await scan(hh);
    hh.llm.reply(analysisJson({ title: 'Forced again' }));
    const res = await hh.inject({
      method: 'POST',
      url: '/api/processing/documents',
      headers: hh.apiKeyHeaders(),
      payload: { ids: [1], prompt: 'Only extract the title.' },
    });
    expect(res.json()).toEqual({ queued: 1 });
    await hh.engine.drain();
    expect(hh.paperless.docs.get(1)!.title).toBe('Forced again');
    const system = (hh.llm.chatRequests()[1].body as { messages: { content: string }[] }).messages[0].content;
    expect(system.startsWith('Only extract the title.')).toBe(true);
  });

  it('pauses and resumes the queue', async () => {
    const hh = await harness();
    hh.paperless.addDocument({ id: 1, content: 'Some content to process here' });
    hh.llm.reply(analysisJson({ title: 'After resume' }));
    await hh.inject({ method: 'POST', url: '/api/processing/pause', headers: hh.apiKeyHeaders() });
    const res = await hh.inject({ method: 'POST', url: '/api/processing/scan', headers: hh.apiKeyHeaders() });
    expect(res.json()).toEqual({ queued: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(hh.engine.status()).toMatchObject({ paused: true, queued: 1, running: false });
    expect(hh.llm.chatRequests()).toHaveLength(0);
    await hh.inject({ method: 'POST', url: '/api/processing/resume', headers: hh.apiKeyHeaders() });
    await hh.engine.drain();
    expect(hh.paperless.docs.get(1)!.title).toBe('After resume');
  });

  it('processes documents concurrently without creating duplicate tags', async () => {
    const hh = await harness({ config: { processing: { concurrency: 4 } } });
    for (let id = 1; id <= 8; id++) hh.paperless.addDocument({ id, content: `Document number ${id} with some content` });
    hh.llm.reply(analysisJson({ title: 'Same', tags: ['Shared tag', 'Another shared'], correspondent: 'Shared Corp', document_type: 'Shared type' }));
    expect(await scan(hh)).toBe(8);
    expect(hh.paperless.calls('POST', '/api/tags/')).toHaveLength(2);
    expect(hh.paperless.calls('POST', '/api/correspondents/')).toHaveLength(1);
    expect(hh.paperless.calls('POST', '/api/document_types/')).toHaveLength(1);
    expect(hh.ctx.repos.documents.counts().processed).toBe(8);
  });

  it('works with the Ollama provider', async () => {
    const hh = await harness({ aiProvider: 'ollama' });
    hh.paperless.addDocument({ id: 1, content: 'Some content to process with Ollama' });
    hh.llm.reply({ content: analysisJson({ title: 'From Ollama' }), usage: { prompt_tokens: 50, completion_tokens: 10 } });
    await scan(hh);
    expect(hh.paperless.docs.get(1)!.title).toBe('From Ollama');
    const [req] = hh.llm.chatRequests();
    expect(req.path).toBe('/api/chat');
    expect((req.body as { format: { type: string } }).format.type).toBe('object');
    expect(hh.ctx.repos.history.list({}).items[0]).toMatchObject({ provider: 'ollama', model: 'llama3.2', totalTokens: 60 });
  });

  it('works with the Anthropic provider', async () => {
    const hh = await harness({ aiProvider: 'anthropic' });
    hh.paperless.addDocument({ id: 1, content: 'Some content to process with Claude' });
    hh.llm.reply({ content: analysisJson({ title: 'From Claude', tags: ['Claude'] }), usage: { prompt_tokens: 70, completion_tokens: 12 } });
    await scan(hh);
    expect(hh.paperless.docs.get(1)!.title).toBe('From Claude');
    const [req] = hh.llm.chatRequests();
    expect(req.path).toBe('/v1/messages');
    expect(req.body).toMatchObject({ model: 'claude-haiku-4-5', output_config: { format: { type: 'json_schema' } } });
    expect(hh.ctx.repos.history.list({}).items[0]).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-4-5', totalTokens: 82 });
  });

  it('uses a fixed Ollama context size and unloads the model once the queue is empty', async () => {
    const hh = await harness({ aiProvider: 'ollama', config: { ai: { ollama: { contextSize: 8192, unloadWhenIdle: true } } } });
    hh.paperless.addDocument({ id: 1, content: 'First document for Ollama' });
    hh.paperless.addDocument({ id: 2, content: 'Second document for Ollama' });
    await scan(hh);
    await vi.waitFor(() => expect(hh.llm.requests.filter((r) => r.path === '/api/generate')).toHaveLength(1));
    expect(hh.llm.requests.find((r) => r.path === '/api/generate')!.body).toEqual({ model: 'llama3.2', keep_alive: 0 });
    // the model is only unloaded after the last document
    const paths = hh.llm.requests.map((r) => r.path).filter((p) => p !== '/api/tags');
    expect(paths).toEqual(['/api/chat', '/api/chat', '/api/generate']);
    expect(hh.llm.chatRequests().map((r) => (r.body!.options as { num_ctx: number }).num_ctx)).toEqual([8192, 8192]);

    // nothing to do → nothing to unload
    await scan(hh);
    expect(hh.llm.requests.filter((r) => r.path === '/api/generate')).toHaveLength(1);
  });

  it('works with Paperless-ngx 2.x (API v7, created_date)', async () => {
    const hh = await harness({ paperless: { maxVersion: 7 } });
    hh.paperless.addDocument({ id: 1, content: 'Some content to process here', created: '2023-01-01' });
    hh.llm.reply(analysisJson({ title: 'Old Paperless', document_date: '2023-06-30' }));
    await scan(hh);
    const [patch] = hh.paperless.patches(1);
    expect(patch.version).toBe(7);
    expect(patch.body).toEqual({ title: 'Old Paperless', created_date: '2023-06-30' });
    expect(hh.paperless.docs.get(1)!.created).toBe('2023-06-30');
  });
});

describe('webhook', () => {
  it('queues the document referenced by its URL', async () => {
    const hh = await harness();
    hh.paperless.addDocument({ id: 5, content: 'Webhook document content here' });
    hh.llm.reply(analysisJson({ title: 'From webhook' }));
    const res = await hh.inject({
      method: 'POST',
      url: '/api/webhook/document',
      headers: hh.apiKeyHeaders(),
      payload: { url: 'http://paperless/documents/5/details' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ documentId: 5, queued: true });
    await hh.engine.drain();
    expect(hh.paperless.docs.get(5)!.title).toBe('From webhook');
    expect(hh.ctx.repos.history.list({}).items[0].source).toBe('webhook');

    // already processed → not processed again unless forced
    hh.llm.reply(analysisJson({ title: 'Forced' }));
    await hh.inject({ method: 'POST', url: '/api/webhook/document', headers: hh.apiKeyHeaders(), payload: { document_id: '5' } });
    await hh.engine.drain();
    expect(hh.paperless.docs.get(5)!.title).toBe('From webhook');
    await hh.inject({ method: 'POST', url: '/api/webhook/document', headers: hh.apiKeyHeaders(), payload: { doc_url: '/documents/5/', force: true, prompt: 'Webhook prompt' } });
    await hh.engine.drain();
    expect(hh.paperless.docs.get(5)!.title).toBe('Forced');
    const last = hh.llm.chatRequests().at(-1)!.body as { messages: { content: string }[] };
    expect(last.messages[0].content.startsWith('Webhook prompt')).toBe(true);
  });

  it('rejects invalid references', async () => {
    const hh = await harness();
    for (const payload of [{}, { url: 'http://paperless/tags/5/' }, { document_id: 'abc' }, { id: -1 }]) {
      const res = await hh.inject({ method: 'POST', url: '/api/webhook/document', headers: hh.apiKeyHeaders(), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('answers 409 when the app is not configured', async () => {
    const hh = await harness({ config: { ai: { custom: { baseUrl: '' } } } });
    const res = await hh.inject({ method: 'POST', url: '/api/webhook/document', headers: hh.apiKeyHeaders(), payload: { document_id: 1 } });
    expect(res.statusCode).toBe(409);
    const scanRes = await hh.inject({ method: 'POST', url: '/api/processing/scan', headers: hh.apiKeyHeaders() });
    expect(scanRes.statusCode).toBe(409);
    expect(scanRes.json()).toMatchObject({ code: 'not_configured' });
  });
});
