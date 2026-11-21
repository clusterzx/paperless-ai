/**
 * WebDAV inbox at /dav/inbox/ (docs/standalone/ingest.md): scanners and file managers put files
 * there, each file goes to the archive like an upload. Authentication: HTTP Basic with an API key
 * (scope `upload`) as the password; the user name is ignored.
 *
 *   /dav/inbox/<file>                    → the user's first library they can add to
 *   /dav/inbox/<library>/<file>          → that library (built-in archive)
 *   /dav/inbox/<library>/<a>/<b>/<file>  → plus the tags "a" and "b" (like watch folders)
 *
 * Nothing is ever listed or downloaded: the inbox looks empty, except for files put there in the
 * last minutes (some clients check after the upload that the file exists).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Services } from '../http/app.js';
import { canEdit, readableLibraries } from '../access/scope.js';
import { statusOf } from '../backend/types.js';
import { describeError } from '../util/http.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'webdav' });

export const DAV_METHODS = ['PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK'];
const ROOT = '/dav/inbox';
const RECENT_MS = 10 * 60_000;

function xmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

function entry(href: string, collection: boolean, size = 0, modified = new Date()): string {
  return `<D:response><D:href>${xmlEscape(encodeURI(href))}</D:href><D:propstat><D:prop>
<D:displayname>${xmlEscape(decodeURIComponent(path.posix.basename(href)) || 'inbox')}</D:displayname>
<D:resourcetype>${collection ? '<D:collection/>' : ''}</D:resourcetype>
${collection ? '' : `<D:getcontentlength>${size}</D:getcontentlength><D:getcontenttype>application/octet-stream</D:getcontenttype>`}
<D:getlastmodified>${modified.toUTCString()}</D:getlastmodified>
<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>
</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function multistatus(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${body}</D:multistatus>`;
}

export const davRoutes =
  ({ ctx }: Services): FastifyPluginAsync =>
  async (app) => {
    // The bodies (files, XML) are read as streams here.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

    /** Files put recently (path → size), so a check right after the upload finds them. */
    const recent = new Map<string, { size: number; at: number }>();
    const remember = (p: string, size: number) => {
      const now = Date.now();
      for (const [k, v] of recent) if (now - v.at > RECENT_MS) recent.delete(k);
      recent.set(`${p}`, { size, at: now });
    };

    const enabled = () => ctx.cfg.archive.builtin.webdav && ctx.archiveConfigured();
    /** Path segments below /dav/inbox/ (decoded, without empty ones). */
    const segments = (req: FastifyRequest) =>
      decodeURIComponent(req.url.split('?')[0].slice(ROOT.length))
        .split('/')
        .filter(Boolean);
    /** Libraries the caller may add to (built-in archive); null in companion mode. */
    const libraries = (req: FastifyRequest) => {
      if (!ctx.archive().capabilities.libraries) return null;
      const libs = readableLibraries(req.access!) ?? ctx.repos.libraries.list().map((l) => l.id);
      return ctx.repos.libraries
        .list()
        .filter((l) => libs.includes(l.id) && canEdit(req.access!, l.id))
        .map((l) => ({ id: l.id, name: l.name }));
    };
    /** Target library and tags of a path. */
    const target = (req: FastifyRequest, segs: string[]) => {
      const libs = libraries(req);
      if (!libs || !segs.length) return { libraryId: undefined, tags: segs };
      const lib = libs.find((l) => l.name.toLowerCase() === segs[0].toLowerCase());
      return lib ? { libraryId: lib.id, tags: segs.slice(1) } : { libraryId: undefined, tags: segs };
    };
    const notFound = (reply: FastifyReply) => reply.code(404).type('text/plain').send('Not found');
    const drain = async (body: unknown) => {
      if (body && typeof (body as Readable).resume === 'function') (body as Readable).resume();
    };

    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!enabled()) return notFound(reply);
      const segs = segments(req);
      const href = `${ROOT}/${segs.join('/')}`;
      switch (req.method) {
        case 'PROPFIND': {
          await drain(req.body);
          const depth = String(req.headers.depth ?? '1');
          const known = recent.get(href);
          if (known) return reply.code(207).type('application/xml; charset=utf-8').send(multistatus(entry(href, false, known.size, new Date(known.at))));
          // Everything else is a (virtual, empty) folder; the root lists the libraries.
          let body = entry(`${href}/`.replace(/\/+$/, '/'), true);
          if (depth !== '0' && !segs.length) for (const l of libraries(req) ?? []) body += entry(`${ROOT}/${l.name}/`, true);
          if (depth !== '0') for (const [p, f] of recent) if (path.posix.dirname(p) === href.replace(/\/$/, '')) body += entry(p, false, f.size, new Date(f.at));
          return reply.code(207).type('application/xml; charset=utf-8').send(multistatus(body));
        }
        case 'PUT': {
          const name = segs.at(-1);
          if (!name) return reply.code(405).send();
          // AppleDouble files, .DS_Store, Office lock files: accepted and dropped.
          if (name.startsWith('.') || name.startsWith('~$')) {
            await drain(req.body);
            return reply.code(201).send();
          }
          const limit = ctx.cfg.archive.builtin.maxUploadMb * 1024 * 1024;
          const dir = path.join(ctx.dataDir, 'tmp');
          fs.mkdirSync(dir, { recursive: true });
          const tmp = path.join(dir, `dav-${randomUUID()}`);
          let size = 0;
          try {
            const counter = new Transform({
              transform(chunk: Buffer, _enc, cb) {
                size += chunk.length;
                if (size > limit) cb(Object.assign(new Error('too large'), { tooLarge: true }));
                else cb(null, chunk);
              },
            });
            await pipeline(req.body as Readable, counter, fs.createWriteStream(tmp));
          } catch (err) {
            fs.rmSync(tmp, { force: true });
            if ((err as { tooLarge?: boolean }).tooLarge) return reply.code(413).send();
            throw err;
          }
          // Windows creates the file empty first and writes it in a second PUT.
          if (size === 0) {
            fs.rmSync(tmp, { force: true });
            remember(href, 0);
            return reply.code(201).send();
          }
          const { libraryId, tags } = target(req, segs.slice(0, -1));
          try {
            const res = await ctx.backend(req.access!).ingest({ path: tmp, filename: name }, 'webdav', { libraryId, tags: tags.length ? tags : undefined, context: { folder: segs.slice(0, -1).join('/') } });
            if (res.status === 'rejected') return reply.code(415).type('text/plain').send(res.reason ?? 'Not accepted');
            remember(href, size);
            log.info(`WebDAV: "${name}" ${res.status}${res.documentId ? ` (document ${res.documentId})` : ''}`);
            return reply.code(201).send();
          } catch (err) {
            const status = statusOf(err) ?? 500;
            return reply.code(status === 404 || status === 403 ? 403 : status >= 500 ? 500 : 415).type('text/plain').send(describeError(err));
          } finally {
            fs.rmSync(tmp, { force: true });
          }
        }
        case 'MKCOL':
          await drain(req.body);
          return reply.code(201).send();
        case 'DELETE':
          recent.delete(href);
          return reply.code(204).send();
        case 'MOVE':
        case 'COPY': {
          // Uploads under a temporary name that are renamed afterwards are stored already.
          const dest = String(req.headers.destination ?? '');
          if (dest) {
            const destPath = decodeURIComponent(new URL(dest, 'http://x').pathname);
            const known = recent.get(href);
            if (known) remember(destPath, known.size);
          }
          return reply.code(201).send();
        }
        case 'LOCK': {
          await drain(req.body);
          const token = `opaquelocktoken:${randomUUID()}`;
          return reply
            .code(200)
            .header('Lock-Token', `<${token}>`)
            .type('application/xml; charset=utf-8')
            .send(
              `<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth><D:timeout>Second-3600</D:timeout><D:locktoken><D:href>${token}</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>`,
            );
        }
        case 'UNLOCK':
          return reply.code(204).send();
        case 'PROPPATCH':
          await drain(req.body);
          return reply.code(207).type('application/xml; charset=utf-8').send(multistatus(entry(href, segs.length === 0)));
        case 'GET':
        case 'HEAD': {
          if (recent.has(href)) return reply.code(404).send();
          return reply.type('text/plain; charset=utf-8').send('Paperless-AI inbox – put files here (WebDAV). They are stored in the archive and do not stay in this folder.\n');
        }
        default:
          return reply.code(405).send();
      }
    };

    const methods = ['GET', 'HEAD', 'PUT', 'DELETE', ...DAV_METHODS] as const;
    // Trailing slashes are ignored by the router: /dav/inbox and /dav/inbox/ are one route.
    for (const url of [ROOT, `${ROOT}/*`]) {
      app.route({ method: methods as unknown as string[], url, config: { auth: 'user' }, schema: { hide: true }, handler });
    }
  };
