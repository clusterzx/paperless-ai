/**
 * OCR API server (ocr/apiServer.ts), switched on with `ocr.apiServer`. Two ways in, both with an API
 * key of Paperless-AI with the `ocr` scope:
 *
 * 1. The part of the Azure AI Document Intelligence REST API (2024-11-30) that Paperless-ngx uses as
 *    its remote OCR engine (PAPERLESS_REMOTE_OCR_ENGINE=azureai) – and other clients of that API.
 *    The key comes as `Ocp-Apim-Subscription-Key`.
 *      POST /documentintelligence/documentModels/prebuilt-read:analyze?api-version=…&output=pdf
 *           { "base64Source": "…" }                    → 202, Operation-Location: …/analyzeResults/{id}
 *      GET  /documentintelligence/documentModels/prebuilt-read/analyzeResults/{id}      → status, text
 *      GET  /documentintelligence/documentModels/prebuilt-read/analyzeResults/{id}/pdf  → the PDF
 *
 * 2. A simple API for scripts and other apps: send the file, wait, get the answer.
 *      POST /api/ocr/read?format=json|text|pdf   (multipart "file", or the file as the body)
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Services } from '../http/app.js';
import { HttpProblem } from '../http/helpers.js';
import { OcrApiBusy, OcrApiServer, type OcrJob } from '../ocr/apiServer.js';

/** The Azure models Paperless-AI answers for (all of them read text; layout and tables are not analysed). */
const MODELS = new Set(['prebuilt-read', 'prebuilt-layout', 'prebuilt-document']);
const API_VERSION = '2024-11-30';
const BASE = '/documentintelligence/documentModels';
const OFF = 'The OCR API server of Paperless-AI is switched off – turn it on in Settings → OCR → OCR API server';

export const ocrApiRoutes =
  ({ ctx, ocr }: Services): FastifyPluginAsync =>
  async (app) => {
    const server = new OcrApiServer(ctx, ocr);
    app.addHook('onClose', async () => server.idle());

    // Base64 in JSON is a third larger than the file.
    const bodyLimit = Math.ceil(ctx.cfg.archive.builtin.maxUploadMb * 1.4 + 2) * 1024 * 1024;
    // The file itself as the body.
    const raw = (_req: FastifyRequest, body: string | Buffer, done: (err: Error | null, body?: unknown) => void) =>
      done(null, body);
    app.addContentTypeParser(['application/octet-stream', 'application/pdf'], { parseAs: 'buffer', bodyLimit }, raw);
    app.addContentTypeParser(/^image\//, { parseAs: 'buffer', bodyLimit }, raw);

    const ownerOf = (req: FastifyRequest) => {
      const p = req.principal;
      return p?.kind === 'user' ? `user:${p.userId}` : (p?.kind ?? 'none');
    };
    const unavailable = async () => !(await ocr.isAvailable());

    // ---------------------------------------------------------------- Azure AI Document Intelligence

    const fail = (reply: FastifyReply, status: number, code: string, message: string) =>
      reply.code(status).send({ error: { code, message } });
    const versionOf = (req: FastifyRequest) => String((req.query as Record<string, unknown>)['api-version'] ?? API_VERSION);
    const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const jobOf = (req: FastifyRequest, reply: FastifyReply): OcrJob | null => {
      const { model, id } = req.params as { model: string; id: string };
      const job = server.get(id, ownerOf(req));
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
      if (!ctx.cfg.ocr.apiServer) return fail(reply, 403, 'Forbidden', OFF);
      if (await unavailable())
        return fail(reply, 503, 'ServiceUnavailable', 'OCR is not available in this installation of Paperless-AI');
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
      let job: OcrJob;
      try {
        job = server.submit(bytes, { owner: ownerOf(req), model, wantsPdf: output.includes('pdf') });
      } catch (err) {
        if (err instanceof OcrApiBusy) return fail(reply.header('Retry-After', '30'), 429, 'TooManyRequests', err.message);
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
          pages: (job.pages ?? []).map((p, i) => ({
            pageNumber: i + 1,
            angle: 0,
            width: p.width,
            height: p.height,
            unit: 'pixel',
            spans: [{ offset: p.offset, length: p.text.length }],
          })),
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
      server.fetched(job);
      return reply.type('application/pdf').send(Buffer.from(job.pdf));
    });

    // ---------------------------------------------------------------- simple API

    app.post(
      '/api/ocr/read',
      {
        config: { auth: 'user' },
        bodyLimit,
        schema: {
          tags: ['OCR'],
          summary: 'Read a file with the OCR API server',
          description:
            'Send a PDF or an image (multipart field "file", or the file itself as the body) and get its text back once it is read. ' +
            '`format=json`: the text, and per page its text and lines (corners in fractions of the page, in reading order); `text`: plain text; ' +
            '`pdf`: the searchable PDF. Needs the OCR API server (Settings → OCR) and an API key with the `ocr` permission.',
          querystring: z.object({ format: z.enum(['json', 'text', 'pdf']).default('json') }),
        },
      },
      async (req, reply) => {
        if (!ctx.cfg.ocr.apiServer) throw new HttpProblem(403, OFF);
        if (await unavailable())
          throw new HttpProblem(
            503,
            'OCR is not available in this installation (onnxruntime-node, sharp or @hyzyla/pdfium missing)',
          );
        let bytes: Buffer | null = null;
        if (req.isMultipart()) {
          const part = await req.file();
          if (part) bytes = await part.toBuffer();
        } else if (Buffer.isBuffer(req.body)) bytes = req.body;
        if (!bytes?.length)
          throw new HttpProblem(400, 'Send a PDF or an image: multipart field "file", or the file itself with its content type');
        const { format } = req.query as { format: 'json' | 'text' | 'pdf' };
        let job: OcrJob;
        try {
          job = server.submit(bytes, { owner: ownerOf(req), model: 'api', wantsPdf: format === 'pdf' });
        } catch (err) {
          if (err instanceof OcrApiBusy) {
            reply.header('Retry-After', '30');
            throw new HttpProblem(429, err.message);
          }
          throw err;
        }
        const started = Date.now();
        await job.done;
        server.discard(job);
        if (job.status === 'failed') throw new HttpProblem(500, job.error?.message ?? 'Paperless-AI could not read the file');
        if (job.ocrError) throw new HttpProblem(422, `Paperless-AI could not read the file: ${job.ocrError}`);
        if (format === 'pdf') return reply.type('application/pdf').send(Buffer.from(job.pdf!));
        if (format === 'text') return reply.type('text/plain; charset=utf-8').send(job.text ?? '');
        return {
          text: job.text ?? '',
          pages: (job.pages ?? []).map((p, i) => ({
            page: i + 1,
            width: p.width,
            height: p.height,
            rotation: p.rotation,
            text: p.text,
            lines: p.layout.lines,
          })),
          durationMs: Date.now() - started,
        };
      },
    );
  };
