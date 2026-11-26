/**
 * Remote OCR for Paperless-ngx: the part of the Azure AI Document Intelligence REST API (2024-11-30)
 * that Paperless-ngx uses with PAPERLESS_REMOTE_OCR_ENGINE=azureai – analyse a document with the
 * model prebuilt-read, poll for the result, fetch the searchable PDF. The key comes in the
 * `Ocp-Apim-Subscription-Key` header: an API key of Paperless-AI with the `ocr` scope.
 *
 *   POST /documentintelligence/documentModels/prebuilt-read:analyze?api-version=…&output=pdf
 *        { "base64Source": "…" }                     → 202, Operation-Location: …/analyzeResults/{id}
 *   GET  /documentintelligence/documentModels/prebuilt-read/analyzeResults/{id}      → status, text
 *   GET  /documentintelligence/documentModels/prebuilt-read/analyzeResults/{id}/pdf  → the PDF
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Services } from '../http/app.js';
import { RemoteOcr, RemoteOcrBusy, type RemoteJob } from '../ocr/remote.js';

/** The models Paperless-AI answers for (all of them read text; layout and tables are not analysed). */
const MODELS = new Set(['prebuilt-read', 'prebuilt-layout', 'prebuilt-document']);
const API_VERSION = '2024-11-30';
const BASE = '/documentintelligence/documentModels';

export const remoteOcrRoutes =
  ({ ctx, ocr }: Services): FastifyPluginAsync =>
  async (app) => {
    const remote = new RemoteOcr(ctx, ocr);
    app.addHook('onClose', async () => remote.idle());

    // Base64 in JSON is a third larger than the file.
    const bodyLimit = Math.ceil(ctx.cfg.archive.builtin.maxUploadMb * 1.4 + 2) * 1024 * 1024;
    // The file itself as the body works too (other clients of the API send it that way).
    const raw = (_req: FastifyRequest, body: string | Buffer, done: (err: Error | null, body?: unknown) => void) =>
      done(null, body);
    app.addContentTypeParser(['application/octet-stream', 'application/pdf'], { parseAs: 'buffer', bodyLimit }, raw);
    app.addContentTypeParser(/^image\//, { parseAs: 'buffer', bodyLimit }, raw);

    const fail = (reply: FastifyReply, status: number, code: string, message: string) =>
      reply.code(status).send({ error: { code, message } });
    const ownerOf = (req: FastifyRequest) => {
      const p = req.principal;
      return p?.kind === 'user' ? `user:${p.userId}` : (p?.kind ?? 'none');
    };
    const versionOf = (req: FastifyRequest) => String((req.query as Record<string, unknown>)['api-version'] ?? API_VERSION);
    const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const jobOf = (req: FastifyRequest, reply: FastifyReply): RemoteJob | null => {
      const { model, id } = req.params as { model: string; id: string };
      const job = remote.get(id, ownerOf(req));
      if (job && job.model === model) return job;
      void fail(
        reply,
        404,
        'NotFound',
        'Paperless-AI has no such analysis (it expired, or Paperless-AI was restarted meanwhile)',
      );
      return null;
    };

    app.post(`${BASE}/:modelAction`, { config: { auth: 'user' }, bodyLimit, schema: { hide: true } }, async (req, reply) => {
      const action = /^(.+):analyze$/.exec((req.params as { modelAction: string }).modelAction);
      if (!action)
        return fail(reply, 404, 'NotFound', 'Paperless-AI only analyses documents (…/documentModels/prebuilt-read:analyze)');
      const model = action[1];
      if (!MODELS.has(model))
        return fail(
          reply,
          404,
          'ModelNotFound',
          `Paperless-AI reads documents with the model "prebuilt-read" – "${model}" is not available`,
        );
      if (!ctx.cfg.ocr.enabled || !ctx.cfg.ocr.remoteEndpoint) {
        return fail(
          reply,
          403,
          'Forbidden',
          'OCR for Paperless-ngx is switched off – turn it on in Paperless-AI: Settings → OCR',
        );
      }
      let bytes: Buffer;
      if (Buffer.isBuffer(req.body)) bytes = req.body;
      else {
        const body = (req.body ?? {}) as { base64Source?: unknown; urlSource?: unknown };
        if (body.urlSource !== undefined)
          return fail(
            reply,
            400,
            'InvalidRequest',
            'Paperless-AI does not download files (urlSource) – send the file itself (base64Source)',
          );
        if (typeof body.base64Source !== 'string')
          return fail(reply, 400, 'InvalidRequest', 'The request holds no file (base64Source)');
        bytes = Buffer.from(body.base64Source, 'base64');
      }
      if (!bytes.length) return fail(reply, 400, 'InvalidRequest', 'The file is empty');
      const output = String((req.query as Record<string, unknown>).output ?? '')
        .split(',')
        .map((o) => o.trim().toLowerCase());
      let job: RemoteJob;
      try {
        job = remote.submit(bytes, { owner: ownerOf(req), model, wantsPdf: output.includes('pdf') });
      } catch (err) {
        if (err instanceof RemoteOcrBusy) return fail(reply.header('Retry-After', '30'), 429, 'TooManyRequests', err.message);
        throw err;
      }
      const location = `${req.protocol}://${req.host}${BASE}/${model}/analyzeResults/${job.id}?api-version=${encodeURIComponent(versionOf(req))}`;
      return reply
        .code(202)
        .header('Operation-Location', location)
        .header('apim-request-id', job.id)
        .header('Retry-After', '1')
        .send();
    });

    app.get(`${BASE}/:model/analyzeResults/:id`, { config: { auth: 'user' }, schema: { hide: true } }, async (req, reply) => {
      const job = jobOf(req, reply);
      if (!job) return reply;
      const body: Record<string, unknown> = {
        status: job.status,
        createdDateTime: iso(job.created),
        lastUpdatedDateTime: iso(job.updated),
      };
      if (job.status === 'succeeded') {
        body.analyzeResult = {
          apiVersion: versionOf(req),
          modelId: job.model,
          stringIndexType: 'textElements',
          contentFormat: 'text',
          content: job.text ?? '',
          pages: job.pages ?? [],
          paragraphs: [],
          styles: [],
        };
      } else if (job.status === 'failed') body.error = job.error;
      else reply.header('Retry-After', '1');
      return body;
    });

    app.get(`${BASE}/:model/analyzeResults/:id/pdf`, { config: { auth: 'user' }, schema: { hide: true } }, async (req, reply) => {
      const job = jobOf(req, reply);
      if (!job) return reply;
      if (job.status !== 'succeeded')
        return fail(reply, 404, 'NotFound', `The analysis is ${job.status === 'failed' ? 'failed' : 'not finished yet'}`);
      if (!job.pdf) return fail(reply, 404, 'NotFound', 'No PDF was asked for (output=pdf)');
      remote.fetched(job);
      return reply.type('application/pdf').send(Buffer.from(job.pdf));
    });
  };
