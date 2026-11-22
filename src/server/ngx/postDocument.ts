/**
 * The upload endpoint of Paperless-ngx (`POST /api/documents/post_document/`): scanner apps,
 * shortcuts and the Paperless-ngx mobile apps upload with it. Served at the same path as before
 * (/api/documents/post_document/) and in the compatible API (/ngx/api/documents/post_document/).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { LocalBackend } from '../archive/backend.js';
import { notSupported } from '../backend/types.js';
import { badRequest, HttpProblem } from '../http/helpers.js';
import { receiveUploads } from '../routes/documentOps.js';
import { documentDateOf, taskIdOf } from './format.js';

export function postDocumentHandler(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const b = ctx.archive();
    if (!(b instanceof LocalBackend)) throw notSupported('post_document');
    const results = await receiveUploads(
      ctx,
      req,
      'api',
      {},
      async (fields) => {
        // Ids of tags, correspondents and types are those of the lists the client got (all readable
        // libraries); they are taken over by name into the library the document goes to.
        const scopes = (await ctx.backend(req.access!).metadataScopes()).filter((l): l is number | null => l !== undefined);
        const snaps = await Promise.all(scopes.map((l) => ctx.metadata(l).snapshot()));
        const name = (kind: 'tag' | 'correspondent' | 'documentType', v: string) => {
          const n = Number(v);
          if (!Number.isInteger(n)) return v;
          for (const s of snaps) {
            const found = (kind === 'tag' ? s.tags : kind === 'correspondent' ? s.correspondents : s.documentTypes).find((x) => x.id === n);
            if (found) return found.name;
          }
          return undefined;
        };
        return {
          title: fields.title?.[0],
          created: documentDateOf(fields.created?.[0]) ?? undefined,
          correspondent: fields.correspondent?.[0] ? name('correspondent', fields.correspondent[0]) : undefined,
          documentType: fields.document_type?.[0] ? name('documentType', fields.document_type[0]) : undefined,
          tags: (fields.tags ?? []).map((t) => name('tag', t)).filter((t): t is string => Boolean(t)),
          archiveSerialNumber: fields.archive_serial_number?.[0] ? Number(fields.archive_serial_number[0]) : undefined,
        };
      },
      'document',
    );
    const r = results[0];
    if (r.status === 'rejected') throw badRequest(r.reason ?? 'The document was not accepted');
    if (r.status === 'failed') throw new HttpProblem(503, r.reason ?? 'The document could not be stored – send it again');
    // Paperless-ngx answers with the id of the consumption task (a UUID) as a JSON string.
    return reply.type('application/json').send(JSON.stringify(taskIdOf(r.intakeId ?? 0)));
  };
}
