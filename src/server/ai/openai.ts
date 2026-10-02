/**
 * Client for OpenAI and every OpenAI-compatible API (DeepSeek, OpenRouter,
 * LiteLLM, vLLM, LM Studio, Gemini's OpenAI endpoint, Perplexity, Together …)
 * as well as Azure OpenAI deployments.
 *
 * Instead of hard-coding provider quirks, the client adapts at runtime:
 * when the API rejects a parameter (json_schema response_format,
 * max_completion_tokens, temperature …) it retries once with a compatible
 * variant and remembers what works for this endpoint/model.
 */
import { HttpError, QUOTA_EXHAUSTED, request, trimSlash } from '../util/http.js';
import { parseSse, ThinkFilter } from './stream.js';
import {
  AiError,
  type ChatMessage,
  type CompletionOptions,
  type CompletionResult,
  type EmbeddingClient,
  type EmbeddingKind,
  type LlmClient,
  type StreamChunk,
  type Usage,
  emptyUsage,
} from './types.js';

export interface OpenAiCompatibleOptions {
  /** Display name, e.g. "openai", "custom", "azure". */
  provider: string;
  /** Base URL including the version path, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey?: string;
  model: string;
  contextWindow: number;
  /** Azure: deployments are addressed via URL + api-version and authenticated with `api-key`. */
  azure?: { apiVersion: string };
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
  /** Additional request body parameters (e.g. chat_template_kwargs, top_k, provider routing). */
  extraBody?: Record<string, unknown>;
}

/** Limits learned for a single request (from a context length error). */
interface CallState {
  maxBudget?: number;
}

/** Body fields an extra parameter must not replace. */
const PROTECTED_FIELDS = new Set(['messages', 'model', 'stream', 'stream_options']);

type ResponseFormatMode = 'json_schema' | 'json_object' | 'none';

interface Capabilities {
  responseFormat: ResponseFormatMode;
  tokenParam: 'max_tokens' | 'max_completion_tokens' | 'none';
  temperature: boolean;
  streamUsage: boolean;
  /** Reasoning model: the token limit also covers the hidden reasoning, so it gets extra room. */
  reasoning: boolean;
  /** `reasoning_effort` sent to reasoning models; null when the model/endpoint does not accept it. */
  reasoningEffort: string | null;
  /** Largest output the model accepts (learned from "at most N tokens" errors). */
  maxOutput: number | null;
}

/** Capabilities learned per endpoint+model, shared across client instances. */
const learned = new Map<string, Capabilities>();

/**
 * OpenAI reasoning models: o1/o3/o4…, gpt-5, gpt-5.x, gpt-6-… (also behind prefixes such as
 * "openai/gpt-5-mini" on OpenRouter). Other reasoning models are detected from their responses.
 */
const REASONING_MODEL = /(^|\/)(o\d|gpt-([5-9]|\d{2,})(\b|[.-]))/i;
/** Extra output budget for hidden reasoning (an upper bound – only tokens actually used are billed). */
export const REASONING_RESERVE = 16_384;

