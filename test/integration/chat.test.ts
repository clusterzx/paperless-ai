import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatStreamEvent } from '../../src/shared/api.js';
import { createHarness, parseSsePayload, type Harness } from '../helpers/appHarness.js';

let h: Harness;
let auth: Record<string, string>;

const LONG = Array.from({ length: 300 }, (_, i) =>
  i === 217 ? 'The secret penalty fee for early termination is 1234 EUR.' : `Clause ${i}: general terms and conditions apply to all services.`,
).join('\n\n');

beforeAll(async () => {
  h = await createHarness({ config: { ai: { tokenLimit: 4096, responseTokens: 500 } } });
  auth = h.apiKeyHeaders();
  h.paperless.addTag('Energy', 1);
  h.paperless.addCorrespondent('City Power', 10);
  h.paperless.addDocument({ id: 1, title: 'Electricity bill', content: 'Total amount: 89.50 EUR. Due on 2024-04-15.', correspondent: 10, tags: [1], created: '2024-03-31' });
  h.paperless.addDocument({ id: 2, title: 'Long contract', content: LONG, created: '2020-01-01' });
  h.llm.reply({ content: 'The total is 89.50 EUR.', chunkSize: 5, usage: { prompt_tokens: 80, completion_tokens: 8 } });
});
afterAll(() => h.close());

const lastMessages = () => (h.llm.chatRequests().at(-1)!.body as { messages: { role: string; content: string }[] }).messages;
const deltas = (events: ChatStreamEvent[]) =>
  events
    .filter((e): e is Extract<ChatStreamEvent, { type: 'delta' }> => e.type === 'delta')
    .map((e) => e.text)
    .join('');

describe('document chat', () => {
  it('streams an answer about one document', async () => {
    const res = await h.inject({ method: 'POST', url: '/api/chat/document/1', headers: auth, payload: { message: 'What is the total?' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    const events = parseSsePayload(res.payload) as ChatStreamEvent[];
    expect(deltas(events)).toBe('The total is 89.50 EUR.');
    expect(events.at(-1)).toEqual({ type: 'done', usage: { promptTokens: 80, completionTokens: 8, totalTokens: 88 }, model: 'test-model' });

    const msgs = lastMessages();
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('Title: Electricity bill');
    expect(msgs[0].content).toContain('Correspondent: City Power');
    expect(msgs[0].content).toContain('Date: 2024-03-31');
    expect(msgs[0].content).toContain('Tags: Energy');
    expect(msgs[0].content).toContain('Total amount: 89.50 EUR.');
    expect(msgs.at(-1)).toEqual({ role: 'user', content: 'What is the total?' });
    expect((h.llm.chatRequests().at(-1)!.body as { stream: boolean }).stream).toBe(true);
    expect(h.ctx.repos.usage.stats().byFeature).toContainEqual({ feature: 'chat', calls: 1, tokens: 88 });
  });

  it('sends the conversation history', async () => {
    await h.inject({
      method: 'POST',
      url: '/api/chat/document/1',
      headers: auth,
      payload: {
        message: 'And when is it due?',
        history: [
          { role: 'user', content: 'What is the total?' },
          { role: 'assistant', content: 'The total is 89.50 EUR.' },
          { role: 'user', content: '   ' },
        ],
      },
    });
    expect(lastMessages().map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('selects the relevant passages of long documents', async () => {
    const res = await h.inject({
      method: 'POST',
      url: '/api/chat/document/2',
      headers: auth,
      payload: { message: 'How high is the penalty fee for early termination?' },
    });
    const events = parseSsePayload(res.payload) as ChatStreamEvent[];
    expect(events[0]).toEqual({ type: 'status', message: 'The document is long – using the most relevant passages.' });
    const system = lastMessages()[0].content;
    expect(system).toContain('Document content (relevant excerpts)');
    expect(system).toContain('The secret penalty fee for early termination is 1234 EUR.');
    expect(system.length).toBeLessThan(LONG.length);
  });

  it('reports errors as stream events', async () => {
    const missing = await h.inject({ method: 'POST', url: '/api/chat/document/999', headers: auth, payload: { message: 'Hello?' } });
    expect(missing.statusCode).toBe(200);
    expect(parseSsePayload(missing.payload).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('404') });

    h.llm.reply({ status: 401, error: { error: { message: 'Invalid API key' } } });
    const failing = await h.inject({ method: 'POST', url: '/api/chat/document/1', headers: auth, payload: { message: 'Hello?' } });
    expect(parseSsePayload(failing.payload).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('Invalid API key') });
    h.llm.reply({ content: 'The total is 89.50 EUR.', chunkSize: 5, usage: { prompt_tokens: 80, completion_tokens: 8 } });
  });

  it('validates the request', async () => {
    const res = await h.inject({ method: 'POST', url: '/api/chat/document/1', headers: auth, payload: { message: '' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('legacy chat API (browser extension)', () => {
  it('initialises a chat', async () => {
    const res = await h.inject({ method: 'GET', url: '/chat/init/1', headers: auth });
    expect(res.json()).toEqual({ documentTitle: 'Electricity bill', initialized: true });
    const viaQuery = await h.inject({ method: 'GET', url: '/chat/init?documentId=1', headers: auth });
    expect(viaQuery.json()).toEqual({ documentTitle: 'Electricity bill', initialized: true });
  });

  it('streams content chunks and [DONE], keeping the history between messages', async () => {
    const first = await h.inject({ method: 'POST', url: '/chat/message', headers: auth, payload: { documentId: 1, message: 'What is the total?' } });
    expect(first.statusCode).toBe(200);
    const events = parseSsePayload(first.payload);
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1) as { content: string }[];
    expect(chunks.every((c) => Object.keys(c).length === 1 && typeof c.content === 'string')).toBe(true);
    expect(chunks.map((c) => c.content).join('')).toBe('The total is 89.50 EUR.');

    await h.inject({ method: 'POST', url: '/chat/message', headers: auth, payload: { documentId: '1', message: 'Thanks!' } });
    expect(lastMessages().slice(1)).toEqual([
      { role: 'user', content: 'What is the total?' },
      { role: 'assistant', content: 'The total is 89.50 EUR.' },
      { role: 'user', content: 'Thanks!' },
    ]);

    // a new init resets the conversation
    await h.inject({ method: 'GET', url: '/chat/init/1', headers: auth });
    await h.inject({ method: 'POST', url: '/chat/message', headers: auth, payload: { documentId: 1, message: 'Fresh start' } });
    expect(lastMessages().slice(1)).toEqual([{ role: 'user', content: 'Fresh start' }]);
  });

  it('sends errors in the legacy format', async () => {
    h.llm.reply({ status: 401, error: { error: { message: 'Invalid API key' } } });
    const res = await h.inject({ method: 'POST', url: '/chat/message', headers: auth, payload: { documentId: 1, message: 'Hi' } });
    const events = parseSsePayload(res.payload) as { error?: string }[];
    expect(events).toHaveLength(1);
    expect(events[0].error).toContain('Invalid API key');
  });
});
