/**
 * Fake LLM server speaking the OpenAI-compatible API (/v1/models,
 * /v1/chat/completions incl. SSE streaming, /v1/embeddings) and the native
 * Ollama API (/api/tags, /api/chat incl. NDJSON streaming, /api/embed).
 *
 * Replies are produced by a programmable handler; every request body is
 * captured. Embeddings are deterministic hashed bag-of-words vectors, with a
 * small synonym table so that "semantic" matches can be tested.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export type LlmApi = 'openai' | 'ollama';

export interface ChatRequestInfo {
  api: LlmApi;
  body: Record<string, unknown>;
  messages: { role: string; content: string }[];
  stream: boolean;
  /** Content of the system message (if any). */
  system: string;
  /** Content of the last user message. */
  user: string;
}

export interface ChatReply {
  content?: string;
  /** Respond with this HTTP status and error body instead. */
  status?: number;
  error?: unknown;
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** Split streamed content into pieces of this size (default 4 chars). */
  chunkSize?: number;
  /** Exact pieces to stream (overrides content/chunkSize for streams). */
  chunks?: string[];
  /** OpenAI refusal message (content will be null). */
  refusal?: string;
}

export type ChatHandler = (req: ChatRequestInfo) => string | ChatReply | Promise<string | ChatReply>;

export interface CapturedLlmRequest {
  method: string;
  path: string;
  /** Path including the query string. */
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown> | undefined;
}

export const EMBEDDING_DIMS = 64;

/** Words mapped onto a shared concept so that semantically similar texts get similar vectors. */
export const DEFAULT_SYNONYMS: Record<string, string> = {
  car: 'vehicle',
  cars: 'vehicle',
  automobile: 'vehicle',
  auto: 'vehicle',
  vehicle: 'vehicle',
  kfz: 'vehicle',
  physician: 'doctor',
  doctor: 'doctor',
  medical: 'doctor',
  arzt: 'doctor',
  electricity: 'power',
  power: 'power',
  energy: 'power',
  strom: 'power',
};

const EMBED_STOPWORDS = new Set([
  'title', 'from', 'type', 'date', 'tags', 'the', 'a', 'an', 'of', 'for', 'and', 'or', 'to', 'in', 'is', 'my', 'what', 'which', 'about',
  'query', 'passage', 'document', 'documents', 'search_query', 'search_document',
]);

function hashDim(word: string): number {
  return createHash('md5').update(word).digest().readUInt32LE(0) % EMBEDDING_DIMS;
}

