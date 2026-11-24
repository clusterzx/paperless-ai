import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { CalendarEvent, CalendarResponse } from '../../shared/api.js';
import type { Services } from '../http/app.js';
import { HttpProblem, notFound } from '../http/helpers.js';
import { buildIcs } from '../calendar/ics.js';
import { CalendarScanner } from '../calendar/scanner.js';
import type { CalendarEventRow } from '../db/calendarRepo.js';
import { logger } from '../logger.js';
import { readableLibraries } from '../access/scope.js';
import { userScope } from '../access/context.js';
import { localDay } from '../../shared/dates.js';

const log = logger.child({ module: 'calendar' });

const FEED_TOKEN_KEY = 'calendar.feedToken';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** The feed covers the last year and everything ahead. */
const FEED_PAST_DAYS = 365;

export const calendarRoutes =
  ({ ctx, ocr }: Services): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();
    const repo = ctx.repos.calendar;
    const scanner = new CalendarScanner(ctx, ocr);
    fastify.addHook('onClose', async () => scanner.stop());

    const enabled = () => ctx.cfg.processing.functions.events;
    const toDto = (r: CalendarEventRow): CalendarEvent => ({
      id: r.id,
      documentId: r.document_id,
      documentTitle: r.document_title,
      url: ctx.documentLink(r.document_id),
      title: r.title,
      date: r.date,
      time: r.time,
      kind: r.kind,
      dismissed: r.dismissed_at !== null,
    });
    /**
     * The feed token of a user (the same link every time – calendar apps keep it). The global token of
     * ≤ 4.4 becomes the token of the first admin who opens the calendar, so existing subscriptions
     * keep working.
     */
    const feedToken = (userId: number, renew = false): string => {
      const feeds = ctx.repos.calendarFeeds;
      const existing = feeds.tokenOf(userId);
      if (!renew && existing) return existing;
      const legacy = ctx.repos.kv.get<string>(FEED_TOKEN_KEY);
      const user = ctx.repos.users.byId(userId);
      if (!renew && !existing && legacy && user?.role === 'admin') {
        feeds.set(userId, legacy);
        ctx.repos.kv.delete(FEED_TOKEN_KEY);
        return legacy;
      }
      const token = randomBytes(24).toString('base64url');
      feeds.set(userId, token);
      return token;
    };
    const feedPath = (token: string) => `/api/calendar/feed/${token}.ics`;
    const userOf = (req: { principal: { kind: string; userId?: number } | null }) => (req.principal?.kind === 'user' ? req.principal.userId! : null);

    app.get(
      '/api/calendar',
      {
        schema: {
          description: 'Appointments, due dates and deadlines found in documents.',
          querystring: z.object({ from: day.optional(), to: day.optional(), dismissed: z.stringbool().default(false) }),
        },
      },
      async (req): Promise<CalendarResponse> => ({
        enabled: enabled(),
        events: repo.list({ ...req.query, libraryIds: req.access ? readableLibraries(req.access) : [] }).map(toDto),
        scannedDocuments: repo.scannedCount(),
        scan: scanner.status,
      }),
    );

    for (const [action, dismissed] of [
      ['dismiss', true],
      ['restore', false],
    ] as const) {
      app.post(`/api/calendar/:id/${action}`, { schema: { params: z.object({ id: z.coerce.number().int().positive() }) } }, async (req) => {
        const event = repo.get(req.params.id);
        // Only dates of documents the caller may read (built-in archive: libraries).
        if (!event || !repo.list({ ids: [event.id], dismissed: true, libraryIds: req.access ? readableLibraries(req.access) : [] }).length) {
          throw notFound('Date not found');
        }
        if (!repo.setDismissed(req.params.id, dismissed)) throw notFound('Date not found');
        return { ok: true };
      });
    }

    app.post(
      '/api/calendar/scan',
      {
        schema: {
          description: 'Search documents that were not searched yet for dates (only the dates are asked for – nothing is changed in Paperless).',
          body: z.object({ months: z.number().int().min(0).max(600).default(12) }).nullish(),
        },
      },
      async (req, reply) => {
        if (!enabled()) throw new HttpProblem(409, 'The calendar is switched off – enable it in Settings → Processing');
        if (!ctx.isConfigured()) throw new HttpProblem(409, 'Paperless-AI is not configured yet');
        const months = req.body?.months ?? 12;
        if (!scanner.start(months)) throw new HttpProblem(409, 'A scan is already running');
        return reply.code(202).send(scanner.status);
      },
    );

    app.get(
      '/api/calendar/feed',
      { config: { auth: 'session' }, schema: { description: 'Path of the private iCal subscription link of the signed-in user (shown once; null when it exists already).' } },
      async (req) => {
        return { path: feedPath(feedToken(userOf(req)!)), exists: true };
      },
    );

    app.post(
      '/api/calendar/feed/reset',
      { config: { auth: 'session' }, schema: { description: 'Create a new subscription link; the old one stops working.' } },
      async (req) => {
        log.info('New calendar subscription link created');
        return { path: feedPath(feedToken(userOf(req)!, true)), exists: true };
      },
    );

    app.get(
      '/api/calendar/feed/:file',
      {
        // Calendar apps cannot log in: the secret token in the path is the authentication.
        config: { auth: 'public', rateLimit: { max: 60, timeWindow: '1 minute' } },
        schema: { hide: true, params: z.object({ file: z.string().max(100) }) },
      },
      async (req, reply) => {
        const given = req.params.file.replace(/\.ics$/, '');
        let userId = ctx.repos.calendarFeeds.userFor(given);
        if (userId === null) {
          // Link of ≤ 4.4 that no admin has opened in the calendar yet: it belongs to the first admin.
          const legacy = ctx.repos.kv.get<string>(FEED_TOKEN_KEY);
          if (legacy && sameSecret(given, legacy)) userId = ctx.repos.users.list().find((u) => u.role === 'admin' && !u.disabled_at)?.id ?? null;
        }
        const scope = userId !== null ? userScope(ctx, userId) : null;
        if (!scope) return reply.code(404).send({ error: 'Not found' });
        const from = localDay(new Date(Date.now() - FEED_PAST_DAYS * 86_400_000));
        const ics = buildIcs(
          repo.list({ from, libraryIds: readableLibraries(scope) }).map((r) => ({
            id: r.id,
            documentId: r.document_id,
            documentTitle: r.document_title,
            title: r.title,
            date: r.date,
            time: r.time,
            kind: r.kind,
            url: ctx.documentLink(r.document_id),
          })),
        );
        return reply
          .header('Content-Type', 'text/calendar; charset=utf-8')
          .header('Content-Disposition', 'inline; filename="paperless-ai.ics"')
          .header('Cache-Control', 'private, max-age=300')
          .send(ics);
      },
    );
  };

/** Constant-time comparison of two secrets of any length. */
function sameSecret(a: string, b: string): boolean {
  const h = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(a), h(b));
}
