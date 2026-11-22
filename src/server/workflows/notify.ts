/**
 * Notifications of workflows: in the app, by e-mail (SMTP) and by webhook (generic JSON with an
 * HMAC signature, ntfy, Gotify). External deliveries are retried up to three times.
 * Recipients only ever hear about documents they may read.
 */
import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { AppContext } from '../context.js';
import { canRead } from '../access/scope.js';
import { userScope } from '../access/context.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'workflows' });

/** What a notification tells about the document. */
export interface NotifySubject {
  documentId: number;
  libraryId: number | null;
  title: string;
  correspondent: string | null;
  documentType: string | null;
  created: string | null;
  tags: string[];
  url: string;
}

/** Users (directly or through groups) who may read the document. */
export function recipients(ctx: AppContext, subject: NotifySubject, users: number[], groups: number[]): number[] {
  const ids = new Set(users);
  for (const g of groups) for (const u of ctx.repos.groups.members(g)) ids.add(u);
  return [...ids].filter((id) => {
    const scope = userScope(ctx, id);
    return scope !== null && (subject.libraryId === null || canRead(scope, subject.libraryId));
  });
}

export function notifyInApp(ctx: AppContext, subject: NotifySubject, users: number[], groups: number[], title: string, body: string): number[] {
  const to = recipients(ctx, subject, users, groups);
  for (const u of to) ctx.repos.notifications.add(u, { title, body, link: `/documents/${subject.documentId}` });
  return to;
}

/** Retry a delivery (network errors, 5xx, 429) with back-off. */
export async function withRetries<T>(what: string, fn: (attempt: number) => Promise<T>, delays = [1000, 4000, 9000]): Promise<{ result: T; attempts: number }> {
  let last: unknown;
  for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
    try {
      return { result: await fn(attempt), attempts: attempt };
    } catch (err) {
      last = err;
      if ((err as { permanent?: boolean }).permanent || attempt > delays.length) break;
      log.warn(`${what} failed (attempt ${attempt}): ${err instanceof Error ? err.message : String(err)} – retrying`);
      await new Promise((r) => setTimeout(r, delays[attempt - 1]));
    }
  }
  throw last;
}

function permanent(message: string): Error {
  return Object.assign(new Error(message), { permanent: true });
}

/** Delays between delivery attempts (shortened by tests). */
export const retryDelays = { value: [1000, 4000, 9000] };

export async function notifyWebhook(
  url: string,
  preset: 'generic' | 'ntfy' | 'gotify',
  secret: string | undefined,
  payload: { event: string; workflow: { id: number; name: string }; document: NotifySubject; changes: { field: string; before: unknown; after: unknown }[] },
): Promise<{ status: number; attempts: number }> {
  const title = `${payload.document.title} – ${payload.workflow.name}`;
  let body: string;
  const headers: Record<string, string> = { 'User-Agent': 'Paperless-AI' };
  if (preset === 'ntfy') {
    body = [payload.document.correspondent, payload.document.documentType, payload.document.created].filter(Boolean).join(' · ') || payload.document.title;
    headers['Title'] = encodeHeader(title);
    headers['Click'] = payload.document.url;
    headers['Content-Type'] = 'text/plain; charset=utf-8';
  } else if (preset === 'gotify') {
    body = JSON.stringify({ title, message: `${payload.document.url}`, priority: 5, extras: { 'client::notification': { click: { url: payload.document.url } } } });
    headers['Content-Type'] = 'application/json';
  } else {
    body = JSON.stringify(payload);
    headers['Content-Type'] = 'application/json';
  }
  if (secret) headers['X-Paperless-AI-Signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const { result, attempts } = await withRetries(
    `Webhook ${new URL(url).host}`,
    async () => {
      const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000), redirect: 'error' });
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw permanent(`HTTP ${res.status}`);
      return res.status;
    },
    retryDelays.value,
  );
  return { status: result, attempts };
}

/** Header values must be Latin-1; ntfy reads RFC 2047 encoded words. */
function encodeHeader(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

export function smtpConfigured(ctx: AppContext): boolean {
  const s = ctx.cfg.notifications.smtp;
  return Boolean(s.host && s.from);
}

function transport(ctx: AppContext) {
  const s = ctx.cfg.notifications.smtp;
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === 'tls',
    requireTLS: s.security === 'starttls',
    ignoreTLS: s.security === 'none',
    auth: s.username ? { user: s.username, pass: s.password } : undefined,
    connectionTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

export async function sendMail(ctx: AppContext, to: string[], subject: string, text: string): Promise<{ accepted: number; attempts: number }> {
  if (!smtpConfigured(ctx)) throw permanent('E-mail is not set up (Settings → Notifications)');
  if (!to.length) throw permanent('No recipient with an e-mail address');
  const t = transport(ctx);
  try {
    const { result, attempts } = await withRetries(
      'E-mail',
      async () => {
        const info = await t.sendMail({ from: ctx.cfg.notifications.smtp.from, to, subject, text });
        return info.accepted.length;
      },
      retryDelays.value,
    );
    return { accepted: result, attempts };
  } finally {
    t.close();
  }
}

/** Test the SMTP settings (Settings → Notifications). */
export async function verifySmtp(ctx: AppContext): Promise<void> {
  if (!smtpConfigured(ctx)) throw new Error('Host and sender address are needed');
  const t = transport(ctx);
  try {
    await t.verify();
  } finally {
    t.close();
  }
}

/** E-mail addresses of users (directly or through groups) who may read the document. */
export function userAddresses(ctx: AppContext, subject: NotifySubject, users: number[], groups: number[]): string[] {
  return recipients(ctx, subject, users, groups)
    .map((id) => ctx.repos.users.byId(id)?.email)
    .filter((e): e is string => Boolean(e));
}
