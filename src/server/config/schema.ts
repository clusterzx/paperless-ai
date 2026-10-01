import { z } from 'zod';
import {
  DEFAULT_AZURE_API_VERSION,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_PROCESSED_TAG,
  DEFAULT_SCAN_INTERVAL,
  DEFAULT_SYSTEM_PROMPT,
} from './defaults.js';
import { normalizePaperlessUrl } from './url.js';

const str = (def = '') => z.string().trim().default(def);
const bool = (def: boolean) => z.boolean().default(def);
const tagList = z
  .array(z.string().trim().min(1).max(128))
  .default([])
  .transform((tags) => [...new Set(tags)]);

export const CUSTOM_FIELD_TYPES = ['string', 'integer', 'float', 'monetary', 'date', 'boolean', 'url'] as const;

export const customFieldSchema = z.object({
  name: z.string().trim().min(1).max(128),
  type: z.enum(CUSTOM_FIELD_TYPES).default('string'),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** Optional hint for the AI what to extract into this field. */
  description: z.string().trim().max(500).default(''),
});

export const AI_PROVIDERS = ['openai', 'ollama', 'custom', 'azure'] as const;
export const EMBEDDING_PROVIDERS = ['local', 'openai', 'ollama', 'custom', 'azure', 'none'] as const;

export const configSchema = z.object({
  version: z.literal(1).default(1),
  /** True once the setup wizard (or a migrated legacy config) produced a usable configuration. */
  setupCompleted: bool(false),
  paperless: z
    .object({
      /** Base URL of Paperless-ngx without the /api suffix, e.g. http://paperless:8000 */
      url: str().transform(normalizePaperlessUrl),
      token: str(),
      /** Kept for compatibility; the current user is resolved from the token. */
      username: str(),
      /** URL used for links opened in the browser (if different from the internal URL). */
      publicUrl: str().transform(normalizePaperlessUrl),
    })
    .prefault({}),
  ai: z
    .object({
      provider: z.enum(AI_PROVIDERS).default('openai'),
      openai: z.object({ apiKey: str(), model: str(DEFAULT_OPENAI_MODEL) }).prefault({}),
      ollama: z.object({ url: str(DEFAULT_OLLAMA_URL), model: str(DEFAULT_OLLAMA_MODEL), keepAlive: str() }).prefault({}),
      custom: z.object({ baseUrl: str(), apiKey: str(), model: str() }).prefault({}),
      azure: z
        .object({ endpoint: str(), apiKey: str(), deployment: str(), apiVersion: str(DEFAULT_AZURE_API_VERSION) })
        .prefault({}),
      /** Context window of the model in tokens. */
      tokenLimit: z.coerce.number().int().min(1024).max(10_000_000).default(128_000),
      /** Tokens reserved for the model's answer. */
      responseTokens: z.coerce.number().int().min(100).max(200_000).default(1000),
      temperature: z.coerce.number().min(0).max(2).default(0.2),
      timeoutSeconds: z.coerce.number().int().min(10).max(3600).default(300),
    })
    .prefault({}),
  processing: z
    .object({
      /** Scan Paperless automatically on the schedule below. */
      automatic: bool(true),
      scanInterval: str(DEFAULT_SCAN_INTERVAL),
      /** Only process documents carrying one of `tags`. */
      onlyTagged: bool(false),
      tags: tagList,
      /** Remove the trigger tags from a document once it has been processed. */
      removeTriggerTags: bool(false),
      addProcessedTag: bool(false),
      processedTagName: str(DEFAULT_PROCESSED_TAG),
      /** Restrict the AI to a fixed list of tags (replaces the system prompt). */
      usePromptTags: bool(false),
      promptTags: tagList,
      /** Send existing tags/correspondents/document types to the AI. */
      useExistingData: bool(false),
      systemPrompt: z.string().default(DEFAULT_SYSTEM_PROMPT),
      functions: z
        .object({
          tags: bool(true),
          correspondent: bool(true),
          documentType: bool(true),
          title: bool(true),
          customFields: bool(true),
          documentDate: bool(true),
        })
        .prefault({}),
      restrict: z
        .object({ tags: bool(false), correspondents: bool(false), documentTypes: bool(false) })
        .prefault({}),
      customFields: z.array(customFieldSchema).default([]),
      /** Documents analysed in parallel. */
      concurrency: z.coerce.number().int().min(1).max(8).default(1),
      /** Failed documents are retried on later scans until this many attempts were made. */
      maxAttempts: z.coerce.number().int().min(1).max(20).default(3),
    })
    .prefault({}),
  externalApi: z
    .object({
      enabled: bool(false),
      url: str(),
      method: z.enum(['GET', 'POST', 'PUT']).default('GET'),
      /** JSON object with request headers. */
      headers: z.string().default('{}'),
      /** JSON request body for POST/PUT. */
      body: z.string().default('{}'),
      timeoutMs: z.coerce.number().int().min(100).max(120_000).default(5000),
      /** Optional JS function body `return …` receiving `data`; runs in a sandbox with a time limit. */
      transform: z.string().default(''),
    })
    .prefault({}),
  rag: z
    .object({
      enabled: bool(true),
      embeddingProvider: z.enum(EMBEDDING_PROVIDERS).default('local'),
      /** Empty = provider default. */
      embeddingModel: str(),
      /** Keep the index in sync automatically. */
      autoSync: bool(true),
      /** Number of document passages handed to the model. */
      topK: z.coerce.number().int().min(2).max(40).default(10),
      /** Token budget for retrieved passages. */
      contextTokens: z.coerce.number().int().min(1000).max(200_000).default(8000),
    })
    .prefault({}),
  security: z
    .object({
      apiKey: str(),
      jwtSecret: str(),
      sessionHours: z.coerce.number().int().min(1).max(24 * 365).default(24 * 7),
    })
    .prefault({}),
});

export type AppConfig = z.output<typeof configSchema>;
export type CustomFieldConfig = z.output<typeof customFieldSchema>;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Paths of secret values that must never be sent to the browser verbatim. */
export const SECRET_PATHS = [
  'paperless.token',
  'ai.openai.apiKey',
  'ai.custom.apiKey',
  'ai.azure.apiKey',
  'security.apiKey',
  'security.jwtSecret',
] as const;

export const SECRET_MASK = '••••••••';

export function defaultConfig(): AppConfig {
  return configSchema.parse({});
}
