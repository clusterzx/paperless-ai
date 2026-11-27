/**
 * Profile pictures (#1045).
 *
 *   GET    /api/users/:id/avatar      the picture of an account (every signed-in user, keys with `read`)
 *   GET    /api/account/avatar        the own picture
 *   PUT    /api/account/avatar        set the own picture (multipart field "file", or the image as the body)
 *   DELETE /api/account/avatar        remove it
 *   PUT    /api/users/:id/avatar      administrators, signed-in browser: the picture of any account
 *   DELETE /api/users/:id/avatar
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Services } from '../http/app.js';
import { HttpProblem, notFound } from '../http/helpers.js';
import { audit } from '../access/context.js';
import { AVATAR_MAX_BYTES, avatarUrl, normalizeAvatar } from '../avatars.js';
import { etagMatches } from './documents.js';

const id = z.object({ id: z.coerce.number().int().positive() });
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'];

export const avatarRoutes =
  ({ ctx }: Services): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();
    // The picture itself as the body (apps); a bit more than the limit, so a larger one gets a clear 413.
    app.addContentTypeParser(IMAGE_TYPES, { parseAs: 'buffer', bodyLimit: AVATAR_MAX_BYTES + 64 * 1024 }, (_req, body, done) => done(null, body));

    const own = (req: FastifyRequest) => {
      const p = req.principal;
      if (p?.kind !== 'user') throw new HttpProblem(403, 'Only accounts have a profile picture');
      return p.userId;
    };
    const account = (userId: number) => {
      const u = ctx.repos.users.byId(userId);
      if (!u) throw notFound('User not found');
      return u;
    };

    const received = async (req: FastifyRequest): Promise<Buffer> => {
      if (req.isMultipart()) {
        let part;
        try {
          part = await req.file({ limits: { fileSize: AVATAR_MAX_BYTES, files: 1 } });
          if (!part) throw new HttpProblem(400, 'Send the picture in the multipart field "file"');
          return await part.toBuffer();
        } catch (err) {
          if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw new HttpProblem(413, 'The picture is larger than 2 MB');
          throw err;
        }
      }
      if (Buffer.isBuffer(req.body) && req.body.length) return req.body;
      throw new HttpProblem(400, 'Send a PNG, JPEG or WebP picture: multipart field "file", or the picture as the body with its content type');
    };

    const send = (req: FastifyRequest, reply: FastifyReply, userId: number) => {
      const a = ctx.repos.users.avatar(userId);
      if (!a) throw notFound('No profile picture');
      reply
        .header('ETag', `"${a.sha256}"`)
        .header('Cache-Control', 'private, no-cache')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Last-Modified', new Date(a.updated_at).toUTCString());
      if (etagMatches(req.headers['if-none-match'], a.sha256)) return reply.code(304).send();
      return reply.type('image/webp').send(a.image);
    };

    const store = async (req: FastifyRequest, userId: number) => {
      const { image, sha256 } = await normalizeAvatar(await received(req));
      ctx.repos.users.setAvatar(userId, image, sha256);
      return { avatarUrl: avatarUrl(userId, sha256) };
    };

    // ---------------------------------------------------------------- reading

    app.get(
      '/api/users/:id/avatar',
      { schema: { tags: ['Accounts'], summary: 'The profile picture of an account (256×256 WebP, 404 without one)', params: id } },
      async (req, reply) => send(req, reply, account(req.params.id).id),
    );
    app.get('/api/account/avatar', { schema: { tags: ['Accounts'], summary: 'The own profile picture' } }, async (req, reply) => send(req, reply, own(req)));

    // ---------------------------------------------------------------- the own picture

    app.put(
      '/api/account/avatar',
      {
        schema: {
          tags: ['Accounts'],
          summary: 'Set the own profile picture',
          description: 'PNG, JPEG or WebP up to 2 MB (multipart field "file", or the picture as the body). It is stored as a 256×256 WebP.',
        },
      },
      async (req) => {
        const userId = own(req);
        const res = await store(req, userId);
        audit(ctx, req.access, 'user.avatar_changed', `user:${userId}`);
        return res;
      },
    );
    app.delete('/api/account/avatar', { schema: { tags: ['Accounts'], summary: 'Remove the own profile picture' } }, async (req) => {
      const userId = own(req);
      if (ctx.repos.users.deleteAvatar(userId)) audit(ctx, req.access, 'user.avatar_removed', `user:${userId}`);
      return { ok: true };
    });

    // ---------------------------------------------------------------- administrators

    app.put(
      '/api/users/:id/avatar',
      { config: { auth: 'session' }, schema: { tags: ['Accounts'], summary: 'Set the profile picture of an account (administrators)', params: id } },
      async (req) => {
        const user = account(req.params.id);
        const res = await store(req, user.id);
        audit(ctx, req.access, 'user.avatar_changed', `user:${user.id}`, { username: user.username });
        return res;
      },
    );
    app.delete(
      '/api/users/:id/avatar',
      { config: { auth: 'session' }, schema: { tags: ['Accounts'], summary: 'Remove the profile picture of an account (administrators)', params: id } },
      async (req) => {
        const user = account(req.params.id);
        if (ctx.repos.users.deleteAvatar(user.id)) audit(ctx, req.access, 'user.avatar_removed', `user:${user.id}`, { username: user.username });
        return { ok: true };
      },
    );
  };
