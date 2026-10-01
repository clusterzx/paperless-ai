import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OllamaClient, OllamaEmbeddingClient } from '../../src/server/ai/ollama.js';
import { estimateTokens } from '../../src/server/ai/tokens.js';
import { AiError, type ChatMessage, type StreamChunk } from '../../src/server/ai/types.js';
import { EMBEDDING_DIMS, MockLlm, mockEmbedding } from '../helpers/mockLlm.js';

let llm: MockLlm;
beforeEach(async () => {
  llm = await new MockLlm().start();
});
afterEach(() => llm.close());

function client(opts: Partial<ConstructorParameters<typeof OllamaClient>[0]> = {}) {
  return new OllamaClient({ baseUrl: llm.url, model: 'llama3.2', contextWindow: 32_768, ...opts });
}

const messages: ChatMessage[] = [
  { role: 'system', content: 'You are a test' },
  { role: 'user', content: 'Hello' },
];
const schema = { name: 'document_analysis', schema: { type: 'object', properties: { title: { type: 'string' } } } };
const chatBodies = () => llm.chatRequests().map((r) => r.body as Record<string, unknown>);

async function collect(gen: AsyncGenerator<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const c of gen) chunks.push(c);
  return { text: chunks.map((c) => (c.type === 'delta' ? c.text : '')).join(''), chunks };
}

describe('OllamaClient.numCtx', () => {
  it('uses at least 2048 tokens', () => {
    expect(client().numCtx(messages)).toBe(2048);
  });

  it('grows with the prompt, rounded up to 1024 and capped by the context window', () => {
    const long: ChatMessage[] = [{ role: 'user', content: 'word '.repeat(8000) }];
    const promptTokens = estimateTokens(long[0].content) + 8;
    const expected = Math.ceil((promptTokens * 1.1 + 1000 + 256) / 1024) * 1024;
    expect(client().numCtx(long, 1000)).toBe(expected);
    expect(expected % 1024).toBe(0);
    expect(expected).toBeGreaterThan(promptTokens + 1000);
    expect(client({ contextWindow: 8192 }).numCtx(long, 1000)).toBe(8192);
    // default answer budget is 1024 tokens
    expect(client().numCtx(long)).toBe(Math.ceil((promptTokens * 1.1 + 1024 + 256) / 1024) * 1024);
  });
});

describe('OllamaClient.complete', () => {
  it('uses the native chat API with num_ctx, options and a JSON schema format', async () => {
    llm.reply({ content: '{"title":"x"}', usage: { prompt_tokens: 30, completion_tokens: 6 } });
    const c = client({ baseUrl: `${llm.url}/v1/`, keepAlive: '10m' });
    const res = await c.complete(messages, { temperature: 0.1, maxTokens: 300, jsonSchema: schema });
    expect(res).toMatchObject({ text: '{"title":"x"}', usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 }, model: 'llama3.2' });
    const [req] = llm.chatRequests();
    expect(req.path).toBe('/api/chat');
    expect(req.body).toEqual({
      model: 'llama3.2',
      messages,
      stream: false,
      options: { num_ctx: 2048, temperature: 0.1, num_predict: 300 },
      format: schema.schema,
      keep_alive: '10m',
    });
  });

  it('uses format "json" for plain JSON mode and strips an /api suffix from the URL', async () => {
    await client({ baseUrl: `${llm.url}/api` }).complete(messages, { json: true });
    expect(chatBodies()[0].format).toBe('json');
    expect(llm.chatRequests()[0].path).toBe('/api/chat');
  });

  it('falls back to format "json" when the server does not support schemas', async () => {
    await llm.close();
    llm = await new MockLlm({ rejectOllamaSchemaFormat: true }).start();
    llm.reply('{"title":"old ollama"}');
    const res = await client().complete(messages, { jsonSchema: schema });
    expect(res.text).toBe('{"title":"old ollama"}');
    expect(chatBodies().map((b) => b.format)).toEqual([schema.schema, 'json']);
  });

  it('explains missing models', async () => {
    llm.reply({ status: 404, error: { error: "model 'llama9' not found, try pulling it first" } });
    const err = (await client().complete(messages).catch((e: unknown) => e)) as AiError;
    expect(err).toBeInstanceOf(AiError);
    expect(err.message).toContain("model 'llama9' not found");
    expect(err.message).toContain('ollama pull llama3.2');
  });

  it('explains unreachable servers', async () => {
    const url = llm.url;
    await llm.close();
    const c = new OllamaClient({ baseUrl: url, model: 'm', contextWindow: 4096, timeoutMs: 2000 });
    const err = (await c.listModels().catch((e: unknown) => e)) as AiError;
    expect(err).toBeInstanceOf(AiError);
    expect(err.message).toContain('Is Ollama running');
    expect(err.retryable).toBe(true);
    llm = await new MockLlm().start();
  });
});

describe('OllamaClient.stream', () => {
  it('yields NDJSON deltas and the final usage', async () => {
    llm.reply({ content: 'Streaming from Ollama', chunkSize: 5, usage: { prompt_tokens: 11, completion_tokens: 3 } });
    const { text, chunks } = await collect(client().stream(messages, { maxTokens: 64 }));
    expect(text).toBe('Streaming from Ollama');
    expect(chunks[chunks.length - 1]).toEqual({ type: 'usage', usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 } });
    expect(chatBodies()[0]).toMatchObject({ stream: true, options: { num_predict: 64 } });
  });

  it('hides <think> reasoning', async () => {
    llm.reply({ chunks: ['<think>', 'internal', '</think>', 'Answer', '!'] });
    expect((await collect(client().stream(messages))).text).toBe('Answer!');
    llm.reply({ chunks: ['<think>x</think>Direct'] });
    expect((await collect(client().stream(messages))).text).toBe('Direct');
  });
});

describe('OllamaClient models', () => {
  it('lists models and pings (":latest" is implied)', async () => {
    expect(await client().listModels()).toEqual(['llama3.2:latest', 'nomic-embed-text:latest']);
    await expect(client().ping()).resolves.toBeUndefined();
    await expect(client({ model: 'nomic-embed-text:latest' }).ping()).resolves.toBeUndefined();
    const err = (await client({ model: 'mistral' }).ping().catch((e: unknown) => e)) as AiError;
    expect(err).toBeInstanceOf(AiError);
    expect(err.message).toContain('Model "mistral" is not available in Ollama');
    expect(err.message).toContain('Available: llama3.2:latest, nomic-embed-text:latest');
  });
});

describe('OllamaEmbeddingClient', () => {
  it('embeds texts in batches', async () => {
    const c = new OllamaEmbeddingClient({ baseUrl: `${llm.url}/api/`, model: 'nomic-embed-text', batchSize: 2, keepAlive: '1m' });
    expect(c.id).toBe('ollama:nomic-embed-text');
    const texts = ['one fish', 'two fish', 'red fish'];
    const vectors = await c.embed(texts, 'passage');
    expect(vectors.map((v) => v.length)).toEqual([EMBEDDING_DIMS, EMBEDDING_DIMS, EMBEDDING_DIMS]);
    texts.forEach((t, i) => expect([...vectors[i]]).toEqual(mockEmbedding(t)));
    const reqs = llm.embeddingRequests();
    expect(reqs).toHaveLength(2);
    expect(reqs[0].body).toEqual({ model: 'nomic-embed-text', input: ['one fish', 'two fish'], truncate: true, keep_alive: '1m' });
  });
});
