/**
 * Authentication: password hashing, signed session cookies (JWT) and API keys.
 */
import { randomBytes, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { jwtVerify, SignJWT } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import type { UserRow } from './db/repos.js';
import { ApiKeysRepo, type ApiKeyRow } from './db/accessRepo.js';
import type { AccessScope, Principal } from './access/scope.js';
import { scopeFor } from './access/context.js';

export const SESSION_COOKIE = 'paperless_ai_session';
const BCRYPT_ROUNDS = 12;

export type { Principal } from './access/scope.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    /** What the caller may access (null = not authenticated). */
    access: AccessScope | null;
  }
}

export function validatePassword(password: string): string | null {
  if (typeof password !== 'string' || password.length < 8) return 'The password must be at least 8 characters long';
  if (password.length > 200) return 'The password is too long';
  return null;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

function secret(ctx: AppContext): Uint8Array {
  return new TextEncoder().encode(ctx.cfg.security.jwtSecret);
}

export async function issueSession(ctx: AppContext, user: { id: number; username: string; token_version: number }): Promise<string> {
  return new SignJWT({ name: user.username, ver: user.token_version })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime(`${ctx.cfg.security.sessionHours}h`)
    .sign(secret(ctx));
}

export async function verifySession(ctx: AppContext, token: string): Promise<Principal | null> {
  try {
    const { payload } = await jwtVerify(token, secret(ctx), { algorithms: ['HS256'] });
    const user = ctx.repos.users.byId(Number(payload.sub));
    if (!user || user.token_version !== payload.ver || user.disabled_at) return null;
    return { kind: 'user', userId: user.id, username: user.username, role: user.role, via: 'session' };
  } catch {
    return null;
  }
}

/** Tickets are signed with their own key: one can never pass as a session, whatever it contains. */
function ticketKey(ctx: AppContext): Uint8Array {
  return createHmac('sha256', ctx.cfg.security.jwtSecret).update('paperless-ai two-factor login ticket').digest();
}

/** Proof that the password was right, valid for 5 minutes and only for the second sign-in step. */
export async function issueTwoFactorTicket(ctx: AppContext, user: { id: number; token_version: number }): Promise<string> {
  return new SignJWT({ ver: user.token_version, typ: '2fa' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(ticketKey(ctx));
}

export async function verifyTwoFactorTicket(ctx: AppContext, ticket: string): Promise<UserRow | null> {
  try {
    const { payload } = await jwtVerify(ticket, ticketKey(ctx), { algorithms: ['HS256'] });
    if (payload.typ !== '2fa') return null;
    const user = ctx.repos.users.byId(Number(payload.sub));
    // A changed password (or 2FA switched off) invalidates open tickets.
    return user && user.token_version === payload.ver && user.totp_enabled_at && !user.disabled_at ? user : null;
  } catch {
    return null;
  }
}

export function apiKeyMatches(ctx: AppContext, candidate: string | undefined): boolean {
  const expected = ctx.cfg.security.apiKey;
  if (!candidate || !expected) return false;
  // Compare hashes so the comparison is constant-time regardless of length.
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function newApiKey(): string {
  return randomBytes(32).toString('hex');
}

export interface Authenticated {
  principal: Principal;
  /** The personal API key used (null for sessions and the legacy key). */
  key: ApiKeyRow | null;
}

/** A personal API key (pai_…) or the global legacy key. */
function fromApiKey(ctx: AppContext, candidate: string): Authenticated | null {
  if (ApiKeysRepo.looksLikeKey(candidate)) {
    const key = ctx.repos.apiKeys.verify(candidate);
    if (!key) return null;
    const user = ctx.repos.users.byId(key.user_id);
    if (!user || user.disabled_at) return null;
    return { principal: { kind: 'user', userId: user.id, username: user.username, role: user.role, via: 'apiKey', apiKeyId: key.id }, key };
  }
  if (apiKeyMatches(ctx, candidate)) return { principal: { kind: 'legacyApiKey' }, key: null };
  return null;
}

/**
 * Resolve the caller from the session cookie, a Bearer token, `Authorization: Token <key>` (as
 * Paperless-ngx clients send it), the x-api-key header or `Ocp-Apim-Subscription-Key` (as Paperless-ngx
 * sends the key of its remote OCR engine).
 */
export async function authenticate(ctx: AppContext, req: FastifyRequest): Promise<Authenticated | null> {
  for (const header of ['x-api-key', 'ocp-apim-subscription-key']) {
    const headerKey = req.headers[header];
    if (typeof headerKey !== 'string' || !headerKey) continue;
    const a = fromApiKey(ctx, headerKey);
    if (a) return a;
  }
  const auth = req.headers.authorization;
  // HTTP Basic with an API key as the password (WebDAV clients, scanners); the user name is ignored.
  if (auth?.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
    const a = fromApiKey(ctx, decoded.slice(decoded.indexOf(':') + 1));
    if (a) return a;
  }
  if (auth?.startsWith('Bearer ') || auth?.startsWith('Token ')) {
    const token = auth.slice(auth.indexOf(' ') + 1).trim();
    const a = fromApiKey(ctx, token);
    if (a) return a;
    if (auth.startsWith('Bearer ')) {
      const p = await verifySession(ctx, token);
      if (p) return { principal: p, key: null };
    }
  }
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (cookie) {
    const p = await verifySession(ctx, cookie);
    if (p) return { principal: p, key: null };
  }
  return null;
}

/** Authenticate and build the access scope of a request. */
export async function resolveAccess(ctx: AppContext, req: FastifyRequest): Promise<{ principal: Principal | null; access: AccessScope | null; key: ApiKeyRow | null }> {
  const a = await authenticate(ctx, req);
  if (!a) return { principal: null, access: null, key: null };
  return { principal: a.principal, access: scopeFor(ctx, a.principal, a.key), key: a.key };
}

export function isSecureRequest(req: FastifyRequest): boolean {
  return req.protocol === 'https';
}

export function setSessionCookie(reply: FastifyReply, req: FastifyRequest, token: string, hours: number): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: '/',
    maxAge: hours * 3600,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
