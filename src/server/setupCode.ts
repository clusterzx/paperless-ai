/**
 * Setup code: protects the first-run setup of an instance that already holds credentials of other
 * services before its first account exists – a Paperless-ngx token, an AI key … set with environment
 * variables or a data/.env of 3.x. Whoever reached the setup first could otherwise create the
 * administrator and use them (read every Paperless document, spend the AI key). The setup then asks
 * for a code that only the one who runs the server can see: it is written to the log at the start and
 * kept in data/setup-code. An installation without such credentials has nothing to take and needs no
 * code.
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from './context.js';
import { getPath } from './config/store.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'setup' });

/** Credentials of other services (not the secrets Paperless-AI makes for itself, like the JWT secret). */
const CREDENTIAL_PATHS = [
  'paperless.token',
  'ai.openai.apiKey',
  'ai.anthropic.apiKey',
  'ai.custom.apiKey',
  'ai.azure.apiKey',
  'auth.oidc.clientSecret',
  'notifications.smtp.password',
] as const;

/** No 0/O, 1/I/L: the code is read from a log and typed in. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const fileOf = (ctx: AppContext) => path.join(ctx.dataDir, 'setup-code');
const normalize = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The setup is open (no account yet) and the configuration holds credentials worth protecting. */
export function setupCodeRequired(ctx: AppContext): boolean {
  if (ctx.repos.users.count() > 0) return false;
  return CREDENTIAL_PATHS.some((p) => {
    const v = getPath(ctx.cfg, p);
    return typeof v === 'string' && v.trim() !== '';
  });
}

/** The code (made once, kept in data/setup-code until the first account exists). */
export function setupCode(ctx: AppContext): string {
  const file = fileOf(ctx);
  try {
    const stored = normalize(fs.readFileSync(file, 'utf8'));
    if (stored.length >= 12) return stored;
  } catch {
    // none yet
  }
  let code = '';
  for (let i = 0; i < 12; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${code}\n`, { mode: 0o600 });
  return code;
}

const formatted = (code: string) => code.match(/.{1,4}/g)!.join('-');

/** The code given with a setup request is right (or none is needed). */
export function setupCodeAccepted(ctx: AppContext, given: unknown): boolean {
  if (!setupCodeRequired(ctx)) return true;
  if (typeof given !== 'string' || !given.trim()) return false;
  const h = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(normalize(given)), h(setupCode(ctx)));
}

/** At the start: write the code to the log while it is needed, remove it once it is not. */
export function announceSetupCode(ctx: AppContext): void {
  if (!setupCodeRequired(ctx)) {
    discardSetupCode(ctx);
    return;
  }
  log.warn(
    `Paperless-AI has no account yet, but its configuration already holds credentials (e.g. the Paperless-ngx token). ` +
      `To protect them, the setup asks for this code: ${formatted(setupCode(ctx))} (also in ${fileOf(ctx)}).`,
  );
}

/** The first account exists: the code has done its job. */
export function discardSetupCode(ctx: AppContext): void {
  fs.rmSync(fileOf(ctx), { force: true });
}
