import { audit } from '../access/context.js';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Services } from '../http/app.js';
import { HttpProblem } from '../http/helpers.js';
import { isSecureRequest, issueSession, setSessionCookie } from '../auth.js';
import { SECRET_MASK } from '../config/schema.js';
import { logger } from '../logger.js';
import { describeOidcError, discover, OIDC_ID_TOKEN_COOKIE, OidcLoginError, oidcService, oidcUsable, passwordLoginAllowed, safeNext } from '../oidc.js';

const log = logger.child({ module: 'auth' });
const LIMIT = { max: 30, timeWindow: '1 minute' };

export const oidcRoutes =
  ({ ctx }: Services): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();
    const oidc = oidcService(ctx);
    const users = ctx.repos.users;

    /** Errors are shown where the flow started: the login page, the setup wizard (no account yet) or the account settings when linking. */
    const fail = (reply: FastifyReply, message: string, linking = false) =>
      reply.redirect(`${linking ? '/settings?tab=account&' : users.count() === 0 ? '/setup?' : '/login?'}sso_error=${encodeURIComponent(message)}`);

    app.get(
      '/api/auth/oidc/login',
      {
        config: { auth: 'public', rateLimit: LIMIT },
        schema: { hide: true, querystring: z.object({ next: z.string().max(2000).optional(), link: z.enum(['1']).optional() }) },
      },
      async (req, reply) => {
        const linking = req.query.link === '1';
        if (!oidcUsable(ctx.cfg)) return fail(reply, 'Single sign-on is not set up', linking);
        let linkUserId: number | undefined;
        if (linking) {
          if (req.principal?.kind !== 'user') return reply.redirect('/login');
          linkUserId = req.principal.userId;
        }
        try {
          const url = await oidc.start(req, reply, { next: safeNext(req.query.next), linkUserId });
          return reply.redirect(url);
        } catch (err) {
          log.error(`Single sign-on: the provider could not be reached – ${describeOidcError(err)}`);
          return fail(reply, 'The sign-in provider could not be reached – see the logs of Paperless-AI', linking);
        }
      },
    );

    app.get('/api/auth/oidc/callback', { config: { auth: 'public', rateLimit: LIMIT }, schema: { hide: true } }, async (req, reply) => {
      let linking = false;
      try {
        if (!oidcUsable(ctx.cfg)) throw new OidcLoginError('Single sign-on is not set up');
        const { identity, flow } = await oidc.finish(req, reply);
        linking = flow.linkUserId !== undefined;
        if (!oidc.allowed(identity)) {
          log.warn(`Single sign-on refused for "${String(identity.claims.preferred_username ?? identity.subject)}": not in an allowed group`);
          throw new OidcLoginError('Your account is not in a group that may use Paperless-AI');
        }
        const owner = users.byOidc(identity.issuer, identity.subject);

        if (flow.linkUserId !== undefined) {
          const user = users.byId(flow.linkUserId);
          if (!user) throw new OidcLoginError('The account to link no longer exists');
          if (owner && owner.id !== user.id) throw new OidcLoginError(`This sign-in is already linked to the account "${owner.username}"`);
          users.setOidc(user.id, identity);
          log.info(`Account "${user.username}" linked with single sign-on`);
          return reply.redirect('/settings?tab=account&sso=linked');
        }

        let user = owner;
        const adminByGroups = oidc.adminByGroups(identity);
        if (!user) {
          // The very first account may always be created this way (setup without a password).
          const first = users.count() === 0;
          if (!ctx.cfg.auth.oidc.autoCreate && !first) {
            throw new OidcLoginError('There is no Paperless-AI account for this sign-in – sign in with your password once and link it in Settings → Account');
          }
          const name = oidc.username(identity);
          user = users.byId(users.createOidc(name, identity.issuer, identity.subject, first || adminByGroups ? 'admin' : 'member'))!;
          log.info(`Created account "${name}" from single sign-on`);
          audit(ctx, null, 'user.created', `user:${user.id}`, { username: name, via: 'sso', role: user.role });
        } else if (adminByGroups !== null && (user.role === 'admin') !== adminByGroups) {
          // Admin groups decide the role – but the last admin is never demoted.
          if (adminByGroups || users.countAdmins() > 1) {
            users.setRole(user.id, adminByGroups ? 'admin' : 'member');
            audit(ctx, null, 'user.role_changed', `user:${user.id}`, { role: adminByGroups ? 'admin' : 'member', via: 'sso groups' });
            user = users.byId(user.id)!;
          }
        }
        if (user.disabled_at) throw new OidcLoginError('This account is disabled');
        if (ctx.cfg.auth.oidc.syncGroups) {
          ctx.repos.groups.syncOidc(user.id, oidc.groups(identity));
          ctx.repos.libraries.invalidate();
        }
        setSessionCookie(reply, req, await issueSession(ctx, user), ctx.cfg.security.sessionHours);
        if (identity.idToken) {
          reply.setCookie(OIDC_ID_TOKEN_COOKIE, identity.idToken, {
            httpOnly: true,
            sameSite: 'lax',
            secure: isSecureRequest(req),
            path: '/api/auth',
            maxAge: ctx.cfg.security.sessionHours * 3600,
          });
        }
        log.info(`User "${user.username}" logged in (single sign-on)`);
        return reply.redirect(flow.next);
      } catch (err) {
        if (err instanceof OidcLoginError) return fail(reply, err.message, linking);
        log.error(`Single sign-on failed: ${describeOidcError(err)}`);
        return fail(reply, 'The sign-in failed – see the logs of Paperless-AI', linking);
      }
    });

    app.post('/api/account/sso/unlink', { config: { auth: 'session' } }, async (req) => {
      const p = req.principal!;
      const user = p.kind === 'user' ? users.byId(p.userId) : undefined;
      if (!user) throw new HttpProblem(403, 'This action requires a logged-in user');
      // Without a password (or with the password login switched off) the account could not be used any more.
      if (!user.password_hash || !passwordLoginAllowed(ctx.cfg)) {
        throw new HttpProblem(409, 'This account signs in only with single sign-on – it cannot be unlinked');
      }
      users.setOidc(user.id, null);
      log.info(`Single sign-on unlinked from "${user.username}"`);
      return { ok: true };
    });

    app.post(
      '/api/settings/test-oidc',
      {
        config: { auth: 'session', rateLimit: LIMIT },
        schema: {
          description: 'Check the issuer URL: discovery of the OpenID Connect provider.',
          body: z.object({ issuer: z.string().trim().min(1).max(500), clientId: z.string().trim().max(500).default(''), clientSecret: z.string().max(2000).default('') }),
        },
      },
      async (req) => {
        const secret = req.body.clientSecret === SECRET_MASK ? ctx.cfg.auth.oidc.clientSecret : req.body.clientSecret;
        try {
          const config = await discover(req.body.issuer, req.body.clientId || 'paperless-ai', secret);
          const m = config.serverMetadata();
          return {
            ok: true,
            message: `Found ${m.issuer}`,
            issuer: m.issuer,
            endSession: Boolean(m.end_session_endpoint),
            callbackUrl: oidc.redirectUri(req),
          };
        } catch (err) {
          return { ok: false, message: `No OpenID Connect provider found at this address: ${describeOidcError(err)}`, callbackUrl: oidc.redirectUri(req) };
        }
      },
    );
  };
