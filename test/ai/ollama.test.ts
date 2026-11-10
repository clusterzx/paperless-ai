import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OllamaThink } from '../../src/server/config/schema.js';
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

  it('grows with the prompt in powers of two, capped by the context window', () => {
    const long: ChatMessage[] = [{ role: 'user', content: 'word '.repeat(8000) }];
    const needed = (estimateTokens(long[0].content) + 8) * 1.1 + 1000 + 256;
    const size = client().numCtx(long, 1000);
    expect(Math.log2(size) % 1).toBe(0);
    expect(size).toBeGreaterThanOrEqual(needed);
    expect(size / 2).toBeLessThan(needed);
    expect(client({ contextWindow: 8192 }).numCtx(long, 1000)).toBe(8192);
  });

  it('always uses a fixed context size, so that Ollama does not reload the model', () => {
    const c = client({ numCtx: 16_384 });
    expect(c.numCtx(messages)).toBe(16_384);
    expect(c.numCtx([{ role: 'user', content: 'word '.repeat(8000) }], 1000)).toBe(16_384);
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

  it('keeps num_predict within a fixed context window', async () => {
    const c = client({ model: 'qwen3:4b', numCtx: 4096, think: 'on' });
    const long: ChatMessage[] = [{ role: 'user', content: 'word '.repeat(2000) }];
    await c.complete(long, { maxTokens: 500 });
    const opts = chatBodies()[0].options as { num_ctx: number; num_predict: number };
    expect(opts.num_ctx).toBe(4096);
    // thinking reserve, but only what is left after the prompt
    expect(opts.num_predict).toBe(4096 - (estimateTokens(long[0].content) + 8));
    expect(opts.num_predict).toBeGreaterThan(500);
  });

  it('uses format "json" for plain JSON mode and strips an /api suffix from the URL', async () => {
    await client({ baseUrl: `${llm.url}/api` }).complete(messages, { json: true });
    expect(chatBodies()[0].format).toBe('json');
    expect(llm.chatRequests()[0].path).toBe('/api/chat');
  });

  it('gives thinking models room to think when the answer was cut off', async () => {
    // qwen3 & co. spend num_predict on thinking first; the answer never starts.
    llm.reply((req) => {
      const opts = req.body.options as { num_predict?: number };
      return (opts.num_predict ?? 0) <= 300 ? { content: '', finishReason: 'length' } : '{"title":"after thinking"}';
    });
    const c = client({ model: 'qwen3:8b' });
    const res = await c.complete(messages, { maxTokens: 300, jsonSchema: schema });
    expect(res.text).toBe('{"title":"after thinking"}');
    const opts = chatBodies().map((b) => b.options as { num_predict: number; num_ctx: number });
    expect(opts.map((o) => o.num_predict)).toEqual([300, 300 + 8192]);
    expect(opts[1].num_ctx).toBeGreaterThan(300 + 8192);
    // learned: the next request reserves the room right away
    await c.complete(messages, { maxTokens: 300 });
    expect((chatBodies()[2].options as { num_predict: number }).num_predict).toBe(300 + 8192);

    // still nothing → a helpful error instead of an empty answer
    llm.reply({ content: '', finishReason: 'length' });
    await expect(c.complete(messages, { maxTokens: 300 })).rejects.toThrow(/whole output budget/);
  });

  it('sends the think setting', async () => {
    const thinkOf = async (think: OllamaThink) => {
      llm.clearRequests();
      await client({ model: 'gpt-oss:20b', think }).complete(messages, { maxTokens: 100 });
      return chatBodies()[0];
    };
    expect((await thinkOf('auto')).think).toBeUndefined();
    expect((await thinkOf('off')).think).toBe(false);
    expect(await thinkOf('on')).toMatchObject({ think: true, options: { num_predict: 100 + 8192 } });
    expect((await thinkOf('low')).think).toBe('low');
    expect((await thinkOf('high')).think).toBe('high');
    // no thinking reserve when thinking is off
    expect((await thinkOf('off')).options).toMatchObject({ num_predict: 100 });
  });

  it('drops the think parameter for models that do not support it', async () => {
    await llm.close();
    llm = await new MockLlm({ rejectOllamaThink: true }).start();
    llm.reply('{"title":"no thinking"}');
    const c = client({ model: 'llama3.2', think: 'off' });
    expect((await c.complete(messages, { jsonSchema: schema })).text).toBe('{"title":"no thinking"}');
    expect(chatBodies().map((b) => b.think)).toEqual([false, undefined]);
    // remembered for the next requests (and streams)
    llm.reply('Plain');
    expect((await collect(c.stream(messages))).text).toBe('Plain');
    expect(chatBodies()[2].think).toBeUndefined();
  });

  it('takes the JSON answer from the thinking when the content is empty', async () => {
    llm.reply({ content: '', thinking: 'Let me see. {"title":"from thinking"}' });
    const res = await client({ model: 'gpt-oss:20b', think: 'low' }).complete(messages, { jsonSchema: schema });
    expect(JSON.parse(res.text)).toEqual({ title: 'from thinking' });
  });

  it('unloads the model', async () => {
    await client({ keepAlive: '30m' }).unload();
    const req = llm.requests.find((r) => r.path === '/api/generate');
    expect(req?.body).toEqual({ model: 'llama3.2', keep_alive: 0 });
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
