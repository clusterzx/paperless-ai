/**
 * Builds a complete Paperless-AI instance (AppContext, ProcessingEngine,
 * RagService, Fastify app) wired to the mock Paperless and mock LLM servers.
 * HTTP tests use Fastify's `inject` – no real port is opened for the app.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { AppContext } from '../../src/server/context.js';
import { ProcessingEngine } from '../../src/server/processing/engine.js';
import { RagService } from '../../src/server/rag/service.js';
import { buildApp } from '../../src/server/http/app.js';
import { hashPassword, SESSION_COOKIE } from '../../src/server/auth.js';
import type { AppConfig, DeepPartial } from '../../src/server/config/schema.js';
import { deepMerge } from '../../src/server/config/store.js';
import { MockPaperless, type MockPaperlessOptions } from './mockPaperless.js';
import { MockLlm, type MockLlmOptions } from './mockLlm.js';

export interface HarnessOptions {
  paperless?: MockPaperlessOptions;
  llm?: MockLlmOptions;
  /** AI provider used for chat/analysis (default: custom OpenAI-compatible endpoint of the mock). */
  aiProvider?: 'custom' | 'ollama';
  /** Embedding provider for RAG (default: none = keyword search only). */
  embedding?: 'custom' | 'ollama' | 'none';
  /** Additional configuration merged over the defaults. */
  config?: DeepPartial<AppConfig>;
  /**
   * When false, the app starts unconfigured (no user, setup not completed,
   * no Paperless/AI configuration) – for setup wizard tests.
   */
  configured?: boolean;
  memoryDb?: boolean;
  env?: Record<string, string | undefined>;
}

export interface Harness {
  ctx: AppContext;
  engine: ProcessingEngine;
  rag: RagService;
  app: FastifyInstance;
  paperless: MockPaperless;
  llm: MockLlm;
  dataDir: string;
  inject(opts: InjectOptions): Promise<LightMyRequestResponse>;
  /** Create a user (if needed), log in through the API and return the Cookie header value. */
  login(username?: string, password?: string): Promise<string>;
  /** Headers authenticating with the API key. */
  apiKeyHeaders(): Record<string, string>;
  close(): Promise<void>;
}

export const TEST_USER = 'admin';
export const TEST_PASSWORD = 'correct horse battery';

export function makeTempDir(prefix = 'paperless-ai-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function baseConfig(paperless: MockPaperless, llm: MockLlm, opts: HarnessOptions): DeepPartial<AppConfig> {
  const embedding = opts.embedding ?? 'none';
  return {
    setupCompleted: true,
    paperless: { url: paperless.url, token: paperless.token },
    ai: {
      provider: opts.aiProvider ?? 'custom',
      custom: { baseUrl: llm.openaiUrl, model: 'test-model', apiKey: 'sk-test-secret' },
      ollama: { url: llm.url, model: 'llama3.2' },
      timeoutSeconds: 30,
    },
    // No cron jobs / background syncs in tests – everything is triggered explicitly.
    processing: { automatic: false },
    rag: {
      enabled: true,
      autoSync: false,
      embeddingProvider: embedding,
      embeddingModel: embedding === 'none' ? '' : 'mock-embed',
    },
  };
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const paperless = await new MockPaperless(opts.paperless).start();
  const llm = await new MockLlm(opts.llm).start();
  const dataDir = makeTempDir();
  const ctx = new AppContext({ dataDir, env: opts.env ?? {}, memoryDb: opts.memoryDb ?? true });

  const configured = opts.configured ?? true;
  const base: DeepPartial<AppConfig> = configured
    ? baseConfig(paperless, llm, opts)
    : { processing: { automatic: false }, rag: { autoSync: false, embeddingProvider: 'none' } };
  ctx.config.update(deepMerge(base, opts.config ?? {}));

  const engine = new ProcessingEngine(ctx);
  const rag = new RagService(ctx);
  const app = await buildApp({ ctx, engine, rag });
  await app.ready();

  let cookie: string | null = null;

  const harness: Harness = {
    ctx,
    engine,
    rag,
    app,
    paperless,
    llm,
    dataDir,
    inject: (o) => app.inject(o),
    async login(username = TEST_USER, password = TEST_PASSWORD) {
      if (cookie && username === TEST_USER && password === TEST_PASSWORD) return cookie;
      if (!ctx.repos.users.byUsername(username)) ctx.repos.users.create(username, await hashPassword(password));
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
      if (res.statusCode !== 200) throw new Error(`Login failed: ${res.statusCode} ${res.body}`);
      const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
      if (!c) throw new Error('Login did not set a session cookie');
      const value = `${SESSION_COOKIE}=${c.value}`;
      if (username === TEST_USER && password === TEST_PASSWORD) cookie = value;
      return value;
    },
    apiKeyHeaders: () => ({ 'x-api-key': ctx.cfg.security.apiKey }),
    async close() {
      await app.close();
      await engine.stop();
      await rag.stop();
      ctx.close();
      await paperless.close();
      await llm.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return harness;
}

/** Parse a text/event-stream payload into the JSON data of its events (`[DONE]` is kept as a string). */
export function parseSsePayload(payload: string): unknown[] {
  const out: unknown[] = [];
  for (const block of payload.split(/\n\n/)) {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    out.push(data === '[DONE]' ? data : JSON.parse(data));
  }
  return out;
}

/** Poll until `check` returns true (tiny intervals, bounded). */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** A realistic analysis answer of the model. */
export function analysisJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: 'Mock title',
    correspondent: '',
    tags: [],
    document_type: '',
    document_date: '',
    language: 'en',
    ...overrides,
  });
}
