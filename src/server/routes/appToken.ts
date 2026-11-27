/**
 * Sign-in for native apps (#1046): username and password (and the second factor) → a personal API
 * key named after the device, returned once. The app keeps it in the keychain; the user sees and
 * revokes it under Settings → API keys like any other key. The app signs out with DELETE, which
 * revokes the key the request comes with.
 *
 *   POST /api/auth/token  { username, password, deviceName?, scopes?, code? }
 *     → { token, keyId, scopes, user }               signed in
 *     → { twoFactor: true, ticket }                    the account has 2FA and no code was sent
 *   POST /api/auth/token  { ticket, code, deviceName?, scopes? }   second step
 *   DELETE /api/auth/token                             (with the key) → the key is revoked
 */
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ApiScope } from '../../shared/api.js';
import type { Services } from '../http/app.js';
import { hashPassword, issueTwoFactorTicket, verifyPassword, verifyTwoFactorTicket } from '../auth.js';
import { audit, userScope } from '../access/context.js';
import type { UserRow } from '../db/repos.js';
import { passwordLoginAllowed } from '../oidc.js';
import { checkSecondFactor, secondFactorError } from '../twoFactor.js';
import { logger } from '../logger.js';
import { avatarUrl } from '../avatars.js';

const log = logger.child({ module: 'auth' });

/** What an app may ask for – never administration, MCP, webhooks or the OCR API. */
export const APP_SCOPES = ['read', 'write', 'delete', 'metadata', 'upload', 'chat'] as const satisfies readonly ApiScope[];

const options = {
  deviceName: z.string().trim().min(1).max(60).optional(),
  scopes: z.array(z.enum(APP_SCOPES)).min(1).max(APP_SCOPES.length).optional(),
};
const body = z.union([
  z.object({ ticket: z.string().min(1).max(2000), code: z.string().trim().min(6).max(40), ...options }),
  z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(200), code: z.string().trim().min(6).max(40).optional(), ...options }),
]);

export const appTokenRoutes =
  ({ ctx }: Services): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();
    let dummy: Promise<string> | null = null;
    const dummyHash = () => (dummy ??= hashPassword(`dummy-${randomUUID()}`));

    const refuse = (reply: FastifyReply, status: number, error: string, code?: string) => reply.code(status).send({ error, ...(code ? { code } : {}) });

    app.post(
      '/api/auth/token',
      {
        config: { auth: 'public', rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: {
          tags: ['Authentication'],
          summary: 'Sign in an app: a personal API key for the device',
          description:
            'For native apps. `{ username, password, deviceName }` → `{ token }`: a personal API key (`pai_…`) named after the device, shown only this once – send it as `Authorization: Bearer …`. ' +
            'With two-factor authentication: send `code` along, or take the `ticket` of the answer `{ twoFactor: true, ticket }` and send `{ ticket, code }`. ' +
            '`scopes` (default all): read, write, delete, metadata, upload, chat. Sign out with `DELETE /api/auth/token`.',
          body,
        },
      },
      async (req, reply) => {
        if (!passwordLoginAllowed(ctx.cfg)) {
          return refuse(reply, 403, 'Signing in with a password is switched off – create an API key in Paperless-AI (Settings → API keys) and enter it in the app', 'password_login_disabled');
        }
        const b = req.body;
        let user: UserRow | undefined;
        let code: string | undefined;
        if ('ticket' in b) {
          user = (await verifyTwoFactorTicket(ctx, b.ticket)) ?? undefined;
          if (!user) return refuse(reply, 401, 'The sign-in has expired – enter your password again', 'ticket_expired');
          code = b.code;
        } else {
          user = ctx.repos.users.byUsername(b.username.trim());
          // A dummy hash for unknown names and accounts without a password: the time reveals nothing.
          const ok = await verifyPassword(b.password, user?.password_hash || (await dummyHash()));
          if (!user || !user.password_hash || !ok) {
            log.warn(`Failed app sign-in for "${b.username.slice(0, 50)}" from ${req.ip}`);
            return refuse(reply, 401, 'Invalid username or password');
          }
          code = b.code;
        }
        if (user.disabled_at) return refuse(reply, 403, 'This account is disabled', 'account_disabled');
        if (user.totp_enabled_at) {
          if (!code) return { twoFactor: true, ticket: await issueTwoFactorTicket(ctx, user) };
          const second = await checkSecondFactor(ctx, user, code);
          if (!second.ok) {
            log.warn(`Failed second sign-in step of an app for "${user.username}" from ${req.ip}`);
            return refuse(reply, 401, secondFactorError(second.reason, second.retryAfterMinutes), 'second_factor');
          }
        }
        const deviceName = b.deviceName ?? 'App';
        const scopes: ApiScope[] = b.scopes ? [...new Set(b.scopes)] : [...APP_SCOPES];
        const { id: keyId, key } = ctx.repos.apiKeys.create(user.id, { name: `App: ${deviceName}`, scopes });
        audit(ctx, userScope(ctx, user.id), 'apikey.created', `apikey:${keyId}`, { name: `App: ${deviceName}`, scopes, via: 'app sign-in' });
        log.info(`User "${user.username}" signed in the app "${deviceName}" (API key #${keyId})`);
        return {
          token: key,
          keyId,
          scopes,
          user: { id: user.id, username: user.username, displayName: user.display_name ?? null, role: user.role, avatarUrl: avatarUrl(user.id, ctx.repos.users.avatarSha256(user.id)) },
        };
      },
    );

    app.delete(
      '/api/auth/token',
      {
        schema: {
          tags: ['Authentication'],
          summary: 'Sign out an app: revoke the API key of this request',
          description: 'Revokes the personal API key the request is sent with (`Authorization: Bearer …`). It works with any key, whatever its permissions.',
        },
      },
      async (req, reply) => {
        const p = req.principal;
        if (p?.kind !== 'user' || p.via !== 'apiKey' || p.apiKeyId === undefined)
          return refuse(reply, 400, 'Send the API key of the app (Authorization: Bearer …) – the browser signs out with /api/auth/logout');
        const k = ctx.repos.apiKeys.get(p.apiKeyId);
        if (k && !k.revoked_at) {
          ctx.repos.apiKeys.revoke(k.id);
          audit(ctx, req.access, 'apikey.revoked', `apikey:${k.id}`, { name: k.name, user: k.user_id, via: 'app sign-out' });
          log.info(`User "${p.username}" signed out the app "${k.name}" (API key #${k.id})`);
        }
        return { ok: true };
      },
    );
  };
