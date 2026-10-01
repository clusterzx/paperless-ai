import type { ConnectionTestResult } from '../../shared/api.js';
import type { AppContext } from '../context.js';
import { configSchema, SECRET_MASK, type AppConfig, type DeepPartial } from '../config/schema.js';
import { deepMerge, getPath, isPlainObject } from '../config/store.js';
import { normalizePaperlessUrl } from '../config/legacy.js';
import { createLlmClient } from '../ai/factory.js';
import { PaperlessClient } from '../paperless/client.js';
import { describeError } from '../util/http.js';

/** Remove masked secret placeholders so the stored values are used instead. */
export function withoutMaskedSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutMaskedSecrets) as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === SECRET_MASK) continue;
    out[k] = withoutMaskedSecrets(v);
  }
  return out as T;
}

const origin = (url: string) => {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return url.trim().replace(/\/+$/, '').toLowerCase();
  }
};

/** Whether a stored secret may be sent to `url` (it belongs to that server, or no server is stored yet). */
const sameServer = (url: string, storedUrl: string) => !storedUrl.trim() || origin(url) === origin(storedUrl);

/**
 * The token for a connection test: the entered one, or the stored one. Without a logged-in user
 * (first setup, e.g. with the token preset by an environment variable) stored secrets are only
 * reused for the server they belong to – otherwise anybody reaching the setup wizard could send
 * them to a server of their choice.
 */
export function storedPaperlessToken(ctx: AppContext, url: string, token: string | undefined, trusted: boolean): string {
  if (token && token !== SECRET_MASK) return token;
  const stored = ctx.cfg.paperless;
  return stored.token && (trusted || sameServer(normalizePaperlessUrl(url), stored.url)) ? stored.token : '';
}

export async function testPaperlessConnection(rawUrl: string, token: string): Promise<ConnectionTestResult> {
  const url = normalizePaperlessUrl(rawUrl ?? '');
  if (!/^https?:\/\/[^/]+/i.test(url)) return { ok: false, message: 'Please enter a valid URL, e.g. http://paperless:8000' };
  if (!token || token === SECRET_MASK) return { ok: false, message: 'Please enter the API token of a Paperless-ngx user' };
  const client = new PaperlessClient({ url, token, timeoutMs: 15_000 });
  try {
    const info = await client.connect();
    const checks: [string, string][] = [
      ['documents', '/documents/'],
      ['tags', '/tags/'],
      ['correspondents', '/correspondents/'],
      ['document types', '/document_types/'],
      ['custom fields', '/custom_fields/'],
    ];
    const missing: string[] = [];
    let documents = 0;
    for (const [name, path] of checks) {
      try {
        const count = await client.count(path);
        if (name === 'documents') documents = count;
      } catch {
        missing.push(name);
      }
    }
    if (missing.includes('documents') || missing.includes('tags')) {
      return { ok: false, message: `Connected, but the user "${info.user.username}" cannot read: ${missing.join(', ')}. Grant the view/change permissions in Paperless.` };
    }
    const version = info.serverVersion ? `Paperless-ngx ${info.serverVersion}` : 'Paperless-ngx';
    return {
      ok: true,
      message: `Connected to ${version} (API v${info.apiVersion}) as "${info.user.username}" – ${documents} documents${missing.length ? `. Missing permissions: ${missing.join(', ')}` : ''}`,
      details: { user: info.user, apiVersion: info.apiVersion, serverVersion: info.serverVersion, documents, missingPermissions: missing, aiEnabled: info.aiEnabled },
    };
  } catch (err) {
    return { ok: false, message: describeError(err) };
  }
}

export async function testAiConnection(
  ctx: AppContext,
  ai: DeepPartial<AppConfig['ai']> | AppConfig['ai'],
  /** trusted: a logged-in user runs the test (see storedPaperlessToken). */
  opts: { modelsOnly?: boolean; trusted?: boolean } = {},
): Promise<ConnectionTestResult> {
  let merged: AppConfig['ai'];
  try {
    merged = configSchema.shape.ai.parse(deepMerge(structuredClone(ctx.cfg.ai), withoutMaskedSecrets(ai)));
  } catch (err) {
    return { ok: false, message: `Invalid AI settings: ${describeError(err)}` };
  }
  if (opts.trusted === false) {
    // Stored keys stay bound to their endpoint (see storedPaperlessToken).
    const stored = ctx.cfg.ai;
    const own = withoutMaskedSecrets(ai) as DeepPartial<AppConfig['ai']>;
    if (!own.custom?.apiKey && !sameServer(merged.custom.baseUrl, stored.custom.baseUrl)) merged.custom.apiKey = '';
    if (!own.azure?.apiKey && !sameServer(merged.azure.endpoint, stored.azure.endpoint)) merged.azure.apiKey = '';
  }
  try {
    const client = createLlmClient(merged);
    let models: string[] = [];
    try {
      models = await client.listModels(AbortSignal.timeout(20_000));
    } catch (err) {
      if (opts.modelsOnly) return { ok: false, message: describeError(err), details: { models: [] } };
    }
    if (opts.modelsOnly) return { ok: true, message: `${models.length} models available`, details: { models } };
    await client.ping(AbortSignal.timeout(60_000));
    if (merged.provider !== 'ollama') {
      // A tiny completion verifies key, model name and quota (costs a handful of tokens).
      await client.complete([{ role: 'user', content: 'Reply with "OK".' }], { maxTokens: 16, timeoutMs: 60_000 });
    }
    return {
      ok: true,
      message: `Connected to ${merged.provider} – model "${client.model}" is available`,
      details: { provider: merged.provider, model: client.model, models },
    };
  } catch (err) {
    return { ok: false, message: describeError(err), details: { provider: getPath(merged, 'provider') } };
  }
}
