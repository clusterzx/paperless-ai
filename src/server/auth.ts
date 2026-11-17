/**
 * Authentication: password hashing, signed session cookies (JWT) and API keys.
 */
import { randomBytes, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { jwtVerify, SignJWT } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import type { UserRow } from './db/repos.js';

export const SESSION_COOKIE = 'paperless_ai_session';
const BCRYPT_ROUNDS = 12;

export type Principal = { kind: 'user'; userId: number; username: string } | { kind: 'apiKey' };

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
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
    if (!user || user.token_version !== payload.ver) return null;
    return { kind: 'user', userId: user.id, username: user.username };
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
    return user && user.token_version === payload.ver && user.totp_enabled_at ? user : null;
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

/** Resolve the caller from the session cookie, a Bearer token or the x-api-key header. */
export async function authenticate(ctx: AppContext, req: FastifyRequest): Promise<Principal | null> {
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && apiKeyMatches(ctx, headerKey)) return { kind: 'apiKey' };
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (apiKeyMatches(ctx, token)) return { kind: 'apiKey' };
    const p = await verifySession(ctx, token);
    if (p) return p;
  }
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (cookie) return verifySession(ctx, cookie);
  return null;
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
