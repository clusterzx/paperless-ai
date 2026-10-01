import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { configFromEnv, type EnvMappingResult } from './legacy.js';
import { type AppConfig, configSchema, type DeepPartial, SECRET_MASK, SECRET_PATHS } from './schema.js';
import { logger } from '../logger.js';

type Env = Record<string, string | undefined>;
const log = logger.child({ module: 'config' });

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge; arrays and primitives in `patch` replace values in `base`. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function getPath(obj: unknown, p: string): unknown {
  return p.split('.').reduce<unknown>((o, k) => (isPlainObject(o) ? o[k] : undefined), obj);
}

function deletePath(obj: unknown, p: (string | number | symbol)[]): void {
  let cur: unknown = obj;
  for (const k of p.slice(0, -1)) {
    if (cur === null || typeof cur !== 'object') return;
    cur = (cur as Record<string | number, unknown>)[k as string];
  }
  if (cur && typeof cur === 'object') {
    const last = p[p.length - 1] as string;
    if (Array.isArray(cur)) cur.splice(Number(last), 1);
    else delete (cur as Record<string, unknown>)[last];
  }
}

/**
 * Parse a configuration, dropping invalid values (they fall back to defaults)
 * instead of rejecting the whole file.
 */
export function lenientParse(raw: unknown): { config: AppConfig; dropped: string[] } {
  const data = structuredClone(isPlainObject(raw) ? raw : {});
  const dropped: string[] = [];
  for (let i = 0; i < 20; i++) {
    const res = configSchema.safeParse(data);
    if (res.success) return { config: res.data, dropped };
    for (const issue of res.error.issues) {
      if (!issue.path.length) return { config: configSchema.parse({}), dropped: ['*'] };
      dropped.push(issue.path.join('.'));
      deletePath(data, issue.path as (string | number)[]);
    }
  }
  return { config: configSchema.parse({}), dropped: ['*'] };
}

export class ConfigStore extends EventEmitter<{ change: [next: AppConfig, prev: AppConfig] }> {
  private stored: AppConfig;
  private effective: AppConfig;
  private readonly overrides: EnvMappingResult;
  /** Environment overrides that failed validation (ignored, not shown as locked). */
  private invalidOverrides = new Set<string>();

  private constructor(
    private readonly file: string,
    stored: AppConfig,
    env: Env,
  ) {
    super();
    this.stored = stored;
    this.overrides = configFromEnv(env);
    this.effective = this.compute();
  }

  /**
   * Load config.json from `dataDir`, migrating a legacy data/.env on first start.
   */
  static load(dataDir: string, env: Env = process.env): ConfigStore {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, 'config.json');
    let stored: AppConfig | undefined;

    for (const candidate of [file, `${file}.bak`]) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(candidate, 'utf8')) as unknown;
        const { config, dropped } = lenientParse(raw);
        if (dropped.length) log.warn({ dropped }, 'Ignored invalid configuration values (defaults used instead)');
        stored = config;
        if (candidate !== file) log.warn('config.json was unreadable – restored from config.json.bak');
        break;
      } catch (err) {
        log.error({ err }, `Could not read ${candidate}`);
      }
    }

    let migrated = false;
    if (!stored) {
      stored = configSchema.parse({});
      const legacyEnv = path.join(dataDir, '.env');
      if (fs.existsSync(legacyEnv)) {
        try {
          const parsed = dotenv.parse(fs.readFileSync(legacyEnv, 'utf8'));
          const { values } = configFromEnv(parsed);
          const { config, dropped } = lenientParse(deepMerge(stored, values));
          stored = config;
          stored.setupCompleted = Boolean(stored.paperless.url && stored.paperless.token);
          migrated = true;
          log.info({ dropped }, 'Migrated legacy data/.env configuration to data/config.json');
        } catch (err) {
          log.error({ err }, 'Failed to migrate legacy data/.env');
        }
      }
    }

    const store = new ConfigStore(file, stored, env);
    if (migrated || !fs.existsSync(file)) store.persist();
    return store;
  }

  /** Effective configuration (stored values overlaid with environment overrides). */
  get current(): AppConfig {
    return this.effective;
  }

  /** Config paths controlled by environment variables (cannot be changed in the UI). */
  get lockedPaths(): Record<string, string> {
    return Object.fromEntries([...this.overrides.paths].filter(([path]) => !this.invalidOverrides.has(path)));
  }

  private compute(): AppConfig {
    const merged = deepMerge(this.stored, this.overrides.values);
    const { config, dropped } = lenientParse(merged);
    this.invalidOverrides = new Set(dropped.filter((p) => this.overrides.paths.has(p)));
    if (!dropped.length) return config;
    log.warn({ dropped }, 'Ignored invalid environment overrides');
    // Remove the invalid overrides so the stored values (not the defaults) are used for them.
    const valid = structuredClone(this.overrides.values) as Record<string, unknown>;
    for (const p of dropped) deletePath(valid, p.split('.'));
    return lenientParse(deepMerge(this.stored, valid)).config;
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    const json = JSON.stringify(this.stored, null, 2);
    fs.writeFileSync(tmp, json, { mode: 0o600 });
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    fs.renameSync(tmp, this.file);
  }

  /**
   * Apply a partial update. Masked secrets (SECRET_MASK) are ignored so the UI
   * can round-trip settings without ever receiving the real secret.
   * @throws ZodError when the resulting config is invalid.
   */
  update(patch: DeepPartial<AppConfig>): AppConfig {
    const cleaned = structuredClone(patch) as Record<string, unknown>;
    for (const p of SECRET_PATHS) {
      if (getPath(cleaned, p) === SECRET_MASK) deletePath(cleaned, p.split('.'));
    }
    const next = configSchema.parse(deepMerge(this.stored, cleaned));
    const prev = this.effective;
    this.stored = next;
    this.persist();
    this.effective = this.compute();
    this.emit('change', this.effective, prev);
    return this.effective;
  }

  /** Generate API key / JWT secret on first start. */
  ensureSecrets(): void {
    const patch: DeepPartial<AppConfig> = { security: {} };
    if (!this.stored.security.jwtSecret) patch.security!.jwtSecret = randomBytes(48).toString('hex');
    if (!this.stored.security.apiKey) patch.security!.apiKey = randomBytes(32).toString('hex');
    if (patch.security!.jwtSecret || patch.security!.apiKey) this.update(patch);
  }

  /** Configuration safe to send to the browser: secrets replaced by a mask. */
  redacted(): AppConfig {
    const copy = structuredClone(this.effective) as unknown as Record<string, unknown>;
    for (const p of SECRET_PATHS) {
      const keys = p.split('.');
      const parent = getPath(copy, keys.slice(0, -1).join('.')) as Record<string, unknown> | undefined;
      if (parent && parent[keys[keys.length - 1]]) parent[keys[keys.length - 1]] = SECRET_MASK;
    }
    return copy as unknown as AppConfig;
  }
}
