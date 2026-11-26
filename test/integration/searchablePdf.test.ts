/**
 * Searchable PDF: the OCR text is laid into the PDF – in Paperless-ngx as a new version of the
 * document, in the built-in archive as the archive PDF of the version. Reverting the OCR text takes
 * it away again; the own version is never read by the OCR again.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentDetail } from '../../src/shared/api.js';
import { inspectFile } from '../../src/server/archive/files.js';
import { OCR_VERSION_LABEL } from '../../src/server/ocr/service.js';
import { analysisJson, createHarness, waitFor, type Harness, type HarnessOptions } from '../helpers/appHarness.js';
import { VERSION_TEXT } from '../helpers/mockPaperless.js';
import { makePdf, makeScanPdf } from '../helpers/pdf.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const OCR_TEXT = 'Rechnung Nr. 4711 der Stadtwerke Musterstadt über 106,72 EUR vom 03.11.2026';

async function harness(opts: HarnessOptions): Promise<Harness> {
  h = await createHarness(opts);
  h.llm.reply(analysisJson({ title: 'Stromrechnung November 2026', tags: ['Rechnung'] }));
  h.ocr.versionWait = { intervalMs: 10, timeoutMs: 5_000 };
  return h;
}

const textOf = async (pdf: Uint8Array) => (await inspectFile(pdf, 'application/pdf')).text;

describe('searchable PDF with Paperless-ngx', () => {
  it('uploads it as a new version, never reads that version again and deletes it on revert', async () => {
    const hh = await harness({ config: { ocr: { enabled: true, mode: 'always', searchablePdf: true } } });
    const scan = makeScanPdf();
    hh.paperless.addDocument({
      id: 2,
      title: 'scan.pdf',
      content: '',
      original_file_name: 'scan.pdf',
      file: { data: scan, contentType: 'application/pdf' },
    });

    hh.engine.enqueue(2, { source: 'scan' });
    await hh.engine.drain(10_000);
    const doc = hh.paperless.docs.get(2)!;
    expect(doc.versions).toHaveLength(1);
    expect(doc.versions[0].label).toBe(OCR_VERSION_LABEL);
    expect(await textOf(doc.versions[0].data)).toContain(OCR_TEXT);
    expect(doc.title).toBe('Stromrechnung November 2026');
    // Paperless-ngx read the text of the new version from its PDF; the saved OCR text replaces it.
    await waitFor(() => hh.paperless.contentOf(2) === OCR_TEXT, 5_000);
    expect(doc.content).toBe(OCR_TEXT); // the first version got it before (write-back)
    const cookie = await hh.login();
    const detail = (await hh.inject({ method: 'GET', url: '/api/ocr/documents?filter=done', headers: { cookie } })).json();
    expect(detail.items[0].ocr).toMatchObject({ pdf: 'version', pdfError: null });

    // "always": the document changed since (e.g. in the Paperless UI) – but its file is the own PDF, nothing to read.
    hh.paperless.editDocument(2, {});
    hh.engine.enqueue(2, { source: 'manual', force: true });
    await hh.engine.drain(10_000);
    expect(hh.ocrEngine.calls).toHaveLength(1);
    expect(doc.versions).toHaveLength(1);

    const revert = await hh.inject({ method: 'POST', url: '/api/ocr/documents/2/revert', headers: { cookie } });
    expect(revert.statusCode).toBe(200);
    expect(doc.versions).toHaveLength(0);
    expect(hh.paperless.contentOf(2)).toBe('');
    expect(hh.paperless.calls('DELETE', /^\/api\/documents\/2\/versions\/\d+\/$/)).toHaveLength(1);
  });

  it('leaves the text Paperless-ngx read from the PDF when the OCR text is not saved there', async () => {
    const hh = await harness({ config: { ocr: { enabled: true, mode: 'poor', writeBack: false, searchablePdf: true } } });
    hh.paperless.addDocument({
      id: 6,
      title: 'scan.pdf',
      content: '',
      file: { data: makeScanPdf(), contentType: 'application/pdf' },
    });
    hh.engine.enqueue(6, { source: 'scan' });
    await hh.engine.drain(10_000);
    expect(hh.paperless.docs.get(6)!.versions).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(hh.paperless.contentOf(6)).toBe(VERSION_TEXT);
    expect(hh.paperless.calls('PATCH', '/api/documents/6/').filter((c) => 'content' in (c.body as object))).toHaveLength(0);
  });

  it('keeps the OCR text and reports it when Paperless-ngx has no document versions', async () => {
    const hh = await harness({ config: { ocr: { enabled: true, mode: 'poor', searchablePdf: true } } });
    hh.paperless.documentVersions = false;
    hh.paperless.addDocument({
      id: 3,
      title: 'scan.pdf',
      content: '',
      file: { data: makeScanPdf(), contentType: 'application/pdf' },
    });
    hh.engine.enqueue(3, { source: 'scan' });
    await hh.engine.drain(10_000);
    expect(hh.paperless.docs.get(3)!.content).toBe(OCR_TEXT);
    expect(hh.ctx.repos.ocr.result(3)).toMatchObject({ pdf: 'failed', pdf_ref: expect.stringMatching(/no document versions/) });
    expect(hh.ctx.repos.documents.get(3)?.status).toBe('processed');
  });

  it('uploads nothing while the setting is off or when the pages have text of their own', async () => {
    const hh = await harness({ config: { ocr: { enabled: true, mode: 'always' } } });
    hh.paperless.addDocument({
      id: 4,
      title: 'scan.pdf',
      content: '',
      file: { data: makeScanPdf(), contentType: 'application/pdf' },
    });
    hh.engine.enqueue(4, { source: 'scan' });
    await hh.engine.drain(10_000);
    expect(hh.paperless.docs.get(4)!.versions).toHaveLength(0);

    hh.ctx.config.update({ ocr: { searchablePdf: true } });
    hh.ocrEngine.textChars = 400; // a digital PDF with a poor text: the pages keep their text
    hh.paperless.addDocument({
      id: 5,
      title: 'digital.pdf',
      content: 'x',
      file: { data: makeScanPdf(), contentType: 'application/pdf' },
    });
    hh.engine.enqueue(5, { source: 'scan' });
    await hh.engine.drain(10_000);
    expect(hh.paperless.docs.get(5)!.versions).toHaveLength(0);
    expect(hh.ctx.repos.ocr.result(5)?.pdf).toBeNull();
  });
});

describe('searchable PDF in the built-in archive', () => {
  async function upload(hh: Harness, cookie: string, name: string, data: Buffer, type: string): Promise<number> {
    const boundary = 'SBOUNDARY';
    const res = await hh.inject({
      method: 'POST',
      url: '/api/documents/upload',
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`,
        ),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().results[0].documentId as number;
  }

  const download = async (hh: Harness, cookie: string, id: number, original = false) => {
    const res = await hh.inject({
      method: 'GET',
      url: `/api/documents/${id}/file${original ? '?original=true' : ''}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    return res.rawPayload;
  };

  it('stores it as the archive PDF next to the untouched original and removes it on revert', async () => {
    const hh = await harness({ archive: 'builtin', config: { ocr: { searchablePdf: true } } });
    const cookie = await hh.login();
    const scan = makeScanPdf(2);
    const id = await upload(hh, cookie, 'scan.pdf', scan, 'application/pdf');
    await hh.engine.drain(10_000);

    const doc = (await hh.inject({ method: 'GET', url: `/api/documents/${id}`, headers: { cookie } })).json() as DocumentDetail;
    expect(doc.has_archive).toBe(true);
    expect(Buffer.compare(await download(hh, cookie, id, true), scan)).toBe(0);
    const archived = await download(hh, cookie, id);
    expect(await textOf(archived)).toContain(OCR_TEXT);
    expect((await inspectFile(archived, 'application/pdf')).pages).toBe(2);
    expect(hh.ctx.repos.ocr.result(id)).toMatchObject({ pdf: 'archive' });

    const revert = await hh.inject({ method: 'POST', url: `/api/ocr/documents/${id}/revert`, headers: { cookie } });
    expect(revert.statusCode).toBe(200);
    const after = (await hh.inject({ method: 'GET', url: `/api/documents/${id}`, headers: { cookie } })).json() as DocumentDetail;
    expect(after.has_archive).toBe(false);
    expect(Buffer.compare(await download(hh, cookie, id), scan)).toBe(0);
  });

  it('turns a photographed page into a searchable PDF', async () => {
    const hh = await harness({ archive: 'builtin', config: { ocr: { searchablePdf: true } } });
    const cookie = await hh.login();
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#ffffff' } })
      .jpeg()
      .toBuffer();
    const id = await upload(hh, cookie, 'beleg.jpg', jpeg, 'image/jpeg');
    await hh.engine.drain(10_000);
    const archived = await download(hh, cookie, id);
    expect(Buffer.from(archived.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(await textOf(archived)).toContain(OCR_TEXT);
    expect(Buffer.compare(await download(hh, cookie, id, true), jpeg)).toBe(0);
  });

  it('leaves a digital PDF alone', async () => {
    const hh = await harness({ archive: 'builtin', config: { ocr: { searchablePdf: true, mode: 'always' } } });
    const cookie = await hh.login();
    hh.ocrEngine.textChars = 300;
    const id = await upload(hh, cookie, 'brief.pdf', makePdf([['Ein Brief mit Text']]), 'application/pdf');
    await hh.engine.drain(10_000);
    const doc = (await hh.inject({ method: 'GET', url: `/api/documents/${id}`, headers: { cookie } })).json() as DocumentDetail;
    expect(doc.has_archive).toBe(false);
  });
});