export function mockEmbedding(text: string, synonyms: Record<string, string> = DEFAULT_SYNONYMS): number[] {
  const v = new Array<number>(EMBEDDING_DIMS).fill(0);
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  for (const w of words) {
    if (EMBED_STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    v[hashDim(synonyms[w] ?? w)] += 1;
  }
  // Avoid all-zero vectors (would be skipped by normalisation).
  if (!v.some((x) => x !== 0)) v[0] = 1e-3;
  return v;
}

export interface MockLlmOptions {
  /** Reject `response_format: {type: "json_schema"}` with HTTP 400 (OpenAI API). */
  rejectJsonSchema?: boolean;
  /** Reject an object passed as Ollama `format` with HTTP 400 (Ollama < 0.5). */
  rejectOllamaSchemaFormat?: boolean;
  models?: string[];
  ollamaModels?: string[];
  synonyms?: Record<string, string>;
  /** Required `Authorization: Bearer …` key for the OpenAI API (optional). */
  apiKey?: string;
  /** Answer GET …/models with 404 (servers without a model listing). */
  noModelsEndpoint?: boolean;
  /** Fail embedding requests (OpenAI and Ollama) with this HTTP status. */
  embeddingErrorStatus?: number;
}

export class MockLlm {
  readonly requests: CapturedLlmRequest[] = [];
  handler: ChatHandler = () => JSON.stringify({ title: 'Mock title', correspondent: '', tags: [], document_type: '', document_date: '', language: 'en' });
  opts: MockLlmOptions;
  private server: http.Server | null = null;

  constructor(opts: MockLlmOptions = {}) {
    this.opts = opts;
  }

  get url(): string {
    const addr = this.server?.address() as AddressInfo | null;
    if (!addr) throw new Error('Mock LLM server not started');
    return `http://127.0.0.1:${addr.port}`;
  }

  /** Base URL for OpenAI-compatible clients. */
  get openaiUrl(): string {
    return `${this.url}/v1`;
  }

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return this;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** Set the chat reply: a handler function, the content as string, or a fixed ChatReply. */
  reply(handler: ChatHandler | string | ChatReply): void {
    if (typeof handler === 'function') this.handler = handler;
    else this.handler = () => handler;
  }

  chatRequests(): CapturedLlmRequest[] {
    return this.requests.filter((r) => r.path.endsWith('/chat/completions') || r.path === '/api/chat');
  }

  embeddingRequests(): CapturedLlmRequest[] {
    return this.requests.filter((r) => r.path.endsWith('/embeddings') || r.path === '/api/embed');
  }

  clearRequests(): void {
    this.requests.length = 0;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    this.requests.push({ method: req.method ?? 'GET', path: u.pathname, url: `${u.pathname}${u.search}`, headers: req.headers, body });

    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    const path = u.pathname;
    // Everything outside Ollama's /api/ prefix is treated as an OpenAI-compatible API (any base path, e.g. Azure deployments).
    const openai = !path.startsWith('/api/');
    const authorized =
      !this.opts.apiKey || req.headers.authorization === `Bearer ${this.opts.apiKey}` || req.headers['api-key'] === this.opts.apiKey;
    if (openai && !authorized) {
      return json(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } });
    }

    // ---------------------------------------------------------------- OpenAI compatible
    if (openai && path.endsWith('/models') && req.method === 'GET' && !this.opts.noModelsEndpoint) {
      return json(200, { object: 'list', data: (this.opts.models ?? ['test-model', 'other-model']).map((id) => ({ id, object: 'model' })) });
    }
    if (this.opts.embeddingErrorStatus && (path.endsWith('/embeddings') || path === '/api/embed')) {
      return json(this.opts.embeddingErrorStatus, { error: { message: 'Embedding model not available' } });
    }
    if (openai && path.endsWith('/embeddings') && req.method === 'POST') {
      const input = body?.input;
      const texts = Array.isArray(input) ? (input as string[]) : [String(input)];
      return json(200, {
        object: 'list',
        model: body?.model,
        // Deliberately reversed to verify that clients sort by index.
        data: texts.map((t, index) => ({ object: 'embedding', index, embedding: mockEmbedding(t, this.opts.synonyms) })).reverse(),
        usage: { prompt_tokens: texts.length, total_tokens: texts.length },
      });
    }
    if (openai && path.endsWith('/chat/completions') && req.method === 'POST') {
      const b = body ?? {};
      const rf = b.response_format as { type?: string } | undefined;
      if (this.opts.rejectJsonSchema && rf?.type === 'json_schema') {
        return json(400, {
          error: { message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.", type: 'invalid_request_error' },
        });
      }
      const info = this.info('openai', b);
      const r = normalizeReply(await this.handler(info));
      if (r.status && r.status >= 400) return json(r.status, r.error ?? { error: { message: 'Mock error' } });
      const content = r.content ?? '';
      const usage = r.usage ?? { prompt_tokens: 100, completion_tokens: 20 };
      const usageObj = { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens };
      const model = String(b.model ?? 'azure-deployment');
      if (!info.stream) {
        return json(200, {
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model,
          choices: [
            { index: 0, message: { role: 'assistant', content: r.refusal ? null : content, refusal: r.refusal ?? null }, finish_reason: 'stop' },
          ],
          usage: usageObj,
        });
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const pieces = r.chunks ?? split(content, r.chunkSize ?? 4);
      res.write(`data: ${JSON.stringify({ id: 'c', model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`);
      for (const p of pieces) {
        res.write(`data: ${JSON.stringify({ id: 'c', model, choices: [{ index: 0, delta: { content: p } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id: 'c', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      if ((b.stream_options as { include_usage?: boolean } | undefined)?.include_usage) {
        res.write(`data: ${JSON.stringify({ id: 'c', model, choices: [], usage: usageObj })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // ---------------------------------------------------------------- Ollama native
    if (path === '/api/tags' && req.method === 'GET') {
      return json(200, { models: (this.opts.ollamaModels ?? ['llama3.2:latest', 'nomic-embed-text:latest']).map((name) => ({ name, model: name })) });
    }
    if (path === '/api/embed' && req.method === 'POST') {
      const input = body?.input;
      const texts = Array.isArray(input) ? (input as string[]) : [String(input)];
      return json(200, { model: body?.model, embeddings: texts.map((t) => mockEmbedding(t, this.opts.synonyms)) });
    }
    if (path === '/api/chat' && req.method === 'POST') {
      const b = body ?? {};
      if (this.opts.rejectOllamaSchemaFormat && b.format && typeof b.format === 'object') {
        return json(400, { error: 'invalid format: expected "json" or a valid JSON schema' });
      }
      const info = this.info('ollama', b);
      const r = normalizeReply(await this.handler(info));
      if (r.status && r.status >= 400) return json(r.status, r.error ?? { error: 'Mock error' });
      const content = r.content ?? '';
      const usage = r.usage ?? { prompt_tokens: 100, completion_tokens: 20 };
      const model = String(b.model);
      if (!info.stream) {
        return json(200, {
          model,
          message: { role: 'assistant', content },
          done: true,
          prompt_eval_count: usage.prompt_tokens,
          eval_count: usage.completion_tokens,
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (const p of r.chunks ?? split(content, r.chunkSize ?? 4)) {
        res.write(`${JSON.stringify({ model, message: { role: 'assistant', content: p }, done: false })}\n`);
      }
      res.write(
        `${JSON.stringify({ model, message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: usage.prompt_tokens, eval_count: usage.completion_tokens })}\n`,
      );
      res.end();
      return;
    }
    return json(404, { error: { message: `Unknown route ${req.method} ${path}` } });
  }

  private info(api: LlmApi, body: Record<string, unknown>): ChatRequestInfo {
    const messages = (body.messages as { role: string; content: string }[] | undefined) ?? [];
    return {
      api,
      body,
      messages,
      stream: body.stream === true,
      system: messages.find((m) => m.role === 'system')?.content ?? '',
      user: [...messages].reverse().find((m) => m.role === 'user')?.content ?? '',
    };
  }
}

function normalizeReply(r: string | ChatReply): ChatReply {
  return typeof r === 'string' ? { content: r } : r;
}

function split(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export async function startMockLlm(opts: MockLlmOptions = {}): Promise<MockLlm> {
  return new MockLlm(opts).start();
}
