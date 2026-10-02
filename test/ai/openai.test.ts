import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAiCompatibleClient, OpenAiEmbeddingClient, REASONING_RESERVE } from '../../src/server/ai/openai.js';
import { azureDeploymentUrl, createLlmClient, aiConfigProblem, embeddingPrefix } from '../../src/server/ai/factory.js';
import { configSchema } from '../../src/server/config/schema.js';
import { AiError, type StreamChunk } from '../../src/server/ai/types.js';
import { EMBEDDING_DIMS, MockLlm, mockEmbedding } from '../helpers/mockLlm.js';

let llm: MockLlm;
beforeEach(async () => {
  llm = await new MockLlm().start();
});
afterEach(() => llm.close());

function client(model = 'test-model', extra: Partial<ConstructorParameters<typeof OpenAiCompatibleClient>[0]> = {}) {
  return new OpenAiCompatibleClient({ provider: 'custom', baseUrl: `${llm.openaiUrl}/`, apiKey: 'sk-test', model, contextWindow: 8000, ...extra });
}

const schema = { name: 'document_analysis', schema: { type: 'object', properties: { title: { type: 'string' } } } };
const messages = [
  { role: 'system' as const, content: 'You are a test' },
  { role: 'user' as const, content: 'Hello' },
];

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<{ text: string; chunks: StreamChunk[] }> {
  const chunks: StreamChunk[] = [];
  for await (const c of gen) chunks.push(c);
  return { text: chunks.map((c) => (c.type === 'delta' ? c.text : '')).join(''), chunks };
}

const chatBodies = () => llm.chatRequests().map((r) => r.body as Record<string, unknown>);

