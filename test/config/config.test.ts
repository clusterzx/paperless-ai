import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore, deepMerge, lenientParse } from '../../src/server/config/store.js';
import {
  configFromEnv,
  decodeLegacyPrompt,
  normalizePaperlessUrl,
  parseBool,
  parseLegacyCustomFields,
} from '../../src/server/config/legacy.js';
import { DEFAULT_SYSTEM_PROMPT } from '../../src/server/config/defaults.js';
import { configSchema, defaultConfig, SECRET_MASK } from '../../src/server/config/schema.js';
import { makeTempDir } from '../helpers/appHarness.js';

const dirs: string[] = [];
function tempDir(): string {
  const d = makeTempDir('paperless-ai-config-');
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('lenientParse', () => {
  it('drops invalid values and keeps the valid ones', () => {
    const { config, dropped } = lenientParse({
      paperless: { url: 'http://paperless:8000', token: 42 },
      ai: { provider: 'gemini', tokenLimit: 'abc', temperature: 5, openai: { model: 'gpt-4.1' } },
      processing: { scanInterval: 123, concurrency: 99, tags: ['ok', '', 'ok'], functions: { title: 'yes', tags: false } },
      rag: { embeddingProvider: 'bogus', topK: 5 },
      unknownKey: true,
    });
    expect(dropped.sort()).toEqual(
      [
        'ai.provider',
        'ai.temperature',
        'ai.tokenLimit',
        'paperless.token',
        'processing.concurrency',
        'processing.functions.title',
        'processing.scanInterval',
        'processing.tags.1',
        'rag.embeddingProvider',
      ].sort(),
    );
    expect(config.paperless.url).toBe('http://paperless:8000');
    expect(config.paperless.token).toBe('');
    expect(config.ai.provider).toBe('openai');
    expect(config.ai.openai.model).toBe('gpt-4.1');
    expect(config.ai.tokenLimit).toBe(128_000);
    expect(config.ai.temperature).toBe(0.2);
    expect(config.processing.concurrency).toBe(1);
    expect(config.processing.tags).toEqual(['ok']);
    expect(config.processing.functions).toMatchObject({ title: true, tags: false });
    expect(config.rag).toMatchObject({ embeddingProvider: 'local', topK: 5 });
    expect((config as unknown as Record<string, unknown>).unknownKey).toBeUndefined();
  });

  it('returns defaults for non-objects', () => {
    expect(lenientParse(null).config).toEqual(defaultConfig());
    expect(lenientParse('garbage').config).toEqual(defaultConfig());
    expect(lenientParse([1, 2]).config).toEqual(defaultConfig());
  });
});

describe('legacy helpers', () => {
  it('parseBool', () => {
    expect(parseBool('yes')).toBe(true);
    expect(parseBool(' TRUE ')).toBe(true);
    expect(parseBool('1')).toBe(true);
    expect(parseBool('no')).toBe(false);
    expect(parseBool('')).toBe(false);
    expect(parseBool('maybe')).toBeUndefined();
    expect(parseBool(undefined)).toBeUndefined();
  });

  it('normalizePaperlessUrl', () => {
    expect(normalizePaperlessUrl('http://paperless:8000/api')).toBe('http://paperless:8000');
    expect(normalizePaperlessUrl('http://paperless:8000/api/')).toBe('http://paperless:8000');
    expect(normalizePaperlessUrl('https://docs.example.com/paperless/API//')).toBe('https://docs.example.com/paperless');
    expect(normalizePaperlessUrl(' http://x:1/ ')).toBe('http://x:1');
    expect(normalizePaperlessUrl('http://x/apiary')).toBe('http://x/apiary');
  });

  it('decodeLegacyPrompt', () => {
    expect(decodeLegacyPrompt('`Line 1\\nLine 2\\r\\nLine 3`')).toBe('Line 1\nLine 2\nLine 3');
    expect(decodeLegacyPrompt('plain')).toBe('plain');
  });

  it('parseLegacyCustomFields', () => {
    expect(
      parseLegacyCustomFields('{"custom_fields":[{"value":"Amount","data_type":"monetary","currency":"eur"},{"value":" Note ","data_type":"weird"},{"value":""}]}'),
    ).toEqual([
      { name: 'Amount', type: 'monetary', currency: 'EUR', description: '' },
      { name: 'Note', type: 'string', currency: undefined, description: '' },
    ]);
    expect(parseLegacyCustomFields('[{"value":"A","data_type":"date"}]')).toEqual([{ name: 'A', type: 'date', currency: undefined, description: '' }]);
    expect(parseLegacyCustomFields('{not json')).toBeUndefined();
    expect(parseLegacyCustomFields('')).toBeUndefined();
    expect(parseLegacyCustomFields('{"other":1}')).toBeUndefined();
  });

  it('configFromEnv maps variables and records the paths', () => {
    const { values, paths } = configFromEnv({
      PAPERLESS_API_URL: 'http://p:8000/api',
      DISABLE_AUTOMATIC_PROCESSING: 'yes',
      TOKEN_LIMIT: 'abc',
      TAGS: ' a, b ,,c ',
      UNRELATED: 'x',
    });
    expect(values).toEqual({ paperless: { url: 'http://p:8000' }, processing: { automatic: false, tags: ['a', 'b', 'c'] } });
    expect(Object.fromEntries(paths)).toEqual({
      'paperless.url': 'PAPERLESS_API_URL',
      'processing.automatic': 'DISABLE_AUTOMATIC_PROCESSING',
      'processing.tags': 'TAGS',
    });
  });
});

const LEGACY_ENV = [
  'PAPERLESS_API_URL=http://paperless:8000/api',
  'PAPERLESS_API_TOKEN=0123456789abcdef',
  'PAPERLESS_USERNAME=admin',
  'AI_PROVIDER=ollama',
  'OPENAI_API_KEY=',
  'OPENAI_MODEL=gpt-4o-mini',
  'OLLAMA_API_URL=http://ollama:11434',
  'OLLAMA_MODEL=qwen2.5:7b',
  'SCAN_INTERVAL=*/15 * * * *',
  'SYSTEM_PROMPT=`You are a document analyzer.\\nExtract the "title" and \'tags\'.',
  'Second real line.\\n\\nUse only: %RESTRICTED_TAGS%`',
  'PROCESS_PREDEFINED_DOCUMENTS=yes',
  'TAGS=pre-process,ai-todo',
  'REMOVE_TRIGGER_TAGS=yes',
  'ADD_AI_PROCESSED_TAG=yes',
  'AI_PROCESSED_TAG_NAME=ai-done',
  'USE_PROMPT_TAGS=no',
  'PROMPT_TAGS=',
  'USE_EXISTING_DATA=no',
  'API_KEY=legacy-api-key',
  'JWT_SECRET=legacy-jwt-secret',
  'CUSTOM_FIELDS={"custom_fields":[{"value":"Amount","data_type":"monetary","currency":"EUR"},{"value":"Invoice number","data_type":"string"}]}',
  'ACTIVATE_TAGGING=yes',
  'ACTIVATE_CORRESPONDENTS=yes',
  'ACTIVATE_DOCUMENT_TYPE=no',
  'ACTIVATE_TITLE=yes',
  'ACTIVATE_CUSTOM_FIELDS=yes',
  'RESTRICT_TO_EXISTING_TAGS=no',
  'RESTRICT_TO_EXISTING_CORRESPONDENTS=yes',
  'DISABLE_AUTOMATIC_PROCESSING=no',
  'TOKEN_LIMIT=32000',
  'RESPONSE_TOKENS=1500',
  'RAG_SERVICE_ENABLED=false',
  '',
].join('\n');

describe('ConfigStore', () => {
  it('starts with defaults and writes config.json', () => {
    const dir = tempDir();
    const store = ConfigStore.load(dir, {});
    expect(store.current).toEqual(defaultConfig());
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true);
    expect(store.lockedPaths).toEqual({});
  });

  it('migrates a legacy data/.env', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, '.env'), LEGACY_ENV);
    const store = ConfigStore.load(dir, {});
    const c = store.current;
    expect(c.setupCompleted).toBe(true);
    expect(c.paperless).toEqual({ url: 'http://paperless:8000', token: '0123456789abcdef', username: 'admin', publicUrl: '' });
    expect(c.ai.provider).toBe('ollama');
    expect(c.ai.ollama).toMatchObject({ url: 'http://ollama:11434', model: 'qwen2.5:7b' });
    expect(c.ai.tokenLimit).toBe(32_000);
    expect(c.ai.responseTokens).toBe(1500);
    expect(c.processing.systemPrompt).toBe(
      'You are a document analyzer.\nExtract the "title" and \'tags\'.\nSecond real line.\n\nUse only: %RESTRICTED_TAGS%',
    );
    expect(c.processing).toMatchObject({
      automatic: true,
      scanInterval: '*/15 * * * *',
      onlyTagged: true,
      tags: ['pre-process', 'ai-todo'],
      removeTriggerTags: true,
      addProcessedTag: true,
      processedTagName: 'ai-done',
      usePromptTags: false,
      promptTags: [],
      functions: { tags: true, correspondent: true, documentType: false, title: true, customFields: true, documentDate: true },
      restrict: { tags: false, correspondents: true, documentTypes: false },
    });
    expect(c.processing.customFields).toEqual([
      { name: 'Amount', type: 'monetary', currency: 'EUR', description: '' },
      { name: 'Invoice number', type: 'string', description: '' },
    ]);
    expect(c.rag.enabled).toBe(false);
    expect(c.security).toMatchObject({ apiKey: 'legacy-api-key', jwtSecret: 'legacy-jwt-secret' });

    // persisted, and the .env file is left alone
    const saved = readJson(path.join(dir, 'config.json'));
    expect(saved.paperless.url).toBe('http://paperless:8000');
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe(LEGACY_ENV);

    // a second start reads config.json instead of migrating again
    fs.writeFileSync(path.join(dir, '.env'), 'PAPERLESS_API_URL=http://changed:1/api\n');
    expect(ConfigStore.load(dir, {}).current.paperless.url).toBe('http://paperless:8000');
  });

  it('does not mark setup as completed when the legacy .env lacks Paperless credentials', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, '.env'), 'AI_PROVIDER=openai\nOPENAI_API_KEY=sk-1\n');
    const store = ConfigStore.load(dir, {});
    expect(store.current.setupCompleted).toBe(false);
    expect(store.current.ai.openai.apiKey).toBe('sk-1');
  });

  it('applies environment overrides without persisting them and reports locked paths', () => {
    const dir = tempDir();
    ConfigStore.load(dir, {}).update({ paperless: { url: 'http://stored:8000', token: 'stored-token' }, processing: { scanInterval: '0 * * * *' } });
    const store = ConfigStore.load(dir, {
      PAPERLESS_API_URL: 'http://env:8000/api/',
      ACTIVATE_TITLE: 'no',
      TOKEN_LIMIT: 'not a number',
    });
    expect(store.current.paperless.url).toBe('http://env:8000');
    expect(store.current.paperless.token).toBe('stored-token');
    expect(store.current.processing.functions.title).toBe(false);
    expect(store.current.ai.tokenLimit).toBe(128_000);
    expect(store.lockedPaths).toEqual({ 'paperless.url': 'PAPERLESS_API_URL', 'processing.functions.title': 'ACTIVATE_TITLE' });

    // updates are stored; the override keeps winning
    store.update({ paperless: { url: 'http://ui:8000' }, processing: { scanInterval: '*/5 * * * *' } });
    expect(store.current.paperless.url).toBe('http://env:8000');
    expect(store.current.processing.scanInterval).toBe('*/5 * * * *');
    const saved = readJson(path.join(dir, 'config.json'));
    expect(saved.paperless.url).toBe('http://ui:8000');
    expect(saved.processing.functions.title).toBe(true);
  });

  it('ignores invalid environment overrides and keeps the stored value', () => {
    const dir = tempDir();
    ConfigStore.load(dir, {}).update({ ai: { provider: 'ollama' }, processing: { concurrency: 3 } });
    const store = ConfigStore.load(dir, { AI_PROVIDER: 'gemini', PROCESSING_CONCURRENCY: '50', OLLAMA_MODEL: 'mistral' });
    expect(store.current.ai.provider).toBe('ollama');
    expect(store.current.processing.concurrency).toBe(3);
    expect(store.current.ai.ollama.model).toBe('mistral');
    // Invalid overrides are ignored, so the UI must not show these settings as locked.
    expect(store.lockedPaths).toEqual({ 'ai.ollama.model': 'OLLAMA_MODEL' });
  });

  it('keeps secrets when the masked placeholder is sent back', () => {
    const dir = tempDir();
    const store = ConfigStore.load(dir, {});
    store.ensureSecrets();
    store.update({ paperless: { url: 'http://p', token: 'real-token' }, ai: { openai: { apiKey: 'sk-real' } } });
    const { apiKey, jwtSecret } = store.current.security;
    expect(apiKey).toMatch(/^[0-9a-f]{64}$/);
    expect(jwtSecret).toMatch(/^[0-9a-f]{96}$/);

    const red = store.redacted();
    expect(red.paperless.token).toBe(SECRET_MASK);
    expect(red.ai.openai.apiKey).toBe(SECRET_MASK);
    expect(red.security.apiKey).toBe(SECRET_MASK);
    expect(red.security.jwtSecret).toBe(SECRET_MASK);
    // empty secrets are not masked (so the UI can show that nothing is set)
    expect(red.ai.custom.apiKey).toBe('');
    // the live config is not modified by redaction
    expect(store.current.paperless.token).toBe('real-token');

    // round trip of the redacted config does not change any secret
    store.update({ ...red, processing: { ...red.processing, concurrency: 2 } });
    expect(store.current.paperless.token).toBe('real-token');
    expect(store.current.ai.openai.apiKey).toBe('sk-real');
    expect(store.current.security).toMatchObject({ apiKey, jwtSecret });
    expect(store.current.processing.concurrency).toBe(2);

    // a real new value replaces the secret
    store.update({ paperless: { token: 'new-token' } });
    expect(store.current.paperless.token).toBe('new-token');

    // ensureSecrets does not regenerate existing secrets
    store.ensureSecrets();
    expect(store.current.security.apiKey).toBe(apiKey);
  });

  it('rejects invalid updates without changing the stored config', () => {
    const dir = tempDir();
    const store = ConfigStore.load(dir, {});
    expect(() => store.update({ processing: { concurrency: 100 } })).toThrow();
    expect(store.current.processing.concurrency).toBe(1);
    expect(readJson(path.join(dir, 'config.json')).processing.concurrency).toBe(1);
  });

  it('emits change events with the previous config', () => {
    const store = ConfigStore.load(tempDir(), {});
    const seen: [number, number][] = [];
    store.on('change', (next, prev) => seen.push([next.rag.topK, prev.rag.topK]));
    store.update({ rag: { topK: 12 } });
    expect(seen).toEqual([[12, 10]]);
  });

  it('restores from config.json.bak when config.json is corrupt', () => {
    const dir = tempDir();
    const store = ConfigStore.load(dir, {});
    store.update({ ai: { openai: { model: 'gpt-backup' } } });
    store.update({ ai: { openai: { model: 'gpt-latest' } } });
    fs.writeFileSync(path.join(dir, 'config.json'), '{ broken json');
    const restored = ConfigStore.load(dir, {});
    expect(restored.current.ai.openai.model).toBe('gpt-backup');
  });

  it('drops invalid stored values instead of failing', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ setupCompleted: true, ai: { provider: 'nope', tokenLimit: 5 }, processing: { systemPrompt: 'Mine' } }));
    const store = ConfigStore.load(dir, {});
    expect(store.current.setupCompleted).toBe(true);
    expect(store.current.ai.provider).toBe('openai');
    expect(store.current.ai.tokenLimit).toBe(128_000);
    expect(store.current.processing.systemPrompt).toBe('Mine');
  });

  it('defaults include the default system prompt', () => {
    expect(configSchema.parse({}).processing.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2], d: undefined } })).toEqual({ a: { b: 1, c: [2] } });
  });
});
