/**
 * Remote OCR for Paperless-ngx: Paperless-ngx (PAPERLESS_REMOTE_OCR_ENGINE=azureai) sends the scans
 * it consumes to Paperless-AI in the protocol of Azure AI Document Intelligence and gets the text
 * and a searchable PDF back. The requests are the ones the Azure SDK makes (recorded from it); with
 * PAI_AZURE_SDK_PYTHON=<python with azure-ai-documentintelligence> the real SDK is used as well.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import type { OcrStatus } from '../../src/shared/api.js';
import { inspectFile } from '../../src/server/archive/files.js';
import { analysisJson, createHarness, makeTempDir, TEST_USER, waitFor, type Harness } from '../helpers/appHarness.js';
import { makeScanPdf } from '../helpers/pdf.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const OCR_TEXT = 'Rechnung Nr. 4711 der Stadtwerke Musterstadt über 106,72 EUR vom 03.11.2026';
const ANALYZE =
  '/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30&outputContentFormat=text&output=pdf';

async function harness(remoteEndpoint = true): Promise<{ hh: Harness; key: string }> {
  h = await createHarness({ config: { ocr: { enabled: true, mode: 'always', remoteEndpoint } } });
  h.llm.reply(analysisJson({ title: 'Stromrechnung November 2026' }));
  await h.login();
  const admin = h.ctx.repos.users.byUsername(TEST_USER)!;
  return { hh: h, key: h.ctx.repos.apiKeys.create(admin.id, { name: 'Paperless-ngx OCR', scopes: ['ocr'] }).key };
}

const headers = (key: string) => ({ 'ocp-apim-subscription-key': key, 'content-type': 'application/json' });

/** What the Azure SDK does: send the file, poll the Operation-Location, fetch the PDF. */
async function analyze(hh: Harness, key: string, file: Buffer) {
  const sent = await hh.inject({
    method: 'POST',
    url: ANALYZE,
    headers: headers(key),
    payload: { base64Source: file.toString('base64') },
  });
  expect(sent.statusCode, sent.body).toBe(202);
  const location = new URL(String(sent.headers['operation-location']));
  expect(location.pathname).toMatch(/^\/documentintelligence\/documentModels\/prebuilt-read\/analyzeResults\/[\w-]+$/);
  expect(location.searchParams.get('api-version')).toBe('2024-11-30');
  let result: { status: string; analyzeResult?: { content: string; pages: unknown[] }; error?: { message: string } } = {
    status: 'notStarted',
  };
  await waitFor(async () => {
    const res = await hh.inject({
      method: 'GET',
      url: location.pathname + location.search,
      headers: { 'ocp-apim-subscription-key': key },
    });
    expect(res.statusCode).toBe(200);
    result = res.json();
    return result.status === 'succeeded' || result.status === 'failed';
  }, 10_000);
  const pdf = await hh.inject({
    method: 'GET',
    url: `${location.pathname}/pdf${location.search}`,
    headers: { 'ocp-apim-subscription-key': key },
  });
  return { result, pdf, location };
}