export class OpenAiCompatibleClient implements LlmClient {
  readonly provider: string;
  readonly model: string;
  readonly contextWindow: number;
  private readonly key: string;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.contextWindow = opts.contextWindow;
    this.key = `${trimSlash(opts.baseUrl)}|${opts.model}`;
  }

  private get caps(): Capabilities {
    let caps = learned.get(this.key);
    if (!caps) {
      const official = /api\.openai\.com/.test(this.opts.baseUrl) || !!this.opts.azure;
      const reasoning = REASONING_MODEL.test(this.opts.model);
      caps = {
        responseFormat: 'json_schema',
        tokenParam: official || reasoning ? 'max_completion_tokens' : 'max_tokens',
        temperature: !reasoning,
        streamUsage: true,
        reasoning,
        // Low effort: metadata extraction and grounded answers need little deliberation – fast and cheap.
        reasoningEffort: reasoning ? 'low' : null,
        maxOutput: null,
      };
      learned.set(this.key, caps);
    }
    return caps;
  }

  private url(path: string): string {
    const base = trimSlash(this.opts.baseUrl);
    if (this.opts.azure) {
      const sep = path.includes('?') ? '&' : '?';
      return `${base}${path}${sep}api-version=${encodeURIComponent(this.opts.azure.apiVersion)}`;
    }
    return `${base}${path}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { ...this.opts.extraHeaders };
    if (this.opts.apiKey) {
      if (this.opts.azure) h['api-key'] = this.opts.apiKey;
      else h.Authorization = `Bearer ${this.opts.apiKey}`;
    }
    return h;
  }

  private buildBody(messages: ChatMessage[], opts: CompletionOptions, stream: boolean, call: CallState = {}): Record<string, unknown> {
    const caps = this.caps;
    const body: Record<string, unknown> = { messages };
    if (!this.opts.azure) body.model = this.model;
    if (opts.temperature !== undefined && caps.temperature) body.temperature = opts.temperature;
    if (opts.maxTokens && caps.tokenParam !== 'none') {
      let budget = caps.reasoning ? opts.maxTokens + REASONING_RESERVE : opts.maxTokens;
      if (caps.maxOutput) budget = Math.min(budget, caps.maxOutput);
      if (call.maxBudget) budget = Math.min(budget, call.maxBudget);
      body[caps.tokenParam] = budget;
    }
    if (caps.reasoning && caps.reasoningEffort) body.reasoning_effort = caps.reasoningEffort;
    if (opts.jsonSchema || opts.json) {
      if (opts.jsonSchema && caps.responseFormat === 'json_schema') {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: opts.jsonSchema.name, schema: opts.jsonSchema.schema, strict: false },
        };
      } else if (caps.responseFormat !== 'none') {
        body.response_format = { type: 'json_object' };
      }
    }
    for (const [key, value] of Object.entries(this.opts.extraBody ?? {})) {
      if (!PROTECTED_FIELDS.has(key)) body[key] = value;
    }
    if (stream) {
      body.stream = true;
      if (caps.streamUsage) body.stream_options = { include_usage: true };
    }
    return body;
  }

  /**
   * Inspect a 400 error and downgrade the capability that caused it.
   * Returns true when a retry with adjusted parameters makes sense.
   */
  private adapt(err: unknown, body: Record<string, unknown>, call: CallState): boolean {
    if (!(err instanceof HttpError) || (err.status !== 400 && err.status !== 413 && err.status !== 422)) return false;
    const msg = JSON.stringify(err.body ?? '').toLowerCase();
    const caps = this.caps;
    // Prompt + answer exceed the model's context window (vLLM, LiteLLM, OpenAI, Anthropic …). Must be
    // checked first: these messages also mention max_tokens/max_completion_tokens.
    const window = contextLimit(msg);
    if (window) {
      const input = inputTokens(msg);
      const current = Number(body[caps.tokenParam] ?? 0);
      if (input && window - input >= 256) {
        // The prompt fits – only the requested answer is too long for this request.
        const allowed = window - input - 16;
        if (!current || allowed < current) {
          call.maxBudget = allowed;
          return true;
        }
      }
      throw new AiError(
        `The prompt does not fit into the model's context window (${window} tokens${input ? `, the prompt alone has ${input}` : ''}). ` +
          `Set "Context window (tokens)" in Settings → AI provider → Advanced to ${window} or less.`,
      );
    }
    if (body.response_format && /response_format|json_schema|json_object|structured|guided/.test(msg)) {
      caps.responseFormat = caps.responseFormat === 'json_schema' ? 'json_object' : 'none';
      return true;
    }
    if (body.reasoning_effort && /reasoning_effort|reasoning effort|reasoning\.effort/.test(msg)) {
      // Unsupported value (e.g. a model that only accepts its default) or unknown parameter.
      caps.reasoningEffort = null;
      return true;
    }
    // "max_completion_tokens is too large: 20000. This model supports at most 16384 completion tokens"
    // "max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens"
    const limit = /at most (\d+)/.exec(msg) ?? /max_(?:completion_)?tokens: \d+ > (\d+)/.exec(msg);
    if (limit && /max_(completion_)?tokens|completion tokens|output tokens/.test(msg)) {
      const max = Number(limit[1]);
      if (max > 0 && max !== caps.maxOutput) {
        caps.maxOutput = max;
        return true;
      }
    }
    if (/max_completion_tokens/.test(msg) && caps.tokenParam === 'max_completion_tokens') {
      caps.tokenParam = 'max_tokens';
      return true;
    }
    if (/max_tokens/.test(msg) && caps.tokenParam === 'max_tokens') {
      caps.tokenParam = msg.includes('max_completion_tokens') ? 'max_completion_tokens' : 'none';
      return true;
    }
    if (/temperature/.test(msg) && caps.temperature && body.temperature !== undefined) {
      caps.temperature = false;
      return true;
    }
    if (/stream_options|include_usage/.test(msg) && caps.streamUsage) {
      caps.streamUsage = false;
      return true;
    }
    return false;
  }

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<CompletionResult> {
    const started = Date.now();
    const call: CallState = {};
    for (let attempt = 0; attempt < 5; attempt++) {
      const body = this.buildBody(messages, opts, false, call);
      try {
        const res = await request<OpenAiChatResponse>(this.url('/chat/completions'), {
          method: 'POST',
          headers: this.headers(),
          body,
          timeoutMs: opts.timeoutMs ?? this.opts.timeoutMs ?? 180_000,
          retries: 2,
          retryDelayMs: 2000,
          signal: opts.signal,
        });
        const choice = res?.choices?.[0];
        const text = choice?.message?.content ?? '';
        if (!text && choice?.message?.refusal) throw new AiError(`Model refused: ${choice.message.refusal}`);
        if (!text.trim() && choice?.finish_reason === 'length') {
          // The output budget was used up before any answer – typically by hidden reasoning.
          if (!this.caps.reasoning) {
            this.caps.reasoning = true;
            continue;
          }
          throw outOfBudget(body[this.caps.tokenParam]);
        }
        return { text, usage: toUsage(res?.usage), model: res?.model ?? this.model, durationMs: Date.now() - started };
      } catch (err) {
        if (this.adapt(err, body, call)) continue;
        throw wrapError(err);
      }
    }
    throw new AiError('Could not find a compatible request format for this AI endpoint');
  }

  async *stream(messages: ChatMessage[], opts: CompletionOptions = {}): AsyncGenerator<StreamChunk> {
    let res: Response | undefined;
    const call: CallState = {};
    for (let attempt = 0; attempt < 5 && !res; attempt++) {
      const body = this.buildBody(messages, opts, true, call);
      try {
        res = await request<Response>(this.url('/chat/completions'), {
          method: 'POST',
          headers: { ...this.headers(), Accept: 'text/event-stream' },
          body,
          timeoutMs: opts.timeoutMs ?? this.opts.timeoutMs ?? 300_000,
          retries: 1,
          signal: opts.signal,
          responseType: 'response',
        });
      } catch (err) {
        if (this.adapt(err, body, call)) continue;
        throw wrapError(err);
      }
    }
    if (!res?.body) throw new AiError('AI endpoint returned an empty stream');
    let usage: Usage | undefined;
    let finish: string | undefined;
    let produced = false;
    // Hide <think> reasoning of reasoning models in chat output.
    const think = new ThinkFilter();
    for await (const evt of parseSse(res.body)) {
      if (evt.data === '[DONE]') break;
      let json: OpenAiStreamChunk;
      try {
        json = JSON.parse(evt.data) as OpenAiStreamChunk;
      } catch {
        continue;
      }
      if ((json as { error?: { message?: string } }).error) {
        throw new AiError((json as { error: { message?: string } }).error.message ?? 'Stream error');
      }
      if (json.usage) usage = toUsage(json.usage);
      finish = json.choices?.[0]?.finish_reason ?? finish;
      const raw = json.choices?.[0]?.delta?.content;
      if (!raw) continue;
      const delta = think.push(raw);
      if (delta) {
        produced = true;
        yield { type: 'delta', text: delta };
      }
    }
    const rest = think.flush();
    if (rest) {
      produced = true;
      yield { type: 'delta', text: rest };
    }
    if (!produced && finish === 'length') {
      this.caps.reasoning = true; // next requests get the reasoning budget
      throw outOfBudget(undefined);
    }
    if (usage) yield { type: 'usage', usage };
  }

  async ping(signal?: AbortSignal): Promise<void> {
    if (this.opts.azure) {
      // Azure has no cheap model listing per deployment; do a tiny completion.
      await this.complete([{ role: 'user', content: 'ping' }], { maxTokens: 5, signal, timeoutMs: 30_000 });
      return;
    }
    try {
      await request(this.url('/models'), { headers: this.headers(), timeoutMs: 15_000, signal });
    } catch (err) {
      // Some compatible servers do not implement /models: fall back to a tiny completion.
      if (err instanceof HttpError && (err.status === 404 || err.status === 405)) {
        await this.complete([{ role: 'user', content: 'ping' }], { maxTokens: 5, signal, timeoutMs: 30_000 });
        return;
      }
      throw wrapError(err);
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    if (this.opts.azure) return [this.model];
    const res = await request<{ data?: { id: string }[] }>(this.url('/models'), {
      headers: this.headers(),
      timeoutMs: 15_000,
      signal,
    }).catch((err) => {
      throw wrapError(err);
    });
    return (res?.data ?? []).map((m) => m.id).sort();
  }
}

