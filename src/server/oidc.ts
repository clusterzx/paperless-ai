/**
 * Single sign-on with an OpenID Connect provider (Authentik, Keycloak, Authelia, Zitadel, …):
 * authorization code flow with PKCE, state and nonce. The flow state lives in a short-lived signed
 * cookie, so nothing has to be stored on the server between the redirect and the callback.
 */
import { createHmac } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify, SignJWT } from 'jose';
import * as client from 'openid-client';
import type { AppConfig } from './config/schema.js';
import type { AppContext } from './context.js';
import { isSecureRequest } from './auth.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'auth' });

export const OIDC_FLOW_COOKIE = 'paperless_ai_oidc';
/** The ID token of an SSO session – needed to end the session at the provider when signing out. */
export const OIDC_ID_TOKEN_COOKIE = 'paperless_ai_idt';
export const OIDC_CALLBACK_PATH = '/api/auth/oidc/callback';
const FLOW_MINUTES = 10;
const DISCOVERY_TTL_MS = 60 * 60_000;

/** Single sign-on is switched on and has the settings it needs. */
export function oidcUsable(cfg: AppConfig): boolean {
  const o = cfg.auth.oidc;
  return o.enabled && Boolean(o.issuer) && Boolean(o.clientId);
}

/** The password login can only be switched off while single sign-on works – otherwise nobody could sign in. */
export function passwordLoginAllowed(cfg: AppConfig): boolean {
  return cfg.auth.passwordLogin || !oidcUsable(cfg);
}

/** A failed sign-in that is shown to the user on the login page. */
export class OidcLoginError extends Error {}

interface Flow {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  /** Path to open after signing in. */
  next: string;
  /** Link the identity to this (signed-in) user instead of signing in. */
  linkUserId?: number;
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  claims: Record<string, unknown>;
  idToken: string | undefined;
}

/** Only paths on this origin ("/…", not "//host" or "/\host"). */
export function safeNext(next: unknown, fallback = '/'): string {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : fallback;
}

const services = new WeakMap<AppContext, OidcService>();

/** One service per app (it caches the provider's metadata). */
export function oidcService(ctx: AppContext): OidcService {
  let s = services.get(ctx);
  if (!s) {
    s = new OidcService(ctx);
    services.set(ctx, s);
  }
  return s;
}

export class OidcService {
  private cached: { key: string; at: number; config: Promise<client.Configuration> } | null = null;

  constructor(private readonly ctx: AppContext) {
    ctx.config.on('change', () => {
      this.cached = null;
    });
  }

  /** Discover the provider (cached for an hour) and choose how the client authenticates. */
  configuration(): Promise<client.Configuration> {
    const o = this.ctx.cfg.auth.oidc;
    const key = JSON.stringify([o.issuer, o.clientId, o.clientSecret]);
    if (!this.cached || this.cached.key !== key || Date.now() - this.cached.at > DISCOVERY_TTL_MS) {
      const config = discover(o.issuer, o.clientId, o.clientSecret);
      // A failed discovery is not cached – the provider may just have been restarting.
      config.catch(() => {
        if (this.cached?.config === config) this.cached = null;
      });
      this.cached = { key, at: Date.now(), config };
    }
    return this.cached.config;
  }

  /**
   * Address of Paperless-AI as the browser sees it: the configured one, else the one of the request.
   * Behind a reverse proxy the request itself is plain http (and may carry an internal host name):
   * the proxy tells in X-Forwarded-Proto / X-Forwarded-Host how the browser came in – used here even
   * without TRUST_PROXY. Safe for this purpose: the address only builds the redirect URIs, and the
   * provider accepts nothing but the ones registered there.
   */
  baseUrl(req: FastifyRequest): string {
    if (this.ctx.cfg.auth.publicUrl) return this.ctx.cfg.auth.publicUrl;
    const first = (name: string) => String(req.headers[name] ?? '').split(',')[0].trim();
    const fwdProto = first('x-forwarded-proto').toLowerCase();
    const fwdHost = first('x-forwarded-host');
    const proto = fwdProto === 'https' || fwdProto === 'http' ? fwdProto : req.protocol;
    const host = /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i.test(fwdHost) ? fwdHost : req.host;
    return `${proto}://${host}`;
  }

