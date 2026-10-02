/**
 * Native Ollama client (/api/chat, /api/embed).
 *
 * Using the native API (instead of Ollama's OpenAI shim) lets us set
 * `num_ctx` per request – otherwise Ollama silently truncates long documents
 * to its small default context – and pass a JSON schema via `format`.
 */
import type { OllamaThink } from '../config/schema.js';
import { describeError, HttpError, request, trimSlash } from '../util/http.js';
import { extractJsonObject } from './json.js';
import { wrapError } from './openai.js';
import { parseNdjson, ThinkFilter } from './stream.js';
import { estimateTokens } from './tokens.js';
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
} from './types.js';

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  /** Upper bound for num_ctx. */
  contextWindow: number;
  /** Fixed num_ctx for every request – changing it makes Ollama reload the model. Unset = sized per request. */
  numCtx?: number;
  /** Thinking of thinking models; "auto" leaves the model's default. */
  think?: OllamaThink;
  timeoutMs?: number;
  /** How long Ollama keeps the model loaded after a request (e.g. "5m", "0" to unload immediately). */
  keepAlive?: string;
  /** Optional bearer token (Ollama behind an authenticating reverse proxy). */
  apiKey?: string;
}

interface OllamaChatResponse {
  model?: string;
  message?: { role: string; content: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** Models that think before answering (qwen3, gpt-oss, deepseek-r1 …) – learned from their responses. */
const thinkingModels = new Set<string>();
/** Models (or Ollama versions) that rejected the `think` parameter. */
const thinkUnsupported = new Set<string>();
/** Extra num_predict for the thinking of such models. */
const THINKING_RESERVE = 8192;

export class OllamaClient implements LlmClient {
  readonly provider = 'ollama';
  readonly model: string;
  readonly contextWindow: number;

  constructor(private readonly opts: OllamaOptions) {
    this.model = opts.model;
    this.contextWindow = opts.contextWindow;
  }

  private get base(): string {
    // Users frequently paste the OpenAI-compatible URL – normalise it.
    return trimSlash(this.opts.baseUrl).replace(/\/(v1|api)$/, '');
  }

  private headers(): Record<string, string> {
    return this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {};
  }

  private promptTokens(messages: ChatMessage[]): number {
    return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 8, 0);
  }

  /**
   * The fixed context size, or – without one – a size large enough for prompt + answer. Sizes
   * are powers of two so that Ollama rarely has to reload the model for a different num_ctx.
   */
  numCtx(messages: ChatMessage[], maxTokens = 1024): number {
    if (this.opts.numCtx) return this.opts.numCtx;
    const needed = this.promptTokens(messages) * 1.1 + maxTokens + 256;
    let size = 2048;
    while (size < needed) size *= 2;
    return Math.min(size, Math.max(2048, this.contextWindow));
  }

  /** Whether the model is known (or told) to think before answering. */
  private get thinks(): boolean {
    const think = this.opts.think ?? 'auto';
    if (think === 'off') return false;
    return think !== 'auto' || thinkingModels.has(this.key);
  }

  private buildBody(messages: ChatMessage[], opts: CompletionOptions, stream: boolean) {
    // num_predict also covers the thinking of thinking models – give them room for it.
    let maxTokens = opts.maxTokens && this.thinks ? opts.maxTokens + THINKING_RESERVE : opts.maxTokens;
    const numCtx = this.numCtx(messages, maxTokens);
    // …but never more than what is left of the context window.
    if (maxTokens && opts.maxTokens) maxTokens = Math.max(opts.maxTokens, Math.min(maxTokens, numCtx - this.promptTokens(messages)));
    const options: Record<string, unknown> = { num_ctx: numCtx };
    if (opts.temperature !== undefined) options.temperature = opts.temperature;
    if (maxTokens) options.num_predict = maxTokens;
    const body: Record<string, unknown> = { model: this.model, messages, stream, options };
    if (opts.jsonSchema) body.format = opts.jsonSchema.schema;
    else if (opts.json) body.format = 'json';
    const think = thinkParam(this.opts.think);
    if (think !== undefined && !thinkUnsupported.has(this.key)) body.think = think;
    if (this.opts.keepAlive) body.keep_alive = this.opts.keepAlive;
    return body;
  }

  /** A 400 because the model (or the Ollama version) does not know `think`: remember and retry without. */
  private rejectedThink(err: unknown, body: Record<string, unknown>): boolean {
    if (!(err instanceof HttpError) || err.status !== 400 || body.think === undefined) return false;
    if (!/think/i.test(describeError(err))) return false;
    thinkUnsupported.add(this.key);
    delete body.think;
    return true;
  }

  private get key(): string {
    return `${this.base}|${this.model}`;
  }

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<CompletionResult> {
    const started = Date.now();
    let res = await this.chat(messages, opts);
    if (!res.message?.content?.trim() && res.done_reason === 'length' && !this.thinks && this.opts.think !== 'off') {
      // The token limit was used up by thinking – retry once with room for it.
      thinkingModels.add(this.key);
      res = await this.chat(messages, opts);
    }
    let text = res.message?.content ?? '';
    if (!text.trim() && res.message?.thinking && (opts.json || opts.jsonSchema)) {
      // Some models (gpt-oss) occasionally put the structured answer into their thinking.
      try {
        text = JSON.stringify(extractJsonObject(res.message.thinking));
      } catch {
        /* no JSON in there */
      }
    }
    if (!text.trim() && res.done_reason === 'length') {
      throw new AiError(
        'The model used its whole output budget before answering – usually for thinking. Increase "Answer tokens" in Settings → AI provider → Advanced or choose a model that thinks less.',
      );
    }
    return { text, usage: usage(res), model: res.model ?? this.model, durationMs: Date.now() - started };
  }

  private async chat(messages: ChatMessage[], opts: CompletionOptions): Promise<OllamaChatResponse> {
    const body = this.buildBody(messages, opts, false);
    let res: OllamaChatResponse | undefined;
    for (let attempt = 0; !res; attempt++) {
      try {
        res = await this.post<OllamaChatResponse>('/api/chat', body, opts);
      } catch (err) {
        if (attempt < 2 && this.rejectedThink(err, body)) continue;
        // Ollama < 0.5 does not support JSON schemas in `format` – fall back to plain JSON mode.
        if (attempt < 2 && err instanceof HttpError && err.status === 400 && typeof body.format === 'object') {
          body.format = 'json';
          continue;
        }
        throw wrapOllamaError(err, this.model);
      }
    }
    if (res.error) throw new AiError(`Ollama: ${res.error}`);
    return res;
  }

  /** Unload the model from memory right away (keep_alive 0). */
  async unload(): Promise<void> {
    try {
      await request(`${this.base}/api/generate`, {
        method: 'POST',
        headers: this.headers(),
        body: { model: this.model, keep_alive: 0 },
        timeoutMs: 30_000,
      });
    } catch (err) {
      throw wrapOllamaError(err, this.model);
    }
  }

  private async post<T>(path: string, body: unknown, opts: CompletionOptions): Promise<T> {
    try {
      return await request<T>(`${this.base}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body,
        // Local models can be slow, especially on the first (cold) request.
        timeoutMs: opts.timeoutMs ?? this.opts.timeoutMs ?? 600_000,
        retries: 1,
        retryDelayMs: 3000,
        signal: opts.signal,
      });
    } catch (err) {
      if (err instanceof HttpError && err.status === 400) throw err;
      throw wrapOllamaError(err, this.model);
    }
  }

  async *stream(messages: ChatMessage[], opts: CompletionOptions = {}): AsyncGenerator<StreamChunk> {
    const body = this.buildBody(messages, opts, true);
    let res: Response | undefined;
    for (let attempt = 0; !res; attempt++) {
      try {
        res = await request<Response>(`${this.base}/api/chat`, {
          method: 'POST',
          headers: this.headers(),
          body,
          timeoutMs: opts.timeoutMs ?? this.opts.timeoutMs ?? 600_000,
          signal: opts.signal,
          responseType: 'response',
        });
      } catch (err) {
        if (attempt === 0 && this.rejectedThink(err, body)) continue;
        throw wrapOllamaError(err, this.model);
      }
    }
    if (!res.body) throw new AiError('Ollama returned an empty stream');
    const think = new ThinkFilter();
    let produced = false;
    for await (const chunk of parseNdjson<OllamaChatResponse>(res.body)) {
      if (chunk.error) throw new AiError(`Ollama: ${chunk.error}`);
      const text = think.push(chunk.message?.content ?? '');
      if (text) {
        produced = true;
        yield { type: 'delta', text };
      }
      if (chunk.done) {
        const rest = think.flush();
        if (rest) {
          produced = true;
          yield { type: 'delta', text: rest };
        }
        if (!produced && chunk.done_reason === 'length') {
          thinkingModels.add(this.key); // next requests get room for the thinking
          throw new AiError('The model used its whole output budget before answering – usually for thinking. Please try again.');
        }
        yield { type: 'usage', usage: usage(chunk) };
        break;
      }
    }
  }

  async ping(signal?: AbortSignal): Promise<void> {
    const models = await this.listModels(signal);
    const wanted = this.model.includes(':') ? this.model : `${this.model}:latest`;
    if (!models.some((m) => m === this.model || m === wanted)) {
      throw new AiError(
        `Model "${this.model}" is not available in Ollama. Pull it with "ollama pull ${this.model}". Available: ${models.slice(0, 15).join(', ') || 'none'}`,
      );
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    try {
      const res = await request<{ models?: { name: string; model?: string }[] }>(`${this.base}/api/tags`, {
        headers: this.headers(),
        timeoutMs: 15_000,
        signal,
      });
      return (res?.models ?? []).map((m) => m.name ?? m.model ?? '').filter(Boolean).sort();
    } catch (err) {
      throw wrapOllamaError(err, this.model);
    }
  }
}

export class OllamaEmbeddingClient implements EmbeddingClient {
  readonly id: string;
  constructor(private readonly opts: { baseUrl: string; model: string; apiKey?: string; batchSize?: number; keepAlive?: string }) {
    this.id = `ollama:${opts.model}`;
  }

  async embed(texts: string[], _kind: EmbeddingKind, signal?: AbortSignal): Promise<Float32Array[]> {
    const base = trimSlash(this.opts.baseUrl).replace(/\/(v1|api)$/, '');
    const headers = this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : undefined;
    const batch = this.opts.batchSize ?? 32;
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += batch) {
      const slice = texts.slice(i, i + batch);
      try {
        const res = await request<{ embeddings?: number[][] }>(`${base}/api/embed`, {
          method: 'POST',
          headers,
          body: { model: this.opts.model, input: slice, truncate: true, keep_alive: this.opts.keepAlive },
          timeoutMs: 300_000,
          retries: 2,
          signal,
        });
        if (!res?.embeddings || res.embeddings.length !== slice.length) {
          throw new AiError('Ollama returned an unexpected number of embeddings');
        }
        for (const e of res.embeddings) out.push(Float32Array.from(e));
      } catch (err) {
        if (err instanceof HttpError && err.status === 404 && /not found/i.test(JSON.stringify(err.body ?? ''))) {
          throw new AiError(`Embedding model "${this.opts.model}" not found in Ollama. Run "ollama pull ${this.opts.model}".`);
        }
        throw wrapOllamaError(err, this.opts.model);
      }
    }
    return out;
  }
}

/** The `think` request parameter for a setting (undefined = leave the model's default). */
function thinkParam(think: OllamaThink | undefined): boolean | string | undefined {
  switch (think) {
    case 'off':
      return false;
    case 'on':
      return true;
    case 'low':
    case 'medium':
    case 'high':
      return think;
    default:
      return undefined;
  }
}

function usage(r: OllamaChatResponse): Usage {
  const promptTokens = r.prompt_eval_count ?? 0;
  const completionTokens = r.eval_count ?? 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

function wrapOllamaError(err: unknown, model: string): Error {
  if (err instanceof HttpError) {
    const msg = typeof err.body === 'object' && err.body ? (err.body as { error?: string }).error : undefined;
    if (err.status === 404 && msg && /model/i.test(msg)) {
      return new AiError(`Ollama: ${msg}. Pull it with "ollama pull ${model}".`);
    }
    if (err.status === 0) {
      return new AiError(`${err.message}. Is Ollama running and reachable from Paperless-AI?`, true);
    }
  }
  return wrapError(err);
}
