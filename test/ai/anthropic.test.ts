import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnthropicClient } from '../../src/server/ai/anthropic.js';
import { aiConfigProblem, createLlmClient } from '../../src/server/ai/factory.js';
import { configSchema } from '../../src/server/config/schema.js';
import { AiError, type ChatMessage, type StreamChunk } from '../../src/server/ai/types.js';
import { MockLlm } from '../helpers/mockLlm.js';

let llm: MockLlm;
beforeEach(async () => {
  llm = await new MockLlm({ apiKey: 'sk-ant-test' }).start();
});
afterEach(() => llm.close());

function client(model = 'claude-haiku-4-5', opts: Partial<ConstructorParameters<typeof AnthropicClient>[0]> = {}) {
  return new AnthropicClient({ apiKey: 'sk-ant-test', model, baseUrl: llm.url, contextWindow: 200_000, timeoutMs: 10_000, ...opts });
}

const messages: ChatMessage[] = [
  { role: 'system', content: 'You analyse documents.' },
  { role: 'user', content: 'Hello' },
];
const schema = { name: 'document_analysis', schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } };
const bodies = () => llm.chatRequests().map((r) => r.body as Record<string, unknown>);

async function collect(gen: AsyncGenerator<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const c of gen) chunks.push(c);
  return { text: chunks.map((c) => (c.type === 'delta' ? c.text : '')).join(''), chunks };
}

describe('AnthropicClient.complete', () => {
  it('sends the system prompt (cached), the schema and returns text and usage', async () => {
    llm.reply({ content: '{"title":"Invoice"}', usage: { prompt_tokens: 40, completion_tokens: 8 } });
    const res = await client().complete(messages, { temperature: 0.2, maxTokens: 500, jsonSchema: schema });
    expect(res).toMatchObject({ text: '{"title":"Invoice"}', model: 'claude-haiku-4-5', usage: { promptTokens: 40, completionTokens: 8, totalTokens: 48 } });
    const [req] = llm.chatRequests();
    expect(req.path).toBe('/v1/messages');
    expect(req.headers['x-api-key']).toBe('sk-ant-test');
    expect(req.body).toMatchObject({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      stream: true,
      temperature: 0.2,
      system: [{ type: 'text', text: 'You analyse documents.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'Hello' }],
      // Haiku 4.5 knows no effort
      output_config: { format: { type: 'json_schema', schema: schema.schema } },
    });
  });

  it('uses low effort, no temperature and room for thinking on Claude 5 models', async () => {
    await client('claude-sonnet-5-5').complete(messages, { temperature: 0.2, maxTokens: 500 });
    const body = bodies()[0];
    expect(body.temperature).toBeUndefined();
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.max_tokens).toBe(500 + 8192);
    expect(body.thinking).toBeUndefined();
  });

  it('drops parameters the model rejects and remembers it', async () => {
    llm.reply((req) =>
      (req.body.output_config as { effort?: string } | undefined)?.effort
        ? { status: 400, error: { type: 'error', error: { type: 'invalid_request_error', message: 'This model does not support the effort parameter.' } } }
        : 'fine',
    );
    const c = client('claude-sonnet-4-5-20250929-custom', { baseUrl: llm.url });
    // sonnet-4-5 is legacy → no effort in the first place
    expect((await c.complete(messages)).text).toBe('fine');
    expect(bodies()).toHaveLength(1);

    const opus = client('claude-opus-4-6');
    expect((await opus.complete(messages)).text).toBe('fine');
    expect(bodies().slice(1).map((b) => (b.output_config as { effort?: string } | undefined)?.effort)).toEqual(['low', undefined]);
    await opus.complete(messages);
    expect(bodies()).toHaveLength(4);
  });

  it('learns the output limit', async () => {
    llm.reply((req) =>
      Number(req.body.max_tokens) > 4096
        ? { status: 400, error: { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 9000 > 4096, which is the maximum allowed number of output tokens for claude-x' } } }
        : 'ok',
    );
    expect((await client('claude-x').complete(messages, { maxTokens: 9000 })).text).toBe('ok');
    expect(bodies().map((b) => b.max_tokens)).toEqual([9000, 4096]);
  });

  it('retries with room for thinking when the answer never started', async () => {
    llm.reply((req) => (Number(req.body.max_tokens) < 1000 ? { content: '', thinking: 'hmm', finishReason: 'max_tokens' } : '{"title":"done"}'));
    const res = await client('claude-new-model').complete(messages, { maxTokens: 300 });
    expect(res.text).toBe('{"title":"done"}');
    expect(bodies().map((b) => b.max_tokens)).toEqual([300, 300 + 8192]);
  });

  it('ignores thinking blocks and reports refusals', async () => {
    llm.reply({ content: 'Answer', thinking: 'Let me think' });
    expect((await client('claude-opus-5-5').complete(messages)).text).toBe('Answer');
    llm.reply({ content: '', refusal: 'no' });
    await expect(client().complete(messages)).rejects.toThrow(/refused/);
  });

  it('turns API errors into helpful AiErrors', async () => {
    const bad = new AnthropicClient({ apiKey: 'wrong', model: 'claude-haiku-4-5', baseUrl: llm.url, contextWindow: 1000 });
    const auth = (await bad.complete(messages).catch((e: unknown) => e)) as AiError;
    expect(auth).toBeInstanceOf(AiError);
    expect(auth.message).toBe('Anthropic API: HTTP 401: invalid x-api-key (check the API key)');

    llm.reply({ status: 429, error: { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } }, headers: { 'retry-after': '42' } });
    const limited = (await client().complete(messages).catch((e: unknown) => e)) as AiError;
    expect(limited.rateLimited).toBe(true);
    expect(limited.info).toMatchObject({ status: 429, retryAfterMs: 42_000 });

    llm.reply({ status: 400, error: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } });
    const credit = (await client().complete(messages).catch((e: unknown) => e)) as AiError;
    expect(credit.rateLimited).toBe(false);
    expect(credit.message).toContain('credit balance exhausted');
  });
});

describe('AnthropicClient.stream', () => {
  it('yields text deltas and usage', async () => {
    llm.reply({ content: 'Streaming from Claude', chunkSize: 6, thinking: 'secret', usage: { prompt_tokens: 12, completion_tokens: 4 } });
    const { text, chunks } = await collect(client().stream(messages, { maxTokens: 100 }));
    expect(text).toBe('Streaming from Claude');
    expect(chunks.at(-1)).toEqual({ type: 'usage', usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 } });
  });

  it('explains a stream that ended before the answer', async () => {
    llm.reply({ content: '', finishReason: 'max_tokens' });
    await expect(collect(client().stream(messages))).rejects.toThrow(/whole output budget/);
  });
});

describe('AnthropicClient models', () => {
  it('lists models and pings', async () => {
    expect(await client().listModels()).toEqual(['claude-haiku-4-5', 'claude-sonnet-5-5']);
    await expect(client().ping()).resolves.toBeUndefined();
    await expect(client('claude-nope').ping()).rejects.toThrow('Model "claude-nope" is not available');
  });

  it('is created by the factory', () => {
    const ai = configSchema.parse({ ai: { provider: 'anthropic' } }).ai;
    expect(ai.anthropic.model).toBe('claude-haiku-4-5');
    expect(aiConfigProblem(ai)).toBe('Anthropic API key is missing');
    const c = createLlmClient({ ...ai, anthropic: { ...ai.anthropic, apiKey: 'sk-ant' } });
    expect(c).toBeInstanceOf(AnthropicClient);
    expect(c).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-4-5', contextWindow: 128_000 });
  });
});
