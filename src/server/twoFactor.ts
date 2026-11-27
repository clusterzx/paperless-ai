/**
 * Second sign-in factor of a user: a code of the authenticator app or a single-use recovery code.
 */
import type { TwoFactorStatus } from '../shared/api.js';
import type { AppContext } from './context.js';
import type { UserRow } from './db/repos.js';
import { logger } from './logger.js';
import { recoveryCodeMatches, verifyTotp } from './totp.js';

const log = logger.child({ module: 'auth' });

export type SecondFactorResult =
  | { ok: true; method: 'totp' | 'recovery'; recoveryCodesLeft: number }
  | { ok: false; reason: 'invalid' | 'reused' | 'off' | 'locked'; retryAfterMinutes?: number };

/** Wrong second factors in a row per account, before the account waits (per account, not per address). */
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const failures = new Map<string, { count: number; lockedUntil: number }>();
/** Account key: the id alone could be one of an earlier, deleted account. */
const accountKey = (user: UserRow) => `${user.id}:${user.created_at}`;

/** The account waits after too many wrong codes – a six-digit code is guessed otherwise, from many addresses. */
function lockedFor(key: string): number {
  const f = failures.get(key);
  return f && f.lockedUntil > Date.now() ? Math.ceil((f.lockedUntil - Date.now()) / 60_000) : 0;
}

function recordFailure(key: string): void {
  const f = failures.get(key) ?? { count: 0, lockedUntil: 0 };
  f.count++;
  if (f.count >= MAX_FAILURES) {
    f.count = 0;
    f.lockedUntil = Date.now() + LOCK_MS;
  }
  failures.set(key, f);
}

export async function checkSecondFactor(ctx: AppContext, user: UserRow, code: string): Promise<SecondFactorResult> {
  if (!user.totp_secret || !user.totp_enabled_at) return { ok: false, reason: 'off' };
  const key = accountKey(user);
  const wait = lockedFor(key);
  if (wait) return { ok: false, reason: 'locked', retryAfterMinutes: wait };
  const res = await checkCode(ctx, user, code);
  if (res.ok) failures.delete(key);
  else if (res.reason === 'invalid') recordFailure(key);
  return res;
}

async function checkCode(ctx: AppContext, user: UserRow, code: string): Promise<SecondFactorResult> {
  const users = ctx.repos.users;
  if (!user.totp_secret) return { ok: false, reason: 'off' };
  const compact = code.replace(/\s/g, '');
  if (/^\d{6}$/.test(compact)) {
    const step = verifyTotp(user.totp_secret, compact);
    if (step === null) return { ok: false, reason: 'invalid' };
    // Each code works once: a code seen on the screen or in transit cannot be replayed.
    if (!users.useTotpStep(user.id, step)) return { ok: false, reason: 'reused' };
    return { ok: true, method: 'totp', recoveryCodesLeft: users.unusedRecoveryCodes(user.id).length };
  }
  const unused = users.unusedRecoveryCodes(user.id);
  for (const row of unused) {
    if (await recoveryCodeMatches(code, row.code_hash)) {
      if (!users.useRecoveryCode(row.id)) return { ok: false, reason: 'reused' };
      return { ok: true, method: 'recovery', recoveryCodesLeft: unused.length - 1 };
    }
  }
  return { ok: false, reason: 'invalid' };
}

export function secondFactorError(reason: 'invalid' | 'reused' | 'off' | 'locked', retryAfterMinutes?: number): string {
  if (reason === 'locked') return `Too many wrong codes – try again in ${retryAfterMinutes ?? 15} minute(s)`;
  if (reason === 'reused') return 'This code was already used – wait for the next one';
  if (reason === 'off') return 'Two-factor authentication is not enabled';
  return 'Invalid code';
}

export function twoFactorStatus(ctx: AppContext, userId: number): TwoFactorStatus {
  const user = ctx.repos.users.byId(userId);
  const enabled = Boolean(user?.totp_enabled_at);
  return { enabled, enabledAt: user?.totp_enabled_at ?? null, recoveryCodesLeft: enabled ? ctx.repos.users.unusedRecoveryCodes(userId).length : 0 };
}

/**
 * Locked out (phone lost, no recovery codes)? PAPERLESS_AI_RESET_2FA=<username> switches 2FA off
 * for that account at the next start. The password stays.
 */
export function resetTwoFactorFromEnv(ctx: AppContext, env: NodeJS.ProcessEnv = process.env): void {
  const username = env.PAPERLESS_AI_RESET_2FA?.trim();
  if (!username) return;
  const user = ctx.repos.users.byUsername(username);
  if (!user) {
    log.error(`PAPERLESS_AI_RESET_2FA: there is no user "${username}"`);
    return;
  }
  if (user.totp_secret || user.totp_enabled_at) {
    ctx.repos.users.disableTotp(user.id);
    log.warn(`Two-factor authentication of "${user.username}" was switched off by PAPERLESS_AI_RESET_2FA – remove the variable and set it up again`);
  } else {
    log.warn(`PAPERLESS_AI_RESET_2FA: "${user.username}" has no two-factor authentication – remove the variable`);
  }
}