/** Embeddings through an OpenAI-compatible /embeddings endpoint. */
export class OpenAiEmbeddingClient implements EmbeddingClient {
  readonly id: string;
  constructor(
    private readonly opts: {
      baseUrl: string;
      apiKey?: string;
      model: string;
      azure?: { apiVersion: string };
      batchSize?: number;
    },
  ) {
    this.id = `openai:${opts.model}`;
  }

  async embed(texts: string[], _kind: EmbeddingKind, signal?: AbortSignal): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    const batch = this.opts.batchSize ?? 64;
    const base = trimSlash(this.opts.baseUrl);
    const url = this.opts.azure
      ? `${base}/embeddings?api-version=${encodeURIComponent(this.opts.azure.apiVersion)}`
      : `${base}/embeddings`;
    const headers: Record<string, string> = {};
    if (this.opts.apiKey) {
      if (this.opts.azure) headers['api-key'] = this.opts.apiKey;
      else headers.Authorization = `Bearer ${this.opts.apiKey}`;
    }
    for (let i = 0; i < texts.length; i += batch) {
      const slice = texts.slice(i, i + batch);
      const body: Record<string, unknown> = { input: slice };
      if (!this.opts.azure) body.model = this.opts.model;
      const res = await request<{ data: { embedding: number[]; index: number }[] }>(url, {
        method: 'POST',
        headers,
        body,
        timeoutMs: 120_000,
        retries: 3,
        retryDelayMs: 1500,
        signal,
      }).catch((err) => {
        throw wrapError(err);
      });
      const sorted = [...(res?.data ?? [])].sort((a, b) => a.index - b.index);
      if (sorted.length !== slice.length) throw new AiError('Embedding endpoint returned an unexpected number of vectors');
      for (const d of sorted) out.push(Float32Array.from(d.embedding));
    }
    return out;
  }
}