describe('OpenAiCompatibleClient.complete', () => {
  it('sends a chat completion request and returns text and usage', async () => {
    llm.reply({ content: '{"title":"Hi"}', usage: { prompt_tokens: 12, completion_tokens: 5 } });
    const res = await client().complete(messages, { temperature: 0.3, maxTokens: 500, jsonSchema: schema });
    expect(res.text).toBe('{"title":"Hi"}');
    expect(res.usage).toEqual({ promptTokens: 12, completionTokens: 5, totalTokens: 17 });
    expect(res.model).toBe('test-model');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    const [req] = llm.chatRequests();
    expect(req.path).toBe('/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer sk-test');
    expect(req.body).toEqual({
      model: 'test-model',
      messages,
      temperature: 0.3,
      max_tokens: 500,
      response_format: { type: 'json_schema', json_schema: { name: 'document_analysis', schema: schema.schema, strict: false } },
    });
  });

  it('falls back from json_schema to json_object when the provider rejects it, and remembers it', async () => {
    await llm.close();
    llm = await new MockLlm({ rejectJsonSchema: true }).start();
    llm.reply('{"title":"fallback"}');
    const res = await client().complete(messages, { jsonSchema: schema });
    expect(res.text).toBe('{"title":"fallback"}');
    expect(chatBodies().map((b) => (b.response_format as { type: string }).type)).toEqual(['json_schema', 'json_object']);

    // learned per endpoint + model: the next call (even from a new client instance) skips json_schema
    await client().complete(messages, { jsonSchema: schema });
    expect(chatBodies().map((b) => (b.response_format as { type: string }).type)).toEqual(['json_schema', 'json_object', 'json_object']);
    // other models on the same endpoint still try json_schema first
    await client('other-model').complete(messages, { jsonSchema: schema });
    expect((chatBodies()[3].response_format as { type: string }).type).toBe('json_schema');
  });

  it('drops response_format completely when no JSON mode is supported', async () => {
    llm.reply((req) =>
      req.body.response_format ? { status: 400, error: { error: { message: 'response_format is not supported by this backend' } } } : '{"ok":true}',
    );
    const res = await client().complete(messages, { jsonSchema: schema });
    expect(res.text).toBe('{"ok":true}');
    expect(chatBodies().map((b) => (b.response_format as { type?: string } | undefined)?.type ?? 'none')).toEqual(['json_schema', 'json_object', 'none']);
  });

  it('adapts token parameter and temperature to the provider', async () => {
    llm.reply((req) => {
      if ('max_tokens' in req.body) {
        return { status: 400, error: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } } };
      }
      if ('temperature' in req.body) return { status: 400, error: { error: { message: "Unsupported value: 'temperature' does not support 0.2" } } };
      return 'done';
    });
    const res = await client().complete(messages, { maxTokens: 100, temperature: 0.2 });
    expect(res.text).toBe('done');
    const bodies = chatBodies();
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toMatchObject({ max_completion_tokens: 100 });
    expect(bodies[2]).not.toHaveProperty('temperature');
    expect(bodies[2]).not.toHaveProperty('max_tokens');
  });

  it('gives reasoning models room for their reasoning, low effort and no temperature', () => {
    // body construction only (no request is sent to api.openai.com)
    const bodyFor = (model: string, baseUrl = 'https://api.openai.com/v1') => {
      const c = new OpenAiCompatibleClient({ provider: 'openai', baseUrl, model, contextWindow: 1000 });
      return (c as unknown as { buildBody: (m: unknown, o: unknown, s: boolean) => Record<string, unknown> }).buildBody(messages, { maxTokens: 10, temperature: 0.5 }, false);
    };
    for (const model of ['o3-mini', 'o4-mini', 'gpt-5', 'gpt-5-mini', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-6-luna']) {
      expect(bodyFor(model), model).toEqual({ messages, model, max_completion_tokens: 10 + REASONING_RESERVE, reasoning_effort: 'low' });
    }
    // also behind routers (OpenRouter: "openai/gpt-5-mini")
    expect(bodyFor('openai/gpt-5-mini', 'https://openrouter.ai/api/v1')).toMatchObject({ max_completion_tokens: 10 + REASONING_RESERVE, reasoning_effort: 'low' });
    // classic models keep their exact limit and temperature
    for (const model of ['gpt-4.1', 'gpt-4o-mini', 'gpt-4.1-nano']) {
      expect(bodyFor(model), model).toEqual({ messages, model, temperature: 0.5, max_completion_tokens: 10 });
    }
  });

  it('retries with a reasoning budget when the answer was cut off before it started', async () => {
    // A reasoning model the client does not know by name spends the whole budget on reasoning.
    llm.reply((req) => (Number(req.body.max_tokens) <= 100 ? { content: '', finishReason: 'length' } : '{"title":"after reasoning"}'));
    const res = await client('my-thinking-model').complete(messages, { maxTokens: 100, jsonSchema: schema });
    expect(res.text).toBe('{"title":"after reasoning"}');
    expect(chatBodies().map((b) => b.max_tokens)).toEqual([100, 100 + REASONING_RESERVE]);
    // remembered for the next request
    await client('my-thinking-model').complete(messages, { maxTokens: 100 });
    expect(chatBodies()[2].max_tokens).toBe(100 + REASONING_RESERVE);
  });

  it('explains an answer that never started instead of returning nothing', async () => {
    llm.reply({ content: '', finishReason: 'length' });
    const err = await client('gpt-5-mini').complete(messages, { maxTokens: 100 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as Error).message).toMatch(/whole output budget \(16484 tokens\).*Answer tokens/);
    expect(chatBodies()).toHaveLength(1);
  });

  it('drops reasoning_effort when the model does not accept it and respects output limits', async () => {
    llm.reply((req) => {
      if ('reasoning_effort' in req.body) {
        return { status: 400, error: { error: { message: "Unsupported value: 'reasoning_effort' does not support 'low' with this model. Supported values are: 'medium'." } } };
      }
      if (Number(req.body.max_completion_tokens) > 8192) {
        return { status: 400, error: { error: { message: 'max_completion_tokens is too large: 17384. This model supports at most 8192 completion tokens, whereas you provided 17384.' } } };
      }
      return 'fine';
    });
    const res = await client('gpt-5.2-chat-latest').complete(messages, { maxTokens: 1000 });
    expect(res.text).toBe('fine');
    expect(chatBodies().at(-1)).toEqual({ model: 'gpt-5.2-chat-latest', messages, max_completion_tokens: 8192 });
  });

  it('wraps HTTP errors into AiError with hints', async () => {
    llm.reply({ status: 401, error: { error: { message: 'Incorrect API key provided' } } });
    const err = (await client().complete(messages).catch((e: unknown) => e)) as AiError;
    expect(err).toBeInstanceOf(AiError);
    expect(err.message).toContain('HTTP 401');
    expect(err.message).toContain('Incorrect API key provided');
    expect(err.message).toContain('(check the API key)');
    expect(err.retryable).toBe(false);

    llm.reply({ status: 404, error: { error: { message: 'The model `nope` does not exist' } } });
    const notFound = (await client().complete(messages).catch((e: unknown) => e)) as AiError;
    expect(notFound.message).toContain('(check base URL / model name)');

    llm.reply({ status: 400, error: { error: 'plain string error' } });
    expect(((await client().complete(messages).catch((e: unknown) => e)) as AiError).message).toContain('plain string error');
  });

  it('reports refusals and accepts empty answers', async () => {
    llm.reply({ refusal: 'I cannot help with that' });
    const err = await client().complete(messages).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as Error).message).toBe('Model refused: I cannot help with that');
    llm.reply({ content: '' });
    expect((await client().complete(messages)).text).toBe('');
  });
});

