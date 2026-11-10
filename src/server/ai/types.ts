export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  /** Request structured JSON output following this JSON schema (best effort per provider). */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** Request JSON output without a schema. */
  json?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CompletionResult {
  text: string;
  usage: Usage;
  model: string;
  durationMs: number;
}

export type StreamChunk = { type: 'delta'; text: string } | { type: 'usage'; usage: Usage };

export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  /** Context window in tokens the client should plan with. */
  readonly contextWindow: number;
  complete(messages: ChatMessage[], opts?: CompletionOptions): Promise<CompletionResult>;
  stream(messages: ChatMessage[], opts?: CompletionOptions): AsyncGenerator<StreamChunk>;
  /** Lightweight connectivity/auth check. Throws on failure. */
  ping(signal?: AbortSignal): Promise<void>;
  listModels(signal?: AbortSignal): Promise<string[]>;
  /** Free the model's memory (local providers). */
  unload?(): Promise<void>;
}

export type EmbeddingKind = 'query' | 'passage';

export interface EmbeddingClient {
  /** Unique identifier of the embedding space (provider + model), stored with the index. */
  readonly id: string;
  embed(texts: string[], kind: EmbeddingKind, signal?: AbortSignal): Promise<Float32Array[]>;
  /** Release resources (e.g. worker threads). */
  dispose?(): Promise<void>;
}

export const emptyUsage = (): Usage => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });

export interface AiErrorInfo {
  /** HTTP status of the provider's response. */
  status?: number;
  /** Too many requests: waiting helps (unlike an exhausted quota). */
  rateLimited?: boolean;
  /** Wait time requested by the provider (Retry-After). */
  retryAfterMs?: number;
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly info: AiErrorInfo = {},
  ) {
    super(message);
    this.name = 'AiError';
  }

  get rateLimited(): boolean {
    return this.info.rateLimited === true;
  }
}