describe('remote OCR for Paperless-ngx', () => {
  it('reads a scan and gives back its text and a searchable PDF, as the Azure SDK asks for them', async () => {
    const { hh, key } = await harness();
    const scan = makeScanPdf(2);
    hh.ocrEngine.pages = 2;
    const { result, pdf } = await analyze(hh, key, scan);
    expect(result.status).toBe('succeeded');
    expect(result.analyzeResult!.content).toBe(`${OCR_TEXT}\n\n${OCR_TEXT}`);
    expect(result.analyzeResult!.pages).toHaveLength(2);
    expect(result.analyzeResult!.pages[1]).toMatchObject({
      pageNumber: 2,
      spans: [{ offset: OCR_TEXT.length + 2, length: OCR_TEXT.length }],
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const info = await inspectFile(pdf.rawPayload, 'application/pdf');
    expect(info.pages).toBe(2);
    expect(info.text).toContain(OCR_TEXT);

    const cookie = await hh.login();
    const status = (await hh.inject({ method: 'GET', url: '/api/ocr/status', headers: { cookie } })).json() as OcrStatus;
    expect(status.remote).toMatchObject({ enabled: true, readToday: 1, lastAt: expect.any(Number) });
  });

  it('turns a photo into a PDF', async () => {
    const { hh, key } = await harness();
    const jpeg = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#ffffff' } })
      .jpeg()
      .toBuffer();
    const { result, pdf } = await analyze(hh, key, jpeg);
    expect(result.analyzeResult!.content).toBe(OCR_TEXT);
    expect((await inspectFile(pdf.rawPayload, 'application/pdf')).text).toContain(OCR_TEXT);
  });

  it('does not read the document again when it arrives from Paperless-ngx with that text', async () => {
    const { hh, key } = await harness();
    await analyze(hh, key, makeScanPdf());
    expect(hh.ocrEngine.calls).toHaveLength(1);
    // Paperless-ngx stored the text (white space may differ) and calls the webhook.
    hh.paperless.addDocument({
      id: 7,
      title: 'scan.pdf',
      content: `  ${OCR_TEXT.replace(/ /g, '  ')}\n`,
      file: { data: makeScanPdf(), contentType: 'application/pdf' },
    });
    hh.engine.enqueue(7, { source: 'webhook' });
    await hh.engine.drain(10_000);
    expect(hh.ocrEngine.calls).toHaveLength(1); // mode "always", yet not read again
    expect(hh.paperless.docs.get(7)!.title).toBe('Stromrechnung November 2026');
  });

  it('hands back the file without text when the OCR fails – Paperless-ngx still gets its document', async () => {
    const { hh, key } = await harness();
    hh.ocrEngine.error = new Error('OCR worker exited unexpectedly (SIGKILL)');
    const scan = makeScanPdf();
    const { result, pdf } = await analyze(hh, key, scan);
    expect(result).toMatchObject({ status: 'succeeded', analyzeResult: { content: '' } });
    expect(Buffer.compare(pdf.rawPayload, scan)).toBe(0);
  });

  it('accepts the file itself as the body', async () => {
    const { hh, key } = await harness();
    const sent = await hh.inject({
      method: 'POST',
      url: ANALYZE,
      headers: { 'ocp-apim-subscription-key': key, 'content-type': 'application/pdf' },
      payload: makeScanPdf(),
    });
    expect(sent.statusCode, sent.body).toBe(202);
  });

  it('answers in the error format of Azure and only to keys with the OCR permission', async () => {
    const { hh, key } = await harness();
    const body = { base64Source: makeScanPdf().toString('base64') };
    const noKey = await hh.inject({
      method: 'POST',
      url: ANALYZE,
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(noKey.statusCode).toBe(401);
    expect(noKey.json().error.message).toMatch(/API key of Paperless-AI/);

    const admin = hh.ctx.repos.users.byUsername(TEST_USER)!;
    const readKey = hh.ctx.repos.apiKeys.create(admin.id, { name: 'reader', scopes: ['read'] }).key;
    const wrongScope = await hh.inject({ method: 'POST', url: ANALYZE, headers: headers(readKey), payload: body });
    expect(wrongScope.statusCode).toBe(403);
    expect(wrongScope.json().error).toMatchObject({ code: 'scope_missing', message: expect.stringMatching(/"ocr" scope/) });
    // … and the OCR key opens nothing else.
    expect((await hh.inject({ method: 'GET', url: '/api/documents', headers: { 'x-api-key': key } })).statusCode).toBe(403);

    const url = await hh.inject({
      method: 'POST',
      url: ANALYZE,
      headers: headers(key),
      payload: { urlSource: 'http://169.254.169.254/latest' },
    });
    expect(url.statusCode).toBe(400);
    expect(url.json().error.code).toBe('InvalidRequest');
    const model = await hh.inject({
      method: 'POST',
      url: ANALYZE.replace('prebuilt-read', 'prebuilt-invoice'),
      headers: headers(key),
      payload: body,
    });
    expect(model.statusCode).toBe(404);
    expect(model.json().error.code).toBe('ModelNotFound');

    // Another user's key does not see the result.
    const { location } = await analyze(hh, key, makeScanPdf());
    const otherId = hh.ctx.repos.users.create('other', 'x', 'admin');
    const otherKey = hh.ctx.repos.apiKeys.create(otherId, { name: 'other', scopes: ['ocr'] }).key;
    const foreign = await hh.inject({
      method: 'GET',
      url: location.pathname + location.search,
      headers: { 'ocp-apim-subscription-key': otherKey },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('refuses while it is switched off', async () => {
    const { hh, key } = await harness(false);
    const res = await hh.inject({
      method: 'POST',
      url: ANALYZE,
      headers: headers(key),
      payload: { base64Source: makeScanPdf().toString('base64') },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/switched off/);
    expect(hh.ocrEngine.calls).toHaveLength(0);
  });

  const python = process.env.PAI_AZURE_SDK_PYTHON;
  it.skipIf(!python)('works with the Azure SDK as Paperless-ngx calls it', { timeout: 60_000 }, async () => {
    const { hh, key } = await harness();
    const address = await hh.app.listen({ port: 0, host: '127.0.0.1' });
    const dir = makeTempDir();
    try {
      const scan = path.join(dir, 'scan.pdf');
      fs.writeFileSync(scan, makeScanPdf());
      // The calls of paperless/parsers/remote.py (Paperless-ngx), without its Django parts.
      const script = [
        'import sys',
        'from azure.ai.documentintelligence import DocumentIntelligenceClient',
        'from azure.ai.documentintelligence.models import AnalyzeDocumentRequest, AnalyzeOutputOption, DocumentContentFormat',
        'from azure.core.credentials import AzureKeyCredential',
        'endpoint, key, file, out = sys.argv[1:5]',
        'client = DocumentIntelligenceClient(endpoint=endpoint, credential=AzureKeyCredential(key))',
        'with open(file, "rb") as f:',
        '    poller = client.begin_analyze_document(model_id="prebuilt-read", body=AnalyzeDocumentRequest(bytes_source=f.read()),',
        '        output_content_format=DocumentContentFormat.TEXT, output=[AnalyzeOutputOption.PDF], content_type="application/json")',
        'poller.wait()',
        'result_id = poller.details["operation_id"]',
        'result = poller.result()',
        'with open(out, "wb") as f:',
        '    for chunk in client.get_analyze_result_pdf(model_id="prebuilt-read", result_id=result_id):',
        '        f.write(chunk)',
        'print(result.content)',
      ].join('\n');
      const out = path.join(dir, 'archive.pdf');
      // Not execFileSync: the server answers from this process.
      const run = async (k: string) =>
        (await promisify(execFile)(python!, ['-I', '-c', script, address, k, scan, out], { timeout: 30_000 })).stdout;
      expect((await run(key)).trim()).toBe(OCR_TEXT);
      expect((await inspectFile(fs.readFileSync(out), 'application/pdf')).text).toContain(OCR_TEXT);
      // A wrong key: Paperless-ngx shows the message of the error.
      await expect(run('wrong')).rejects.toThrow(/API key of Paperless-AI/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