interface OpenAiChatResponse {
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
  usage?: OpenAiUsage;
}
interface OpenAiStreamChunk {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: OpenAiUsage | null;
}

function outOfBudget(budget: unknown): AiError {
  return new AiError(
    `The model used its whole output budget${typeof budget === 'number' ? ` (${budget} tokens)` : ''} before answering – usually for reasoning. ` +
      'Increase "Answer tokens" in Settings → AI provider → Advanced or choose a model that reasons less.',
  );
}
interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

function toUsage(u?: OpenAiUsage | null): Usage {
  if (!u) return emptyUsage();
  const promptTokens = Math.round(u.prompt_tokens ?? 0);
  const completionTokens = Math.round(u.completion_tokens ?? 0);
  return { promptTokens, completionTokens, totalTokens: Math.round(u.total_tokens ?? promptTokens + completionTokens) };
}

export function wrapError(err: unknown): Error {
  if (err instanceof AiError) return err;
  if (err instanceof HttpError) {
    const body = err.body as { error?: { message?: string; code?: string; type?: string } | string; message?: string } | string | undefined;
    let detail = '';
    if (typeof body === 'string') detail = body;
    else if (body && typeof body.error === 'object') detail = body.error?.message ?? '';
    else if (body && typeof body.error === 'string') detail = body.error;
    else if (body?.message) detail = body.message;
    const code = typeof body === 'object' && body && typeof body.error === 'object' ? `${body.error.code ?? ''} ${body.error.type ?? ''}` : '';
    // A 429 is either a rate limit (waiting helps) or an exhausted quota / credit balance (it does not).
    const quota = err.status === 429 && QUOTA_EXHAUSTED.test(`${detail} ${code}`);
    const hint =
      err.status === 401 || err.status === 403
        ? ' (check the API key)'
        : err.status === 404
          ? ' (check base URL / model name)'
          : quota
            ? ' (quota exhausted – check the plan and billing of your account)'
            : err.status === 429
              ? ' (rate limit – processing pauses and continues automatically)'
              : '';
    return new AiError(`${err.message}${detail ? `: ${detail}` : ''}${hint}`, err.retryable && !quota, {
      status: err.status,
      rateLimited: err.status === 429 && !quota,
      retryAfterMs: err.retryAfterMs,
    });
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return err;
  return new AiError(err instanceof Error ? err.message : String(err), true);
}

/** "maximum context length is 8192 tokens", "context window of 8192", "prompt is too long: 210000 tokens > 200000 maximum". */
function contextLimit(msg: string): number | null {
  const m =
    /maximum context length (?:is|of) (\d+)/.exec(msg) ??
    /context (?:window|length) (?:is |of |limit (?:is |of )?)?(\d+)/.exec(msg) ??
    /prompt is too long: \d+ tokens > (\d+)/.exec(msg);
  return m ? Number(m[1]) : null;
}

/** Size of the prompt as reported in a context length error. */
function inputTokens(msg: string): number | null {
  const m =
    /(\d+) in the messages/.exec(msg) ??
    /(?:request|prompt) has (\d+) input tokens/.exec(msg) ??
    /messages resulted in (\d+) tokens/.exec(msg) ??
    /prompt is too long: (\d+) tokens/.exec(msg) ??
    /(\d+) (?:input|prompt) tokens/.exec(msg);
  return m ? Number(m[1]) : null;
}
