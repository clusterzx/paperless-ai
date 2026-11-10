/**
 * Mapping between the environment variables used by Paperless-AI ≤ 3.x
 * (stored in data/.env) and the new structured configuration.
 *
 * The same mapping serves two purposes:
 *  1. one-time migration of an existing data/.env into data/config.json
 *  2. environment variable overrides (e.g. set in docker-compose), which
 *     always win over values stored in config.json.
 */
import type { AppConfig, CustomFieldConfig, DeepPartial } from './schema.js';
import { CUSTOM_FIELD_TYPES } from './schema.js';
import { normalizePaperlessUrl } from './url.js';

type Env = Record<string, string | undefined>;

export function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (['yes', 'true', '1', 'on', 'y'].includes(v)) return true;
  if (['no', 'false', '0', 'off', 'n', ''].includes(v)) return false;
  return undefined;
}

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseIntSafe(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

export { normalizePaperlessUrl };

/** Legacy SYSTEM_PROMPT values were stored with literal "\n" sequences and backticks. */
export function decodeLegacyPrompt(value: string): string {
  let v = value;
  if (v.startsWith('`')) v = v.slice(1);
  if (v.endsWith('`')) v = v.slice(0, -1);
  return v.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
}

export function parseLegacyCustomFields(value: string | undefined): CustomFieldConfig[] | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as { custom_fields?: { value?: string; data_type?: string; currency?: string }[] };
    const list = Array.isArray(parsed) ? parsed : parsed.custom_fields;
    if (!Array.isArray(list)) return undefined;
    return list
      .filter((f) => typeof f?.value === 'string' && f.value.trim())
      .map((f) => ({
        name: f.value!.trim(),
        type: (CUSTOM_FIELD_TYPES as readonly string[]).includes(f.data_type ?? '')
          ? (f.data_type as CustomFieldConfig['type'])
          : 'string',
        currency: f.currency && /^[A-Za-z]{3}$/.test(f.currency) ? f.currency.toUpperCase() : undefined,
        description: '',
      }));
  } catch {
    return undefined;
  }
}

function set(target: Record<string, unknown>, path: string, value: unknown): void {
  if (value === undefined) return;
  const keys = path.split('.');
  let obj = target;
  for (const k of keys.slice(0, -1)) {
    if (typeof obj[k] !== 'object' || obj[k] === null) obj[k] = {};
    obj = obj[k] as Record<string, unknown>;
  }
  obj[keys[keys.length - 1]] = value;
}

interface Mapping {
  env: string;
  path: string;
  parse: (v: string) => unknown;
}

const s = (v: string) => v.trim();
/** OLLAMA_THINK: auto/off/on/low/medium/high, or a boolean. */
function parseThink(v: string): string | undefined {
  const value = v.trim().toLowerCase();
  if (['auto', 'off', 'on', 'low', 'medium', 'high'].includes(value)) return value;
  const flag = parseBool(value);
  return flag === undefined ? undefined : flag ? 'on' : 'off';
}
const b = (v: string) => parseBool(v);
const i = (v: string) => parseIntSafe(v);