describe('OpenAiCompatibleClient.stream', () => {
  it('yields deltas and usage', async () => {
    llm.reply({ content: 'Hello streaming world', chunkSize: 3, usage: { prompt_tokens: 7, completion_tokens: 4 } });
    const { text, chunks } = await collect(client().stream(messages, { temperature: 0.1, maxTokens: 50 }));
    expect(text).toBe('Hello streaming world');
    expect(chunks.filter((c) => c.type === 'delta').length).toBeGreaterThan(5);
    expect(chunks[chunks.length - 1]).toEqual({ type: 'usage', usage: { promptTokens: 7, completionTokens: 4, totalTokens: 11 } });
    const [req] = llm.chatRequests();
    expect(req.headers.accept).toBe('text/event-stream');
    expect(req.body).toMatchObject({ stream: true, stream_options: { include_usage: true }, max_tokens: 50 });
  });

  it('hides <think> reasoning', async () => {
    llm.reply({ chunks: ['<think>', 'secret ', 'reasoning', '</think>', 'Visible', ' answer'] });
    expect((await collect(client().stream(messages))).text).toBe('Visible answer');
    llm.reply({ chunks: ['<think>short</think>Answer', ' continues'] });
    expect((await collect(client().stream(messages))).text).toBe('Answer continues');
    llm.reply({ chunks: ['<think>', 'never closed'] });
    expect((await collect(client().stream(messages))).text).toBe('');
  });

  it('retries without stream_options when unsupported (no usage then)', async () => {
    llm.reply((req) => (req.body.stream_options ? { status: 400, error: { error: { message: 'Unrecognized request argument: stream_options' } } } : 'ok'));
    const { text, chunks } = await collect(client().stream(messages));
    expect(text).toBe('ok');
    expect(chunks.some((c) => c.type === 'usage')).toBe(false);
    expect(chatBodies()).toHaveLength(2);
  });

  it('reports a stream that was cut off before the answer started', async () => {
    llm.reply({ content: '', finishReason: 'length' });
    const err = await collect(client('stream-thinker').stream(messages, { maxTokens: 50 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as Error).message).toMatch(/whole output budget/);
    // the next request reserves room for the reasoning
    llm.reply('ok');
    await collect(client('stream-thinker').stream(messages, { maxTokens: 50 }));
    expect(chatBodies().at(-1)!.max_tokens).toBe(50 + REASONING_RESERVE);
  });

  it('raises errors sent inside the stream', async () => {
    await llm.close();
    const http = await import('node:http');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'part' } }] })}\n\ndata: {"error":{"message":"overloaded"}}\n\n`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const c = new OpenAiCompatibleClient({ provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', contextWindow: 1000 });
    const seen: string[] = [];
    const err = await (async () => {
      for await (const chunk of c.stream(messages)) if (chunk.type === 'delta') seen.push(chunk.text);
    })().catch((e: unknown) => e);
    server.close();
    llm = await new MockLlm().start();
    expect(seen).toEqual(['part']);
    expect(err).toBeInstanceOf(AiError);
    expect((err as Error).message).toBe('overloaded');
  });
});

describe('OpenAiCompatibleClient models / ping / azure', () => {
  it('lists models and pings', async () => {
    expect(await client().listModels()).toEqual(['other-model', 'test-model']);
    await client().ping();
    expect(llm.requests.filter((r) => r.path === '/v1/models')).toHaveLength(2);
  });

  it('pings with a tiny completion when /models is not implemented', async () => {
    await llm.close();
    llm = await new MockLlm({ noModelsEndpoint: true }).start();
    await client().ping();
    expect(llm.requests.map((r) => r.path)).toEqual(['/v1/models', '/v1/chat/completions']);
    expect(llm.chatRequests()[0].body).toMatchObject({ max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] });
  });

  it('talks to Azure deployments with api-key and api-version', async () => {
    const baseUrl = azureDeploymentUrl(`${llm.url}/`, 'my deployment');
    expect(baseUrl).toBe(`${llm.url}/openai/deployments/my%20deployment`);
    expect(azureDeploymentUrl(`${llm.url}/openai/deployments/dep`, 'ignored')).toBe(`${llm.url}/openai/deployments/dep`);
    const c = new OpenAiCompatibleClient({
      provider: 'azure',
      baseUrl,
      apiKey: 'azure-key',
      model: 'my deployment',
      azure: { apiVersion: '2024-10-21' },
      contextWindow: 1000,
    });
    llm.reply('azure says hi');
    expect((await c.complete(messages, { maxTokens: 5 })).text).toBe('azure says hi');
    await c.ping();
    expect(await c.listModels()).toEqual(['my deployment']);
    const [req] = llm.chatRequests();
    expect(req.url).toBe('/openai/deployments/my%20deployment/chat/completions?api-version=2024-10-21');
    expect(req.headers['api-key']).toBe('azure-key');
    expect(req.headers.authorization).toBeUndefined();
    expect(req.body).not.toHaveProperty('model');
    expect(req.body).toHaveProperty('max_completion_tokens', 5);
  });
});

describe('OpenAiEmbeddingClient', () => {
  it('embeds in batches and keeps the input order', async () => {
    const c = new OpenAiEmbeddingClient({ baseUrl: llm.openaiUrl, apiKey: 'k', model: 'mock-embed', batchSize: 2 });
    expect(c.id).toBe('openai:mock-embed');
    const texts = ['electricity bill', 'car insurance', 'doctor letter'];
    const vectors = await c.embed(texts, 'passage');
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors[0]).toHaveLength(EMBEDDING_DIMS);
    texts.forEach((t, i) => expect([...vectors[i]]).toEqual(mockEmbedding(t)));
    const reqs = llm.embeddingRequests();
    expect(reqs.map((r) => (r.body!.input as string[]).length)).toEqual([2, 1]);
    expect(reqs[0].body).toMatchObject({ model: 'mock-embed' });
    expect(reqs[0].headers.authorization).toBe('Bearer k');
  });
});

describe('factory', () => {
  it('validates provider configuration', () => {
    const ai = configSchema.parse({}).ai;
    expect(aiConfigProblem(ai)).toBe('OpenAI API key is missing');
    expect(aiConfigProblem({ ...ai, provider: 'custom' })).toBe('Base URL of the custom provider is missing');
    expect(aiConfigProblem({ ...ai, provider: 'ollama' })).toBeNull();
    expect(aiConfigProblem({ ...ai, provider: 'azure' })).toContain('Azure');
    expect(() => createLlmClient(ai)).toThrow(AiError);
    const custom = createLlmClient({ ...ai, provider: 'custom', custom: { baseUrl: llm.openaiUrl, apiKey: '', model: 'm' } });
    expect(custom).toMatchObject({ provider: 'custom', model: 'm', contextWindow: 128_000 });
  });

  it('knows embedding prefixes', () => {
    expect(embeddingPrefix('Xenova/multilingual-e5-small', 'query')).toBe('query: ');
    expect(embeddingPrefix('nomic-embed-text', 'passage')).toBe('search_document: ');
    expect(embeddingPrefix('text-embedding-3-small', 'query')).toBe('');
  });
});