  /**
   * The callback URL registered at the provider – normalised (no default port …), because it has to
   * match exactly in the authorization and the token request.
   */
  redirectUri(req: FastifyRequest): string {
    return new URL(OIDC_CALLBACK_PATH, `${this.baseUrl(req)}/`).href;
  }

  /** Redirect to the provider; the flow state goes into a signed cookie. */
  async start(req: FastifyRequest, reply: FastifyReply, opts: { next: string; linkUserId?: number }): Promise<string> {
    const config = await this.configuration();
    const flow: Flow = {
      state: client.randomState(),
      nonce: client.randomNonce(),
      verifier: client.randomPKCECodeVerifier(),
      redirectUri: this.redirectUri(req),
      next: safeNext(opts.next),
      linkUserId: opts.linkUserId,
    };
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: flow.redirectUri,
      scope: this.ctx.cfg.auth.oidc.scopes || 'openid',
      code_challenge: await client.calculatePKCECodeChallenge(flow.verifier),
      code_challenge_method: 'S256',
      state: flow.state,
      nonce: flow.nonce,
    });
    const token = await new SignJWT({ flow }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(`${FLOW_MINUTES}m`).sign(this.key('flow'));
    // Lax: the provider sends the browser back with a top-level GET, which carries Lax cookies.
    reply.setCookie(OIDC_FLOW_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: isSecureRequest(req), path: '/api/auth/oidc', maxAge: FLOW_MINUTES * 60 });
    return url.href;
  }

  /** Check the provider's answer and return who signed in, plus the flow it belongs to. */
  async finish(req: FastifyRequest, reply: FastifyReply): Promise<{ identity: OidcIdentity; flow: Flow }> {
    const cookie = req.cookies?.[OIDC_FLOW_COOKIE];
    reply.clearCookie(OIDC_FLOW_COOKIE, { path: '/api/auth/oidc' });
    if (!cookie) throw new OidcLoginError('The sign-in took too long or was started in another browser – please try again');
    let flow: Flow;
    try {
      flow = (await jwtVerify(cookie, this.key('flow'), { algorithms: ['HS256'] })).payload.flow as Flow;
    } catch {
      throw new OidcLoginError('The sign-in took too long – please try again');
    }
    const config = await this.configuration();
    const query = req.raw.url?.split('?')[1] ?? '';
    const current = new URL(`${flow.redirectUri}?${query}`);
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
    } catch (err) {
      const e = err as { error?: string; error_description?: string; message?: string }
      log.warn(`Single sign-on failed: ${e.error_description ?? e.error ?? e.message}`);
      if (e.error === 'access_denied') throw new OidcLoginError('The sign-in was cancelled or denied by the provider');
      throw new OidcLoginError(`The provider did not confirm the sign-in${e.error_description ? `: ${e.error_description}` : ''}`);
    }
    const idClaims = tokens.claims();
    if (!idClaims) throw new OidcLoginError('The provider sent no ID token');
    let claims: Record<string, unknown> = { ...idClaims };
    // Groups and names are often only in the userinfo answer (depends on the provider's mappers).
    if (config.serverMetadata().userinfo_endpoint && tokens.access_token) {
      try {
        claims = { ...(await client.fetchUserInfo(config, tokens.access_token, idClaims.sub)), ...idClaims };
      } catch (err) {
        log.debug(`Userinfo request failed (only the ID token is used): ${(err as Error).message}`);
      }
    }
    return { identity: { issuer: String(idClaims.iss), subject: idClaims.sub, claims, idToken: tokens.id_token }, flow };
  }

  /** Group names of the identity (from the configured groups claim). */
  groups(identity: OidcIdentity): string[] {
    const raw = identity.claims[this.ctx.cfg.auth.oidc.groupsClaim];
    return (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\s]+/) : []).map((g) => String(g).trim()).filter(Boolean);
  }

  /** Is the identity in one of the allowed groups (if any are configured)? */
  allowed(identity: OidcIdentity): boolean {
    const o = this.ctx.cfg.auth.oidc;
    if (!o.allowedGroups.length) return true;
    const groups = this.groups(identity).map((g) => g.toLowerCase());
    return o.allowedGroups.some((g) => groups.includes(g.toLowerCase()));
  }

  /** Admin by group membership: true / false, or null when no admin groups are configured. */
  adminByGroups(identity: OidcIdentity): boolean | null {
    const o = this.ctx.cfg.auth.oidc;
    if (!o.adminGroups.length) return null;
    const groups = this.groups(identity).map((g) => g.toLowerCase());
    return o.adminGroups.some((g) => groups.includes(g.toLowerCase()));
  }

  /** A free user name for a new account, from the configured claim (then preferred_username, email, name, sub). */
  username(identity: OidcIdentity): string {
    const c = identity.claims;
    const candidates = [c[this.ctx.cfg.auth.oidc.usernameClaim], c.preferred_username, c.email, c.name, identity.subject];
    const base =
      candidates
        .find((v): v is string => typeof v === 'string' && v.trim() !== '')
        ?.trim()
        .slice(0, 90) ?? 'user';
    let name = base;
    for (let i = 2; this.ctx.repos.users.byUsername(name); i++) name = `${base}-${i}`;
    return name;
  }

  /** Where to send the browser after signing out locally, to end the session at the provider too. */
  async logoutUrl(req: FastifyRequest, idToken: string | undefined): Promise<string | null> {
    if (!oidcUsable(this.ctx.cfg) || !this.ctx.cfg.auth.oidc.providerLogout) return null;
    try {
      const config = await this.configuration();
      if (!config.serverMetadata().end_session_endpoint) return null;
      return client.buildEndSessionUrl(config, {
        post_logout_redirect_uri: new URL('/login', `${this.baseUrl(req)}/`).href,
        ...(idToken ? { id_token_hint: idToken } : { client_id: this.ctx.cfg.auth.oidc.clientId }),
      }).href;
    } catch (err) {
      log.warn(`Could not end the session at the provider: ${(err as Error).message}`);
      return null;
    }
  }

  private key(purpose: string): Uint8Array {
    return createHmac('sha256', this.ctx.cfg.security.jwtSecret).update(`paperless-ai oidc ${purpose}`).digest();
  }
}