export const ENV_MAPPINGS: Mapping[] = [
  // Both name the internal URL; PAPERLESS_API_URL (the 3.x name) wins when both are set.
  { env: 'PAPERLESS_URL', path: 'paperless.url', parse: (v) => normalizePaperlessUrl(v) },
  { env: 'PAPERLESS_API_URL', path: 'paperless.url', parse: (v) => normalizePaperlessUrl(v) },
  { env: 'PAPERLESS_API_TOKEN', path: 'paperless.token', parse: s },
  { env: 'PAPERLESS_USERNAME', path: 'paperless.username', parse: s },
  { env: 'PAPERLESS_PUBLIC_URL', path: 'paperless.publicUrl', parse: (v) => normalizePaperlessUrl(v) },

  { env: 'AI_PROVIDER', path: 'ai.provider', parse: (v) => v.trim().toLowerCase() },
  { env: 'OPENAI_API_KEY', path: 'ai.openai.apiKey', parse: s },
  { env: 'OPENAI_MODEL', path: 'ai.openai.model', parse: s },
  { env: 'ANTHROPIC_API_KEY', path: 'ai.anthropic.apiKey', parse: s },
  { env: 'ANTHROPIC_MODEL', path: 'ai.anthropic.model', parse: s },
  { env: 'ANTHROPIC_BASE_URL', path: 'ai.anthropic.baseUrl', parse: s },
  { env: 'OLLAMA_API_URL', path: 'ai.ollama.url', parse: s },
  { env: 'OLLAMA_MODEL', path: 'ai.ollama.model', parse: s },
  { env: 'OLLAMA_KEEP_ALIVE', path: 'ai.ollama.keepAlive', parse: s },
  { env: 'OLLAMA_CONTEXT_SIZE', path: 'ai.ollama.contextSize', parse: i },
  { env: 'OLLAMA_NUM_CTX', path: 'ai.ollama.contextSize', parse: i },
  { env: 'OLLAMA_THINK', path: 'ai.ollama.think', parse: (v) => parseThink(v) },
  { env: 'OLLAMA_UNLOAD_WHEN_IDLE', path: 'ai.ollama.unloadWhenIdle', parse: b },
  { env: 'CUSTOM_BASE_URL', path: 'ai.custom.baseUrl', parse: s },
  { env: 'CUSTOM_API_KEY', path: 'ai.custom.apiKey', parse: s },
  { env: 'CUSTOM_MODEL', path: 'ai.custom.model', parse: s },
  { env: 'CUSTOM_EXTRA_BODY', path: 'ai.custom.extraBody', parse: s },
  { env: 'AZURE_ENDPOINT', path: 'ai.azure.endpoint', parse: s },
  { env: 'AZURE_API_KEY', path: 'ai.azure.apiKey', parse: s },
  { env: 'AZURE_DEPLOYMENT_NAME', path: 'ai.azure.deployment', parse: s },
  { env: 'AZURE_API_VERSION', path: 'ai.azure.apiVersion', parse: s },
  { env: 'TOKEN_LIMIT', path: 'ai.tokenLimit', parse: i },
  { env: 'RESPONSE_TOKENS', path: 'ai.responseTokens', parse: i },
  { env: 'AI_TEMPERATURE', path: 'ai.temperature', parse: (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined) },
  { env: 'AI_TIMEOUT_SECONDS', path: 'ai.timeoutSeconds', parse: i },

  { env: 'SCAN_INTERVAL', path: 'processing.scanInterval', parse: s },
  { env: 'DISABLE_AUTOMATIC_PROCESSING', path: 'processing.automatic', parse: (v) => (parseBool(v) === undefined ? undefined : !parseBool(v)) },
  { env: 'PROCESS_PREDEFINED_DOCUMENTS', path: 'processing.onlyTagged', parse: b },
  { env: 'TAGS', path: 'processing.tags', parse: (v) => parseList(v) },
  { env: 'REMOVE_TRIGGER_TAGS', path: 'processing.removeTriggerTags', parse: b },
  { env: 'ADD_AI_PROCESSED_TAG', path: 'processing.addProcessedTag', parse: b },
  { env: 'AI_PROCESSED_TAG_NAME', path: 'processing.processedTagName', parse: s },
  { env: 'USE_PROMPT_TAGS', path: 'processing.usePromptTags', parse: b },
  { env: 'PROMPT_TAGS', path: 'processing.promptTags', parse: (v) => parseList(v) },
  { env: 'USE_EXISTING_DATA', path: 'processing.useExistingData', parse: b },
  { env: 'OVERWRITE_CORRESPONDENT', path: 'processing.overwriteCorrespondent', parse: b },
  { env: 'SHARE_CREATED_OBJECTS', path: 'processing.shareCreatedObjects', parse: b },
  { env: 'SYSTEM_PROMPT', path: 'processing.systemPrompt', parse: (v) => decodeLegacyPrompt(v) || undefined },
  { env: 'ACTIVATE_TAGGING', path: 'processing.functions.tags', parse: b },
  { env: 'ACTIVATE_CORRESPONDENTS', path: 'processing.functions.correspondent', parse: b },
  { env: 'ACTIVATE_DOCUMENT_TYPE', path: 'processing.functions.documentType', parse: b },
  { env: 'ACTIVATE_TITLE', path: 'processing.functions.title', parse: b },
  { env: 'ACTIVATE_CUSTOM_FIELDS', path: 'processing.functions.customFields', parse: b },
  { env: 'ACTIVATE_DOCUMENT_DATE', path: 'processing.functions.documentDate', parse: b },
  { env: 'RESTRICT_TO_EXISTING_TAGS', path: 'processing.restrict.tags', parse: b },
  { env: 'RESTRICT_TO_EXISTING_CORRESPONDENTS', path: 'processing.restrict.correspondents', parse: b },
  { env: 'RESTRICT_TO_EXISTING_DOCUMENT_TYPES', path: 'processing.restrict.documentTypes', parse: b },
  { env: 'CUSTOM_FIELDS', path: 'processing.customFields', parse: (v) => parseLegacyCustomFields(v) },
  { env: 'PROCESSING_CONCURRENCY', path: 'processing.concurrency', parse: i },

  { env: 'EXTERNAL_API_ENABLED', path: 'externalApi.enabled', parse: b },
  { env: 'EXTERNAL_API_URL', path: 'externalApi.url', parse: s },
  { env: 'EXTERNAL_API_METHOD', path: 'externalApi.method', parse: (v) => v.trim().toUpperCase() },
  { env: 'EXTERNAL_API_HEADERS', path: 'externalApi.headers', parse: (v) => v || undefined },
  { env: 'EXTERNAL_API_BODY', path: 'externalApi.body', parse: (v) => v || undefined },
  { env: 'EXTERNAL_API_TIMEOUT', path: 'externalApi.timeoutMs', parse: i },
  { env: 'EXTERNAL_API_TRANSFORM', path: 'externalApi.transform', parse: (v) => v },

  { env: 'RAG_SERVICE_ENABLED', path: 'rag.enabled', parse: b },
  { env: 'RAG_ENABLED', path: 'rag.enabled', parse: b },
  { env: 'RAG_EMBEDDING_PROVIDER', path: 'rag.embeddingProvider', parse: (v) => v.trim().toLowerCase() },
  { env: 'RAG_EMBEDDING_MODEL', path: 'rag.embeddingModel', parse: s },
  { env: 'RAG_QUERY_EXPANSION', path: 'rag.queryExpansion', parse: b },

  { env: 'API_KEY', path: 'security.apiKey', parse: s },
  { env: 'JWT_SECRET', path: 'security.jwtSecret', parse: s },
];

export interface EnvMappingResult {
  values: DeepPartial<AppConfig>;
  /** config paths that were set, with the env var that set them */
  paths: Map<string, string>;
  /** Known variables that are present but empty – ignored (e.g. `OPENAI_API_KEY=` in a compose file). */
  empty: string[];
}

/** Convert an environment map into a partial configuration. */
export function configFromEnv(env: Env): EnvMappingResult {
  const values: Record<string, unknown> = {};
  const paths = new Map<string, string>();
  const empty: string[] = [];
  for (const m of ENV_MAPPINGS) {
    const raw = env[m.env];
    if (raw === undefined) continue;
    // An empty variable must not replace (and lock) the value configured in the web interface.
    if (!raw.trim()) {
      empty.push(m.env);
      continue;
    }
    const parsed = m.parse(raw);
    if (parsed === undefined) continue;
    set(values, m.path, parsed);
    paths.set(m.path, m.env);
  }
  return { values: values as DeepPartial<AppConfig>, paths, empty };
}
