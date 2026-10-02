import type { AppConfig } from '../config/schema.js';
import {
  DEFAULT_LOCAL_EMBEDDING_MODEL,
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
} from '../config/defaults.js';
import { trimSlash } from '../util/http.js';
import { OllamaClient, OllamaEmbeddingClient } from './ollama.js';
import { OpenAiCompatibleClient, OpenAiEmbeddingClient } from './openai.js';
import { AiError, type EmbeddingClient, type LlmClient } from './types.js';

const OPENAI_BASE = 'https://api.openai.com/v1';

export function azureDeploymentUrl(endpoint: string, deployment: string): string {
  const base = trimSlash(endpoint);
  if (/\/openai\/deployments\/[^/]+$/.test(base)) return base;
  return `${base.replace(/\/openai$/, '')}/openai/deployments/${encodeURIComponent(deployment)}`;
}

/** Room reserved for the thinking of local models when the context size is fixed. */
const OLLAMA_THINK_ROOM = 4096;

/** num_ctx for Ollama: the fixed context size, or 0 when it is sized per request. */
export function ollamaContextSize(ai: AppConfig['ai']): number {
  return ai.ollama.contextSize > 0 ? Math.min(ai.ollama.contextSize, ai.tokenLimit) : 0;
}

/**
 * Tokens a prompt and its answer may use together. Usually the configured token limit; with a
 * fixed Ollama context size the smaller of both, minus room for thinking unless it is switched off.
 */
export function contextBudget(ai: AppConfig['ai']): number {
  const fixed = ai.provider === 'ollama' ? ollamaContextSize(ai) : 0;
  if (!fixed) return ai.tokenLimit;
  return ai.ollama.think === 'off' ? fixed : fixed - Math.min(OLLAMA_THINK_ROOM, Math.floor(fixed / 4));
}

/** Name of the active model for display purposes. */
export function activeModel(ai: AppConfig['ai']): string {
  switch (ai.provider) {
    case 'openai':
      return ai.openai.model;
    case 'ollama':
      return ai.ollama.model;
    case 'custom':
      return ai.custom.model;
    case 'azure':
      return ai.azure.deployment;
  }
}

/** Returns a human readable reason why the AI provider is not usable, or null. */
export function aiConfigProblem(ai: AppConfig['ai']): string | null {
  switch (ai.provider) {
    case 'openai':
      if (!ai.openai.apiKey) return 'OpenAI API key is missing';
      if (!ai.openai.model) return 'OpenAI model is missing';
      return null;
    case 'ollama':
      if (!ai.ollama.url) return 'Ollama URL is missing';
      if (!ai.ollama.model) return 'Ollama model is missing';
      return null;
    case 'custom':
      if (!ai.custom.baseUrl) return 'Base URL of the custom provider is missing';
      if (!ai.custom.model) return 'Model of the custom provider is missing';
      return null;
    case 'azure':
      if (!ai.azure.endpoint || !ai.azure.apiKey || !ai.azure.deployment) return 'Azure endpoint, API key and deployment are required';
      return null;
  }
}

export function createLlmClient(ai: AppConfig['ai']): LlmClient {
  const problem = aiConfigProblem(ai);
  if (problem) throw new AiError(problem);
  const timeoutMs = ai.timeoutSeconds * 1000;
  switch (ai.provider) {
    case 'openai':
      return new OpenAiCompatibleClient({
        provider: 'openai',
        baseUrl: OPENAI_BASE,
        apiKey: ai.openai.apiKey,
        model: ai.openai.model,
        contextWindow: ai.tokenLimit,
        timeoutMs,
      });
    case 'custom':
      return new OpenAiCompatibleClient({
        provider: 'custom',
        baseUrl: ai.custom.baseUrl,
        apiKey: ai.custom.apiKey || undefined,
        model: ai.custom.model,
        contextWindow: ai.tokenLimit,
        extraBody: ai.custom.extraBody ? (JSON.parse(ai.custom.extraBody) as Record<string, unknown>) : undefined,
        timeoutMs,
      });
    case 'azure':
      return new OpenAiCompatibleClient({
        provider: 'azure',
        baseUrl: azureDeploymentUrl(ai.azure.endpoint, ai.azure.deployment),
        apiKey: ai.azure.apiKey,
        model: ai.azure.deployment,
        azure: { apiVersion: ai.azure.apiVersion },
        contextWindow: ai.tokenLimit,
        timeoutMs,
      });
    case 'ollama':
      return new OllamaClient({
        baseUrl: ai.ollama.url,
        model: ai.ollama.model,
        contextWindow: ai.tokenLimit,
        numCtx: ollamaContextSize(ai) || undefined,
        think: ai.ollama.think,
        keepAlive: ai.ollama.keepAlive || undefined,
        timeoutMs,
      });
  }
}

export interface EmbeddingSpec {
  provider: AppConfig['rag']['embeddingProvider'];
  model: string;
}

export function embeddingSpec(cfg: AppConfig): EmbeddingSpec {
  const provider = cfg.rag.embeddingProvider;
  const explicit = cfg.rag.embeddingModel;
  switch (provider) {
    case 'local':
      return { provider, model: explicit || DEFAULT_LOCAL_EMBEDDING_MODEL };
    case 'openai':
    case 'custom':
      return { provider, model: explicit || DEFAULT_OPENAI_EMBEDDING_MODEL };
    case 'azure':
      return { provider, model: explicit };
    case 'ollama':
      return { provider, model: explicit || DEFAULT_OLLAMA_EMBEDDING_MODEL };
    case 'none':
      return { provider, model: '' };
  }
}

/**
 * Create the embedding client for remote providers. Local embeddings are
 * handled by LocalEmbedder (worker thread) and created by the RAG module.
 */
export function createRemoteEmbeddingClient(cfg: AppConfig): EmbeddingClient | null {
  const spec = embeddingSpec(cfg);
  switch (spec.provider) {
    case 'openai':
      if (!cfg.ai.openai.apiKey) throw new AiError('OpenAI embeddings need an OpenAI API key (AI settings)');
      return new OpenAiEmbeddingClient({ baseUrl: OPENAI_BASE, apiKey: cfg.ai.openai.apiKey, model: spec.model });
    case 'custom':
      if (!cfg.ai.custom.baseUrl) throw new AiError('Custom embeddings need the custom provider base URL');
      return new OpenAiEmbeddingClient({ baseUrl: cfg.ai.custom.baseUrl, apiKey: cfg.ai.custom.apiKey, model: spec.model });
    case 'azure':
      if (!spec.model) throw new AiError('Azure embeddings need the name of an embedding deployment (RAG settings → model)');
      return new OpenAiEmbeddingClient({
        baseUrl: azureDeploymentUrl(cfg.ai.azure.endpoint, spec.model),
        apiKey: cfg.ai.azure.apiKey,
        model: spec.model,
        azure: { apiVersion: cfg.ai.azure.apiVersion },
      });
    case 'ollama':
      return new OllamaEmbeddingClient({ baseUrl: cfg.ai.ollama.url, model: spec.model, keepAlive: cfg.ai.ollama.keepAlive || undefined });
    default:
      return null;
  }
}

/** Instruction prefixes some embedding model families expect. */
export function embeddingPrefix(model: string, kind: 'query' | 'passage'): string {
  const m = model.toLowerCase();
  if (m.includes('e5')) return kind === 'query' ? 'query: ' : 'passage: ';
  if (m.includes('nomic-embed')) return kind === 'query' ? 'search_query: ' : 'search_document: ';
  if (m.includes('mxbai-embed') && kind === 'query') return 'Represent this sentence for searching relevant passages: ';
  return '';
}
