/**
 * Native Ollama client (/api/chat, /api/embed).
 *
 * Using the native API (instead of Ollama's OpenAI shim) lets us set
 * `num_ctx` per request – otherwise Ollama silently truncates long documents
 * to its small default context – and pass a JSON schema via `format`.
 */
import { HttpError, request, trimSlash } from '../util/http.js';
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
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

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

  /** Context size large enough for prompt + answer, rounded to 1k, capped by config. */
  numCtx(messages: ChatMessage[], maxTokens = 1024): number {
    const promptTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content) + 8, 0);
    const needed = Math.ceil((promptTokens * 1.1 + maxTokens + 256) / 1024) * 1024;
    return Math.max(2048, Math.min(needed, this.contextWindow));
  }

  private buildBody(messages: ChatMessage[], opts: CompletionOptions, stream: boolean) {
    const options: Record<string, unknown> = { num_ctx: this.numCtx(messages, opts.maxTokens) };
    if (opts.temperature !== undefined) options.temperature = opts.temperature;
    if (opts.maxTokens) options.num_predict = opts.maxTokens;
    const body: Record<string, unknown> = { model: this.model, messages, stream, options };
    if (opts.jsonSchema) body.format = opts.jsonSchema.schema;
    else if (opts.json) body.format = 'json';
    if (this.opts.keepAlive) body.keep_alive = this.opts.keepAlive;
    return body;
  }

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<CompletionResult> {
    const started = Date.now();
    let body = this.buildBody(messages, opts, false);
    let res: OllamaChatResponse;
    try {
      res = await this.post<OllamaChatResponse>('/api/chat', body, opts);
    } catch (err) {
      // Ollama < 0.5 does not support JSON schemas in `format` – fall back to plain JSON mode.
      if (err instanceof HttpError && err.status === 400 && typeof body.format === 'object') {
        body = { ...body, format: 'json' };
        res = await this.post<OllamaChatResponse>('/api/chat', body, opts);
      } else throw wrapOllamaError(err, this.model);
    }
    if (res.error) throw new AiError(`Ollama: ${res.error}`);
    return {
      text: res.message?.content ?? '',
      usage: usage(res),
      model: res.model ?? this.model,
      durationMs: Date.now() - started,
    };
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
    let res: Response;
    try {
      res = await request<Response>(`${this.base}/api/chat`, {
        method: 'POST',
        headers: this.headers(),
        body: this.buildBody(messages, opts, true),
        timeoutMs: opts.timeoutMs ?? this.opts.timeoutMs ?? 600_000,
        signal: opts.signal,
        responseType: 'response',
      });
    } catch (err) {
      throw wrapOllamaError(err, this.model);
    }
    if (!res.body) throw new AiError('Ollama returned an empty stream');
    const think = new ThinkFilter();
    for await (const chunk of parseNdjson<OllamaChatResponse>(res.body)) {
      if (chunk.error) throw new AiError(`Ollama: ${chunk.error}`);
      const text = think.push(chunk.message?.content ?? '');
      if (text) yield { type: 'delta', text };
      if (chunk.done) {
        const rest = think.flush();
        if (rest) yield { type: 'delta', text: rest };
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
