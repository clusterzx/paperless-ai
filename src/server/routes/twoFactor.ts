import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { renderSVG } from 'uqr';
import { z } from 'zod';
import type { TwoFactorSetup } from '../../shared/api.js';
import type { Services } from '../http/app.js';
import { HttpProblem } from '../http/helpers.js';
import { issueSession, setSessionCookie, verifyPassword, verifyTwoFactorTicket } from '../auth.js';
import type { UserRow } from '../db/repos.js';
import { logger } from '../logger.js';
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUrl, verifyTotp } from '../totp.js';
import { checkSecondFactor, secondFactorError, twoFactorStatus } from '../twoFactor.js';

const log = logger.child({ module: 'auth' });

/** Same limit as the password login – a 6-digit code must not be guessable by trying. */
const LIMIT = { max: 10, timeWindow: '1 minute' };
const code = z.string().trim().min(6).max(40);
const password = z.string().min(1).max(200);

export const twoFactorRoutes =
  ({ ctx }: Services): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();
    const users = ctx.repos.users;

    const currentUser = (req: FastifyRequest): UserRow => {
      const p = req.principal;
      const user = p?.kind === 'user' ? users.byId(p.userId) : undefined;
      if (!user) throw new HttpProblem(403, 'This action requires a logged-in user');
      return user;
    };
    const requirePassword = async (user: UserRow, given: string) => {
      if (!(await verifyPassword(given, user.password_hash))) throw new HttpProblem(400, 'The current password is wrong');
    };
    const requireSecondFactor = async (user: UserRow, given: string) => {
      const res = await checkSecondFactor(ctx, user, given);
      if (!res.ok) throw new HttpProblem(400, secondFactorError(res.reason));
      return res;
    };
    const newCodes = async (userId: number) => {
      const codes = newRecoveryCodes();
      const hashes = await Promise.all(codes.map(hashRecoveryCode));
      return { codes, hashes, userId };
    };
    const renewSession = async (reply: FastifyReply, req: FastifyRequest, userId: number) =>
      setSessionCookie(reply, req, await issueSession(ctx, users.byId(userId)!), ctx.cfg.security.sessionHours);

    // ---------------------------------------------------------------- second sign-in step

    app.post(
      '/api/auth/login/2fa',
      {
        config: { auth: 'public', rateLimit: LIMIT },
        schema: {
          description: 'Second sign-in step: the ticket from /api/auth/login and a code of the authenticator app or a recovery code.',
          body: z.object({ ticket: z.string().min(1).max(2000), code }),
        },
      },
      async (req, reply) => {
        const user = await verifyTwoFactorTicket(ctx, req.body.ticket);
        if (!user) return reply.code(401).send({ error: 'The sign-in has expired – enter your password again', code: 'ticket_expired' });
        const res = await checkSecondFactor(ctx, user, req.body.code);
        if (!res.ok) {
          log.warn(`Failed second sign-in step for "${user.username}" from ${req.ip}`);
          return reply.code(401).send({ error: secondFactorError(res.reason) });
        }
        await renewSession(reply, req, user.id);
        if (res.method === 'recovery') log.warn(`User "${user.username}" signed in with a recovery code (${res.recoveryCodesLeft} left)`);
        log.info(`User "${user.username}" logged in (two-factor)`);
        return { ok: true, user: { id: user.id, username: user.username }, usedRecoveryCode: res.method === 'recovery', recoveryCodesLeft: res.recoveryCodesLeft };
      },
    );

    // ---------------------------------------------------------------- set-up in the account settings

    app.get('/api/account/2fa', { config: { auth: 'session' } }, async (req) => twoFactorStatus(ctx, currentUser(req).id));

    app.post(
      '/api/account/2fa/setup',
      { config: { auth: 'session', rateLimit: LIMIT }, schema: { description: 'Start the set-up: a new secret to scan; it only counts once a code from it is confirmed.' } },
      async (req): Promise<TwoFactorSetup> => {
        const user = currentUser(req);
        if (user.totp_enabled_at) throw new HttpProblem(409, 'Two-factor authentication is already enabled');
        const secret = newTotpSecret();
        users.setPendingTotp(user.id, secret);
        const url = otpauthUrl(secret, user.username);
        return { secret, otpauthUrl: url, qrSvg: renderSVG(url, { border: 2 }) };
      },
    );

    app.post(
      '/api/account/2fa/enable',
      {
        config: { auth: 'session', rateLimit: LIMIT },
        schema: {
          description: 'Confirm the set-up with the current password and a code of the app. Returns the recovery codes (shown once); other sessions end.',
          body: z.object({ password, code }),
        },
      },
      async (req, reply) => {
        const user = currentUser(req);
        await requirePassword(user, req.body.password);
        if (user.totp_enabled_at) throw new HttpProblem(409, 'Two-factor authentication is already enabled');
        if (!user.totp_secret) throw new HttpProblem(409, 'Start the set-up first');
        const step = verifyTotp(user.totp_secret, req.body.code);
        if (step === null) throw new HttpProblem(400, 'The code is not valid – check that the time on your phone is correct and try the next code');
        const { codes, hashes } = await newCodes(user.id);
        users.enableTotp(user.id, step, hashes);
        await renewSession(reply, req, user.id);
        log.info(`Two-factor authentication enabled for "${user.username}"`);
        return { recoveryCodes: codes };
      },
    );

    app.post(
      '/api/account/2fa/disable',
      {
        config: { auth: 'session', rateLimit: LIMIT },
        schema: { description: 'Switch two-factor authentication off (current password and a code or recovery code).', body: z.object({ password, code }) },
      },
      async (req) => {
        const user = currentUser(req);
        await requirePassword(user, req.body.password);
        await requireSecondFactor(user, req.body.code);
        users.disableTotp(user.id);
        log.warn(`Two-factor authentication disabled for "${user.username}"`);
        return { ok: true };
      },
    );

    app.post(
      '/api/account/2fa/recovery-codes',
      {
        config: { auth: 'session', rateLimit: LIMIT },
        schema: { description: 'Replace all recovery codes with new ones (current password and a code).', body: z.object({ password, code }) },
      },
      async (req) => {
        const user = currentUser(req);
        await requirePassword(user, req.body.password);
        await requireSecondFactor(user, req.body.code);
        const { codes, hashes } = await newCodes(user.id);
        users.replaceRecoveryCodes(user.id, hashes);
        log.info(`New recovery codes for "${user.username}"`);
        return { recoveryCodes: codes };
      },
    );
  };
