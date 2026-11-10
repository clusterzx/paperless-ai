/**
 * Native client for Anthropic's Claude models (Messages API via the official SDK).
 *
 * Claude models differ in what they accept: newer ones always think, reject
 * sampling parameters and take an `effort`; older ones (Haiku 4.5, Sonnet 4.5)
 * do not know `effort`. Like the OpenAI-compatible client, this client starts
 * from what the model name suggests and adapts when the API rejects a
 * parameter, remembering what works per model.
 */
import Anthropic from '@anthropic-ai/sdk';
import { QUOTA_EXHAUSTED } from '../util/http.js';
import { AiError, type ChatMessage, type CompletionOptions, type CompletionResult, type LlmClient, type StreamChunk, type Usage } from './types.js';

export const ANTHROPIC_BASE = 'https://api.anthropic.com';

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  /** Empty = Anthropic's API. */
  baseUrl?: string;
  contextWindow: number;
  timeoutMs?: number;
}

interface Capabilities {
  temperature: boolean;
  /** `output_config.effort` – null when the model does not support it. */
  effort: 'low' | null;
  structuredOutputs: boolean;
  /** Thinks before answering, so max_tokens needs room for the thinking. */
  thinks: boolean;
  maxOutput: number | null;
}

const learned = new Map<string, Capabilities>();

/** Models from before effort and adaptive thinking (Claude 3, Haiku 4.5, Sonnet/Opus 4.0–4.1, Sonnet 4.5). */
const LEGACY = /claude-(3|haiku-4|(sonnet|opus)-4-[01]|sonnet-4-5)/i;
/** Models that still accept temperature (sampling parameters were removed with Opus 4.7 and the 5.x models). */
const SAMPLING = /claude-(3|haiku|(sonnet|opus)-4-[0-6])/i;
/** Models that think by default (Claude 5 family: Opus, Sonnet, Fable, Mythos). */
const THINKING = /claude-(opus|sonnet|fable|mythos)-5/i;
/** Extra max_tokens for thinking (an upper bound – only tokens actually generated are billed). */
const THINKING_RESERVE = 8192;

export class AnthropicClient implements LlmClient {
  readonly provider = 'anthropic';
  readonly model: string;
  readonly contextWindow: number;
  private readonly client: Anthropic;
  private readonly key: string;