/** Discovery plus client authentication as the provider prefers it (client_secret_basic is the OIDC default). */
export async function discover(issuer: string, clientId: string, clientSecret: string): Promise<client.Configuration> {
  const url = new URL(issuer);
  const insecure = url.protocol === 'http:';
  const found = await client.discovery(url, clientId, undefined, undefined, { execute: insecure ? [client.allowInsecureRequests] : [], timeout: 15 });
  const server = found.serverMetadata();
  const methods = server.token_endpoint_auth_methods_supported;
  const auth = !clientSecret
    ? client.None()
    : !methods || methods.includes('client_secret_basic')
      ? client.ClientSecretBasic(clientSecret)
      : client.ClientSecretPost(clientSecret);
  const config = new client.Configuration(server, clientId, clientSecret || undefined, auth);
  if (insecure) {
    client.allowInsecureRequests(config);
    log.warn(`The OIDC provider ${url.origin} is reached without HTTPS – use HTTPS outside a trusted network`);
  }
  return config;
}

export function describeOidcError(err: unknown): string {
  const e = err as { message?: string; cause?: { message?: string; code?: string } };
  const cause = e.cause?.message ?? e.cause?.code;
  return `${e.message ?? String(err)}${cause && !e.message?.includes(cause) ? ` (${cause})` : ''}`;
}