  constructor(private readonly opts: AnthropicOptions) {
    this.model = opts.model;
    this.contextWindow = opts.contextWindow;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl || ANTHROPIC_BASE,
      timeout: opts.timeoutMs ?? 300_000,
      maxRetries: 2,
    });
    this.key = `${opts.baseUrl || ANTHROPIC_BASE}|${opts.model}`;
  }

  private get caps(): Capabilities {
    let caps = learned.get(this.key);
    if (!caps) {
      caps = {
        temperature: SAMPLING.test(this.model),
        // Metadata extraction and grounded answers need little deliberation: fast and cheap.
        effort: LEGACY.test(this.model) ? null : 'low',
        structuredOutputs: true,
        thinks: THINKING.test(this.model),
        maxOutput: null,
      };
      learned.set(this.key, caps);
    }
    return caps;
  }

  private params(messages: ChatMessage[], opts: CompletionOptions): Anthropic.MessageCreateParamsNonStreaming {
    const caps = this.caps;
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const turns: Anthropic.MessageParam[] = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    if (!turns.length || turns[0].role !== 'user') turns.unshift({ role: 'user', content: 'Please proceed.' });

    let maxTokens = (opts.maxTokens ?? 1024) + (caps.thinks ? THINKING_RESERVE : 0);
    if (caps.maxOutput) maxTokens = Math.min(maxTokens, caps.maxOutput);
    const params: Anthropic.MessageCreateParamsNonStreaming = { model: this.model, max_tokens: maxTokens, messages: turns };
    // The system prompt (instructions, tag lists …) is the same for every document: cache it.
    if (system) params.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    if (opts.temperature !== undefined && caps.temperature) params.temperature = Math.min(opts.temperature, 1);
    const output: Anthropic.OutputConfig = {};
    if (caps.effort) output.effort = caps.effort;
    if (opts.jsonSchema && caps.structuredOutputs) output.format = { type: 'json_schema', schema: opts.jsonSchema.schema };
    if (Object.keys(output).length) params.output_config = output;
    return params;
  }

  /** Adjust to a rejected parameter. Returns true when a retry makes sense. */
  private adapt(err: unknown, params: Anthropic.MessageCreateParamsNonStreaming): boolean {
    if (!(err instanceof Anthropic.BadRequestError)) return false;
    const msg = apiMessage(err).toLowerCase();
    const caps = this.caps;
    if (params.temperature !== undefined && /temperature|sampling/.test(msg)) {
      caps.temperature = false;
      return true;
    }
    if (params.output_config?.effort && /effort/.test(msg)) {
      caps.effort = null;
      return true;
    }
    if (params.output_config?.format && /output_config|format|schema|structured/.test(msg)) {
      caps.structuredOutputs = false; // the prompt asks for JSON as well
      return true;
    }
    // "max_tokens: 20000 > 8192, which is the maximum allowed number of output tokens for …"
    const limit = /max_tokens: \d+ > (\d+)/.exec(msg);
    if (limit && Number(limit[1]) !== caps.maxOutput) {
      caps.maxOutput = Number(limit[1]);
      return true;
    }
    return false;
  }

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<CompletionResult> {
    const started = Date.now();
    for (let attempt = 0; attempt < 5; attempt++) {
      const params = this.params(messages, opts);
      let message: Anthropic.Message;
      try {
        // Streaming keeps long requests (large documents, thinking) clear of HTTP timeouts.
        message = await this.client.messages.stream(params, this.requestOptions(opts)).finalMessage();
      } catch (err) {
        if (this.adapt(err, params)) continue;
        throw wrapAnthropicError(err);
      }
      const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      if (message.stop_reason === 'refusal') throw new AiError(`Model refused${text ? `: ${text}` : ' the request'}`);
      if (message.stop_reason === 'model_context_window_exceeded' && !text.trim()) throw contextExceeded();
      if (!text.trim() && message.stop_reason === 'max_tokens') {
        // Thinking used up max_tokens before the answer started: retry once with room for it.
        if (!this.caps.thinks) {
          this.caps.thinks = true;
          continue;
        }
        throw new AiError(
          `The model used its whole output budget (${params.max_tokens} tokens) before answering – usually for thinking. Increase "Answer tokens" in Settings → AI provider → Advanced.`,
        );
      }
      return { text, usage: toUsage(message.usage), model: message.model ?? this.model, durationMs: Date.now() - started };
    }
    throw new AiError('Could not find a request format the Anthropic API accepts for this model');
  }

  async *stream(messages: ChatMessage[], opts: CompletionOptions = {}): AsyncGenerator<StreamChunk> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const params = this.params(messages, opts);
      const stream = this.client.messages.stream(params, this.requestOptions(opts));
      let produced = false;
      try {
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text) {
            produced = true;
            yield { type: 'delta', text: event.delta.text };
          }
        }
        const message = await stream.finalMessage();
        if (!produced) {
          if (message.stop_reason === 'refusal') throw new AiError('Model refused the request');
          if (message.stop_reason === 'model_context_window_exceeded') throw contextExceeded();
          if (message.stop_reason === 'max_tokens') {
            this.caps.thinks = true;
            throw new AiError('The model used its whole output budget before answering – usually for thinking. Please try again.');
          }
        }
        yield { type: 'usage', usage: toUsage(message.usage) };
        return;
      } catch (err) {
        if (!produced && this.adapt(err, params)) continue;
        throw wrapAnthropicError(err);
      }
    }
    throw new AiError('Could not find a request format the Anthropic API accepts for this model');
  }

  private requestOptions(opts: CompletionOptions): Anthropic.RequestOptions {
    return { signal: opts.signal, ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}) };
  }

  async ping(signal?: AbortSignal): Promise<void> {
    try {
      await this.client.models.retrieve(this.model, {}, { signal });
    } catch (err) {
      if (err instanceof Anthropic.NotFoundError) {
        throw new AiError(`Model "${this.model}" is not available for this API key. Use "Load" to list the available models.`);
      }
      throw wrapAnthropicError(err);
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    try {
      const ids: string[] = [];
      for await (const m of this.client.models.list({ limit: 100 }, { signal })) ids.push(m.id);
      return ids;
    } catch (err) {
      throw wrapAnthropicError(err);
    }
  }
}

function contextExceeded(): AiError {
  return new AiError(
    'The prompt does not fit into the model\'s context window. Lower "Context window (tokens)" in Settings → AI provider → Advanced.',
  );
}

function toUsage(u: Anthropic.Usage | undefined): Usage {
  if (!u) return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  // Cached system prompts are reported separately – they are part of the prompt nonetheless.
  const promptTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const completionTokens = u.output_tokens ?? 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

/** The message from the error body ({type: "error", error: {type, message}}) instead of the raw JSON. */
function apiMessage(err: InstanceType<typeof Anthropic.APIError>): string {
  const body = err.error as { error?: { message?: unknown } } | undefined;
  return typeof body?.error?.message === 'string' ? body.error.message : err.message.replace(/^\d{3} /, '');
}

function retryAfterMs(headers: Headers | undefined): number | undefined {
  const value = headers?.get('retry-after');
  if (!value) return undefined;
  const secs = Number(value);
  return Number.isFinite(secs) ? Math.min(secs * 1000, 3_600_000) : undefined;
}

export function wrapAnthropicError(err: unknown): Error {
  if (err instanceof AiError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new AiError(`Anthropic API: ${err.message}`, true);
  if (err instanceof Anthropic.APIConnectionError) {
    return new AiError(`Anthropic API not reachable: ${err.message}${err.cause instanceof Error ? ` (${err.cause.message})` : ''}`, true);
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    const message = apiMessage(err);
    const quota = QUOTA_EXHAUSTED.test(message);
    // 429 = rate limit, 529 = overloaded: waiting helps in both cases.
    const rateLimited = (status === 429 || status === 529) && !quota;
    const hint =
      err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError
        ? ' (check the API key)'
        : err instanceof Anthropic.NotFoundError
          ? ' (check the model name)'
          : quota
            ? ' (credit balance exhausted – check the billing of your Anthropic account)'
            : rateLimited
              ? ' (rate limit – processing pauses and continues automatically)'
              : '';
    return new AiError(`Anthropic API: HTTP ${status}: ${message}${hint}`, rateLimited || status >= 500, {
      status,
      rateLimited,
      retryAfterMs: retryAfterMs(err.headers),
    });
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return err;
  return new AiError(err instanceof Error ? err.message : String(err), true);
}
